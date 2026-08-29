#!/usr/bin/env node
"use strict";

/**
 * Dashboard fitness-meter regression test for the Auto-Adaptive cockpit.
 *
 * The user reported: "auto adaptive strategy system me har strategy ka
 * confluence 100 nahi to sab equal" — every strategy's fitness meter read
 * 100/100 (or all tied) so the card could not differentiate a marginal
 * confluence call from an overwhelming one, and the "which strategy won"
 * tiebreak was effectively random.
 *
 * Root cause: the display clamped `Math.min(100, rawScore*8 + confidence*0.3
 * + regimeBonus + signalBonus + winrateBonus)` and the weighted vote sum
 * routinely exceeded 15, so `*8` already saturated at 100 for every strategy
 * that fired on the bar. The raw score is still unbounded for *selecting*
 * the winning strategy, but the number we render is now normalised through
 * a saturating map so the strongest candidate stays first while clearly
 * separating it from the runners-up.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

const chromeStub = {
  runtime: {
    id: "test",
    getURL: (p) => p,
    sendMessage: () => Promise.resolve({ ok: true }),
    onMessage: { addListener: () => {} },
    lastError: null,
  },
  storage: {
    local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() },
  },
};

const sandbox = {
  self: {},
  console,
  Date,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  chrome: chromeStub,
  location: { hostname: "qxbroker.com", pathname: "/trade" },
  navigator: { userAgent: "node" },
  Uint8Array, ArrayBuffer, Uint16Array, Uint32Array, DataView,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

const files = [
  "indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js",
  "asset-selector.js", "storage.js", "auto.js", "backtest.js", "quotex.js",
];
for (const f of files) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}

let failed = 0;
function check(name, cond, extra) {
  if (!cond) {
    console.error("FAIL " + name + (extra ? " — " + extra : ""));
    failed++;
  } else {
    console.log("ok   " + name);
  }
}

const ASSETS = sandbox.self.CYBER_ASSETS;
const FEED = sandbox.self.CYBER_FEED;
const ENG = sandbox.self.CYBER_ENGINE;

const asset = ASSETS.get("EURUSD_otc") || ASSETS.get("EURUSD");
const candles = FEED.syntheticSeries(asset, 200, { seed: 42, drift: 0.001 });
const base = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false });

const scores = base.strategyScores || {};
const fitnessVals = Object.values(scores).map((s) => Number(s.fitness) || 0);
const maxFit = Math.max(...fitnessVals);
const minFit = Math.min(...fitnessVals);

check("adaptive result carries a strategyScores map", Object.keys(scores).length >= 11);
check("fitness scores are bounded to 0-100",
  fitnessVals.every((v) => v >= 0 && v <= 100), "range=" + minFit + ".." + maxFit);

// The key regression: the top candidate must be clearly above the runners-up,
// not clamped to a wall of 100s (and not all equal).
const sorted = [...fitnessVals].sort((a, b) => b - a);
const top = sorted[0];
const midpoint = sorted[Math.floor(sorted.length / 2)];
check("fitness values are differentiated (not all 100)",
  fitnessVals.filter((v) => v >= 100).length < Math.max(1, fitnessVals.length - 1) &&
  new Set(fitnessVals).size > 1,
  "distinct=" + new Set(fitnessVals).size + "/" + fitnessVals.length);
check("top fitness is strictly above the median",
  top > midpoint, "top=" + top + " median=" + midpoint);

// The selected strategy must be the highest-scoring candidate.
check("selected strategy carries the max fitness",
  (scores[base.selectedStrategy] && scores[base.selectedStrategy].fitness) === top,
  "selected=" + base.selectedStrategy + " fit=" +
    (scores[base.selectedStrategy] && scores[base.selectedStrategy].fitness));

// Confidence must be present and non-zero whenever a real direction fires.
const fired = Object.keys(scores).filter(
  (id) => scores[id].direction === "CALL" || scores[id].direction === "PUT");
if (fired.length) {
  const allHaveConf = fired.every((id) => Number(scores[id].confidence) > 0);
  check("firing candidates report a real confidence", allHaveConf,
    "fired=" + fired.map((id) => id + ":" + scores[id].confidence).join(","));
} else {
  console.log("ok   (no firing candidate on this bar — nothing to assert for confidence)");
}

// The overall signal, if it fired, must carry a non-zero confidence too.
if (base.direction === "CALL" || base.direction === "PUT") {
  check("signal direction has a real confidence", Number(base.confidence) > 0,
    "dir=" + base.direction + " conf=" + base.confidence);
}

console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nDashboard fitness display checks passed!");
process.exit(failed ? 1 : 0);
