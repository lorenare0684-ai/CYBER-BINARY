#!/usr/bin/env node
"use strict";

/**
 * Auto-adaptive router + asset-selector regressions (v2.6.8).
 *
 * 1. Adaptive regime sit-out: choppy/squeeze regimes (measured 48-53% WR,
 *    below the 54.05% breakeven at 85% payout) must hold WAIT.
 * 2. Adaptive still trades genuine trends.
 * 3. Evidence-based ranking: a measured (even weak) asset outranks any
 *    prior-only asset; unevidenced assets are never "recommended".
 * 4. getBestAsset never returns a closed market.
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
vm.createContext(sandbox);
for (const f of ["indicators", "assets", "strategy", "feed", "engine", "asset-selector"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f + ".js"), "utf8"), sandbox);
}
const ENG = sandbox.self.CYBER_ENGINE;
const AS = sandbox.self.CYBER_ASSET_SELECTOR;

let a = 7;
const rnd = () => { a = (a * 16807) % 2147483647; return (a & 1023) / 1023; };
const t0 = Date.UTC(2025, 0, 1);
function build(n, step, wick) {
  wick = wick == null ? 0.0002 : wick;
  const out = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    const c = p * (1 + step());
    out.push({ time: t0 + i * 60000, open: p, close: c, high: Math.max(p, c) * (1 + wick), low: Math.min(p, c) * (1 - wick) });
    p = c;
  }
  return out;
}

const hostile = ENG.analyze(build(600, () => (rnd() - 0.5) * 0.006, 0.004), { strategy: "auto_adaptive" });
check("adaptive detects a hostile regime", hostile.regime === "choppy" || hostile.regime === "squeeze", hostile.regime);
check("adaptive sits out choppy/squeeze (WAIT)", hostile.direction === "WAIT", hostile.reason);
check("sit-out carries an honest reason", /sit-out/i.test(hostile.reason), hostile.reason);

const flat = ENG.analyze(build(600, () => (rnd() - 0.5) * 0.00001), { strategy: "auto_adaptive" });
check("flat/quiet series is also held out or WAIT", flat.regime === "squeeze" ? flat.direction === "WAIT" : true, flat.regime + " " + flat.direction);

const trend = ENG.analyze(build(600, () => 0.0009 + (rnd() - 0.5) * 0.0004), { strategy: "auto_adaptive" });
check("genuine trend still trades", trend.direction === "CALL" || trend.direction === "PUT", trend.regime + " " + trend.direction + " " + trend.reason);
check("adaptive can select the gated high_accuracy preset", Object.prototype.hasOwnProperty.call(trend.strategyScores || {}, "high_accuracy"));

const stats = { byAsset: { EURUSD_otc: { w: 11, l: 9 } } }; // weak but MEASURED (55%)
const ranked = AS.rankAssets({ stats, candlesByAsset: {} });
const evidenced = ranked.find((r) => r.id === "EURUSD_otc");
const unevidenced = ranked.find((r) => !r.hasEvidence);
check("evidenced asset outranks every unevidenced asset", evidenced && (!unevidenced || ranked.indexOf(evidenced) < ranked.indexOf(unevidenced)));
check("unevidenced asset is never recommended", !unevidenced || unevidenced.recommended === false);
check("evidenced asset exposes dataConfidence > 0", evidenced && evidenced.dataConfidence > 0 && evidenced.hasEvidence === true);

const closedBest = AS.getBestAsset({ stats, assets: [{ id: "ZZZ_closed_test", isOpen: false, basePrice: 1 }, { id: "EURUSD_otc" }], candlesByAsset: {} });
check("getBestAsset never returns a closed market", closedBest && closedBest.id !== "ZZZ_closed_test", closedBest && closedBest.id);
const forcedClosed = AS.getBestAsset({ assets: [{ id: "ZZZ_closed_test", isOpen: false, basePrice: 1 }], includeClosed: true, candlesByAsset: {} });
check("includeClosed override still works", !forcedClosed || forcedClosed.id === "ZZZ_closed_test");

console.log(failed ? failed + " FAILED" : "all adaptive/selector regressions pass");
process.exit(failed ? 1 : 0);
