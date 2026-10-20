# bills36

Split bills item by item with the people you live with. A website that also installs on a phone like an app.
Plain HTML/CSS/JS front end, Node + Express back end, SQLite database.

## Run it on your computer

Requires Node 22.13 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. Set `PORT` to change the port. Data is stored in `data.db` next to the code.

## How splitting works

When you add an expense you enter, for each item:

- the item name
- its price
- which people shared it (tap their names; "Everyone" selects all), with a live count and per-person total

Each item's price is divided equally among only the people who shared it. An optional tax/tip amount is spread across people in proportion to what they ordered. The person who paid is credited the full total. The Balances tab shows who owes whom and the fewest payments needed to settle up. All money is stored as whole cents, so totals never drift.

## Using it on a phone

bills36 is an installable web app (a PWA), so housemates don't need an app store.

- **Android (Chrome):** open the site, tap the menu, then "Install app" (or use the "Add bills36 to your phone" link at the bottom of the page).
- **iPhone (Safari):** open the site, tap Share, then "Add to Home Screen".

Installing needs the site to be served over HTTPS, which any normal host provides. It works on http://localhost for testing.

Once installed it opens full screen with its own icon and follows the phone's light or dark setting. The app itself opens even with no connection, but expenses live on the server, so adding or viewing them needs internet.

Everyone in a group sees the same list. The screen refreshes itself every 20 seconds and whenever the app comes back to the front.

## Put it online

Any host that runs Node works (for example Render, Railway or Fly.io).

- Build command: `npm install`
- Start command: `npm start`
- Environment variables:
  - `NODE_ENV=production` (adds the Secure flag to the login cookie)
  - `TRUST_PROXY=1` (the host puts a proxy in front of the app)
  - `DB_FILE=/data/data.db` (a path on a **persistent disk or volume**)

The database is one SQLite file. On hosts where the disk is wiped on every restart, all groups and expenses are lost unless `DB_FILE` points at a persistent volume. Back that file up occasionally.

A custom address such as bills36.com is a domain you buy from a registrar and point at the host; the host's docs explain how.

## What's in the box

- Sign up and log in (scrypt password hashing, HttpOnly session cookie, login rate limit)
- Groups with named people; add someone's email and the group appears for them when they sign up
- Itemised expenses with an optional date, balances, simplified debts, recorded payments with undo
- Delete expenses, payments, people (when not in any expense) and groups
- Installable app: manifest, icons, offline app shell (service worker), fonts served from the site itself

## Tests

```bash
npm test
```

Fonts (Bricolage Grotesque, DM Sans, IBM Plex Mono) are used under the SIL Open Font License; the licence texts are in `public/fonts`.
