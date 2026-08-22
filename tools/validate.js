#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const required = [
  "manifest.json",
  "src/background.js",
  "src/content.js",
  "src/content.css",
  "src/dashboard.html",
  "src/dashboard.js",
  "src/dashboard.css",
  "src/lib/indicators.js",
  "src/lib/assets.js",
  "src/lib/strategy.js",
  "src/lib/engine.js",
  "src/lib/feed.js",
  "src/lib/storage.js",
  "src/lib/auto.js",
  "src/lib/backtest.js",
  "src/page-hook.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

let failed = 0;
for (const f of required) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.error("MISSING", f);
    failed++;
  }
}

const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (man.manifest_version !== 3) {
  console.error("manifest_version must be 3");
  failed++;
}

const sandbox = { self: {}, globalThis: null, console };
sandbox.globalThis = sandbox.self;
vm.createContext(sandbox);
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}

if (!sandbox.self.CYBER_FEED) { console.error("feed missing"); failed++; }
else {
  const f = sandbox.self.CYBER_FEED.createFeed({ tfMs: 60000 });
  f.seedHistory(50, 1.1);
  if (f.series().length < 40) { console.error("feed seed failed"); failed++; }
}

if (!sandbox.self.CYBER_ASSETS || !sandbox.self.CYBER_ASSETS.list().length) {
  console.error("assets missing"); failed++;
}
if (!sandbox.self.CYBER_STRATEGIES || !sandbox.self.CYBER_STRATEGIES.list().length) {
  console.error("strategies missing"); failed++;
}
if (!sandbox.self.CYBER_TA) { console.error("indicators missing"); failed++; }
if (!sandbox.self.CYBER_ENGINE) { console.error("engine missing"); failed++; }
if (!sandbox.self.CYBER_STORE) { console.error("store missing"); failed++; }
if (!sandbox.self.CYBER_AUTO) { console.error("auto missing"); failed++; }
if (!sandbox.self.CYBER_HIST) { console.error("backtest missing"); failed++; }

// Smoke-test new indicators
const TA = sandbox.self.CYBER_TA;
const closes = [];
let p = 1.1;
for (let i = 0; i < 200; i++) { p += (Math.sin(i / 9) * 0.0008); closes.push(p); }
const highs = closes.map((c, i) => c + 0.0005 + (i % 5) * 0.0001);
const lows = closes.map((c, i) => c - 0.0005 - (i % 7) * 0.0001);
for (const fn of ["rsi", "ema", "sma", "macd", "stochastic", "bollinger", "atr", "adx", "keltner", "psar", "supertrend", "vwap", "hurst", "momentum", "williamsR", "cci", "mfi", "obv", "donchian"]) {
  const r = TA[fn](highs, lows, closes, new Array(closes.length).fill(100), 14);
  if (!r) { console.error("indicator", fn, "failed"); failed++; }
}

// Engine analyze on a full series
const candles = [];
let q = 1;
for (let i = 0; i < 240; i++) {
  const c = q + (i % 7 === 0 ? -0.005 : 0.001) + Math.sin(i / 11) * 0.0008;
  candles.push({ time: i * 60000, open: q, high: Math.max(q, c) + 0.0005, low: Math.min(q, c) - 0.0005, close: c });
  q = c;
}
const sig = sandbox.self.CYBER_ENGINE.analyze(candles, { strategy: "confluence", lean: false });
if (!sig || !sig.ready) { console.error("engine not ready on 240 candles"); failed++; }
if (!sig.metrics || sig.metrics.adx == null) { console.error("missing adx metric"); failed++; }
if (!sig.metrics || sig.metrics.hurst == null) { console.error("missing hurst metric"); failed++; }

// Backtest smoke (lean path)
const r = sandbox.self.CYBER_ENGINE.backtest(candles, { strategy: "confluence", horizon: 3, minBars: 200 });
if (!r || typeof r.winrate !== "number") { console.error("backtest failed"); failed++; }

// Historic matrix smoke (fast path, lean + smaller days)
const matrix = sandbox.self.CYBER_HIST.runMatrix({ days: 2, strategies: ["confluence"], assets: sandbox.self.CYBER_ASSETS.byKind("fx").slice(0, 3), minBars: 200 });
if (!matrix || !matrix.results.length) { console.error("historic matrix failed"); failed++; }

if (failed) {
  console.error("FAILED", failed);
  process.exit(1);
}
console.log("OK — structure + engine + backtest checks passed");
