'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

process.env.DB_FILE = path.join(os.tmpdir(), `splitwise-test-${process.pid}-${Date.now()}.db`);

const { splitEvenly, distributeProportionally, computeExpenseShares, computeBalances, simplifyDebts } = require('../lib/split');

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

test('splitEvenly never loses a cent', () => {
  const r = splitEvenly(1000, ['a', 'b', 'c']);
  assert.strictEqual(sum(r), 1000);
  assert.deepStrictEqual(Object.values(r).sort(), [333, 333, 334]);
});

test('distributeProportionally sums exactly', () => {
  const r = distributeProportionally(101, { a: 333, b: 333, c: 334 });
  assert.strictEqual(sum(r), 101);
});

test('item-by-item split: only sharers pay for an item', () => {
  // Pizza 30.00 shared by A,B,C ; Beer 12.00 shared by A,B ; Salad 8.00 only C
  const items = [
    { price: 3000, shares: [1, 2, 3] },
    { price: 1200, shares: [1, 2] },
    { price: 800, shares: [3] },
  ];
  const { owed, total } = computeExpenseShares(items, 0);
  assert.deepStrictEqual(owed, { 1: 1600, 2: 1600, 3: 1800 });
  assert.strictEqual(total, 5000);
});

test('tax/tip is spread in proportion and totals match', () => {
  const items = [
    { price: 3000, shares: [1] },
    { price: 1000, shares: [2] },
  ];
  const { owed, total } = computeExpenseShares(items, 400);
  assert.deepStrictEqual(owed, { 1: 3300, 2: 1100 });
  assert.strictEqual(sum(owed), total);
});

test('balances net to zero and settlements reduce debt', () => {
  const expenses = [
    { paidBy: 1, extra: 0, items: [{ price: 3000, shares: [1, 2, 3] }] },
    { paidBy: 2, extra: 0, items: [{ price: 900, shares: [2, 3] }] },
  ];
  let bal = computeBalances([1, 2, 3], expenses, []);
  assert.strictEqual(sum(bal), 0);
  assert.deepStrictEqual(bal, { 1: 2000, 2: -550, 3: -1450 });
  const pays = simplifyDebts(bal);
  assert.strictEqual(pays.length, 2);
  bal = computeBalances([1, 2, 3], expenses, [{ from: 2, to: 1, amount: 550 }]);
  assert.strictEqual(bal[2], 0);
});

test('simplifyDebts settles everyone to zero', () => {
  const bal = { 1: 5000, 2: -2000, 3: -1500, 4: -1500 };
  const pays = simplifyDebts(bal);
  const after = { ...bal };
  pays.forEach((p) => { after[p.from] += p.amount; after[p.to] -= p.amount; });
  assert.deepStrictEqual(Object.values(after).every((v) => v === 0), true);
});

// ---------- API integration ----------
test('API end to end', async (t) => {
  const app = require('../server');
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async (method, url, body) => {
      const res = await fetch(base + url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json().catch(() => ({})) };
    };
  }

  const alice = client();
  const bob = client();
  const stranger = client();

  // unauthenticated access is blocked
  assert.strictEqual((await alice('GET', '/api/groups')).status, 401);

  // validation
  assert.strictEqual((await alice('POST', '/api/register', { name: 'A', email: 'bad', password: 'password1' })).status, 400);
  assert.strictEqual((await alice('POST', '/api/register', { name: 'A', email: 'a@x.com', password: 'short' })).status, 400);

  // Alice adds Bob by email BEFORE Bob has an account
  assert.strictEqual((await alice('POST', '/api/register', { name: 'Alice', email: 'alice@example.com', password: 'password1' })).status, 200);
  const g = await alice('POST', '/api/groups', {
    name: 'Trip', currency: '$',
    members: [{ name: 'Bob', email: 'bob@example.com' }, { name: 'Cara' }],
  });
  assert.strictEqual(g.status, 200);
  const gid = g.body.id;

  // duplicate email rejected, wrong password rejected
  assert.strictEqual((await bob('POST', '/api/register', { name: 'Bob', email: 'alice@example.com', password: 'password1' })).status, 409);
  assert.strictEqual((await bob('POST', '/api/login', { email: 'alice@example.com', password: 'wrongpass' })).status, 401);

  // Bob registers later and automatically sees the group
  assert.strictEqual((await bob('POST', '/api/register', { name: 'Bob', email: 'bob@example.com', password: 'password1' })).status, 200);
  const bobGroups = await bob('GET', '/api/groups');
  assert.strictEqual(bobGroups.body.groups.length, 1);

  // a stranger cannot see the group
  await stranger('POST', '/api/register', { name: 'Eve', email: 'eve@example.com', password: 'password1' });
  assert.strictEqual((await stranger('GET', `/api/groups/${gid}`)).status, 404);
  assert.strictEqual((await stranger('POST', `/api/groups/${gid}/expenses`, {})).status, 404);

  let data = (await alice('GET', `/api/groups/${gid}`)).body;
  const [A, B, C] = data.members.map((m) => m.id);

  // bad expense payloads
  const base0 = { title: 'Dinner', paidBy: A };
  assert.strictEqual((await alice('POST', `/api/groups/${gid}/expenses`, { ...base0, items: [] })).status, 400);
  assert.strictEqual((await alice('POST', `/api/groups/${gid}/expenses`, { ...base0, items: [{ name: 'x', price: -5, shares: [A] }] })).status, 400);
  assert.strictEqual((await alice('POST', `/api/groups/${gid}/expenses`, { ...base0, items: [{ name: 'x', price: 5, shares: [] }] })).status, 400);
  assert.strictEqual((await alice('POST', `/api/groups/${gid}/expenses`, { ...base0, items: [{ name: 'x', price: 5, shares: [99999] }] })).status, 400);

  // Dinner: pizza 30 (A,B,C), beer 12 (A,B), salad 8 (C). Alice paid.
  const ok = await alice('POST', `/api/groups/${gid}/expenses`, {
    title: 'Dinner', paidBy: A,
    items: [
      { name: 'Pizza', price: '30.00', shares: [A, B, C] },
      { name: 'Beer', price: 12, shares: [A, B] },
      { name: 'Salad', price: 8, shares: [C] },
    ],
  });
  assert.strictEqual(ok.status, 200);

  data = (await bob('GET', `/api/groups/${gid}`)).body;
  assert.strictEqual(data.expenses.length, 1);
  assert.strictEqual(data.expenses[0].total, 5000);
  assert.strictEqual(data.balances[A], 3400); // paid 5000, owes 1600
  assert.strictEqual(data.balances[B], -1600);
  assert.strictEqual(data.balances[C], -1800);
  assert.strictEqual(data.suggested.length, 2);

  // Bob settles his share
  const pay = await bob('POST', `/api/groups/${gid}/settlements`, { from: B, to: A, amount: 16 });
  assert.strictEqual(pay.status, 200);
  data = (await alice('GET', `/api/groups/${gid}`)).body;
  assert.strictEqual(data.balances[B], 0);
  assert.strictEqual(data.balances[A], 1800);

  // groups list shows Alice's balance
  const list = (await alice('GET', '/api/groups')).body.groups[0];
  assert.strictEqual(list.myBalance, 1800);
  assert.strictEqual(list.memberCount, 3);

  // list endpoint carries the totals the phone interface shows
  assert.strictEqual(list.expenseCount, 1);
  assert.strictEqual(list.totalSpent, 5000);
  assert.strictEqual(list.paymentsLeft, 1);

  // optional expense date: valid dates are kept, impossible ones rejected
  const dated = await alice('POST', `/api/groups/${gid}/expenses`, {
    title: 'Internet', paidBy: A, date: '2026-10-01', items: [{ name: 'Plan', price: 60, shares: [A, B] }],
  });
  assert.strictEqual(dated.status, 200);
  assert.strictEqual((await alice('POST', `/api/groups/${gid}/expenses`, {
    title: 'Bad', paidBy: A, date: '2026-02-31', items: [{ name: 'x', price: 1, shares: [A] }],
  })).status, 400);
  data = (await alice('GET', `/api/groups/${gid}`)).body;
  assert.strictEqual(data.expenses.find((e) => e.title === 'Internet').createdAt.slice(0, 10), '2026-10-01');
  assert.strictEqual((await alice('DELETE', `/api/groups/${gid}/expenses/${dated.body.id}`)).status, 200);

  // removing people: not while they are in expenses, fine for a new person, never below two
  assert.strictEqual((await alice('DELETE', `/api/groups/${gid}/members/${C}`)).status, 400);
  const dave = await alice('POST', `/api/groups/${gid}/members`, { name: 'Dave' });
  assert.strictEqual((await alice('DELETE', `/api/groups/${gid}/members/${dave.body.id}`)).status, 200);
  assert.strictEqual((await stranger('DELETE', `/api/groups/${gid}/members/${C}`)).status, 404);

  // the app shell and cache headers a phone install depends on
  const sw = await fetch(`${base}/sw.js`);
  assert.strictEqual(sw.status, 200);
  assert.match(sw.headers.get('cache-control') || '', /no-cache/);
  const manifest = await fetch(`${base}/manifest.webmanifest`);
  assert.strictEqual(manifest.status, 200);
  assert.strictEqual((await manifest.json()).short_name, 'bills36');
  const icon = await fetch(`${base}/icons/icon-512.png`);
  assert.strictEqual(icon.status, 200);
  assert.strictEqual(icon.headers.get('content-type'), 'image/png');
  const apiRes = await fetch(`${base}/api/me`);
  assert.strictEqual(apiRes.headers.get('cache-control'), 'no-store');

  // delete expense and settlement (re-read first: the dated expense above was already removed)
  data = (await alice('GET', `/api/groups/${gid}`)).body;
  assert.strictEqual(data.expenses.length, 1);
  assert.strictEqual((await alice('DELETE', `/api/groups/${gid}/expenses/${data.expenses[0].id}`)).status, 200);
  assert.strictEqual((await alice('DELETE', `/api/groups/${gid}/settlements/${data.settlements[0].id}`)).status, 200);
  data = (await alice('GET', `/api/groups/${gid}`)).body;
  assert.strictEqual(data.expenses.length, 0);
  assert.ok(Object.values(data.balances).every((v) => v === 0));

  // only the owner can delete the group
  assert.strictEqual((await bob('DELETE', `/api/groups/${gid}`)).status, 403);
  assert.strictEqual((await alice('DELETE', `/api/groups/${gid}`)).status, 200);

  // logout invalidates the session
  assert.strictEqual((await alice('POST', '/api/logout')).status, 200);
  assert.strictEqual((await alice('GET', '/api/me')).status, 401);
});
