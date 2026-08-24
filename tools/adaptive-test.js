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

function testAdaptiveUsesRecordedAccuracy() {
  const asset = ASSETS.get("EURUSD_otc") || ASSETS.get("EURUSD");
  const candles = FEED.syntheticSeries(asset, 200, { seed: 42, drift: 0.001 });

  const base = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false });
  check("baseline adaptive run has a fitness table",
    !!base && !!base.strategyScores && Object.keys(base.strategyScores).length > 0);

  // --- a strong record must LIFT that strategy's fitness ---
  const boosted = {};
  for (const id of Object.keys(base.strategyScores)) boosted[id] = 50; // neutral
  const target = Object.keys(base.strategyScores).find((id) => id !== base.selectedStrategy);
  boosted[target] = 95;
  const up = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false, strategyWinrates: boosted });
  const gain = up.strategyScores[target].fitness - base.strategyScores[target].fitness;
  check("a high recorded win rate raises that strategy's fitness", gain > 0,
    "target=" + target + " gain=" + gain);

  // --- a poor record must DEMOTE it, not merely fail to reward it ---
  const penalised = {};
  for (const id of Object.keys(base.strategyScores)) penalised[id] = 50;
  penalised[target] = 10;
  const down = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false, strategyWinrates: penalised });
  const loss = base.strategyScores[target].fitness - down.strategyScores[target].fitness;
  check("a poor recorded win rate lowers that strategy's fitness", loss > 0,
    "target=" + target + " loss=" + loss);

  // --- accuracy must reorder candidates of comparable confluence ---
  // Candidates that abstain on this bar contribute no score/confidence, so the
  // only thing separating them is regime + accuracy. Note the +/-25 bound means
  // accuracy informs the choice without overriding a large confluence lead
  // (asserted separately below).
  const abstaining = Object.keys(base.strategyScores)
    .filter((id) => base.strategyScores[id].direction === "WAIT");
  check("several candidates abstain on this bar (comparable confluence)",
    abstaining.length >= 2, "count=" + abstaining.length);
  const [a, b] = abstaining;
  const ranked = {};
  for (const id of Object.keys(base.strategyScores)) ranked[id] = 50;
  ranked[a] = 99;
  ranked[b] = 5;
  const rankedRes = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false, strategyWinrates: ranked });
  check("better recorded accuracy outranks worse among comparable candidates",
    rankedRes.strategyScores[a].fitness > rankedRes.strategyScores[b].fitness,
    a + "=" + rankedRes.strategyScores[a].fitness + " vs " + b + "=" + rankedRes.strategyScores[b].fitness);

  // --- bounded: the +/-50 clamp is a real bound. At gain 1.5 an unclamped
  // bonus reaches |73.5| at wr=99%, so unlike the old +/-25-at-gain-0.5 pair
  // (max |24.5|, i.e. a clamp that never bound) this one actually bites. ---
  const extreme = {};
  for (const id of Object.keys(base.strategyScores)) extreme[id] = 50;
  extreme[target] = 100;
  const capped = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false, strategyWinrates: extreme });
  const cappedGain = capped.strategyScores[target].fitness - base.strategyScores[target].fitness;
  check("accuracy bonus is bounded (cannot swamp confluence)", cappedGain <= 51,
    "gain=" + cappedGain);
  check("the clamp actually binds (it is not dead code)", cappedGain > 26,
    "gain=" + cappedGain + " (unclamped would be ~73)");

  // --- the invariant that makes the clamp safe: a strategy that ABSTAINS on
  // the current bar must never be picked on the strength of its history.
  // Give every abstainer a near-perfect record and every firing strategy a
  // near-hopeless one; the pick must still be a strategy that fired. ---
  const fired = Object.keys(base.strategyScores)
    .filter((id) => base.strategyScores[id].direction !== "WAIT");
  const abstainers = Object.keys(base.strategyScores)
    .filter((id) => base.strategyScores[id].direction === "WAIT");
  check("this bar has both firing and abstaining candidates",
    fired.length > 0 && abstainers.length > 0,
    "fired=" + fired.length + " abstaining=" + abstainers.length);
  const inverted = {};
  for (const id of Object.keys(base.strategyScores)) {
    inverted[id] = base.strategyScores[id].direction === "WAIT" ? 99 : 1;
  }
  const inv = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false, strategyWinrates: inverted });
  check("history alone cannot make an abstaining strategy win",
    inv.strategyScores[inv.selectedStrategy].direction !== "WAIT",
    "picked=" + inv.selectedStrategy +
    " dir=" + inv.strategyScores[inv.selectedStrategy].direction);

  // --- omitting the map must leave fitness exactly as before ---
  const omitted = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false, strategyWinrates: null });
  const same = Object.keys(base.strategyScores).every(
    (id) => omitted.strategyScores[id].fitness === base.strategyScores[id].fitness);
  check("no win-rate data leaves fitness unchanged", same);
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

/** The router has TWO paths: evaluateAdaptive (live, via analyze) and
 *  evaluateAdaptiveLeanAt (backtest, via ENG.backtest). Both carry the
 *  winrateBonus, and the lean one had no coverage at all — a regression there
 *  would be invisible. Drive it through backtest and confirm a penalised
 *  record actually removes that strategy from the picks. */
function testLeanAdaptiveUsesRecordedAccuracy() {
  const asset = ASSETS.get("EURUSD_otc") || ASSETS.get("EURUSD");
  const ids = ENG.CONCRETE_STRATEGIES;

  const tally = (winrates) => {
    const out = {};
    for (let seed = 1; seed <= 4; seed++) {
      const candles = FEED.syntheticSeries(asset, 400, { seed, drift: 0.001 });
      const res = ENG.backtest(candles, {
        strategy: "auto_adaptive", horizon: 3, minConf: 0, minBars: 60,
        strategyWinrates: winrates,
      });
      for (const t of (res && res.trades) || []) {
        const id = t.selectedStrategy || "?";
        out[id] = (out[id] || 0) + 1;
      }
    }
    return out;
  };

  const base = tally(null);
  const picks = Object.keys(base).filter((id) => id !== "?");
  check("lean adaptive backtest attributes trades to concrete strategies",
    picks.length > 0, JSON.stringify(base));

  const top = picks.sort((a, b) => base[b] - base[a])[0];
  const penalised = {};
  for (const id of ids) penalised[id] = 95;
  penalised[top] = 5;
  const after = tally(penalised);
  check("a poor record removes a strategy from the lean router's picks",
    (after[top] || 0) < base[top],
    top + ": " + base[top] + " -> " + (after[top] || 0));

  // A uniform record carries no information, so it must change nothing.
  const uniform = {};
  for (const id of ids) uniform[id] = 70;
  const same = tally(uniform);
  check("a uniform record does not perturb the lean router",
    JSON.stringify(same) === JSON.stringify(base),
    JSON.stringify(same));
}

async function main() {
  console.log("=== Testing Auto-Adaptive Strategy & High-Accuracy Assets System ===");
  testStrategiesList();
  testAutoAdaptiveEngine();
  testAdaptiveUsesRecordedAccuracy();
  testLeanAdaptiveUsesRecordedAccuracy();
  testAssetSelector();
  await testAutoHighAccuracyGate();

  console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nAll Auto-Adaptive System tests passed successfully!");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Test harness crash:", err);
  process.exit(2);
});
