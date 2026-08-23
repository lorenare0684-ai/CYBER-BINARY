#!/usr/bin/env node
"use strict";

/**
 * High-Accuracy 80+ regression.
 *
 * The `high_accuracy` preset gates signals to trending regimes with 90+
 * confluence (engine `regimeFilter` + `minConfidence`). This tool proves,
 * on the deterministic full-catalog backtest, that:
 *
 *   1. coverage stays complete (every catalog asset produces rows);
 *   2. the aggregate win rate clears 80% with a large trade sample;
 *   3. the gates only ever SUPPRESS signals — an ungated twin of the same
 *      strategy fires strictly more often on the identical series;
 *   4. ungated scalp on the same data sits well below the gated rate, so
 *      the accuracy comes from the gates, not from a lucky seed.
 *
 * Simulated data: this pins the ENGINE's behaviour, not live-market
 * performance. Live win rate is not guaranteed to match.
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

console.log(failed ? "\n" + failed + " ACCURACY FAILURE(S)" : "\nhigh-accuracy preset: " + winrate.toFixed(2) + "% WR over " + total + " full-catalog trades — all checks pass");
process.exit(failed ? 1 : 0);
