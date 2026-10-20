'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { db, tx } = require('./lib/db');
const { computeExpenseShares, computeBalances, simplifyDebts } = require('./lib/split');

const app = express();
app.use(express.json({ limit: '100kb' }));
app.disable('x-powered-by');
// Hosts such as Render or Railway put a proxy in front of the app; set TRUST_PROXY=1 there so the login throttle sees real client addresses.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---------- helpers ----------
const COOKIE = 'sid';
const SESSION_DAYS = 30;

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, userId);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`
  );
}

function clean(s, max = 100) {
  return typeof s === 'string' ? s.trim().slice(0, max) : '';
}

function toCents(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// naive in-memory throttle for auth endpoints
const attempts = new Map();
function throttle(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (rec.length >= 20) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  rec.push(now);
  attempts.set(key, rec);
  next();
}

function auth(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.created_at > datetime('now', ?)`
    )
    .get(token, `-${SESSION_DAYS} days`);
  if (!row) return res.status(401).json({ error: 'Not signed in' });
  req.user = row;
  req.token = token;
  next();
}

// Loads the group and checks the user can see it.
function groupAccess(req, res, next) {
  const gid = Number(req.params.id);
  const group = Number.isInteger(gid) ? db.prepare('SELECT * FROM groups WHERE id = ?').get(gid) : null;
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const me = db.prepare('SELECT * FROM members WHERE group_id = ? AND user_id = ?').get(gid, req.user.id);
  if (!me && group.created_by !== req.user.id) return res.status(404).json({ error: 'Group not found' });
  req.group = group;
  req.me = me || null;
  next();
}

function addMember(groupId, name, email) {
  let userId = null;
  if (email) {
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (u) userId = u.id;
  }
  const r = db
    .prepare('INSERT INTO members (group_id, name, email, user_id) VALUES (?, ?, ?, ?)')
    .run(groupId, name, email || null, userId);
  return Number(r.lastInsertRowid);
}

function loadGroupData(groupId) {
  const members = db.prepare('SELECT id, name, email, user_id AS userId FROM members WHERE group_id = ? ORDER BY id').all(groupId);
  const expRows = db.prepare('SELECT * FROM expenses WHERE group_id = ? ORDER BY id DESC').all(groupId);
  const itemRows = db
    .prepare(`SELECT i.* FROM items i JOIN expenses e ON e.id = i.expense_id WHERE e.group_id = ? ORDER BY i.id`)
    .all(groupId);
  const shareRows = db
    .prepare(
      `SELECT s.item_id, s.member_id FROM item_shares s
       JOIN items i ON i.id = s.item_id JOIN expenses e ON e.id = i.expense_id WHERE e.group_id = ?`
    )
    .all(groupId);
  const sharesByItem = {};
  shareRows.forEach((s) => (sharesByItem[s.item_id] = (sharesByItem[s.item_id] || []).concat(s.member_id)));
  const itemsByExpense = {};
  itemRows.forEach((i) => {
    (itemsByExpense[i.expense_id] = itemsByExpense[i.expense_id] || []).push({
      id: i.id,
      name: i.name,
      price: i.price_cents,
      shares: sharesByItem[i.id] || [],
    });
  });
  const expenses = expRows.map((e) => {
    const items = itemsByExpense[e.id] || [];
    const { owed, subtotal, total } = computeExpenseShares(items, e.extra_cents);
    return {
      id: e.id,
      title: e.title,
      paidBy: e.paid_by,
      extra: e.extra_cents,
      subtotal,
      total,
      owed,
      items,
      createdAt: e.created_at,
    };
  });
  const settlements = db
    .prepare('SELECT id, from_member AS "from", to_member AS "to", amount_cents AS amount, created_at AS createdAt FROM settlements WHERE group_id = ? ORDER BY id DESC')
    .all(groupId);
  const balances = computeBalances(
    members.map((m) => m.id),
    expenses,
    settlements
  );
  const suggested = simplifyDebts(balances);
  return { members, expenses, settlements, balances, suggested };
}

// ---------- auth routes ----------
app.post('/api/register', throttle, (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'That email is already registered' });
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db
    .prepare('INSERT INTO users (name, email, salt, password_hash) VALUES (?, ?, ?, ?)')
    .run(name, email, salt, hashPassword(password, salt));
  const userId = Number(r.lastInsertRowid);
  // link any groups this email was already added to
  db.prepare('UPDATE members SET user_id = ? WHERE email = ? AND user_id IS NULL').run(userId, email);
  startSession(res, userId);
  res.json({ user: { id: userId, name, email } });
});

app.post('/api/login', throttle, (req, res) => {
  const email = clean(req.body.email, 120).toLowerCase();
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !verifyPassword(password, u.salt, u.password_hash))
    return res.status(401).json({ error: 'Incorrect email or password' });
  startSession(res, u.id);
  res.json({ user: { id: u.id, name: u.name, email: u.email } });
});

app.post('/api/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: req.user }));

// ---------- groups ----------
app.get('/api/groups', auth, (req, res) => {
  const groups = db
    .prepare(
      `SELECT DISTINCT g.* FROM groups g LEFT JOIN members m ON m.group_id = g.id
       WHERE g.created_by = ? OR m.user_id = ? ORDER BY g.id DESC`
    )
    .all(req.user.id, req.user.id);
  const out = groups.map((g) => {
    const data = loadGroupData(g.id);
    const me = data.members.find((m) => m.userId === req.user.id);
    return {
      id: g.id,
      name: g.name,
      currency: g.currency,
      memberCount: data.members.length,
      myBalance: me ? data.balances[me.id] || 0 : 0,
      expenseCount: data.expenses.length,
      totalSpent: data.expenses.reduce((s, e) => s + e.total, 0),
      paymentsLeft: data.suggested.length,
    };
  });
  res.json({ groups: out });
});

app.post('/api/groups', auth, (req, res) => {
  const name = clean(req.body.name, 80);
  const currency = clean(req.body.currency, 4) || '$';
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const others = Array.isArray(req.body.members) ? req.body.members.slice(0, 30) : [];
  const id = tx(() => {
    const r = db.prepare('INSERT INTO groups (name, currency, created_by) VALUES (?, ?, ?)').run(name, currency, req.user.id);
    const gid = Number(r.lastInsertRowid);
    addMember(gid, req.user.name, req.user.email);
    for (const m of others) {
      const mn = clean(m && m.name, 60);
      const me = clean(m && m.email, 120).toLowerCase();
      if (!mn) continue;
      if (me && !EMAIL_RE.test(me)) throw Object.assign(new Error(`Invalid email for ${mn}`), { status: 400 });
      addMember(gid, mn, me);
    }
    return gid;
  });
  res.json({ id });
});

app.get('/api/groups/:id', auth, groupAccess, (req, res) => {
  const data = loadGroupData(req.group.id);
  res.json({
    group: { id: req.group.id, name: req.group.name, currency: req.group.currency, isOwner: req.group.created_by === req.user.id },
    meMemberId: req.me ? req.me.id : null,
    ...data,
  });
});

app.delete('/api/groups/:id', auth, groupAccess, (req, res) => {
  if (req.group.created_by !== req.user.id) return res.status(403).json({ error: 'Only the group creator can delete it' });
  db.prepare('DELETE FROM groups WHERE id = ?').run(req.group.id);
  res.json({ ok: true });
});

app.post('/api/groups/:id/members', auth, groupAccess, (req, res) => {
  const name = clean(req.body.name, 60);
  const email = clean(req.body.email, 120).toLowerCase();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email or leave it blank' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM members WHERE group_id = ?').get(req.group.id).c;
  if (count >= 50) return res.status(400).json({ error: 'A group can have at most 50 people' });
  const id = addMember(req.group.id, name, email);
  res.json({ id });
});

app.delete('/api/groups/:id/members/:mid', auth, groupAccess, (req, res) => {
  const mid = Number(req.params.mid);
  const gid = req.group.id;
  const member = db.prepare('SELECT id FROM members WHERE id = ? AND group_id = ?').get(mid, gid);
  if (!member) return res.status(404).json({ error: 'Person not found' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM members WHERE group_id = ?').get(gid).c;
  if (count <= 2) return res.status(400).json({ error: 'A group needs at least two people' });
  const used = db
    .prepare(
      `SELECT 1 FROM expenses WHERE paid_by = ? AND group_id = ?
       UNION SELECT 1 FROM item_shares s JOIN items i ON i.id = s.item_id JOIN expenses e ON e.id = i.expense_id
             WHERE s.member_id = ? AND e.group_id = ?
       UNION SELECT 1 FROM settlements WHERE group_id = ? AND (from_member = ? OR to_member = ?)`
    )
    .get(mid, gid, mid, gid, gid, mid, mid);
  if (used) return res.status(400).json({ error: 'They appear in expenses or payments, so they cannot be removed' });
  db.prepare('DELETE FROM members WHERE id = ?').run(mid);
  res.json({ ok: true });
});

// ---------- expenses ----------
app.post('/api/groups/:id/expenses', auth, groupAccess, (req, res) => {
  const title = clean(req.body.title, 100);
  if (!title) return res.status(400).json({ error: 'Give the expense a title' });
  const memberIds = new Set(db.prepare('SELECT id FROM members WHERE group_id = ?').all(req.group.id).map((m) => m.id));
  const paidBy = Number(req.body.paidBy);
  if (!memberIds.has(paidBy)) return res.status(400).json({ error: 'Choose who paid' });
  const extra = req.body.extra === undefined || req.body.extra === '' || req.body.extra === null ? 0 : toCents(req.body.extra);
  if (Number.isNaN(extra) || extra < 0) return res.status(400).json({ error: 'Tax/tip must be a number, 0 or more' });
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) return res.status(400).json({ error: 'Add at least one item' });
  if (rawItems.length > 100) return res.status(400).json({ error: 'Too many items (max 100)' });
  const items = [];
  for (const it of rawItems) {
    const name = clean(it && it.name, 100);
    const price = toCents(it && it.price);
    if (!name) return res.status(400).json({ error: 'Every item needs a name' });
    if (Number.isNaN(price) || price <= 0) return res.status(400).json({ error: `"${name}" needs a price above 0` });
    if (price > 100000000) return res.status(400).json({ error: `"${name}" price is too large` });
    const shares = [...new Set((Array.isArray(it.shares) ? it.shares : []).map(Number))];
    if (!shares.length) return res.status(400).json({ error: `Choose who shares "${name}"` });
    if (!shares.every((s) => memberIds.has(s))) return res.status(400).json({ error: `"${name}" has someone who isn't in this group` });
    items.push({ name, price, shares });
  }
  // optional date the bill was paid, as YYYY-MM-DD
  let createdAt = null;
  if (typeof req.body.date === 'string' && req.body.date !== '') {
    const d = req.body.date.trim();
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T00:00:00Z`) : null;
    if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d)
      return res.status(400).json({ error: 'Enter a valid date' });
    createdAt = `${d} 12:00:00`;
  }
  const id = tx(() => {
    const r = db
      .prepare(
        "INSERT INTO expenses (group_id, title, paid_by, extra_cents, created_by, created_at) VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')))"
      )
      .run(req.group.id, title, paidBy, extra, req.user.id, createdAt);
    const eid = Number(r.lastInsertRowid);
    const insItem = db.prepare('INSERT INTO items (expense_id, name, price_cents) VALUES (?, ?, ?)');
    const insShare = db.prepare('INSERT INTO item_shares (item_id, member_id) VALUES (?, ?)');
    for (const it of items) {
      const iid = Number(insItem.run(eid, it.name, it.price).lastInsertRowid);
      for (const m of it.shares) insShare.run(iid, m);
    }
    return eid;
  });
  res.json({ id });
});

app.delete('/api/groups/:id/expenses/:eid', auth, groupAccess, (req, res) => {
  const r = db.prepare('DELETE FROM expenses WHERE id = ? AND group_id = ?').run(Number(req.params.eid), req.group.id);
  if (!r.changes) return res.status(404).json({ error: 'Expense not found' });
  res.json({ ok: true });
});

// ---------- settlements ----------
app.post('/api/groups/:id/settlements', auth, groupAccess, (req, res) => {
  const from = Number(req.body.from);
  const to = Number(req.body.to);
  const amount = toCents(req.body.amount);
  const ids = new Set(db.prepare('SELECT id FROM members WHERE group_id = ?').all(req.group.id).map((m) => m.id));
  if (!ids.has(from) || !ids.has(to) || from === to) return res.status(400).json({ error: 'Choose two different people in this group' });
  if (Number.isNaN(amount) || amount <= 0) return res.status(400).json({ error: 'Amount must be above 0' });
  const r = db
    .prepare('INSERT INTO settlements (group_id, from_member, to_member, amount_cents) VALUES (?, ?, ?, ?)')
    .run(req.group.id, from, to, amount);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.delete('/api/groups/:id/settlements/:sid', auth, groupAccess, (req, res) => {
  const r = db.prepare('DELETE FROM settlements WHERE id = ? AND group_id = ?').run(Number(req.params.sid), req.group.id);
  if (!r.changes) return res.status(404).json({ error: 'Payment not found' });
  res.json({ ok: true });
});

// ---------- static + errors ----------
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      const base = path.basename(filePath);
      // the service worker and manifest must always be re-checked so updates reach phones
      if (base === 'sw.js' || base === 'manifest.webmanifest' || base === 'index.html') {
        res.setHeader('Cache-Control', 'no-cache');
      } else if (filePath.includes(`${path.sep}fonts${path.sep}`) || filePath.includes(`${path.sep}icons${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Bad request' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`bills36 running on http://localhost:${PORT}`));
}
module.exports = app;
