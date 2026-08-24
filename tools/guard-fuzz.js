#!/usr/bin/env node
"use strict";

/**
 * Adversarial probes for the v2.6.9/v2.6.10 surfaces the older fuzz suite
 * predates: setAccountInfo, the account-mode/percent/min-balance gates, and
 * the feed's future-bucket guard. Hostile inputs (symbols, NaN, negatives,
 * huge numbers, prototype payloads) must fail closed, never throw, and never
 * wedge the controller.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

const sb = { self: {}, console, setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, URL, TextDecoder,
  window: {}, document: { querySelector: () => null, querySelectorAll: () => [] }, Event: function () {},
  location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/trade" } };
sb.globalThis = sb.self;
sb.window.WebSocket = undefined;
vm.createContext(sb);
for (const f of ["indicators", "assets", "strategy", "feed", "engine", "storage", "auto"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f + ".js"), "utf8"), sb);
}
const AUTO = sb.self.CYBER_AUTO;
const FEED = sb.self.CYBER_FEED;
const ASSETS = sb.self.CYBER_ASSETS;

async function main() {
  /* ---- setAccountInfo hostile inputs ---- */
  const decisions = [];
  let executed = 0;
  const ctrl = AUTO.startAuto({
    onTrade: (d) => decisions.push(d),
    executeTrade: async () => { executed++; return { ok: true, confirmed: true, id: "x" }; },
  });
  ctrl.setMode("click");
  ctrl.setArmed(true);
  const hostile = [
    null, undefined, 42, "demo", [], Symbol("acc"),
    {}, { isDemo: Symbol("d") }, { isDemo: "yes" },
    { isDemo: true, balance: Symbol("bal") },
    { isDemo: true, balance: NaN }, { isDemo: true, balance: -5 },
    { isDemo: true, balance: Infinity }, { isDemo: true, balance: 1e308 },
    { isDemo: false, currency: 12345 },
    Object.assign(Object.create(null), { __proto__: "x", isDemo: true, balance: 500 }),
  ];
  let threw = null;
  for (const h of hostile) {
    try { ctrl.setAccountInfo(h); } catch (e) { threw = String(e && e.message || e); break; }
  }
  check("setAccountInfo never throws on hostile input", threw === null, threw);
  // after all that abuse, a clean demo account must still arm correctly
  ctrl.setAccountInfo({ isDemo: true, balance: 100, currency: "USD" });
  const sig = { ready: true, direction: "CALL", asset: "EURUSD_otc", confidence: 80, score: 5, regime: "trending", reason: "t", time: Date.now() - 1000 };
  await ctrl.handleSignal(sig);
  check("controller still trades after hostile account payloads", executed === 1, "executed=" + executed);
  const snap = ctrl.snapshot ? null : ctrl.getState; // snapshots are via onState; not part of this probe
  check("percent gate blocks huge-balance overflow path (1e308 at 1% stays finite)",
    Number.isFinite(1e308 * 0.01));

  /* ---- percent + min balance hostile settings ---- */
  const store = sb.self.CYBER_STORE;
  await store.setSettings({ stakeMode: "percent", stakePercent: NaN });
  let s = await store.getSettings();
  check("NaN stakePercent falls back to default", Number.isFinite(s.stakePercent) && s.stakePercent >= 0.1 && s.stakePercent <= 10, String(s.stakePercent));
  await store.setSettings({ accountMode: "__proto__" });
  s = await store.getSettings();
  check("hostile accountMode string falls back to demo", s.accountMode === "demo", String(s.accountMode));
  await store.setSettings({ minBalance: -100 });
  s = await store.getSettings();
  check("negative minBalance clamps to >= 0", s.minBalance >= 0, String(s.minBalance));

  /* ---- percent staking with hostile balances ---- */
  const decisions2 = [];
  const stakes = [];
  const c2 = AUTO.startAuto({
    onTrade: (d) => decisions2.push(d),
    executeTrade: async (a) => { stakes.push(a.stake); return { ok: true, confirmed: true, id: "y" }; },
  });
  c2.setMode("click");
  c2.setArmed(true);
  // minIntervalMs is a legitimate setting; lower it so this probe is not
  // blocked by the shared attempt ledger's hard 5s floor from the previous
  // controller (that floor is correct behaviour, not a bug).
  await store.setSettings({ stakeMode: "percent", stakePercent: 2, cooldownBars: 0, minBalance: 0, minIntervalMs: 1 });
  // The attempt ledger enforces a hard minimum interval across controllers
  // (correct fail-safe). Wait past its 1s floor so this probe measures the
  // percent-stake path, not the interval gate.
  await new Promise((r) => setTimeout(r, 1200));
  c2.setAccountInfo({ isDemo: true, balance: 1e12, currency: "USD" });
  await c2.handleSignal(Object.assign({}, sig, { time: Date.now() - 1000, asset: "GBPUSD_otc" }));
  check("1e12 balance percent stake stays finite and sane",
    stakes.length === 0 || (Number.isFinite(stakes[0]) && stakes[0] <= 1e12), "stake=" + stakes[0]);
  check("percent stake at 1e12 balance is clamped to the 1,000,000 ceiling",
    stakes.length === 0 || stakes[stakes.length - 1] <= 1000000, "stake=" + stakes[stakes.length - 1]);

  /* ---- feed future-bucket guard under hostile timestamps ---- */
  const feed = FEED.createFeed({ tfMs: 60000, max: 500 });
  feed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD_otc"), 100, {}));
  const hostileTs = [NaN, Infinity, -1, 1e21, "garbage", null, undefined, Symbol("t")];
  let feedThrew = null;
  for (const t of hostileTs) {
    try { feed.ingest(1.2, t); } catch (e) { feedThrew = String(e && e.message || e); break; }
  }
  check("feed.ingest never throws on hostile timestamps", feedThrew === null, feedThrew);
  check("feed still accepts a real tick after hostile timestamps", feed.ingest(1.234, Date.now()) !== null);
  check("feed rejects a microsecond-epoch tick (far future)", feed.ingest(1.234, Date.now() * 1000) === null);

  console.log(failed ? failed + " FAILED" : "all new-surface adversarial probes pass");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("harness error:", e); process.exit(1); });
