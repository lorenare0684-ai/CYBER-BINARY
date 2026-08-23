#!/usr/bin/env node
"use strict";
/**
 * Bug-audit regression tests (v2.3.2):
 *
 *   1. storage.js save/load race: two rapid setSettings() calls inside the
 *      200ms save() debounce must BOTH survive (old code re-read storage on
 *      every load() and dropped the earlier patch).
 *   2. storage.js recordTrade "daily" reset: must be a real day (old code
 *      used 36e5 = 1 hour, resetting every hour).
 *   3. quotex.js asString(): binary frames >= ~64KB crashed with
 *      "Maximum call stack size exceeded" (String.fromCharCode.apply).
 *      Must decode 1KB … 4MB frames without throwing.
 *   4. feed.js ingest(): a stale tick (older bucket than the in-progress
 *      bar) must be dropped, not swap `current` for an older bar and break
 *      series ordering.
 *   5. feed.js setSeries(): cap() keeps the newest bar as the live bar
 *      (guard against a regression where trimming evicts it).
 *   6. storage.js calibrationAdjust(): wiring used by the content script.
 *
 * A stub chrome.storage.local + a timer that NEVER fires reproduces the
 * original race exactly (the debounce never flushes on its own — only a
 * subsequent load() can flush).
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

// ---------- controllable clock ----------
const RealDate = Date;
let fakeNow = Date.now();
class FakeDate extends RealDate {}
FakeDate.now = () => fakeNow;
function advance(ms) { fakeNow += ms; }
const HOUR = 36e5, DAY = 24 * HOUR;

// ---------- chrome.storage stub that behaves like the real one ----------
// set() persists immediately into the map; get() reads from it. The
// setTimeout stub NEVER fires its callback (like the VM repro of the bug):
// the only way pending debounced writes reach storage is a later load().
// Timer ids must be truthy (a falsy id silently disabled flush-on-load).
let nextTimerId = 1;
const storageMap = {};
function applyStoragePatch(patch) {
  const key = "cyberBinaryV2";
  const state = storageMap[key] && typeof storageMap[key] === "object"
    ? JSON.parse(JSON.stringify(storageMap[key])) : {};
  for (const op of patch || []) {
    let parent = state;
    for (let i = 0; i < op.path.length - 1; i++) {
      const part = op.path[i];
      if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) parent[part] = {};
      parent = parent[part];
    }
    const leaf = op.path[op.path.length - 1];
    if (op.remove) delete parent[leaf];
    else parent[leaf] = JSON.parse(JSON.stringify(op.value));
  }
  storageMap[key] = state;
}
const chromeStub = {
  runtime: {
    id: "t", getURL: (p) => p,
    sendMessage: (msg) => {
      if (msg && msg.type === "CYBER_STORAGE_PATCH") applyStoragePatch(msg.patch);
      return Promise.resolve({ ok: true });
    },
    onMessage: { addListener: () => {} }, lastError: null,
  },
  storage: {
    local: {
      get: (key, cb) => {
        const out = {};
        if (typeof key === "string") out[key] = storageMap[key];
        else if (Array.isArray(key)) for (const k of key) out[k] = storageMap[k];
        else Object.assign(out, storageMap);
        if (cb) cb(out);
      },
      set: (obj, cb) => {
        Object.assign(storageMap, obj);
        if (cb) cb();
        return Promise.resolve();
      },
    },
    session: { get: (k, cb) => cb && cb({}), set: () => Promise.resolve() },
  },
  tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve({}) },
  windows: { create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve() },
  action: { onClicked: { addListener: () => {} } },
};

const sandbox = {
  self: {}, console, Date: FakeDate,
  // The bug's defining condition: debounced save() callbacks NEVER run.
  setTimeout: () => nextTimerId++, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  chrome: chromeStub,
  location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo" },
  navigator: { userAgent: "node" },
  // Same-realm typed arrays: Node-built Uint8Array/ArrayBuffer must pass
  // `instanceof` inside the VM (the code under test relies on it).
  Uint8Array, ArrayBuffer, Uint16Array, Uint32Array, DataView,
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
vm.createContext(sandbox);

for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "backtest.js", "quotex.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}

let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

const STORE = sandbox.self.CYBER_STORE;
const Q = sandbox.self.CYBER_QUOTEX;
const FEED = sandbox.self.CYBER_FEED;
const KEY = "cyberBinaryV2";

// ---------- 1. storage save/load race ----------
async function raceTest() {
  await STORE.setSettings({ autoMode: "click" });   // 1st patch, debounce pending
  await STORE.setSettings({ armed: true });         // 2nd patch — must NOT lose the 1st
  const s = await STORE.getSettings();
  check("rapid setSettings keeps BOTH patches (load sees flushed write)",
    s.autoMode === "click" && s.armed === true,
    "autoMode=" + s.autoMode + " armed=" + s.armed);
  const persisted = storageMap[KEY];
  check("storage map eventually contains both patches",
    persisted && persisted.settings && persisted.settings.autoMode === "click" && persisted.settings.armed === true,
    persisted && JSON.stringify(persisted.settings));

  // A third update after a full flush must also survive.
  await STORE.flush();
  await STORE.setSettings({ stake: 9 });
  const s2 = await STORE.getSettings();
  check("update after flush keeps prior + new value",
    s2.stake === 9 && s2.armed === true && s2.autoMode === "click",
    "stake=" + s2.stake + " armed=" + s2.armed);

  // Cross-context sync must survive: another context (dashboard popup)
  // writes storage directly → our next load() must see the change.
  storageMap[KEY] = storageMap[KEY] || {};
  storageMap[KEY].settings = Object.assign({}, storageMap[KEY].settings, { autoMode: "alerts" });
  const s3 = await STORE.getSettings();
  check("cross-context storage write is picked up on next load",
    s3.autoMode === "alerts" && s3.stake === 9,
    "autoMode=" + s3.autoMode + " stake=" + s3.stake);
}

// ---------- 2. recordTrade daily reset (24h, not 1h) ----------
async function dailyResetTest() {
  const t0 = 1720000000000;
  fakeNow = t0;
  const first = await STORE.recordTrade({ won: true, payout: 0.85, asset: "EURUSD_otc", dir: "CALL", strategy: "confluence", regime: "trending", confidence: 80, entry: 1.1, exit: 1.1008 });
  check("first trade: dailyPnl = payout", Math.abs(first.dailyPnl - 0.85) < 1e-9, "dailyPnl=" + first.dailyPnl);

  // +2h: OLD code (36e5) would have reset. Must NOT reset within a day.
  advance(2 * HOUR);
  const two = await STORE.recordTrade({ won: false, asset: "EURUSD_otc", dir: "PUT", strategy: "confluence", regime: "trending", confidence: 80, entry: 1.1008, exit: 1.099 });
  check("no reset after 2h (old 1h bug): dailyPnl = 0.85 - 1", Math.abs(two.dailyPnl - (-0.15)) < 1e-9, "dailyPnl=" + two.dailyPnl);

  // +25h more (27h total): now it IS a new day → reset.
  advance(25 * HOUR);
  const three = await STORE.recordTrade({ won: true, payout: 0.85, asset: "EURUSD_otc", dir: "CALL", strategy: "confluence", regime: "trending", confidence: 80, entry: 1.1, exit: 1.1008 });
  check("reset happens after 24h: dailyPnl = 0.85 again", Math.abs(three.dailyPnl - 0.85) < 1e-9, "dailyPnl=" + three.dailyPnl);

  const dayKeys = Object.keys(three.byDay || {});
  check("byDay has two distinct UTC days", dayKeys.length === 2, dayKeys.join(","));

  // Stats breakdowns recorded per trade.
  check("byStrategy updated", three.byStrategy.confluence.w === 2 && three.byStrategy.confluence.l === 1);
  check("byAsset updated", three.byAsset.EURUSD_otc.w === 2 && three.byAsset.EURUSD_otc.l === 1);
  check("byRegime updated", three.byRegime.trending.w === 2 && three.byRegime.trending.l === 1);

  const entryTime = FakeDate.now();
  const detailed = await STORE.recordTrade({
    won: true, payout: 0.85, asset: "GBPUSD", dir: "PUT", strategy: "trend",
    regime: "trending", confidence: 77, entry: 1.25, exit: 1.24,
    entryTime, expiryTime: entryTime + 180000, exitTime: entryTime + 180500,
    expiryMinutes: 3,
  });
  const h = detailed.history[0];
  check("trade history keeps entry/expiry/exit times and prices",
    h.entryTime === entryTime && h.expiryTime === entryTime + 180000 &&
    h.exitTime === entryTime + 180500 && h.entryPrice === 1.25 && h.exitPrice === 1.24 && h.expiryMinutes === 3,
    JSON.stringify(h));
}

// ---------- 3. quotex asString big-frame decode ----------
// Build a valid binary Socket.IO frame: byte 0x04 + JSON whose payload
// contains a string of the requested size (spaces are legal in JSON strings,
// so the frame stays parseable at any length).
function makeBinaryFrame(padLen) {
  const json = '[["quotes/stream",["EURUSD_otc",{"pad":"' + " ".repeat(padLen) + '"}]]]';
  const bytes = new Uint8Array(1 + json.length);
  bytes[0] = 4;
  for (let i = 0; i < json.length; i++) bytes[1 + i] = json.charCodeAt(i);
  return bytes;
}

function asStringTest() {
  const u8 = makeBinaryFrame(2 * 1024 * 1024);
  let decoded = null, threw = null;
  try { decoded = Q.decodeFrame(u8); } catch (e) { threw = e && e.message; }
  check("2MB binary frame decodes without stack overflow", threw === null && decoded !== null, "err=" + threw);
  check("2MB frame parsed as binary event", decoded && decoded.type === "bin", decoded && decoded.type);
  check("2MB payload content intact",
    decoded && decoded.payload && decoded.payload[0][0] === "quotes/stream" && decoded.payload[0][1][1].pad.length === 2 * 1024 * 1024,
    "pad=" + (decoded && decoded.payload && decoded.payload[0][1][1].pad.length));

  // ArrayBuffer path + sizes around the old apply() limit and above
  const sizes = [1024, 0x8000 - 1, 0x8000, 0x8000 + 1, 0x10000, 64 * 1024 + 7, 1024 * 1024, 4 * 1024 * 1024];
  let ok = true, detail = "";
  for (const n of sizes) {
    try {
      const d = Q.decodeFrame(makeBinaryFrame(n).buffer);
      if (!d || d.type !== "bin") { ok = false; detail = n + ":type=" + (d && d.type); break; }
    } catch (e) { ok = false; detail = n + ":" + (e && e.message); break; }
  }
  check("frames at every size boundary decode cleanly", ok, detail);

  // non-JSON junk must not throw either
  let ok3 = true;
  try { Q.decodeFrame(new Uint8Array(2 * 1024 * 1024)); } catch (e) { ok3 = false; }
  check("huge non-JSON binary payload doesn't throw", ok3);
}

// ---------- 4. feed stale-tick ordering ----------
function feedTest() {
  const feed = FEED.createFeed({ tfMs: 60000 });
  feed.ingest(1.0, 1000000);        // bar A (bucket 960000)
  feed.ingest(1.001, 1000060);      // still A
  feed.ingest(1.002, 1020000);      // bar B (bucket 1020000) closes A
  const before = feed.series().length; // 2 (A closed + B live)
  const beforePrice = feed.lastPrice();
  check("feed can reject stale tick before any pre-ingest mutation", feed.canIngest(1010000) === false);
  check("feed accepts current/new tick before mutation", feed.canIngest(1020060) === true);
  const stale = feed.ingest(1.05, 1010000); // bucket 960000 < B's 1020000 → stale
  check("stale tick (older bucket) dropped", stale === null, "got=" + JSON.stringify(stale && stale.current));
  check("stale tick cannot overwrite last price", feed.lastPrice() === beforePrice, beforePrice + "→" + feed.lastPrice());
  check("series length unchanged after stale tick", feed.series().length === before, before + "→" + feed.series().length);
  const times = feed.series().map((b) => b.time);
  const sorted = times.every((t, i) => i === 0 || t > times[i - 1]);
  check("series stays strictly ascending", sorted, times.join(","));
  check("current bar is still the newest", feed.series()[feed.series().length - 1].time === 1020000);

  const fresh = feed.ingest(1.01, 1080000); // bucket 1080000 → closes B, new current
  check("newer tick still accepted", fresh && fresh.current.time === 1080000 && fresh.closed && fresh.closed.time === 1020000);

  // mergeCandles order-safety (newest-first broker history)
  const f2 = FEED.createFeed({ tfMs: 60000 });
  f2.mergeCandles([
    { time: 100120, open: 1.01, high: 1.015, low: 1.005, close: 1.012 },
    { time: 100060, open: 1.005, high: 1.02, low: 1.0, close: 1.01 },
    { time: 100000, open: 1, high: 1.01, low: 0.99, close: 1.005 },
  ]);
  const t2 = f2.series().map((b) => b.time);
  check("mergeCandles sorts arbitrary-order history", t2[0] < t2[1] && t2[1] < t2[2], t2.join(","));

  // setSeries with tiny cap keeps the newest bar as live (times are
  // seconds → normalized to ms by setSeries)
  const f3 = FEED.createFeed({ tfMs: 60000, max: 3 });
  const arr = [];
  for (let i = 0; i < 10; i++) arr.push({ time: 100000 + i * 60, open: 1, high: 1.01, low: 0.99, close: 1 });
  const s3 = f3.setSeries(arr);
  check("setSeries caps to max including live without evicting newest",
    s3.length === 3 && s3[2].time === (100000 + 9 * 60) * 1000,
    "len=" + s3.length + " last=" + s3[s3.length - 1].time);
  const cappedMerge = FEED.createFeed({ tfMs: 60000, max: 3 });
  cappedMerge.mergeCandles(arr);
  check("mergeCandles cap includes the current bar", cappedMerge.series().length === 3);
  const cappedSeed = FEED.createFeed({ tfMs: 60000, max: 3 });
  cappedSeed.seedHistory(3, 1);
  check("seedHistory cap includes the current bar", cappedSeed.series().length === 3);

  let malformedFeedSafe = true;
  try {
    const malformed = FEED.createFeed({ tfMs: Symbol("tf"), max: Symbol("max") });
    malformedFeedSafe = malformed.ingest(Symbol("price"), Symbol("time")) === null &&
      malformed.mergeCandles([{ time: Symbol("time"), open: Symbol("open"), close: 1 }]).closed === null &&
      malformed.forceClose(Symbol("time")) === null && malformed.pruneBefore(Symbol("time")) === 0;
    malformed.seedHistory(Symbol("count"), Symbol("price"));
    const synthetic = FEED.syntheticSeries({
      id: "MALFORMED", basePrice: Symbol("base"), vol: Symbol("vol"),
      drift: Symbol("drift"), jumpRate: Symbol("jump"),
    }, 3, { seed: Symbol("seed"), regimePeriod: Symbol("regime"), startTime: Symbol("start") });
    malformedFeedSafe = malformedFeedSafe && synthetic.length === 3 && synthetic.every((bar) =>
      Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close));
  } catch (_) { malformedFeedSafe = false; }
  check("symbol-valued feed and synthetic inputs fail closed", malformedFeedSafe);
}

// ---------- 6. calibration adjust ----------
function calibrationTest() {
  const adjNone = STORE.calibrationAdjust(80, {});
  check("calibrationAdjust with no data returns input", adjNone === 80);
  const adjCold = STORE.calibrationAdjust(80, { 80: { hits: 0, n: 2 } });
  check("calibrationAdjust with <5 samples leaves input", adjCold === 80);
  const adjHot = STORE.calibrationAdjust(80, { 80: { hits: 0, n: 25 } });
  check("calibrationAdjust pulls confidence toward observed 0%", adjHot < 80, "adj=" + adjHot);
  check("calibration cannot collapse a signal bucket to 0% and starve new samples", adjHot === 55, "adj=" + adjHot);
}

async function storageSanitizeTest() {
  await STORE.setCandles("SAN", [
    { time: 1700000120, open: 1.2, high: 1.3, low: 1.1, close: 1.25, extra: { huge: true } },
    { time: 1700000000, open: 1, high: 1.1, low: 0.9, close: 1.05 },
    { time: 1700000000, open: 2, high: 2.1, low: 1.9, close: 2.05 },
  ], 3);
  const candles = await STORE.getCandles("SAN");
  check("stored candles are sorted, deduplicated, and exact-shaped",
    candles.length === 2 && candles[0].time < candles[1].time && candles[0].open === 2 &&
    !Object.prototype.hasOwnProperty.call(candles[1], "extra"), JSON.stringify(candles));

  const protectedTrade = await STORE.recordTrade({
    won: true, asset: "toString", dir: "CALL", strategy: "valueOf", regime: "constructor",
    entry: 1, exit: 1.1,
  });
  check("prototype-collision breakdown keys are rejected",
    protectedTrade.history[0].asset === "UNKNOWN" && protectedTrade.history[0].strategy === "confluence");

  storageMap[KEY].automation = Object.assign({}, storageMap[KEY].automation, { unknownBlob: { nested: "discard" } });
  const automation = await STORE.getAutomation();
  check("unknown persisted automation fields are discarded", !Object.prototype.hasOwnProperty.call(automation, "unknownBlob"));

  STORE.DEFAULTS.settings.strategy = "mutated";
  await STORE.reset();
  check("exported defaults cannot mutate internal reset defaults", (await STORE.getSettings()).strategy === "confluence");
}

async function candleMatchingTest() {
  // 1. Bare array of candle rows without asset/period metadata in payload
  const bareArray = [[1700000000, 1.1945, 1.1948, 1.1942, 1.1946, 100]];
  const parsedBare = Q.parseCandles(bareArray, "EURUSD_otc", 60);
  check("bare candle array parsed with fallback context",
    parsedBare && parsedBare.asset === "EURUSD_otc" && parsedBare.period === 60 && parsedBare.raw.length === 1);

  // 2. Wrapped history object without top-level asset field
  const historyObj = { history: [[1700000000, 1.1945, 1.1948, 1.1942, 1.1946, 100]] };
  const parsedHist = Q.parseCandles(historyObj, "EURUSD_otc", 60);
  check("history payload parsed with fallback context",
    parsedHist && parsedHist.asset === "EURUSD_otc" && parsedHist.period === 60 && parsedHist.raw.length === 1);

  // 3. Candles object without top-level asset field
  const candlesObj = { candles: [[1700000000, 1.1945, 1.1948, 1.1942, 1.1946, 100]] };
  const parsedCandles = Q.parseCandles(candlesObj, "EURUSD_otc", 60);
  check("candles wrapper parsed with fallback context",
    parsedCandles && parsedCandles.asset === "EURUSD_otc" && parsedCandles.period === 60);

  // 4. Quotex tuple vs Standard OHLC tuple vs Object candle normalization
  const qTupleNorm = Q.normalizeCandles({ raw: [[1700000000, 1.1945, 1.1948, 1.1950, 1.1940, 100]] });
  const ohlcTupleNorm = Q.normalizeCandles({ raw: [[1700000000, 1.1945, 1.1950, 1.1940, 1.1948, 100]] });
  const objNorm = Q.normalizeCandles({ raw: [{ time: 1700000000, open: 1.1945, high: 1.1950, low: 1.1940, close: 1.1948, volume: 100 }] });

  check("Quotex tuple normalized correctly",
    qTupleNorm.length === 1 && qTupleNorm[0].open === 1.1945 && qTupleNorm[0].close === 1.1948 &&
    qTupleNorm[0].high === 1.1950 && qTupleNorm[0].low === 1.1940);
  check("Standard OHLC tuple normalized correctly",
    ohlcTupleNorm.length === 1 && ohlcTupleNorm[0].open === 1.1945 && ohlcTupleNorm[0].close === 1.1948 &&
    ohlcTupleNorm[0].high === 1.1950 && ohlcTupleNorm[0].low === 1.1940);
  check("Object candle normalized correctly",
    objNorm.length === 1 && objNorm[0].open === 1.1945 && objNorm[0].close === 1.1948 &&
    objNorm[0].high === 1.1950 && objNorm[0].low === 1.1940);

  // 5. Router emitCandles propagation with fallback asset
  let routerCandles = null;
  const testRouter = Q.createRouter({
    onCandle: (c) => { routerCandles = c; },
  });
  testRouter.dispatch({ type: "sio", event: "instruments/follow", payload: "EURUSD_otc" });
  testRouter.dispatch({ type: "bin", payload: { history: [[1700000000, 1.1945, 1.1948, 1.1950, 1.1940, 100]] } });
  check("router emits candles with current asset when payload is headerless/omits asset",
    routerCandles && routerCandles.asset === "EURUSD_otc" && routerCandles.candles.length === 1 &&
    routerCandles.candles[0].close === 1.1948);
}

async function resetScopeTest() {
  await STORE.setAutomation({ tradesToday: 7 });
  const before = await STORE.getSettings();
  await STORE.resetStats();
  const afterSettings = await STORE.getSettings();
  const afterAutomation = await STORE.getAutomation();
  const afterStats = await STORE.getStats();
  check("history-only reset preserves user settings", afterSettings.stake === before.stake && afterSettings.autoMode === before.autoMode);
  check("history-only reset preserves automation safety ledger", afterAutomation.tradesToday === 7);
  check("history-only reset clears stats", afterStats.wins === 0 && afterStats.losses === 0 && afterStats.history.length === 0);
}

async function main() {
  await raceTest();
  await dailyResetTest();
  asStringTest();
  feedTest();
  calibrationTest();
  await candleMatchingTest();
  await resetScopeTest();
  await storageSanitizeTest();
  console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nall bug-audit tests pass");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("harness error", e); process.exit(2); });
