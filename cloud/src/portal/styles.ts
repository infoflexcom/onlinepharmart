/**
 * The portal's stylesheet. Navy #1F3F73, gold #C9A24B, off-white #FBF9F4 — the same three colours as the
 * desktop and the phone app, so the vendor's tooling looks like the product it sells.
 *
 * One embedded stylesheet keeps the portal a single deployable file set and lets the pages render before any
 * request for an asset. It is mobile-first: the licence list becomes cards on a narrow screen because the
 * brief requires the vendor to renew a licence from a phone.
 */
export const PORTAL_CSS = String.raw`
:root {
  --navy: #1f3f73;
  --navy-deep: #16305a;
  --navy-soft: #e8edf6;
  --gold: #c9a24b;
  --gold-soft: #f6edda;
  --offwhite: #fbf9f4;
  --ink: #1b2b42;
  --muted: #66788f;
  --line: #dfe5ee;
  --ok: #1f7a4d;
  --warn: #a4741a;
  --bad: #ab4438;
  --radius: 12px;
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--offwhite);
  color: var(--ink);
  font-size: 16px;
  line-height: 1.5;
  -webkit-text-size-adjust: 100%;
}
a { color: var(--navy); }
h1, h2, h3 { font-family: 'Manrope', 'DM Sans', system-ui, sans-serif; letter-spacing: -0.02em; }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.125rem; margin: 0 0 .75rem; }
h3 { font-size: 1rem; margin: 0 0 .5rem; }
p { margin: .4rem 0; }
small, .small { font-size: .8rem; color: var(--muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }

/* ---------------------------------------------------------------- brand */
.brandbar {
  display: flex; align-items: center; gap: .7rem;
  padding: .7rem 1rem; background: var(--navy); color: #fff;
}
.brandbar img { height: 30px; width: auto; display: block; }
.brandbar .tag { font-size: .62rem; letter-spacing: .16em; text-transform: uppercase; color: var(--gold); }
.brandbar .spacer { flex: 1; }
.brandbar a, .brandbar button { color: #fff; }
@media (min-width: 760px) { .brandbar img { height: 38px; } .brandbar .tag { font-size: .7rem; } }

/* ---------------------------------------------------------------- sign-in */
.auth-shell { min-height: 100dvh; display: grid; place-items: center; padding: 1rem; background: linear-gradient(160deg, var(--navy-deep), #0f2344 60%, #1b3459); }
.auth-card { width: min(100%, 420px); background: #fff; border-radius: 18px; padding: 1.5rem; box-shadow: 0 24px 60px rgba(6, 16, 32, .45); }
.auth-card .logo { display: block; margin: 0 auto .9rem; width: 190px; max-width: 70%; }
.auth-card h1 { text-align: center; font-size: 1.35rem; }
.auth-card > p { text-align: center; color: var(--muted); font-size: .9rem; margin-bottom: 1.2rem; }

/* ---------------------------------------------------------------- forms */
label.field { display: block; margin-bottom: .85rem; }
label.field > span { display: block; font-size: .78rem; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; color: var(--muted); margin-bottom: .3rem; }
input[type=text], input[type=email], input[type=password], input[type=search], input[type=date], input[type=number], input[type=tel], select, textarea {
  width: 100%; min-height: 46px; padding: .6rem .7rem; border: 1px solid var(--line);
  border-radius: 10px; background: #fff; color: var(--ink); font-size: 1rem; font-family: inherit;
}
input:focus, select:focus, textarea:focus { outline: 2px solid var(--navy); outline-offset: 1px; border-color: var(--navy); }
textarea { min-height: 84px; resize: vertical; }
input[type=checkbox] { width: 22px; height: 22px; accent-color: var(--navy); vertical-align: middle; }
.check { display: flex; align-items: flex-start; gap: .6rem; margin-bottom: .85rem; font-size: .92rem; }
.check > span { padding-top: .15rem; }
button, .button {
  display: inline-flex; align-items: center; justify-content: center; gap: .4rem;
  min-height: 44px; padding: 0 1rem; border-radius: 10px; border: 1px solid var(--line);
  background: #fff; color: var(--navy); font: inherit; font-weight: 700; cursor: pointer; text-decoration: none;
}
button:hover, .button:hover { border-color: var(--navy); }
button.primary { background: var(--navy); border-color: var(--navy); color: #fff; }
button.primary:hover { background: var(--navy-deep); }
button.gold { background: var(--gold); border-color: var(--gold); color: #2a2109; }
button.danger { background: #fff; border-color: #e7c8c2; color: var(--bad); }
button.link { background: none; border: none; min-height: auto; padding: 0; color: var(--navy); text-decoration: underline; font-weight: 600; }
button:disabled, a.button.disabled { opacity: .55; cursor: not-allowed; }
.button-row { display: flex; flex-wrap: wrap; gap: .5rem; }
.button-row form { display: inline; }

/* ---------------------------------------------------------------- layout */
.shell { max-width: 1180px; margin: 0 auto; padding: 1rem 1rem 3rem; }
.card { background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; margin-bottom: 1rem; }
.card > h2:first-child { margin-top: 0; }
.grid-2 { display: grid; gap: 1rem; }
@media (min-width: 860px) { .grid-2 { grid-template-columns: 1fr 1fr; } }
.grid-3 { display: grid; gap: 1rem; }
@media (min-width: 860px) { .grid-3 { grid-template-columns: repeat(3, 1fr); } }
.nav { display: flex; gap: .3rem; overflow-x: auto; background: #fff; border: 1px solid var(--line); border-radius: var(--radius); padding: .35rem; margin-bottom: 1rem; }
.nav a { flex: 0 0 auto; padding: .55rem .85rem; border-radius: 8px; text-decoration: none; font-weight: 700; font-size: .9rem; color: var(--muted); }
.nav a.active { background: var(--navy); color: #fff; }
.nav a:hover { background: var(--navy-soft); color: var(--navy); }
.nav a.active:hover { background: var(--navy-deep); color: #fff; }

/* ---------------------------------------------------------------- tables */
.table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; padding: .6rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: .72rem; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
tbody tr:hover { background: #fafcff; }
@media (max-width: 720px) {
  table.responsive thead { display: none; }
  table.responsive, table.responsive tbody, table.responsive tr, table.responsive td { display: block; width: 100%; }
  table.responsive tr { border: 1px solid var(--line); border-radius: 10px; padding: .5rem .6rem; margin-bottom: .6rem; background: #fff; }
  table.responsive td { border: 0; padding: .2rem 0; display: flex; gap: .5rem; }
  table.responsive td::before { content: attr(data-label); flex: 0 0 40%; color: var(--muted); font-size: .76rem; text-transform: uppercase; letter-spacing: .04em; }
}

/* ---------------------------------------------------------------- status & notices */
.pill { display: inline-block; padding: .15rem .55rem; border-radius: 999px; font-size: .72rem; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; }
.pill-active { background: #e2f3ea; color: var(--ok); }
.pill-expiring { background: #fdf1d8; color: var(--warn); }
.pill-expired { background: #fdeae7; color: var(--bad); }
.pill-suspended { background: #f1e9f7; color: #67308f; }
.pill-revoked { background: #eceff3; color: #5b6875; }
.pill-onsite { background: var(--gold-soft); color: #7b5f19; }
.pill-online { background: #e2f3ea; color: var(--ok); }
.pill-offline { background: #eceff3; color: #5b6875; }
.notice { border-left: 4px solid var(--gold); background: var(--gold-soft); padding: .7rem .9rem; border-radius: 8px; margin-bottom: 1rem; font-size: .9rem; }
.notice.error { border-color: var(--bad); background: #fdeae7; color: #7d2f26; }
.notice.ok { border-color: var(--ok); background: #e2f3ea; color: #14563a; }
.warn-box { border: 1px solid #ecd9a8; background: #fffaf0; padding: .8rem .9rem; border-radius: 10px; font-size: .88rem; }
.kpi { display: grid; gap: .75rem; grid-template-columns: repeat(2, 1fr); }
@media (min-width: 760px) { .kpi { grid-template-columns: repeat(4, 1fr); } }
.kpi .card { margin: 0; }
.kpi .big { font-size: 1.9rem; font-weight: 800; font-family: 'Manrope', system-ui, sans-serif; color: var(--navy); }
.kpi .label { font-size: .74rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.actions { display: flex; flex-wrap: wrap; gap: .4rem; }
.actions form { margin: 0; }
.actions button { min-height: 36px; padding: 0 .7rem; font-size: .84rem; }
.searchbar { display: flex; gap: .5rem; flex-wrap: wrap; margin-bottom: .8rem; }
.searchbar input { flex: 1 1 200px; }
.tabs { display: flex; gap: .3rem; flex-wrap: wrap; margin-bottom: .8rem; }
.tabs a { padding: .4rem .7rem; border-radius: 999px; border: 1px solid var(--line); text-decoration: none; font-size: .82rem; font-weight: 700; color: var(--muted); background: #fff; }
.tabs a.on { background: var(--navy); border-color: var(--navy); color: #fff; }
.key { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--navy-soft); padding: .15rem .45rem; border-radius: 6px; font-size: .88rem; word-break: break-all; }
.muted { color: var(--muted); }
.right { text-align: right; }
.nowrap { white-space: nowrap; }
.qr { display: block; margin: .6rem auto; width: 180px; height: 180px; image-rendering: pixelated; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
details { border: 1px solid var(--line); border-radius: 10px; padding: .6rem .8rem; margin-bottom: .8rem; background: #fff; }
summary { cursor: pointer; font-weight: 700; }
footer.foot { text-align: center; color: var(--muted); font-size: .78rem; padding: 2rem 1rem 1rem; }
.empty { padding: 2rem 1rem; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: var(--radius); }
`;
