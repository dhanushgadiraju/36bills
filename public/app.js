'use strict';

/* bills36 front end. Plain JavaScript, no build step.
   All text from people is set with textContent (via h()), never parsed as HTML. */
(function () {
  /* ---------- tiny DOM helpers ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    var kids = Array.prototype.slice.call(arguments, 2);
    var flat = [].concat.apply([], kids.map(function (k) { return Array.isArray(k) ? [].concat.apply([], k) : [k]; }));
    flat.forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return el;
  }
  // Replace an element's children; skips null, flattens one level of arrays.
  function fill(el, list) {
    el.textContent = '';
    list.forEach(function (c) {
      if (Array.isArray(c)) c.forEach(function (x) { if (x) el.append(x); });
      else if (c) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
  }

  /* ---------- money and split maths (integer cents; mirrors lib/split.js on the server) ---------- */
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function todayStr() {
    var d = new Date();
    function p(n) { return String(n).padStart(2, '0'); }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function money(c, cur) { return (c < 0 ? '-' : '') + cur + (Math.abs(c) / 100).toFixed(2); }
  function cents(v) { var n = parseFloat(v); return isFinite(n) ? Math.round(n * 100) : NaN; }
  function initial(n) { return (String(n).trim()[0] || '?').toUpperCase(); }

  function splitEvenly(total, ids) {
    var out = {};
    if (!ids.length) return out;
    var base = Math.floor(total / ids.length);
    var rem = total - base * ids.length;
    ids.forEach(function (id) { out[id] = base + (rem > 0 ? 1 : 0); if (rem > 0) rem--; });
    return out;
  }
  function distribute(total, weights) {
    var ids = Object.keys(weights);
    var out = {};
    if (!ids.length) return out;
    var sum = ids.reduce(function (s, id) { return s + weights[id]; }, 0);
    if (sum === 0) return splitEvenly(total, ids);
    var assigned = 0;
    var fr = [];
    ids.forEach(function (id) {
      var exact = total * weights[id] / sum;
      out[id] = Math.floor(exact);
      assigned += out[id];
      fr.push({ id: id, f: exact - out[id] });
    });
    var left = total - assigned;
    fr.sort(function (a, b) { return b.f - a.f; });
    for (var i = 0; left > 0; i = (i + 1) % fr.length, left--) out[fr[i].id] += 1;
    return out;
  }
  // items: [{price, shares:[memberId]}]; extra (tax/tip) is spread in proportion to each person's items
  function sharesOf(items, extra) {
    var subs = {};
    var subtotal = 0;
    items.forEach(function (it) {
      subtotal += it.price;
      var parts = splitEvenly(it.price, it.shares);
      it.shares.forEach(function (id) { subs[id] = (subs[id] || 0) + parts[id]; });
    });
    var owed = {};
    Object.keys(subs).forEach(function (id) { owed[id] = subs[id]; });
    if (extra) {
      var ep = distribute(extra, subs);
      Object.keys(ep).forEach(function (id) { owed[id] += ep[id]; });
    }
    return { owed: owed, subtotal: subtotal, total: subtotal + (extra || 0) };
  }
  function balancesOf(g) {
    var bal = {};
    g.members.forEach(function (m) { bal[m.id] = 0; });
    g.expenses.forEach(function (e) {
      var c = sharesOf(e.items, e.extra || 0);
      bal[e.paidBy] = (bal[e.paidBy] || 0) + c.total;
      Object.keys(c.owed).forEach(function (id) { bal[id] = (bal[id] || 0) - c.owed[id]; });
    });
    g.settlements.forEach(function (s) {
      bal[s.from] = (bal[s.from] || 0) + s.amount;
      bal[s.to] = (bal[s.to] || 0) - s.amount;
    });
    return bal;
  }
  function simplify(bal) {
    var debtors = [];
    var creditors = [];
    Object.keys(bal).forEach(function (id) {
      if (bal[id] < 0) debtors.push({ id: id, amt: -bal[id] });
      else if (bal[id] > 0) creditors.push({ id: id, amt: bal[id] });
    });
    debtors.sort(function (a, b) { return b.amt - a.amt; });
    creditors.sort(function (a, b) { return b.amt - a.amt; });
    var pays = [];
    var i = 0;
    var j = 0;
    while (i < debtors.length && j < creditors.length) {
      var pay = Math.min(debtors[i].amt, creditors[j].amt);
      if (pay > 0) pays.push({ from: debtors[i].id, to: creditors[j].id, amount: pay });
      debtors[i].amt -= pay;
      creditors[j].amt -= pay;
      if (debtors[i].amt === 0) i++;
      if (creditors[j].amt === 0) j++;
    }
    return pays;
  }
  function totalSpent(g) {
    return g.expenses.reduce(function (s, e) { return s + sharesOf(e.items, e.extra || 0).total; }, 0);
  }

  /* ---------- API ---------- */
  async function api(method, url, body) {
    var res;
    try {
      res = await fetch(url, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin'
      });
    } catch (e) {
      var ne = new Error('No connection. Check your internet and try again.');
      ne.status = 0;
      throw ne;
    }
    var data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      var err = new Error(data.error || 'Something went wrong');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ---------- state ---------- */
  var S = { user: null, groups: null, group: null, loadError: null };
  var ui = { tab: 'expenses', open: {}, confirm: null, timer: null, authMode: 'login', installEvt: null };
  var app = document.getElementById('app');

  function groupId() {
    var m = location.hash.match(/^#\/group\/(\d+)/);
    return m ? Number(m[1]) : null;
  }
  async function loadGroups() {
    S.groups = (await api('GET', '/api/groups')).groups;
  }
  async function loadGroup(id) {
    var d = await api('GET', '/api/groups/' + id);
    S.group = {
      id: d.group.id, name: d.group.name, currency: d.group.currency, isOwner: d.group.isOwner,
      meId: d.meMemberId === null || d.meMemberId === undefined ? null : String(d.meMemberId),
      members: d.members.map(function (m) { return { id: String(m.id), name: m.name, email: m.email || '' }; }),
      expenses: d.expenses.map(function (e) {
        return {
          id: String(e.id), title: e.title, paidBy: String(e.paidBy), extra: e.extra || 0,
          createdAt: String(e.createdAt || '').slice(0, 10),
          items: e.items.map(function (i) { return { id: String(i.id), name: i.name, price: i.price, shares: i.shares.map(String) }; })
        };
      }),
      settlements: d.settlements.map(function (s) {
        return { id: String(s.id), from: String(s.from), to: String(s.to), amount: s.amount, createdAt: String(s.createdAt || '').slice(0, 10) };
      })
    };
  }
  function reload() {
    var gid = groupId();
    return gid ? loadGroup(gid) : loadGroups();
  }
  function signedOut() { S.user = null; S.groups = null; S.group = null; }

  /* ---------- small UI pieces ---------- */
  var toastTimer = null;
  function toast(msg) {
    var old = document.getElementById('toast');
    if (old) old.remove();
    var t = h('div', { id: 'toast', class: 'toast', role: 'status' }, msg);
    document.body.append(t);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 2800);
  }

  // Runs a change on the server, then refreshes what is on screen.
  async function act(fn, okMsg) {
    try { await fn(); }
    catch (e) {
      if (e.status === 401) { signedOut(); render(); } else toast(e.message);
      return false;
    }
    if (okMsg) toast(okMsg);
    try { await reload(); } catch (e) { if (e.status === 401) signedOut(); else toast('Saved, but the list could not refresh.'); }
    render();
    return true;
  }

  // Two-tap delete (works the same on phones as on desktop).
  function confirmBtn(label, key, onConfirm) {
    var armed = ui.confirm === key;
    return h('button', {
      type: 'button', class: 'btn danger sm' + (armed ? ' armed' : ''),
      onclick: function () {
        if (armed) { ui.confirm = null; onConfirm(); return; }
        ui.confirm = key;
        render();
        clearTimeout(ui.timer);
        ui.timer = setTimeout(function () { if (ui.confirm === key) { ui.confirm = null; render(); } }, 3500);
      }
    }, armed ? 'Tap again to confirm' : label);
  }

  function openModal(title, build) {
    var prev = document.activeElement;
    var overlay = null;
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    var m = {};
    function onKey(e) { if (e.key === 'Escape') m.close(); }
    m.close = function () {
      document.removeEventListener('keydown', onKey);
      if (overlay) overlay.remove();
      if (prev && prev.focus) prev.focus();
    };
    m.error = function (msg) { err.textContent = msg; err.hidden = false; if (err.scrollIntoView) err.scrollIntoView({ block: 'nearest' }); };
    var built = build(m);
    var panel = h('div', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('h2', {}, title), err, built.content, h('div', { class: 'actions' }, built.actions));
    overlay = h('div', { class: 'overlay' }, panel);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) m.close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    var first = panel.querySelector('input, select');
    if (first) first.focus();
    return m;
  }

  /* ---------- install on phone ---------- */
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function openInstallHelp() {
    openModal('Add bills36 to your phone', function (m) {
      var content = h('div', { class: 'stack' },
        h('div', {}, h('strong', {}, 'iPhone (Safari)'),
          h('ol', { class: 'steps' }, h('li', {}, 'Tap the Share button at the bottom of the screen.'), h('li', {}, 'Choose “Add to Home Screen”.'), h('li', {}, 'Tap Add.'))),
        h('div', {}, h('strong', {}, 'Android (Chrome)'),
          h('ol', { class: 'steps' }, h('li', {}, 'Tap the ⋮ menu at the top right.'), h('li', {}, 'Choose “Install app” or “Add to Home screen”.'), h('li', {}, 'Tap Install.'))),
        h('div', { class: 'muted sm' }, 'Open this from the website address in your browser, not from inside another app such as WhatsApp. Then bills36 opens full screen with its own icon.'));
      return { content: content, actions: [h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Done')] };
    });
  }
  function installApp() {
    var evt = ui.installEvt;
    if (!evt) { openInstallHelp(); return; }
    ui.installEvt = null;
    evt.prompt();
    if (evt.userChoice && evt.userChoice.then) evt.userChoice.then(function () { render(); });
  }

  /* ---------- page frame ---------- */
  function header() {
    return h('div', { class: 'top' },
      h('button', { class: 'brand', type: 'button', 'aria-label': 'bills36, all groups', onclick: function () { if (S.user) location.hash = '#/'; } }, 'bills', h('span', {}, '36')),
      S.user ? h('div', { class: 'who' }, h('span', { class: 'name' }, S.user.name),
        h('button', { class: 'btn ghost sm', type: 'button', onclick: async function () {
          try { await api('POST', '/api/logout'); } catch (e) { /* signing out locally is enough */ }
          signedOut(); ui.authMode = 'login'; location.hash = '#/'; render();
        } }, 'Log out')) : null);
  }
  function footer() {
    return h('div', { class: 'footer' },
      isStandalone() ? null : h('button', { class: 'linkbtn', type: 'button', onclick: installApp }, 'Add bills36 to your phone'),
      h('div', {}, 'Split bills item by item.'));
  }
  function loadingCard() { return h('div', { class: 'card empty' }, 'Loading…'); }
  function errorCard() {
    return h('div', { class: 'card empty stack' }, h('div', {}, S.loadError || 'Something went wrong.'),
      h('div', {}, h('button', { class: 'btn', type: 'button', onclick: function () { S.loadError = null; route(); } }, 'Try again')));
  }

  /* ---------- sign in / sign up ---------- */
  function authView() {
    var mode = ui.authMode;
    var err = h('div', { class: 'error', role: 'alert', hidden: true });
    var name = h('input', { id: 'au-name', type: 'text', autocomplete: 'name', maxlength: 60 });
    var email = h('input', { id: 'au-email', type: 'email', autocomplete: 'email', inputmode: 'email', required: true });
    var pass = h('input', { id: 'au-pass', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
    var btn = h('button', { class: 'btn', type: 'submit' }, mode === 'login' ? 'Log in' : 'Sign up');
    var form = h('form', { class: 'stack' },
      h('div', {}, h('h1', {}, mode === 'login' ? 'Welcome back' : 'Create your account'),
        h('div', { class: 'muted' }, 'Split bills item by item with the people you live with.')),
      err,
      mode === 'register' ? h('div', {}, h('label', { for: 'au-name' }, 'Your name'), name) : null,
      h('div', {}, h('label', { for: 'au-email' }, 'Email'), email),
      h('div', {}, h('label', { for: 'au-pass' }, mode === 'register' ? 'Password (8+ characters)' : 'Password'), pass),
      btn,
      h('div', { class: 'sm muted' }, mode === 'login' ? 'New here? ' : 'Already have an account? ',
        h('button', { type: 'button', class: 'linkbtn', onclick: function () { ui.authMode = mode === 'login' ? 'register' : 'login'; render(); } },
          mode === 'login' ? 'Create an account' : 'Log in')));
    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      err.hidden = true;
      btn.disabled = true;
      try {
        var body = { email: email.value, password: pass.value };
        if (mode === 'register') body.name = name.value;
        var r = await api('POST', mode === 'login' ? '/api/login' : '/api/register', body);
        S.user = r.user; S.groups = null; S.group = null; S.loadError = null;
        await route();
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    });
    return h('div', { class: 'card auth' }, form);
  }

  /* ---------- group list ---------- */
  function groupsView() {
    var rows = S.groups.length ? S.groups.map(function (g) {
      var b = g.myBalance;
      return h('button', { class: 'group-row', type: 'button', onclick: function () { ui.tab = 'expenses'; location.hash = '#/group/' + g.id; } },
        h('div', { class: 'grow' },
          h('div', { class: 'name' }, g.name),
          h('div', { class: 'muted sm' }, g.memberCount + ' people · ' + g.expenseCount + (g.expenseCount === 1 ? ' expense' : ' expenses') + ' · ' + money(g.totalSpent, g.currency) + ' spent')),
        h('div', { class: 'right' },
          h('div', { class: 'amt ' + (b > 0 ? 'pos' : b < 0 ? 'neg' : 'muted') }, money(Math.abs(b), g.currency)),
          h('div', { class: 'muted sm' }, b > 0 ? 'you are owed' : b < 0 ? 'you owe' : 'settled up')));
    }) : [h('div', { class: 'card empty' }, 'No groups yet. Create one for your household to start splitting bills.')];
    return h('div', { class: 'stack' },
      h('div', { class: 'page-head' }, h('h2', {}, 'Your groups'), h('button', { class: 'btn', type: 'button', onclick: openNewGroup }, '+ New group')),
      rows);
  }

  function openNewGroup() {
    openModal('New group', function (m) {
      var name = h('input', { id: 'ng-name', type: 'text', maxlength: 80, placeholder: 'e.g. Flat 4B, Bali trip' });
      var cur = h('input', { id: 'ng-cur', type: 'text', maxlength: 3, value: '$' });
      var rows = h('div', { class: 'stack-sm' });
      function addRow() {
        var row = h('div', { class: 'member-row' },
          h('input', { type: 'text', maxlength: 60, placeholder: 'Name', 'data-f': 'name', 'aria-label': 'Person name' }),
          h('input', { type: 'email', maxlength: 120, placeholder: 'Email (optional)', 'data-f': 'email', 'aria-label': 'Person email, optional', inputmode: 'email' }),
          h('button', { type: 'button', class: 'x', title: 'Remove', 'aria-label': 'Remove person', onclick: function () { row.remove(); } }, '×'));
        rows.append(row);
        return row.firstChild;
      }
      addRow(); addRow();
      var content = h('div', { class: 'stack' },
        h('div', { class: 'field-row' },
          h('div', { class: 'grow' }, h('label', { for: 'ng-name' }, 'Group name'), name),
          h('div', { class: 'cur' }, h('label', { for: 'ng-cur' }, 'Currency'), cur)),
        h('div', {}, h('label', {}, 'Other people (you are added automatically)'), rows,
          h('button', { type: 'button', class: 'btn ghost sm', onclick: function () { addRow().focus(); } }, '+ Add person'),
          h('div', { class: 'small muted sm', style: 'margin-top:8px' }, 'If you add someone’s email and they have, or later create, a bills36 account with it, the group shows up for them too.')));
      var actions = [
        h('button', { class: 'btn ghost', type: 'button', onclick: m.close }, 'Cancel'),
        h('button', { class: 'btn', type: 'button', onclick: async function (ev) {
          var btn = ev.currentTarget;
          var gname = name.value.trim();
          if (!gname) return m.error('Give the group a name.');
          var people = [].slice.call(rows.querySelectorAll('.member-row')).map(function (r) {
            return { name: r.querySelector('[data-f=name]').value.trim(), email: r.querySelector('[data-f=email]').value.trim() };
          }).filter(function (p) { return p.name; });
          if (!people.length) return m.error('Add at least one other person.');
          var names = [S.user.name.toLowerCase()].concat(people.map(function (p) { return p.name.toLowerCase(); }));
          if (names.some(function (n, i) { return names.indexOf(n) !== i; })) return m.error('Each person needs a different name (your own name is already in the group).');
          btn.disabled = true;
          try {
            var r = await api('POST', '/api/groups', { name: gname, currency: cur.value.trim() || '$', members: people });
            m.close(); ui.tab = 'expenses'; location.hash = '#/group/' + r.id;
          } catch (ex) {
            if (ex.status === 401) { m.close(); signedOut(); render(); return; }
            m.error(ex.message); btn.disabled = false;
          }
        } }, 'Create group')
      ];
      return { content: content, actions: actions };
    });
  }

  /* ---------- one group ---------- */
  function groupView(G) {
    var cur = G.currency;
    var nm = function (id) { var x = G.members.filter(function (mm) { return mm.id === id; })[0]; return x ? x.name : 'Unknown'; };
    var me = G.meId ? G.members.filter(function (mm) { return mm.id === G.meId; })[0] || null : null;
    var bal = balancesOf(G);
    var suggested = simplify(bal);
    var gid = G.id;

    var tabs = h('div', { class: 'tabs', role: 'tablist' },
      ['expenses', 'balances', 'people'].map(function (t) {
        return h('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': ui.tab === t ? 'true' : 'false',
          onclick: function () { ui.tab = t; render(); } }, t.charAt(0).toUpperCase() + t.slice(1));
      }));

    var body;
    if (ui.tab === 'expenses') body = tabExpenses();
    else if (ui.tab === 'balances') body = tabBalances();
    else body = tabPeople();

    function line(label, value, strong) {
      return h('div', { class: 'r-line' + (strong ? ' strong' : '') },
        h('span', { class: 'r-l' }, label), h('span', { class: 'lead', 'aria-hidden': 'true' }), h('span', { class: 'r-r' }, value));
    }

    function expenseCard(e) {
      var isOpen = !!ui.open[e.id];
      var calc = sharesOf(e.items, e.extra || 0);
      var head = h('button', { class: 'exp-head', type: 'button', 'aria-expanded': isOpen ? 'true' : 'false',
        onclick: function () { if (ui.open[e.id]) delete ui.open[e.id]; else ui.open[e.id] = true; render(); } },
        h('span', { class: 'grow' },
          h('span', { class: 'exp-title' }, e.title),
          h('span', { class: 'sub' }, nm(e.paidBy) + ' paid · ' + e.items.length + (e.items.length === 1 ? ' item' : ' items') + (e.createdAt ? ' · ' + e.createdAt : ''))),
        h('span', { class: 'amt' }, money(calc.total, cur)));
      var card = h('div', { class: 'card exp' }, head);
      if (isOpen) {
        var receipt = h('div', { class: 'receipt' },
          h('div', { class: 'r-head' }, 'Paid by ' + nm(e.paidBy)),
          e.items.map(function (it) {
            var n = it.shares.length;
            var each = it.price % n === 0 ? money(it.price / n, cur) + ' each' : 'about ' + money(Math.floor(it.price / n), cur) + ' each';
            return h('div', {}, line(it.name, money(it.price, cur)),
              h('div', { class: 'r-sub' }, n + (n === 1 ? ' person' : ' people') + ': ' + it.shares.map(nm).join(', ') + ' · ' + each));
          }),
          e.extra ? line('Tax / tip', money(e.extra, cur)) : null,
          h('div', { class: 'r-rule' }),
          line('Total', money(calc.total, cur), true),
          h('div', { class: 'r-rule' }),
          h('div', { class: 'r-head' }, 'Who owes what'),
          G.members.filter(function (mm) { return calc.owed[mm.id]; }).map(function (mm) { return line(mm.name, money(calc.owed[mm.id], cur)); }));
        card.append(h('div', { class: 'exp-body' }, receipt,
          h('div', {}, confirmBtn('Delete expense', 'exp-' + e.id, function () {
            act(function () { return api('DELETE', '/api/groups/' + gid + '/expenses/' + e.id); }, 'Expense deleted');
          }))));
      }
      return card;
    }

    function tabExpenses() {
      return G.expenses.length ? G.expenses.map(expenseCard)
        : [h('div', { class: 'card empty' }, 'No expenses yet. Add the first one to see who owes what.')];
    }

    function tabBalances() {
      var youCard = null;
      if (me) {
        var mb = bal[me.id] || 0;
        youCard = h('div', { class: 'card pad you-card' },
          h('div', {}, h('div', { class: 'muted sm' }, 'Your balance'),
            h('div', { class: 'big ' + (mb > 0 ? 'pos' : mb < 0 ? 'neg' : 'muted') }, money(Math.abs(mb), cur))),
          h('div', { style: 'font-weight:700' }, mb > 0 ? 'You are owed' : mb < 0 ? 'You owe' : 'You are settled up'));
      }
      var people = h('div', { class: 'card pad' }, h('h3', {}, 'Everyone'),
        G.members.map(function (mm) {
          var b = bal[mm.id] || 0;
          return h('div', { class: 'person' },
            h('div', { class: 'avatar' }, initial(mm.name)),
            h('div', { class: 'grow pname' }, mm.name, me && me.id === mm.id ? h('span', { class: 'tag' }, 'you') : null),
            h('div', { class: 'status' },
              h('div', { class: 'amt ' + (b > 0 ? 'pos' : b < 0 ? 'neg' : 'muted') }, money(Math.abs(b), cur)),
              h('div', { class: 'muted sm' }, b > 0 ? 'is owed' : b < 0 ? 'owes' : 'settled up')));
        }));
      var pays = h('div', { class: 'card pad' }, h('h3', {}, 'Fewest payments to settle up'),
        suggested.length ? suggested.map(function (p) {
          return h('div', { class: 'pay-row' },
            h('div', { class: 'grow' }, h('strong', {}, nm(p.from)), ' pays ', h('strong', {}, nm(p.to))),
            h('span', { class: 'amt' }, money(p.amount, cur)),
            h('button', { class: 'btn sm', type: 'button', onclick: function () { openSettle(p); } }, 'Record payment'));
        }) : h('div', { class: 'muted' }, 'Everyone is settled up.'));
      var hist = G.settlements.length ? h('div', { class: 'card pad' }, h('h3', {}, 'Payments recorded'),
        G.settlements.map(function (s) {
          return h('div', { class: 'pay-row' },
            h('div', { class: 'grow' }, nm(s.from) + ' paid ' + nm(s.to) + ' ', h('span', { class: 'muted sm' }, s.createdAt)),
            h('span', { class: 'amt' }, money(s.amount, cur)),
            h('button', { class: 'btn ghost sm', type: 'button', onclick: function () {
              act(function () { return api('DELETE', '/api/groups/' + gid + '/settlements/' + s.id); }, 'Payment removed');
            } }, 'Undo'));
        })) : null;
      return [youCard, people, pays, hist];
    }

    function tabPeople() {
      function used(mm) {
        return G.expenses.some(function (e) { return e.paidBy === mm.id || e.items.some(function (i) { return i.shares.indexOf(mm.id) !== -1; }); })
          || G.settlements.some(function (s) { return s.from === mm.id || s.to === mm.id; });
      }
      return [
        h('div', { class: 'card pad' }, h('h3', {}, 'People (' + G.members.length + ')'),
          G.members.map(function (mm) {
            var canRemove = G.members.length > 2 && !used(mm);
            return h('div', { class: 'person' },
              h('div', { class: 'avatar' }, initial(mm.name)),
              h('div', { class: 'grow' }, h('div', { class: 'pname' }, mm.name, me && me.id === mm.id ? h('span', { class: 'tag' }, 'you') : null),
                mm.email ? h('div', { class: 'muted sm', style: 'overflow-wrap:anywhere' }, mm.email) : null),
              canRemove ? h('button', { class: 'btn ghost sm', type: 'button', onclick: function () {
                act(function () { return api('DELETE', '/api/groups/' + gid + '/members/' + mm.id); }, mm.name + ' removed');
              } }, 'Remove') : (used(mm) ? h('span', { class: 'muted sm' }, 'in expenses') : null));
          })),
        h('div', {}, h('button', { class: 'btn', type: 'button', onclick: openAddPerson }, '+ Add person')),
        G.isOwner ? h('div', {}, confirmBtn('Delete group', 'grp-' + gid, async function () {
          try {
            await api('DELETE', '/api/groups/' + gid);
            S.group = null; toast('Group deleted'); location.hash = '#/';
          } catch (e) { if (e.status === 401) { signedOut(); render(); } else toast(e.message); }
        })) : null
      ];
    }

    function openAddPerson() {
      openModal('Add a person', function (m) {
        var name = h('input', { id: 'ap-name', type: 'text', maxlength: 60, placeholder: 'Name' });
        var email = h('input', { id: 'ap-email', type: 'email', maxlength: 120, placeholder: 'Email (optional)', inputmode: 'email' });
        var content = h('div', { class: 'stack' },
          h('div', {}, h('label', { for: 'ap-name' }, 'Name'), name),
          h('div', {}, h('label', { for: 'ap-email' }, 'Email (optional)'), email,
            h('div', { class: 'muted sm', style: 'margin-top:6px' }, 'If they have a bills36 account with this email, the group appears for them.')));
        var actions = [
          h('button', { class: 'btn ghost', type: 'button', onclick: m.close }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', onclick: async function (ev) {
            var btn = ev.currentTarget;
            var n = name.value.trim();
            if (!n) return m.error('Enter a name.');
            if (G.members.some(function (x) { return x.name.toLowerCase() === n.toLowerCase(); })) return m.error('Someone here already has that name.');
            btn.disabled = true;
            var ok = await act(function () { return api('POST', '/api/groups/' + gid + '/members', { name: n, email: email.value.trim() }); }, n + ' added');
            btn.disabled = false;
            if (ok) m.close();
          } }, 'Add')
        ];
        return { content: content, actions: actions };
      });
    }

    function openSettle(pre) {
      openModal('Record a payment', function (m) {
        function opts(sel) { return G.members.map(function (mm) { return h('option', { value: mm.id, selected: mm.id === sel }, mm.name); }); }
        var fromDefault = pre ? pre.from : (me ? me.id : G.members[0].id);
        var toDefault = pre ? pre.to : G.members.filter(function (x) { return x.id !== fromDefault; })[0].id;
        var from = h('select', { id: 'st-from' }, opts(fromDefault));
        var to = h('select', { id: 'st-to' }, opts(toDefault));
        var amt = h('input', { id: 'st-amt', type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', value: pre ? (pre.amount / 100).toFixed(2) : '' });
        var content = h('div', { class: 'stack' },
          h('div', {}, h('label', { for: 'st-from' }, 'Who paid'), from),
          h('div', {}, h('label', { for: 'st-to' }, 'Paid to'), to),
          h('div', {}, h('label', { for: 'st-amt' }, 'Amount (' + cur + ')'), amt));
        var actions = [
          h('button', { class: 'btn ghost', type: 'button', onclick: m.close }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', onclick: async function (ev) {
            var btn = ev.currentTarget;
            var c = cents(amt.value);
            if (from.value === to.value) return m.error('Choose two different people.');
            if (!(c > 0)) return m.error('Enter an amount above 0.');
            btn.disabled = true;
            var ok = await act(function () {
              return api('POST', '/api/groups/' + gid + '/settlements', { from: Number(from.value), to: Number(to.value), amount: amt.value });
            }, 'Payment recorded');
            btn.disabled = false;
            if (ok) { m.close(); ui.tab = 'balances'; render(); }
          } }, 'Save payment')
        ];
        return { content: content, actions: actions };
      });
    }

    // Each item has a name, a price, and the people who shared it.
    function openAddExpense() {
      openModal('Add an expense', function (m) {
        var title = h('input', { id: 'ex-title', type: 'text', maxlength: 100, placeholder: 'e.g. Dinner at Luigi’s' });
        var dateIn = h('input', { id: 'ex-date', type: 'date', value: todayStr() });
        var payer = h('select', { id: 'ex-payer' }, G.members.map(function (mm, i) {
          return h('option', { value: mm.id, selected: me ? mm.id === me.id : i === 0 }, mm.name);
        }));
        var extra = h('input', { id: 'ex-extra', type: 'number', step: '0.01', min: '0', inputmode: 'decimal', placeholder: '0.00' });
        var itemsBox = h('div', { class: 'stack' });
        var summary = h('div', { class: 'summary' });
        var rows = [];

        function recompute() {
          var items = rows.map(function (r) { return { price: cents(r.priceEl.value), shares: Array.from(r.shares) }; })
            .filter(function (i) { return i.price > 0 && i.shares.length; });
          var ex = cents(extra.value);
          var c = sharesOf(items, ex > 0 ? ex : 0);
          fill(summary, [
            h('div', { class: 'line' }, h('span', {}, 'Items'), h('span', { class: 'amt' }, money(c.subtotal, cur))),
            ex > 0 ? h('div', { class: 'line' }, h('span', {}, 'Tax / tip'), h('span', { class: 'amt' }, money(ex, cur))) : null,
            G.members.filter(function (mm) { return c.owed[mm.id]; }).map(function (mm) {
              return h('div', { class: 'line sm' }, h('span', {}, mm.name + ' owes'), h('span', { class: 'amt' }, money(c.owed[mm.id], cur)));
            }),
            h('div', { class: 'line total' }, h('span', {}, 'Total'), h('span', { class: 'amt' }, money(c.total, cur)))]);
        }

        function addItem() {
          var r = { shares: new Set(G.members.map(function (mm) { return mm.id; })) };
          var n = rows.length + 1;
          r.nameEl = h('input', { id: 'it-name-' + uid(), type: 'text', maxlength: 100, placeholder: 'Item name', 'aria-label': 'Item ' + n + ' name' });
          r.priceEl = h('input', { id: 'it-price-' + uid(), type: 'number', step: '0.01', min: '0', inputmode: 'decimal', placeholder: '0.00', 'aria-label': 'Item ' + n + ' price' });
          r.priceEl.addEventListener('input', recompute);
          r.chips = h('div', { class: 'chips' });
          function paint() {
            var all = r.shares.size === G.members.length;
            fill(r.chips, [
              h('button', { type: 'button', class: 'chip all', onclick: function () {
                if (all) r.shares.clear(); else G.members.forEach(function (mm) { r.shares.add(mm.id); });
                paint(); recompute();
              } }, all ? 'Clear all' : 'Everyone'),
              G.members.map(function (mm) {
                return h('button', { type: 'button', class: 'chip', 'aria-pressed': r.shares.has(mm.id) ? 'true' : 'false', onclick: function () {
                  if (r.shares.has(mm.id)) r.shares.delete(mm.id); else r.shares.add(mm.id);
                  paint(); recompute();
                } }, mm.name);
              }),
              h('span', { class: 'count' }, r.shares.size + ' of ' + G.members.length + ' sharing')]);
          }
          r.el = h('div', { class: 'item' },
            h('div', { class: 'item-top' },
              h('div', {}, h('label', {}, 'Item'), r.nameEl),
              h('div', {}, h('label', {}, 'Price (' + cur + ')'), r.priceEl),
              h('button', { type: 'button', class: 'x', title: 'Remove item', 'aria-label': 'Remove item', onclick: function () {
                if (rows.length === 1) return;
                rows.splice(rows.indexOf(r), 1); r.el.remove(); recompute();
              } }, '×')),
            r.chips);
          rows.push(r);
          itemsBox.append(r.el);
          paint();
          recompute();
          return r;
        }
        extra.addEventListener('input', recompute);
        addItem();

        var content = h('div', { class: 'stack' },
          h('div', { class: 'field-row' },
            h('div', { class: 'grow', style: 'min-width:180px' }, h('label', { for: 'ex-title' }, 'Title'), title),
            h('div', { class: 'grow', style: 'min-width:150px' }, h('label', { for: 'ex-payer' }, 'Paid by'), payer),
            h('div', { style: 'min-width:150px' }, h('label', { for: 'ex-date' }, 'Date'), dateIn)),
          h('div', {},
            h('label', {}, 'Items'),
            h('div', { class: 'muted sm', style: 'margin-bottom:8px' }, 'For each item, tap the people who shared it. Its price is split equally between them.'),
            itemsBox,
            h('div', { style: 'margin-top:10px' }, h('button', { type: 'button', class: 'btn ghost sm', onclick: function () { addItem().nameEl.focus(); } }, '+ Add another item'))),
          h('div', { style: 'max-width:220px' }, h('label', { for: 'ex-extra' }, 'Tax / tip (' + cur + ', optional)'), extra),
          summary);

        var actions = [
          h('button', { class: 'btn ghost', type: 'button', onclick: m.close }, 'Cancel'),
          h('button', { class: 'btn', type: 'button', onclick: async function (ev) {
            var btn = ev.currentTarget;
            var t = title.value.trim();
            if (!t) return m.error('Give the expense a title.');
            var items = [];
            for (var i = 0; i < rows.length; i++) {
              var r = rows[i];
              var nme = r.nameEl.value.trim();
              var price = cents(r.priceEl.value);
              if (!nme) return m.error('Every item needs a name.');
              if (!(price > 0) || price > 100000000) return m.error('“' + nme + '” needs a price above 0.');
              if (!r.shares.size) return m.error('Choose who shared “' + nme + '”.');
              items.push({ name: nme, price: r.priceEl.value, shares: Array.from(r.shares).map(Number) });
            }
            var exRaw = extra.value.trim();
            if (exRaw && !(cents(exRaw) >= 0)) return m.error('Tax / tip must be 0 or more.');
            btn.disabled = true;
            var ok = await act(function () {
              return api('POST', '/api/groups/' + gid + '/expenses', {
                title: t, paidBy: Number(payer.value), extra: exRaw, date: dateIn.value, items: items
              }).then(function (res) { ui.open[String(res.id)] = true; ui.tab = 'expenses'; });
            }, 'Expense added');
            btn.disabled = false;
            if (ok) m.close();
          } }, 'Save expense')
        ];
        return { content: content, actions: actions };
      });
    }

    return h('div', { class: 'stack' },
      h('button', { class: 'back', type: 'button', onclick: function () { location.hash = '#/'; } }, '← All groups'),
      h('div', { class: 'page-head' },
        h('div', {}, h('h2', {}, G.name), h('div', { class: 'muted sm' }, G.members.length + ' people · ' + money(totalSpent(G), cur) + ' spent')),
        h('div', { class: 'head-actions' },
          h('button', { class: 'btn alt', type: 'button', onclick: function () { openSettle(null); } }, 'Settle up'),
          h('button', { class: 'btn', type: 'button', onclick: openAddExpense }, '+ Add expense'))),
      tabs,
      body);
  }

  /* ---------- render + routing ---------- */
  function render() {
    var gid = groupId();
    var hasData = S.user && (gid ? S.group && S.group.id === gid : S.groups);
    var main;
    if (!S.user) main = S.loadError ? errorCard() : authView();
    else if (hasData) main = gid ? groupView(S.group) : groupsView();
    else main = S.loadError ? errorCard() : loadingCard();
    var offline = navigator.onLine === false;
    fill(app, [
      header(),
      offline && S.user ? h('div', { class: 'notice', role: 'status' }, 'You are offline. Changes can’t be saved until you reconnect.') : null,
      S.loadError && hasData ? h('div', { class: 'notice', role: 'status' }, S.loadError) : null,
      main,
      footer()]);
  }

  async function route() {
    if (!S.user) {
      try { S.user = (await api('GET', '/api/me')).user; }
      catch (e) { S.loadError = e.status === 401 ? null : e.message; render(); return; }
    }
    var gid = groupId();
    var stale = gid ? !S.group || S.group.id !== gid : S.groups === null;
    if (stale) { if (gid) S.group = null; render(); }
    try {
      if (gid) await loadGroup(gid); else await loadGroups();
      S.loadError = null;
    } catch (e) {
      if (e.status === 401) signedOut();
      else if (e.status === 404 && gid) { S.group = null; toast('That group was not found.'); location.hash = '#/'; return; }
      else S.loadError = e.message;
    }
    render();
  }

  // Keep the screen fresh so housemates see each other's changes.
  async function quietRefresh() {
    if (!S.user || document.visibilityState !== 'visible' || navigator.onLine === false) return;
    if (document.querySelector('.overlay')) return;
    try { await reload(); S.loadError = null; render(); }
    catch (e) { if (e.status === 401) { signedOut(); render(); } }
  }
  setInterval(quietRefresh, 20000);
  document.addEventListener('visibilitychange', quietRefresh);
  window.addEventListener('online', function () { if (S.user) quietRefresh(); });
  window.addEventListener('offline', function () { if (S.user) render(); });
  window.addEventListener('hashchange', function () { ui.tab = 'expenses'; route(); });

  // Offer the browser's own install prompt where it exists (Android Chrome and similar).
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); ui.installEvt = e; });
  window.addEventListener('appinstalled', function () { ui.installEvt = null; render(); });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* the app works without it */ }); });
  }

  render();
  route();
})();
