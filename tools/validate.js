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
  "src/lib/quotex.js",
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

const sandbox = { self: {}, globalThis: null, console, window: {}, document: { querySelector: () => null, querySelectorAll: () => [] }, Event: function () {}, location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/trade" } };
sandbox.globalThis = sandbox.self;
sandbox.window.WebSocket = undefined;
sandbox.window.HTMLInputElement = { prototype: {} };
sandbox.window.HTMLTextAreaElement = { prototype: {} };
vm.createContext(sandbox);
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js", "quotex.js"]) {
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
if (!sandbox.self.CYBER_QUOTEX) { console.error("quotex adapter missing"); failed++; }
else {
  const Q = sandbox.self.CYBER_QUOTEX;
  if (Q.getInstruments().length < 80) { console.error("quotex catalog too small"); failed++; }
  const f0 = Q.decodeFrame("0{\"sid\":\"x\"}");
  if (!f0 || f0.kind !== "open") { console.error("quotex open frame"); failed++; }
  const f1 = Q.decodeFrame('42["s_authorization",{"isDemo":1}]');
  if (!f1 || f1.type !== "sio" || f1.event !== "s_authorization") { console.error("quotex sio frame"); failed++; }
  const f2 = Q.decodeFrame('451-["instruments/list",{"_placeholder":true,"num":0}]');
  if (!f2 || f2.type !== "hdr" || f2.event !== "instruments/list") { console.error("quotex header frame"); failed++; }
  const f3 = Q.decodeFrame(String.fromCharCode(0x04) + '{"uid":1,"balance":50}');
  if (!f3 || f3.type !== "bin" || !f3.payload || f3.payload.balance !== 50) { console.error("quotex binary frame"); failed++; }
  const inst = Q.parseInstruments([[1,"EURUSD","EUR/USD","currency",85,0,0,0,0,0,0,0,[[60]],0,true,[]]]);
  if (inst.length !== 1 || inst[0].symbol !== "EURUSD") { console.error("quotex parseInstruments"); failed++; }
  const cNorm = Q.normalizeCandles({ asset:"EURUSD", period:60, raw:[[1700000000,1.08,1.075,1.085,1.082,100]] });
  if (cNorm.length !== 1 || cNorm[0].time !== 1700000000000) { console.error("quotex candle epoch ms"); failed++; }
  const op = Q.buildOrderPayload({ asset:"EURUSD_otc", dir:"CALL", amount:1, expiry:60 });
  if (!op || op.action !== "call") { console.error("quotex order payload"); failed++; }
  const place = Q.placeTradeDom({ dir: "CALL", amount: 1 });
  if (place && place.ok) { console.error("placeTradeDom should fail in vm (no DOM)"); failed++; }

  // attachPageSocket integration smoke (fake WebSocket).
  let fakeWSEvents = 0;
  function FakeWS(url) { this.url = url || ""; this._listeners = {}; this.sent = []; }
  FakeWS.prototype.addEventListener = function (n, fn) { (this._listeners[n] = this._listeners[n] || []).push(fn); };
  FakeWS.prototype.send = function (m) { this.sent.push(m); };
  FakeWS.prototype._emitMessage = function (data) { for (const fn of (this._listeners.message || [])) fn({ data: data }); };
  const oldWS = sandbox.window.WebSocket;
  sandbox.window.WebSocket = FakeWS;
  const r = Q.attachPageSocket({
    onStatus: function () { fakeWSEvents++; },
    onTick: function () { fakeWSEvents++; },
    onInstruments: function () { fakeWSEvents++; },
  });
  if (!r || !r.ok) { console.error("attachPageSocket failed"); failed++; }
  const fakeW = new sandbox.window.WebSocket("wss://x");
  fakeW._emitMessage('42["s_authorization",{"isDemo":1}]');
  fakeW._emitMessage("40");
  fakeW._emitMessage('451-["instruments/list",{"_placeholder":true,"num":0}]');
  fakeW._emitMessage(String.fromCharCode(0x04) + JSON.stringify([[1,"EURUSD","EUR/USD","currency",85,0,0,0,0,0,0,0,[[60]],0,true,[]]]));
  fakeW._emitMessage('451-["quotes/stream",{"_placeholder":true,"num":0}]');
  fakeW._emitMessage(String.fromCharCode(0x04) + JSON.stringify([["EURUSD",1700000000000,1.08,0,0,0]]));
  if (fakeWSEvents < 4) { console.error("attachPageSocket dispatch failed, events=" + fakeWSEvents); failed++; }
  const wsPlace = Q.placeTradeWs(fakeW, { asset: "EURUSD_otc", dir: "CALL", amount: 1, expiry: 60 });
  if (!wsPlace || !wsPlace.ok) { console.error("placeTradeWs should succeed with fake ws"); failed++; }
  if (!fakeW.sent.some((m) => m.indexOf('"orders/open"') !== -1)) { console.error("orders/open not sent"); failed++; }
  r.detach();
  if (sandbox.window.WebSocket !== FakeWS) { console.error("detach did not restore", typeof sandbox.window.WebSocket); failed++; }
}

// Smoke-test the runtime-asset registration in CYBER_ASSETS.
if (sandbox.self.CYBER_ASSETS.registerQuotexAsset) {
  const a = sandbox.self.CYBER_ASSETS.registerQuotexAsset({ id: 999, symbol: "TEST_otc", name: "Test", isOtc: true, payout: 80, timeframes: [60, 120] });
  if (!a || a.id !== "TEST_OTC") { console.error("registerQuotexAsset"); failed++; }
}

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
