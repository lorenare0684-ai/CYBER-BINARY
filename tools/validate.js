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
  "src/historic-worker.js",
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
  "src/lib/workers.js",
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
for (const cs of (man.content_scripts || [])) {
  if (cs.all_frames !== false) {
    console.error("content scripts must be top-frame only (multi-frame trade spam guard)");
    failed++;
  }
}

const sandbox = { self: {}, globalThis: null, console, URL, TextDecoder, window: {}, document: { querySelector: () => null, querySelectorAll: () => [] }, Event: function () {}, location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/trade" } };
sandbox.globalThis = sandbox.self;
sandbox.window.WebSocket = undefined;
sandbox.window.HTMLInputElement = { prototype: {} };
sandbox.window.HTMLTextAreaElement = { prototype: {} };
vm.createContext(sandbox);
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js", "workers.js", "quotex.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}

if (!sandbox.self.CYBER_FEED) { console.error("feed missing"); failed++; }
else {
  const f = sandbox.self.CYBER_FEED.createFeed({ tfMs: 60000 });
  f.seedHistory(50, 1.1);
  if (f.series().length < 40) { console.error("feed seed failed"); failed++; }
  const s1 = sandbox.self.CYBER_FEED.syntheticSeries("EURUSD", 80, { seed: 7 });
  const s2 = sandbox.self.CYBER_FEED.syntheticSeries("GBPUSD", 80, { seed: 7 });
  if (!s1.length || !s2.length || s1[20].close / s1[20].open === s2[20].close / s2[20].open) {
    console.error("per-asset synthetic seeds must not collide"); failed++;
  }
}

if (!sandbox.self.CYBER_ASSETS || !sandbox.self.CYBER_ASSETS.list().length) {
  console.error("assets missing"); failed++;
}
else {
  const A = sandbox.self.CYBER_ASSETS;
  const all = A.list();
  if (all.length < 140) { console.error("asset catalog too small: " + all.length); failed++; }
  const dupIds = all.map((a) => a.id).filter((v, i, arr) => arr.indexOf(v) !== i);
  if (dupIds.length) { console.error("duplicate asset ids", dupIds); failed++; }
  const kinds = new Set(all.map((a) => a.kind));
  for (const k of ["fx", "crypto", "commodity", "index", "stock", "otc"]) {
    if (!kinds.has(k)) { console.error("missing asset kind " + k); failed++; }
  }
  // detection smoke (display names + OTC routing + tickers)
  const detCases = [
    ["EURUSD", "EURUSD"], ["EUR/USD", "EURUSD"], ["EURUSD_otc", "EURUSD_otc"],
    ["EUR/USD OTC", "EURUSD_otc"], ["BTCUSD", "BTCUSD"], ["BTCUSD_otc", "BTCUSD_otc"],
    ["GBPNZD", "GBPNZD"], ["GBP/NZD OTC", "GBPNZD_otc"], ["SOLUSD_otc", "SOLUSD_otc"],
    ["AAPL_otc", "AAPL_otc"], ["Apple (OTC)", "AAPL_otc"], ["TSLA OTC", "TSLA_otc"],
    ["S&P 500", "SPXUSD"], ["XAUUSD", "XAUUSD"], ["XAUUSD OTC", "XAUUSD_otc"],
    ["GOLD", "XAUUSD"], ["USD/JPY", "USDJPY"], ["TESLA", "TSLA_otc"],
  ];
  for (const [text, want] of detCases) {
    const d = A.detect(text);
    if (!d || d.id !== want) { console.error("detect(" + text + ") expected " + want + " got " + (d && d.id)); failed++; }
  }
  // OTC twins must never be returned for plain base text
  if (A.detect("EUR/USD").id !== "EURUSD") { console.error("EUR/USD must map to base EURUSD"); failed++; }
  const assetCopy = A.get("EURUSD");
  assetCopy.name = "MUTATED";
  assetCopy.aliases.push("BAD_ALIAS");
  all[0].id = "BROKEN";
  A.ALIAS.EURUSD = "GBPUSD";
  if (A.get("EURUSD").name === "MUTATED" || A.get("EURUSD").aliases.includes("BAD_ALIAS") ||
      A.list()[0].id === "BROKEN" || A.detect("EURUSD").id !== "EURUSD") {
    console.error("asset getters/list/alias diagnostics must not expose mutable catalog state"); failed++;
  }
  let malformedAssetSafe = true;
  try {
    const malformed = A.registerQuotexAsset({
      symbol: "SAFEUSD_otc", id: Symbol("id"), payout: Symbol("payout"),
      basePrice: Symbol("price"), timeframes: [Symbol("tf"), 60],
    });
    malformedAssetSafe = !!malformed && malformed.brokerId === 0 && malformed.payout === 0 &&
      malformed.timeframes.length === 1 && malformed.timeframes[0] === 60;
  } catch (_) { malformedAssetSafe = false; }
  if (!malformedAssetSafe) { console.error("symbol-valued runtime asset metadata must fail closed"); failed++; }
}
if (!sandbox.self.CYBER_STRATEGIES || !sandbox.self.CYBER_STRATEGIES.list().length) {
  console.error("strategies missing"); failed++;
} else {
  const S = sandbox.self.CYBER_STRATEGIES;
  if (S.get("toString") !== null || S.get("__proto__") !== null) {
    console.error("inherited strategy names must be rejected"); failed++;
  }
  const copy = S.get("confluence");
  copy.params.minScore = 999;
  if (S.get("confluence").params.minScore === 999) {
    console.error("strategy getters must not expose mutable preset state"); failed++;
  }
}
if (!sandbox.self.CYBER_TA) { console.error("indicators missing"); failed++; }
if (!sandbox.self.CYBER_ENGINE) { console.error("engine missing"); failed++; }
if (!sandbox.self.CYBER_STORE) { console.error("store missing"); failed++; }
if (!sandbox.self.CYBER_AUTO) { console.error("auto missing"); failed++; }
if (!sandbox.self.CYBER_HIST) { console.error("backtest missing"); failed++; }
const W = sandbox.self.CYBER_WORKERS;
if (!W) {
  console.error("worker backtest API missing"); failed++;
} else {
  let workerInputsSafe = true;
  try {
    const canonical = W.buildJob(
      [{ id: "EURUSD", name: "FORGED" }, { id: "missing" }],
      [{ id: "trend", label: "FORGED" }],
      { days: 1.9, seed: Symbol("seed") }
    );
    workerInputsSafe = Object.getPrototypeOf(canonical.seriesByAsset) === null &&
      canonical.jobs.length === 1 && canonical.jobs[0].asset.name !== "FORGED" &&
      canonical.jobs[0].strategy.label !== "FORGED" && canonical.seriesByAsset.EURUSD.length === 1440;
    W.runChunk(canonical.seriesByAsset, canonical.jobs, {
      days: Symbol("days"), horizon: Symbol("horizon"), minConf: Symbol("confidence"), minBars: Symbol("bars"),
    });
  } catch (_) { workerInputsSafe = false; }
  if (!workerInputsSafe) { console.error("worker inputs must be canonical, bounded, and symbol-safe"); failed++; }
}
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
  const strictCandles = Q.normalizeCandles({ asset:"EURUSD", period:60, raw:[
    ["1700000060junk", "1.08", "1.07", "1.09", "1.085", "10"],
    ["1700000060", "1.08junk", "1.07", "1.09", "1.085", "10"],
  ] });
  if (strictCandles.length !== 0) { console.error("malformed numeric candle prefixes must be rejected"); failed++; }
  const unknownClose = Q.parseOrderClosed({ id:"missing-outcome", asset:"EURUSD", amount:10, status:"closed" });
  const nullClose = Q.parseOrderClosed({ id:"null-outcome", asset:"EURUSD", amount:10, profit:null, netProfit:null });
  if (!unknownClose || !nullClose || unknownClose.netProfit !== null || unknownClose.profit !== null ||
      nullClose.netProfit !== null || nullClose.profit !== null ||
      unknownClose.win || unknownClose.loss || unknownClose.draw || nullClose.win || nullClose.loss || nullClose.draw) {
    console.error("missing/null close outcomes must remain unknown instead of becoming losses"); failed++;
  }
  let stringQuote = null;
  const stringQuoteRouter = Q.createRouter({ onTick: (quote) => { stringQuote = quote; } });
  stringQuoteRouter.dispatch({ type:"bin", payload:[["EURUSD", "1700000000", "1.0815"]] });
  if (!stringQuote || stringQuote.symbol !== "EURUSD" || stringQuote.price !== 1.0815) {
    console.error("numeric-string headerless quotes must be inferred and parsed"); failed++;
  }
  let malformedBrokerSafe = true;
  try {
    malformedBrokerSafe = Q.toMs(Symbol("time")) === null &&
      Q.parseQuote({ symbol:"EURUSD", time:Symbol("time"), price:Symbol("price") }) === null &&
      Q.parseInstruments([{ symbol:"SAFEUSD", id:Symbol("id"), payout:Symbol("payout"), timeframes:[Symbol("tf")] }]).length === 1 &&
      Q.setExpiry(Symbol("expiry")).ok === false &&
      Q.placeTradeDom({ dir:"CALL", amount:Symbol("amount"), expirySec:60 }).ok === false;
  } catch (_) { malformedBrokerSafe = false; }
  if (!malformedBrokerSafe) { console.error("symbol-valued broker metadata must fail closed"); failed++; }
  const op = Q.buildOrderPayload({ asset:"EURUSD_otc", dir:"CALL", amount:1, expirySec:60, nowMs:1700000000000, isDemo:true });
  if (!op || op.action !== "call" || op.optionType !== 100 || op.time !== 60) { console.error("quotex OTC order payload"); failed++; }
  const regular = Q.buildOrderPayload({ asset:"EURUSD", dir:"PUT", amount:1, expirySec:180, nowMs:1700000000000, isDemo:false });
  if (!regular || regular.action !== "put" || regular.optionType !== 1 || regular.time < 1700000000) {
    console.error("quotex regular order must use absolute expiry + PUT action", regular); failed++;
  }
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
  const fakeW = new sandbox.window.WebSocket("wss://ws.qxbroker.com/socket.io/?EIO=3&transport=websocket");
  fakeW._emitMessage('42["s_authorization",{"isDemo":1}]');
  fakeW._emitMessage("40");
  fakeW._emitMessage('451-["instruments/list",{"_placeholder":true,"num":0}]');
  fakeW._emitMessage(String.fromCharCode(0x04) + JSON.stringify([[1,"EURUSD","EUR/USD","currency",85,0,0,0,0,0,0,0,[[60]],0,true,[]]]));
  fakeW._emitMessage('451-["quotes/stream",{"_placeholder":true,"num":0}]');
  fakeW._emitMessage(String.fromCharCode(0x04) + JSON.stringify([["EURUSD",1700000000000,1.08,0,0,0]]));
  if (fakeWSEvents < 4) { console.error("attachPageSocket dispatch failed, events=" + fakeWSEvents); failed++; }
  const wsPlace = Q.placeTradeWs(fakeW, { asset: "EURUSD_otc", dir: "CALL", amount: 1, expiry: 60, isDemo: true });
  if (!wsPlace || !wsPlace.ok) { console.error("placeTradeWs should succeed with fake ws"); failed++; }
  if (!fakeW.sent.some((m) => m.indexOf('"orders/open"') !== -1)) { console.error("orders/open not sent"); failed++; }
  const historyRequest = Q.subscribeHistory(fakeW, "EURUSD", 60, 9000);
  const historyFrame = fakeW.sent.find((m) => m.indexOf('"history/list/v2"') !== -1);
  if (!historyRequest || !historyRequest.ok || historyRequest.limit !== 5000 ||
      !historyFrame || historyFrame.indexOf('"limit":5000') === -1) {
    console.error("subscribeHistory must explicitly request bounded broker OHLC history"); failed++;
  }

  // v2.3: outgoing-frame sniffing — the client's own requests reveal the
  // active asset (this is the primary auto-detection source).
  let sniffedAsset = null;
  sandbox.window.WebSocket = FakeWS;
  const r2 = Q.attachPageSocket({
    onStatus: function () {},
    onTick: function () {},
    onInstruments: function () {},
    onAsset: function (sym) { sniffedAsset = sym; },
  });
  const fakeW2 = new sandbox.window.WebSocket("wss://ws.qxbroker.com/socket.io/?EIO=3&transport=websocket");
  fakeW2.send('42["instruments/follow","EURUSD_otc"]');
  fakeW2.send('42["history/list/v2",{"asset":"GBPUSD","period":60,"offset":0,"limit":100}]');
  fakeW2.send('42["orders/open",{"asset":"XAUUSD_otc"}]');
  if (sniffedAsset !== "XAUUSD_otc") { console.error("outgoing sniff failed, got " + sniffedAsset); failed++; }
  if (Q.sniffOutgoing('2') !== null || Q.sniffOutgoing('42["tick"]') !== null) { console.error("sniffOutgoing false positive"); failed++; }
  const followHint = Q.sniffOutgoing('42["instruments/follow","GBPUSD"]');
  const mainHint = Q.sniffOutgoing('42["instruments/update",{"asset":"EURUSD","period":300}]');
  if (!followHint || followHint.main || !followHint.candidate) { console.error("follow must be candidate-only"); failed++; }
  if (!mainHint || !mainHint.main || mainHint.symbol !== "EURUSD" || mainHint.period !== 300) { console.error("main chart hint parse failed"); failed++; }
  r2.detach();

  // v2.3: numeric-id tick rows resolve via the live instruments payload.
  Q.rememberIds([[1, "EURUSD", "EUR/USD", "currency", 85, 0, 0, 0, 0, 0, 0, 0, [[60]], 0, true, []]]);
  const nq = Q.parseQuote([[1, 1700000000000, 1.0855]]);
  if (!nq || nq.symbol !== "EURUSD" || nq.price !== 1.0855) { console.error("numeric-id tick parse failed"); failed++; }
  const wq = Q.parseQuote({ tick: [["EURUSD_otc", 1700000000000, 1.0856]] });
  if (!wq || wq.symbol !== "EURUSD_otc") { console.error("{tick:[...]} wrapper parse failed"); failed++; }
  const tq = Q.decodeFrame('43["tick",{"tick":[["EURUSD_otc",1700000000000,1.0857]]}]');
  if (!tq || tq.event !== "tick" || Q.normalizeEvent(tq) !== "quote") { console.error("tick event mapping failed"); failed++; }

  r.detach();
  if (sandbox.window.WebSocket !== FakeWS) { console.error("detach did not restore", typeof sandbox.window.WebSocket); failed++; }
}

// Smoke-test the runtime-asset registration in CYBER_ASSETS.
if (sandbox.self.CYBER_ASSETS.registerQuotexAsset) {
  const A = sandbox.self.CYBER_ASSETS;
  const a = A.registerQuotexAsset({
    id: 999, symbol: "TEST_otc", name: "Test", isOtc: true, payout: 80,
    timeframes: [0.5, 60, 120], aliases: ["EURUSD"],
  });
  // Broker convention: base uppercase, OTC suffix lowercase (EURUSD_otc).
  if (!a || a.id !== "TEST_otc") { console.error("registerQuotexAsset expected TEST_otc, got " + (a && a.id)); failed++; }
  if (!a || a.timeframes.includes(0)) { console.error("fractional timeframe normalized to invalid zero"); failed++; }
  if (!A.get("EURUSD") || A.get("EURUSD").id !== "EURUSD") { console.error("runtime alias hijacked a static asset"); failed++; }
  const closed = A.registerQuotexAsset({ symbol: "TEST_otc", isOpen: "0" });
  if (!closed || closed.isOpen !== false) { console.error("string broker open-state parsing failed"); failed++; }
  const doge = A.detect("Dogecoin (OTC)");
  if (!doge || doge.id !== "DOGUSD_otc") { console.error("confirmed Dogecoin broker symbol was shadowed"); failed++; }
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
const flat = new Array(80).fill(1);
const flatAdx = TA.adx(flat, flat, flat, 14).adx;
if (TA.lastValid(flatAdx).value !== 0) { console.error("flat-series ADX must settle at zero"); failed++; }
const rs = TA.resample([
  { time: 1700000000, open: 1, high: 1.1, low: 0.9, close: 1.05 },
  { time: 1700000060, open: 1.05, high: 1.2, low: 1, close: 1.1 },
], 1);
if (rs.length !== 2 || rs[0].time !== 1700000000000) { console.error("resample must normalize second timestamps"); failed++; }
if (TA.softmaxProbs(1e308, 0).call < 0.99) { console.error("softmax overflow guard failed"); failed++; }
if (TA.lastValid(null).index !== -1) { console.error("lastValid malformed-input guard failed"); failed++; }
let malformedIndicatorsSafe = true;
try {
  const bad = [Symbol("value"), Symbol("value")];
  const badHigh = [Symbol("high"), Symbol("high")];
  const badLow = [Symbol("low"), Symbol("low")];
  const badVolume = [Symbol("volume"), Symbol("volume")];
  const results = [
    TA.sma(bad, Symbol("period")), TA.ema(bad, Symbol("period")),
    TA.rsi(bad, 1), TA.macd(bad, Symbol("fast"), Symbol("slow"), Symbol("signal")),
    TA.stochastic(badHigh, badLow, bad, 1, 1), TA.bollinger(bad, 1, Symbol("mult")),
    TA.atr(badHigh, badLow, bad, 1), TA.adx(badHigh, badLow, bad, 1),
    TA.keltner(badHigh, badLow, bad, 1, Symbol("mult")), TA.psar(badHigh, badLow, { step: Symbol("step") }),
    TA.supertrend(badHigh, badLow, bad, 1, Symbol("mult")), TA.vwap(badHigh, badLow, bad, badVolume),
    TA.hurst(bad, 2), TA.momentum(bad, 1), TA.williamsR(badHigh, badLow, bad, 1),
    TA.cci(badHigh, badLow, bad, 1), TA.mfi(badHigh, badLow, bad, badVolume, 1),
    TA.obv(bad, badVolume), TA.donchian(badHigh, badLow, 1),
    TA.resample([{ time: Symbol("time"), open: Symbol("open"), high: 1, low: 1, close: 1 }], Symbol("minutes")),
  ];
  malformedIndicatorsSafe = results.every((result) => result != null) &&
    TA.lastValid([Symbol("value")]).index === -1 && TA.softmaxProbs(Symbol("call"), Symbol("put")).call === 0.5;
} catch (_) { malformedIndicatorsSafe = false; }
if (!malformedIndicatorsSafe) { console.error("symbol-valued indicator inputs must fail closed"); failed++; }
const huge = Number.MAX_VALUE;
const hugeSma = TA.sma([huge, huge], 2);
const hugeEma = TA.ema([huge, huge], 2);
const hugeRma = TA.rma([huge, huge], 2);
const hugeSd = TA.stdev([huge, huge], 2);
if (![hugeSma[1], hugeEma[1], hugeRma[1], hugeSd[1]].every(Number.isFinite)) {
  console.error("finite large indicator inputs must not overflow intermediate sums"); failed++;
}
if (TA.obv([Symbol("close")], [1])[0] !== null || TA.obv([1], [Symbol("volume")])[0] !== null ||
    TA.sma([null], 1)[0] !== null || TA.ema([" "], 1)[0] !== null) {
  console.error("indicators must reject null/blank initial numeric values"); failed++;
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

// Direction coverage: the extension must produce both CALL and PUT, not a
// one-sided signal stream.
function directionalSeries(direction) {
  const out = [];
  let px = 1;
  for (let i = 0; i < 260; i++) {
    const next = px * (1 + direction * (0.0006 + ((i % 8) - 4) * 0.00001));
    out.push({ time: i * 60000, open: px, high: Math.max(px, next) * 1.0001, low: Math.min(px, next) * 0.9999, close: next });
    px = next;
  }
  return out;
}
const callSignal = sandbox.self.CYBER_ENGINE.analyze(directionalSeries(1), { strategy: "confluence", lean: false });
const putSignal = sandbox.self.CYBER_ENGINE.analyze(directionalSeries(-1), { strategy: "confluence", lean: false });
if (!callSignal || callSignal.direction !== "CALL") { console.error("engine CALL coverage failed", callSignal && callSignal.direction); failed++; }
if (!putSignal || putSignal.direction !== "PUT") { console.error("engine PUT coverage failed", putSignal && putSignal.direction); failed++; }

// A strong trend often has several correlated oscillators briefly voting the
// other way. A one-point winning margin must not leave the live engine stuck
// at score/confidence zero in that regime.
function trendingPullbackSeries() {
  const out = [];
  let state = 1;
  let px = 1;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = 0; i < 260; i++) {
    const drift = i > 180 ? 0.0005 : 0.00008;
    let change = drift + (random() - 0.45) * 0.0005;
    if (i === 259) change = -0.00003;
    const next = px * (1 + change);
    const pad = px * (0.00008 + random() * 0.00008);
    out.push({
      time: i * 60000,
      open: px,
      high: Math.max(px, next) + pad,
      low: Math.min(px, next) - pad,
      close: next,
    });
    px = next;
  }
  return out;
}
const trendPullbackSignal = sandbox.self.CYBER_ENGINE.analyze(trendingPullbackSeries(), {
  strategy: "scalp", lean: false,
});
if (!trendPullbackSignal || trendPullbackSignal.regime !== "trending" ||
    trendPullbackSignal.direction !== "CALL" || trendPullbackSignal.score <= 0 ||
    trendPullbackSignal.confidence <= 0 || trendPullbackSignal.metrics.callScore !== 4 ||
    trendPullbackSignal.metrics.putScore !== 3) {
  console.error("trending one-point vote lead must generate a signal", trendPullbackSignal);
  failed++;
}

// Backtest smoke (lean path)
const r = sandbox.self.CYBER_ENGINE.backtest(candles, { strategy: "confluence", horizon: 3, minBars: 200 });
if (!r || typeof r.winrate !== "number") { console.error("backtest failed"); failed++; }
if (r.trades.length) {
  const tr = r.trades[0];
  if (tr.expiryTime - tr.entryTime !== 3 * 60000 || tr.exitTime !== tr.expiryTime) {
    console.error("backtest lifecycle timestamps are not aligned to candle closes"); failed++;
  }
}
const safeInvalidBacktest = sandbox.self.CYBER_ENGINE.backtest(candles, { strategy: "missing", horizon: -10, warmup: -2 });
if (!safeInvalidBacktest || typeof safeInvalidBacktest.total !== "number") {
  console.error("backtest option validation failed"); failed++;
}
const noSignals = sandbox.self.CYBER_ENGINE.backtest(candles, { minScore: 999 });
if (noSignals.total !== 0) { console.error("top-level strategy overrides were ignored"); failed++; }
const duplicateTimes = candles.map((bar) => ({ ...bar }));
duplicateTimes[100].time = duplicateTimes[99].time;
if (sandbox.self.CYBER_ENGINE.backtest(duplicateTimes, {}).total !== 0) {
  console.error("backtest accepted duplicate/non-ascending timestamps"); failed++;
}
const malformedAnalyze = sandbox.self.CYBER_ENGINE.analyze({ length: 200 }, {});
if (!malformedAnalyze || malformedAnalyze.ready !== false) {
  console.error("analyze malformed-input guard failed"); failed++;
}
let malformedEngineSafe = true;
try {
  const symbolCandles = candles.map((bar) => ({ ...bar }));
  symbolCandles[symbolCandles.length - 1].close = Symbol("close");
  malformedEngineSafe = sandbox.self.CYBER_ENGINE.analyze(symbolCandles, {
    minScore: Symbol("score"), weights: { emaTrend: Symbol("weight") },
  }).ready === false && sandbox.self.CYBER_ENGINE.backtest(candles, {
    horizon: Symbol("horizon"), minConf: Symbol("confidence"), warmup: Symbol("warmup"),
  }).total >= 0;
} catch (_) { malformedEngineSafe = false; }
if (!malformedEngineSafe) { console.error("symbol-valued engine inputs must fail closed"); failed++; }
const unsortedAnalyze = candles.map((bar) => ({ ...bar }));
unsortedAnalyze[220].time = unsortedAnalyze[219].time;
if (sandbox.self.CYBER_ENGINE.analyze(unsortedAnalyze, {}).ready !== false) {
  console.error("live analysis accepted duplicate/non-ascending timestamps"); failed++;
}
const drawSource = directionalSeries(1);
const drawBase = sandbox.self.CYBER_ENGINE.backtest(drawSource, { horizon: 1, warmup: 50 });
if (drawBase.trades.length) {
  const targetTrade = drawBase.trades[0];
  const drawInput = drawSource.map((bar) => ({ ...bar }));
  const entryValue = Number(drawInput[targetTrade.i].close);
  drawInput[targetTrade.i].close = String(entryValue) + "0";
  drawInput[targetTrade.i + 1].close = String(entryValue);
  drawInput[targetTrade.i + 1].high = Math.max(Number(drawInput[targetTrade.i + 1].high), entryValue);
  drawInput[targetTrade.i + 1].low = Math.min(Number(drawInput[targetTrade.i + 1].low), entryValue);
  const drawResult = sandbox.self.CYBER_ENGINE.backtest(drawInput, { horizon: 1, warmup: 50 });
  const normalizedTrade = drawResult.trades.find((trade) => trade.i === targetTrade.i);
  if (!normalizedTrade || !normalizedTrade.draw || typeof normalizedTrade.entry !== "number") {
    console.error("numeric-string lifecycle prices must compare and export numerically"); failed++;
  }
}
if (!sandbox.self.CYBER_ENGINE.walkForward(candles, {}).error) {
  console.error("undersized walk-forward folds must be rejected"); failed++;
}

// Historic matrix smoke (fast path, lean + smaller days)
const HIST = sandbox.self.CYBER_HIST;
const matrix = HIST.runMatrix({ days: 2, strategies: ["confluence"], assets: sandbox.self.CYBER_ASSETS.byKind("fx").slice(0, 3), minBars: 200 });
if (!matrix || !matrix.results.length) { console.error("historic matrix failed"); failed++; }
const cacheStart = 1760000000000;
const cachedSeries = HIST.getSeries(sandbox.self.CYBER_ASSETS.get("EURUSD"), {
  days: 1,
  cachedBars: [
    { time: cacheStart, open: 2, high: 2.1, low: 1.9, close: 2.05 },
    { time: cacheStart + 60000, open: 2.05, high: 2.2, low: 2, close: 2.1 },
  ],
});
if (cachedSeries.length !== 1440 || cachedSeries[cachedSeries.length - 1].close !== 2.1 ||
    cachedSeries[cachedSeries.length - 3].time !== cacheStart - 60000 ||
    Math.abs(cachedSeries[cachedSeries.length - 3].close - 2) > 1e-9) {
  console.error("cached historic series was not preferred/aligned to its synthetic prefix"); failed++;
}
const dedupedMatrix = HIST.runMatrix({ days: 1, strategies: ["confluence", "confluence"], assets: ["EURUSD", "EURUSD"] });
if (dedupedMatrix.count !== 1) { console.error("historic matrix did not deduplicate jobs"); failed++; }
const safeSummary = HIST.summarize({ results: [{ asset: "A", strategy: "S", kind: "fx", wins: "2", losses: "1", draws: Infinity, pnl: "3" }, null] });
if (!safeSummary || safeSummary.trades !== 3 || safeSummary.draws !== 0 || safeSummary.pnl !== 3) {
  console.error("historic summary sanitation failed"); failed++;
}

if (failed) {
  console.error("FAILED", failed);
  process.exit(1);
}
console.log("OK — structure + engine + backtest checks passed");
