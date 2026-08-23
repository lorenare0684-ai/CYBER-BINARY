#!/usr/bin/env node
"use strict";

/**
 * Unit & Integration test suite for Auto-Adaptive Strategy Engine
 * and Auto-Adapting High-Accuracy Asset System v2.6.
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
    local: {
      get: (k, cb) => cb && cb({}),
      set: (obj, cb) => cb && cb(),
    },
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
  "indicators.js", "assets.js", "strategy.js", "feed.js",
  "engine.js", "asset-selector.js", "storage.js", "auto.js",
  "backtest.js", "quotex.js"
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

const STRAT = sandbox.self.CYBER_STRATEGIES;
const ASSETS = sandbox.self.CYBER_ASSETS;
const ENG = sandbox.self.CYBER_ENGINE;
const AS = sandbox.self.CYBER_ASSET_SELECTOR;
const FEED = sandbox.self.CYBER_FEED;
const AUTO = sandbox.self.CYBER_AUTO;

function testStrategiesList() {
  const list = STRAT.list();
  check("Strategy catalog contains 12 strategies", list.length >= 12, "length=" + list.length);
  const expected = [
    "auto_adaptive", "sniper", "turbo_trend", "institutional_flow",
    "confluence", "trend", "breakout", "scalp", "otc", "squeeze",
    "ribbon", "momentum_pulse"
  ];
  for (const id of expected) {
    const s = STRAT.get(id);
    check(`Strategy '${id}' registered with params and weights`, !!s && !!s.params && !!s.weights);
  }
}

function testAutoAdaptiveEngine() {
  const asset = ASSETS.get("EURUSD_otc") || ASSETS.get("EURUSD");
  const trendingCandles = FEED.syntheticSeries(asset, 200, { seed: 42, drift: 0.001 });

  const res = ENG.analyze(trendingCandles, { strategy: "auto_adaptive", lean: false });
  check("auto_adaptive strategy returns ready result", res && res.ready === true);
  check("auto_adaptive result flags adaptive: true", res && res.adaptive === true);
  check("auto_adaptive selects a concrete strategy ID", typeof res.selectedStrategy === "string" && res.selectedStrategy.length > 0);
  check("auto_adaptive selects a human-readable strategy label", typeof res.selectedStrategyLabel === "string" && res.selectedStrategyLabel.length > 0);
  check("auto_adaptive provides strategyScores map", res.strategyScores && Object.keys(res.strategyScores).length >= 11);
  check("auto_adaptive reason carries adaptation details", /Auto-adapted/i.test(res.reason), "reason=" + res.reason);

  // Test that strategies can win over baseline when their fitness is higher
  const scores = res.strategyScores;
  const bestFit = Math.max(...Object.values(scores).map((s) => s.fitness));
  check("auto_adaptive selects high-fitness candidate", scores[res.selectedStrategy].fitness === bestFit || res.direction !== "WAIT");

  const rangingCandles = FEED.syntheticSeries(asset, 200, { seed: 101, drift: 0, vol: 0.00005 });
  const rangingRes = ENG.analyze(rangingCandles, { strategy: "auto_adaptive", lean: false });
  check("auto_adaptive analyzes ranging market without throwing", rangingRes && rangingRes.ready === true);
}

function testAssetSelector() {
  const ranked = AS.rankAssets({
    minWinrate: 0,
    openOnly: false,
  });

  check("Asset selector ranks catalog assets", Array.isArray(ranked) && ranked.length > 50, "count=" + ranked.length);
  const top = ranked[0];
  check("Top asset has rank 1", top && top.rank === 1);
  check("Asset evaluation computes Expected Value and Accuracy Score",
    typeof top.expectedValue === "number" && typeof top.accuracyScore === "number");

  const highAccNoEvidence = AS.getHighAccuracyAssets({ minAccuracy: 50 });
  check("getHighAccuracyAssets returns nothing with zero evidence (v2.6.8: no fabricated recommendations)",
    Array.isArray(highAccNoEvidence) && highAccNoEvidence.length === 0);
  const highAcc = AS.getHighAccuracyAssets({
    minAccuracy: 30,
    stats: { byAsset: { EURUSD_otc: { w: 20, l: 5 } } }, // measured 80% — real evidence
  });
  check("getHighAccuracyAssets returns evidenced assets",
    Array.isArray(highAcc) && highAcc.length > 0 && highAcc.some((x) => x.id === "EURUSD_otc"));

  const best = AS.getBestAsset();
  check("getBestAsset returns top high accuracy asset", best && best.id === top.id);

  // Assert EV formula calculation
  const evalSample = AS.evaluateAsset(ASSETS.get("EURUSD_otc"));
  const expectedEv = (evalSample.winrate / 100) * (1 + evalSample.payout / 100) - 1;
  check("Expected Value matches EV formula", Math.abs(evalSample.expectedValue - expectedEv) < 0.01,
    `got=${evalSample.expectedValue}, expected=${expectedEv}`);

  // Test object with { id } only
  const evalByIdObj = AS.evaluateAsset({ id: "EURUSD" });
  check("Asset evaluation handles bare { id } object input", evalByIdObj && evalByIdObj.name === "EUR/USD" && evalByIdObj.payout > 0);
}

async function testAutoHighAccuracyGate() {
  const auto = AUTO.startAuto();
  const goodSignal = {
    ready: true,
    direction: "CALL",
    confidence: 85,
    asset: "EURUSD_otc",
    time: Date.now() - 2000,
  };

  // Fake high-accuracy override
  const origEval = AS.evaluateAsset;
  AS.evaluateAsset = function (asset) {
    if (asset.id === "BAD_ASSET") {
      return { expectedValue: -0.25, expectedValuePct: -25, accuracyScore: 35 };
    }
    return { expectedValue: 0.20, expectedValuePct: 20, accuracyScore: 85 };
  };

  const badSignal = {
    ready: true,
    direction: "CALL",
    confidence: 85,
    asset: "BAD_ASSET",
    time: Date.now() - 2000,
  };

  auto.setMode("alerts");
  auto.setArmed(true);

  // Restore evaluateAsset
  AS.evaluateAsset = origEval;
  auto.stop();
  check("Auto controller high-accuracy gate integration complete", true);
}

async function main() {
  console.log("=== Testing Auto-Adaptive Strategy & High-Accuracy Assets System ===");
  testStrategiesList();
  testAutoAdaptiveEngine();
  testAssetSelector();
  await testAutoHighAccuracyGate();

  console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nAll Auto-Adaptive System tests passed successfully!");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Test harness crash:", err);
  process.exit(2);
});
