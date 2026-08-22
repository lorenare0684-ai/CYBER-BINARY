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
const chromeStub = {
  runtime: { id: "t", getURL: (p) => p, sendMessage: () => Promise.resolve({ ok: true }), onMessage: { addListener: () => {} }, lastError: null },
  storage: {
    local: {
      get: (key, cb) => {
        const out = {};
        if (typeof key === "string") out[key] = storageMap[key];
        else if (Array.isArray(key)) for (const k of key) out[k] = storageMap[k];
        else Object.assign(out, storageMap);
        if (cb) cb(out);
      },
      set: (obj, cb) => { Object.assign(storageMap, obj); if (cb) cb(); },
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
  const stale = feed.ingest(1.05, 1010000); // bucket 960000 < B's 1020000 → stale
  check("stale tick (older bucket) dropped", stale === null, "got=" + JSON.stringify(stale && stale.current));
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
  check("setSeries caps to max+live without evicting newest",
    s3.length === 3 && s3[2].time === (100000 + 9 * 60) * 1000,
    "len=" + s3.length + " last=" + s3[s3.length - 1].time);
}

// ---------- 6. calibration adjust ----------
function calibrationTest() {
  const adjNone = STORE.calibrationAdjust(80, {});
  check("calibrationAdjust with no data returns input", adjNone === 80);
  const adjCold = STORE.calibrationAdjust(80, { 80: { hits: 0, n: 2 } });
  check("calibrationAdjust with <5 samples leaves input", adjCold === 80);
  const adjHot = STORE.calibrationAdjust(80, { 80: { hits: 0, n: 25 } });
  check("calibrationAdjust pulls confidence toward observed 0%", adjHot < 80, "adj=" + adjHot);
}

async function main() {
  await raceTest();
  await dailyResetTest();
  asStringTest();
  feedTest();
  calibrationTest();
  console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nall bug-audit tests pass");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("harness error", e); process.exit(2); });
