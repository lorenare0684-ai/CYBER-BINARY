#!/usr/bin/env node
"use strict";

/**
 * High-Accuracy 80+ verification.
 *
 * Two modes:
 *
 *   node tools/accuracy.js
 *     Deterministic SIMULATOR verification (default). Proves the engine's
 *     gated behaviour: coverage, >=80% WR floor, suppression-only gates,
 *     live-path gate reasons. The numbers pin ENGINE behaviour, not markets.
 *
 *   node tools/accuracy.js --candles cyber-binary-candles-….json [--horizon 8]
 *     REAL-DATA report. Re-runs the identical gated-vs-ungated comparison on
 *     real Quotex 1m candles exported from the dashboard ("Export live
 *     candles"). Real candles are used exclusively — no synthetic padding —
 *     so the printed win rates are whatever the real data says. Nothing is
 *     asserted about the win rate itself: only engine-integrity checks
 *     (gates suppress, never flip) can fail. Interpret with the payout
 *     breakeven line the report prints.
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

const sandbox = { self: {}, console, setTimeout: (f) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, URL, TextDecoder,
  window: {}, document: { querySelector: () => null, querySelectorAll: () => [] }, Event: function () {},
  location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/trade" } };
sandbox.globalThis = sandbox.self;
sandbox.window.WebSocket = undefined;
vm.createContext(sandbox);
for (const f of ["indicators", "assets", "strategy", "feed", "engine", "backtest"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f + ".js"), "utf8"), sandbox);
}
const HIST = sandbox.self.CYBER_HIST;
const ASSETS = sandbox.self.CYBER_ASSETS;
const ENGINE = sandbox.self.CYBER_ENGINE;
const FEED = sandbox.self.CYBER_FEED;
const STRAT = sandbox.self.CYBER_STRATEGIES;

// 0) preset registered and carries its gates
function syntheticVerification() {
const preset = STRAT.get("high_accuracy");
check("high_accuracy preset registered", !!preset && preset.label.indexOf("High-Accuracy") === 0);
check("preset gates are regime+trend and 90+ confidence",
  Array.isArray(preset.params.regimeFilter) && preset.params.regimeFilter.join(",") === "trending" &&
  preset.params.minConfidence === 90);

// 1+2) full-catalog gated backtest at the recommended 8m expiry
const HORIZON = 8;
const matrix = HIST.runMatrix({ days: 1, strategies: ["high_accuracy"], horizon: HORIZON, minBars: 200 });
let wins = 0, losses = 0;
const withTrades = new Set();
for (const r of matrix.results) {
  wins += r.wins; losses += r.losses;
  if (r.total > 0) withTrades.add(r.asset);
}
const total = wins + losses;
const winrate = total ? (wins / total) * 100 : 0;
check("full-catalog coverage (every asset has rows)", matrix.count === ASSETS.list().length,
  matrix.count + "/" + ASSETS.list().length);
check("assets producing trades", withTrades.size >= 170, String(withTrades.size));
check("trade sample is large enough to be meaningful", total >= 20000, String(total));
check("aggregate win rate clears 80%", winrate >= 80, winrate.toFixed(2) + "%");

// 3) gates only suppress: an ungated twin fires strictly more on the same series
const sample = ["EURUSD_otc", "XAUUSD_otc", "BTCUSD_otc"];
let gatedFired = 0, twinFired = 0;
for (const id of sample) {
  const s = FEED.syntheticSeries(ASSETS.get(id), 1440, { seed: 7 });
  const gated = ENGINE.backtest(s, { strategy: "high_accuracy", horizon: HORIZON, minConf: 0 });
  const twin = ENGINE.backtest(s, { strategy: "high_accuracy", horizon: HORIZON, minConf: 0,
    params: { regimeFilter: [], minConfidence: 0 } });
  gatedFired += gated.total;
  twinFired += twin.total;
  check("gated rate beats ungated twin on " + id,
    gated.winrate > twin.winrate && gated.total < twin.total,
    gated.winrate.toFixed(1) + "%/" + gated.total + " vs " + twin.winrate.toFixed(1) + "%/" + twin.total);
}
check("gates suppress signals (never add)", gatedFired < twinFired, gatedFired + " vs " + twinFired);

// 4) plain scalp (same params, no gates) stays below the gated rate
let scalpW = 0, scalpL = 0, gatedW = 0, gatedL = 0;
for (const id of sample) {
  const s = FEED.syntheticSeries(ASSETS.get(id), 1440, { seed: 7 });
  const scalp = ENGINE.backtest(s, { strategy: "scalp", horizon: HORIZON, minConf: 0 });
  const gated = ENGINE.backtest(s, { strategy: "high_accuracy", horizon: HORIZON, minConf: 0 });
  scalpW += scalp.wins; scalpL += scalp.losses;
  gatedW += gated.wins; gatedL += gated.losses;
}
const scalpWR = (scalpW / (scalpW + scalpL)) * 100;
const gatedWR = (gatedW / (gatedW + gatedL)) * 100;
check("ungated scalp is materially below the gated rate", scalpWR < 85 && gatedWR > scalpWR + 5,
  "scalp " + scalpWR.toFixed(1) + "% vs gated " + gatedWR.toFixed(1) + "%");

// 5) live-path gate: suppressed signals report WAIT with the gate reason
const s = FEED.syntheticSeries(ASSETS.get("EURUSD_otc"), 1440, { seed: 7 });
let gateReasonSeen = false, gatedSignalLeaked = false;
for (let i = 200; i < 1440; i += 7) {
  const sig = ENGINE.analyze(s.slice(0, i + 1), { strategy: "high_accuracy", lean: false });
  if (/Regime gate|Confidence gate/.test(sig.reason || "")) gateReasonSeen = true;
  const twin = ENGINE.analyze(s.slice(0, i + 1), { strategy: "high_accuracy", lean: false,
    params: { regimeFilter: [], minConfidence: 0 } });
  // where the gated signal is WAIT-by-gate, the twin may fire — but the gated
  // engine must never emit a direction the gate should have blocked
  if (sig.direction !== "WAIT" && !twin.ready) gatedSignalLeaked = true;
}
check("live path surfaces gate reasons", gateReasonSeen);
check("live path never fabricates signals", !gatedSignalLeaked);

console.log(failed ? "\n" + failed + " ACCURACY FAILURE(S)" : "\nhigh-accuracy preset: " + winrate.toFixed(2) + "% WR over " + total + " full-catalog SIMULATED trades — all checks pass");
}

/**
 * REAL-DATA mode: identical gated-vs-ungated comparison on exported real
 * Quotex candles. Live-only series (no synthetic padding). Reports win
 * rates as measured; asserts only engine integrity.
 */
function realDataReport(file, horizon) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(path.resolve(file), "utf8")); }
  catch (e) { console.error("FAIL candle file unreadable: " + e.message); process.exit(1); }
  const rawCandles = parsed && typeof parsed === "object"
    ? (parsed.candles && typeof parsed.candles === "object" ? parsed.candles : parsed)
    : null;
  if (!rawCandles || typeof rawCandles !== "object" || Array.isArray(rawCandles)) {
    console.error("FAIL candle file must be an object of assetId -> bar array (dashboard export shape)");
    process.exit(1);
  }
  const cachedByAsset = Object.create(null);
  let totalBars = 0;
  for (const id of Object.keys(rawCandles).slice(0, 256)) {
    const rows = rawCandles[id];
    if (!Array.isArray(rows) || rows.length < 60) continue; // engine needs >=40 usable bars + horizon
    cachedByAsset[id] = rows;
    totalBars += rows.length;
  }
  const assetIds = Object.keys(cachedByAsset);
  if (!assetIds.length) {
    console.error("FAIL no asset in the file has >= 60 candles — let the extension collect more live data first");
    process.exit(1);
  }
  console.log("real candle cache: " + assetIds.length + " assets, " + totalBars + " bars, horizon " + horizon + "m, live-only (no synthetic data)");
  if (parsed && parsed.exportedAt) console.log("exported: " + parsed.exportedAt);

  const rows = [];
  let gW = 0, gL = 0, uW = 0, uL = 0;
  for (const id of assetIds) {
    const asset = ASSETS.get(id) || ASSETS.ensureRegistered(id) || { id, basePrice: 1, vol: 0.0001 };
    const series = HIST.getSeries(asset, { days: 31, cachedByAsset, liveOnly: true });
    if (series.length < 60) continue;
    const gated = ENGINE.backtest(series, { strategy: "high_accuracy", horizon, minConf: 0 });
    const twin = ENGINE.backtest(series, { strategy: "high_accuracy", horizon, minConf: 0,
      params: { regimeFilter: [], minConfidence: 0 } });
    gW += gated.wins; gL += gated.losses;
    uW += twin.wins; uL += twin.losses;
    rows.push({ id, bars: series.length, gn: gated.total, gwr: gated.winrate, un: twin.total, uwr: twin.winrate });
  }
  console.log("\nasset                 bars   gated(n/WR)        ungated(n/WR)");
  for (const r of rows) {
    console.log(r.id.padEnd(20) + String(r.bars).padStart(6) +
      "   " + (r.gn + " / " + (r.gn ? r.gwr.toFixed(1) : "—") + "%").padEnd(16) +
      "  " + (r.un + " / " + (r.un ? r.uwr.toFixed(1) : "—") + "%"));
  }
  const gn = gW + gL, un = uW + uL;
  const gwr = gn ? (gW / gn) * 100 : 0;
  const uwr = un ? (uW / un) * 100 : 0;
  console.log("\nAGGREGATE  gated:     " + gn + " trades  " + gwr.toFixed(2) + "% WR");
  console.log("AGGREGATE  ungated:   " + un + " trades  " + uwr.toFixed(2) + "% WR");
  // Engine-integrity checks that must hold on ANY data.
  check("gates suppress on real data (gated trades <= ungated)", gn <= un, gn + " vs " + un);
  let monotone = true;
  for (const r of rows) if (r.gn > r.un) monotone = false;
  check("gates never add trades on any single asset", monotone);

  console.log("\ninterpretation:");
  console.log("  - payout 85% breakeven = 54.05% WR · payout 80% = 55.56% · payout 92% = 52.08%");
  console.log("  - this is measured on " + gn + " real trades (" + totalBars + " real bars); past real data still does not guarantee future results");
  console.log("  - gated sample is smaller by design — selectivity trades frequency for quality");
  process.exit(failed ? 1 : 0);
}

// ---- dispatch ----
const argv = process.argv.slice(2);
let candleFile = "";
let horizon = 8;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--candles" && argv[i + 1]) candleFile = argv[++i];
  else if (argv[i] === "--horizon" && argv[i + 1]) {
    const n = Math.floor(Number(argv[i + 1]));
    if (Number.isFinite(n) && n >= 1 && n <= 1440) horizon = n; else i++;
  }
}
if (candleFile) realDataReport(candleFile, horizon);
else syntheticVerification();

if (failed) { console.error("\n" + failed + " ACCURACY FAILURE(S)"); process.exit(1); }
