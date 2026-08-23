#!/usr/bin/env node
"use strict";
/**
 * Non-repainting marker regression tests (v2.3.3):
 *
 *   1. src/lib/markers.js store: anchors are immutable + deduped per
 *      (asset, barTime, direction); history seeding; per-asset listing;
 *      budget cap; invalid inputs rejected.
 *   2. src/lib/markers.js toNative(): lightweight-charts setMarkers() format
 *      (UTC seconds, sorted, unique per bar time, shapes/colors).
 *   3. src/page-hook.js rendering:
 *      - LightweightCharts.createChart wrapper captures chart + series;
 *      - content → hook "markers" postMessage renders natively via
 *        series.setMarkers (and is idempotent — the "never repaints" rule);
 *      - React-fiber discovery captures a bundled chart instance;
 *      - setMarkers failure falls back to an overlay canvas.
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

// ---------- Part 1+2: marker store ----------
function storeTests() {
  const sandbox = { self: {}, console };
  sandbox.globalThis = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib/markers.js"), "utf8"), sandbox);
  const M = sandbox.self.CYBER_MARKERS;

  const store = M.createStore({ max: 4 });

  // add + dedupe (same anchor never duplicates)
  const t = 1717000000000;
  check("add returns true on new anchor", store.add({ asset: "EURUSD_otc", time: t, price: 1.0854, dir: "CALL", confidence: 80 }) === true);
  check("add returns false on duplicate anchor", store.add({ asset: "EURUSD_otc", time: t, price: 1.0854, dir: "CALL", confidence: 81 }) === false);
  let l = store.list("EURUSD_otc");
  check("duplicate anchor kept a single marker", l.length === 1 && l[0].confidence === 81, "len=" + l.length + " conf=" + l[0] && l[0].confidence);

  // same bar, other direction → separate marker (allowed in store)
  store.add({ asset: "EURUSD_otc", time: t, price: 1.0854, dir: "PUT", confidence: 70 });
  l = store.list("EURUSD_otc");
  check("same bar + other dir is a separate marker", l.length === 2);

  // fixed anchors: later bars don't change earlier anchors
  store.add({ asset: "EURUSD_otc", time: t + 60000, price: 1.0860, dir: "CALL" });
  store.add({ asset: "EURUSD_otc", time: t + 120000, price: 1.0865, dir: "PUT" });
  l = store.list("EURUSD_otc");
  check("list sorted oldest→newest", l[0].time === t && l[3].time === t + 120000, l.map((m) => m.time).join(","));
  check("earlier anchors unchanged after later adds", l[0].price === 1.0854 && l[0].dir === "CALL");

  // per-asset isolation
  store.add({ asset: "XAUUSD_otc", time: t, price: 2400.5, dir: "CALL" });
  check("per-asset list excludes other assets", store.list("EURUSD_otc").length === 4 && store.list("XAUUSD_otc").length === 1);
  check("list() without asset returns everything", store.list().length === 5);

  // budget cap (max 4 per asset): oldest dropped
  store.add({ asset: "XAUUSD_otc", time: t + 60000, price: 2401, dir: "PUT" });
  store.add({ asset: "XAUUSD_otc", time: t + 120000, price: 2402, dir: "PUT" });
  store.add({ asset: "XAUUSD_otc", time: t + 180000, price: 2403, dir: "PUT" });
  store.add({ asset: "XAUUSD_otc", time: t + 240000, price: 2404, dir: "PUT" });
  const xau = store.list("XAUUSD_otc");
  check("budget cap keeps newest per asset", xau.length === 4 && xau[0].time === t + 60000 && xau[xau.length - 1].time === t + 240000, xau.map((m) => m.time).join(","));

  // invalid inputs rejected
  check("NaN time rejected", store.add({ asset: "A", time: NaN, price: 1, dir: "CALL" }) === false);
  check("unsafe time rejected", store.add({ asset: "A", time: Number.MAX_VALUE, price: 1, dir: "CALL" }) === false);
  check("missing asset rejected", store.add({ time: t, price: 1, dir: "CALL" }) === false);
  check("missing dir rejected", store.add({ asset: "A", time: t, price: 1 }) === false);
  check("non-finite price rejected", store.add({ asset: "A", time: t, price: Infinity, dir: "PUT" }) === false);
  let symbolSafe = true;
  try {
    symbolSafe = store.add({ asset: "A", time: Symbol("time"), price: 1, dir: "CALL" }) === false &&
      store.add({ asset: "A", time: t, price: Symbol("price"), dir: "CALL" }) === false &&
      M.toNative([{ time: Symbol("time"), dir: "CALL" }]).length === 0;
  } catch (_) { symbolSafe = false; }
  check("symbol-valued marker fields fail closed without throwing", symbolSafe);
  const isolated = store.list("EURUSD_otc");
  isolated[0].price = 999;
  isolated[0].time = 1;
  check("list results cannot mutate stored marker anchors",
    store.list("EURUSD_otc")[0].price === 1.0854 && store.list("EURUSD_otc")[0].time === t);
  const fractionalBudget = M.createStore({ max: 0.5 });
  check("fractional marker budget cannot truncate every marker",
    fractionalBudget.add({ asset: "A", time: t, price: 1, dir: "CALL" }) && fractionalBudget.count() === 1);

  // history seeding
  const store2 = M.createStore({});
  const seeded = store2.seedHistory([
    { asset: "EURUSD_otc", at: t, entry: 1.08, dir: "CALL", confidence: 72 },
    { asset: "EURUSD_otc", at: t + 60000, entry: 1.081, dir: "PUT" },
    { asset: "BROKEN", at: null, entry: 1.0, dir: "CALL" },   // skipped
    { asset: "BROKEN", at: t + 120000, entry: null, dir: "PUT" }, // skipped
  ]);
  check("history seeds valid settled trades only", seeded === 2 && store2.list("EURUSD_otc").length === 2);
  check("seeded history is non-repainting too", store2.list("EURUSD_otc")[0].price === 1.08);

  // toNative conversion
  const native = M.toNative([
    { time: t, price: 1.0, dir: "CALL" },
    { time: t + 999, price: 1.0, dir: "PUT" },     // same second as first → deduped (last wins)
    { time: t + 60000, price: 1.0, dir: "PUT" },
    { time: "garbage", price: 1.0, dir: "CALL" },  // skipped
  ]);
  check("toNative converts ms → UTC seconds", native.length === 2 && native[0].time === Math.floor(t / 1000) && native[1].time === Math.floor((t + 60000) / 1000), JSON.stringify(native));
  check("toNative dedupes same-second markers (last wins)", native[0].shape === "arrowDown", JSON.stringify(native));
  check("toNative maps shape/position/color", native[0].shape === "arrowDown" && native[0].position === "aboveBar" && native[1].shape === "arrowDown");
  check("toNative sorts ascending", native[0].time < native[1].time);
  const capped = M.toNative(Array.from({ length: 10 }, (_, i) => ({ time: t + i * 60000, price: 1, dir: i % 2 ? "PUT" : "CALL" })), { cap: 3 });
  check("toNative caps list", capped.length === 3 && capped[0].time === Math.floor((t + 7 * 60000) / 1000), JSON.stringify(capped));
  const micro = M.toNative([{ time: t * 1000, price: 1, dir: "CALL" }]);
  check("toNative normalizes microsecond timestamps", micro.length === 1 && micro[0].time === Math.floor(t / 1000));
  check("fractional native cap falls back safely", M.toNative([{ time: t, dir: "CALL" }], { cap: 0.5 }).length === 1);
}

// ---------- Part 3: page-hook rendering ----------
function hookTests() {
  // ---- fake chart/series ----
  const setMarkersCalls = [];
  const seriesA = {
    setMarkers(list) { setMarkersCalls.push(JSON.parse(JSON.stringify(list))); },
  };
  const chartA = {
    timeScale: () => ({}),
    series: () => [seriesA],
    addCandlestickSeries: () => seriesA,
    addSeries: () => seriesA,
  };

  const seriesB = { setMarkers: () => { throw new Error("setMarkers unsupported"); } };
  const chartB = { timeScale: () => ({}), series: () => [seriesB], addCandlestickSeries: () => seriesB };

  // ---- DOM stubs ----
  const ctxStub = {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, fillRect() {},
  };
  function makeEl(tag) {
    return {
      tagName: tag || "div",
      style: {},
      children: [],
      isConnected: true,
      appendChild(c) { this.children.push(c); return c; },
      remove() { this.isConnected = false; },
      width: 0, height: 0,
      getContext: tag === "canvas" ? () => ctxStub : undefined,
      getBoundingClientRect: () => ({ width: 800, height: 400, left: 10, top: 20, right: 810, bottom: 420 }),
    };
  }
  const body = makeEl("body");
  let created = [];
  const intervalFns = [];
  let msgListener = null;
  const posted = [];

  // React-fiber chart container: memoizedProps carries the chart instance
  const fiberContainer = makeEl("div");
  fiberContainer["__reactFiber$abc123"] = {
    memoizedProps: null,
    memoizedState: null,
    stateNode: null,
    return: {
      memoizedProps: null,
      memoizedState: { next: { next: null }, queue: null },
      stateNode: null,
      return: {
        memoizedProps: { ref: { current: chartA } },
        memoizedState: null,
        stateNode: null,
        return: null,
      },
    },
  };

  const sandbox = {
    self: {}, console, Date,
    location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com" },
    navigator: { userAgent: "node-test" },
    postMessage: (m) => { posted.push(m); },
    addEventListener: () => {},
    setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; },
    clearInterval: () => {},
    setTimeout: () => 0,
    devicePixelRatio: 1,
    WebSocket: function () {},
    document: {
      body,
      documentElement: makeEl("div"),
      createElement: (tag) => { const el = makeEl(tag); created.push(el); return el; },
      querySelectorAll: (sel) => {
        const s = String(sel);
        if (s === "lightweight-chart") return [];
        if (s.indexOf("tv-lightweight-charts") !== -1 || s.indexOf("[class*='chart']") !== -1) return [fiberContainer];
        if (s === "canvas") return [makeEl("canvas")];
        return [];
      },
      contains: () => true,
    },
  };
  sandbox.globalThis = sandbox.self;
  sandbox.window = sandbox.self;
  sandbox.window.postMessage = sandbox.postMessage;
  sandbox.window.addEventListener = (type, fn) => {
    if (type !== "message") return;
    const previous = msgListener;
    msgListener = previous ? (event) => { previous(event); fn(event); } : fn;
  };
  vm.createContext(sandbox);

  // load the REAL built hook (adapter + shell)
  vm.runInContext(fs.readFileSync(path.join(root, "src/page-hook.js"), "utf8"), sandbox);
  const M = sandbox.self.CYBER_MARKERS; // lib loaded inside the hook bundle? no — bundle only has CYBER_QUOTEX
  const HK = sandbox.window.__cyber && sandbox.window.__cyber.markers;
  check("hook exposes markers API", !!HK && typeof HK.applyMarkers === "function", String(HK));

  // History requests are correlated and report the actual socket-send result.
  // Previously content received an uncorrelated event while the dashboard was
  // told success merely because postMessage itself succeeded.
  msgListener({ source: sandbox.window, data: {
    source: "CYBER_BINARY_CONTENT", kind: "subscribe",
    payload: { requestId: "history-test-1", asset: "EURUSD_otc", period: 60, limit: 5000 },
  } });
  const historyAck = posted.filter((m) => m && m.kind === "subscribe_result").pop();
  check("history subscription acknowledgement preserves request identity",
    historyAck && historyAck.payload && historyAck.payload.requestId === "history-test-1");
  check("history subscription surfaces missing socket failure",
    historyAck && historyAck.payload && historyAck.payload.ok === false &&
    /websocket/i.test(String(historyAck.payload.payload && historyAck.payload.payload.error)));

  // 1) LightweightCharts.createChart trap
  const t0 = 1717000000000;
  sandbox.window.LightweightCharts = {
    createChart: () => chartB, // will be wrapped by the hook's setter trap
  };
  // simulate the page creating a chart + series through the wrapped lib
  const made = sandbox.window.LightweightCharts.createChart({});
  check("createChart returns the chart (wrapper transparent)", made === chartB);
  check("chart captured via LightweightCharts trap", HK.hasChart());

  // 2) markers message from content → native render (chartB.setMarkers throws → overlay)
  msgListener({ source: sandbox.window, data: { source: "CYBER_BINARY_CONTENT", kind: "markers", payload: { asset: "EURUSD_otc", markers: [{ time: t0, price: 1.085, dir: "CALL" }], bars: [] } } });
  check("setMarkers failure falls back to overlay mode", HK.mode() === "overlay", HK.mode());
  check("overlay canvas element created", created.some((el) => el.tagName === "canvas"));

  // 3) fiber-discovered chart (chartA) renders natively + idempotently
  const hk2 = (function loadSecondHook() {
    const body2 = makeEl("body");
    const created2 = [];
    const intervalFns2 = [];
    let msgListener2 = null;
    const posted2 = [];
    const sandbox2 = {
      self: {}, console, Date,
      location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com" },
      navigator: { userAgent: "node-test" },
      postMessage: (m) => { posted2.push(m); },
      addEventListener: () => {},
      setInterval: (fn) => { intervalFns2.push(fn); return intervalFns2.length; },
      clearInterval: () => {},
      setTimeout: (fn) => 0,
      devicePixelRatio: 1,
      WebSocket: function () {},
      document: {
        body: body2,
        documentElement: makeEl("div"),
        createElement: (tag) => { const el = makeEl(tag); created2.push(el); return el; },
        querySelectorAll: (sel) => {
          const s = String(sel);
          if (s === "lightweight-chart") return [];
          if (s.indexOf("tv-lightweight-charts") !== -1 || s.indexOf("[class*='chart']") !== -1) return [fiberContainer];
          return [];
        },
        contains: () => true,
      },
    };
    sandbox2.globalThis = sandbox2.self;
    sandbox2.window = sandbox2.self;
    sandbox2.window.postMessage = sandbox2.postMessage;
    sandbox2.window.addEventListener = (type, fn) => {
      if (type !== "message") return;
      const previous = msgListener2;
      msgListener2 = previous ? (event) => { previous(event); fn(event); } : fn;
    };
    vm.createContext(sandbox2);
    vm.runInContext(fs.readFileSync(path.join(root, "src/page-hook.js"), "utf8"), sandbox2);
    const hk = sandbox2.window.__cyber.markers;
    // run the scheduled chart scan → fiber discovery
    for (const fn of intervalFns2) { try { fn(); } catch (_) {} }
    check("fiber scan discovers chart + series", hk.hasChart());
    // send markers through the content protocol
    msgListener2({
      source: sandbox2.window,
      data: { source: "CYBER_BINARY_CONTENT", kind: "markers", payload: {
        asset: "EURUSD_otc",
        markers: [
          { time: t0, price: 1.0850, dir: "CALL" },
          { time: t0 + 60000, price: 1.0855, dir: "PUT" },
        ],
        bars: [],
      } },
    });
    check("native render via setMarkers", hk.mode() === "native" && setMarkersCalls.length >= 1, hk.mode());
    const last = setMarkersCalls[setMarkersCalls.length - 1];
    check("setMarkers got timeframe-aligned UTC-second list",
      last.length === 2 && last[0].time === Math.floor(Math.floor(t0 / 1000) / 60) * 60 &&
      last[0].shape === "arrowUp" && last[1].shape === "arrowDown",
      JSON.stringify(last));
    check("markers sorted ascending", last[0].time < last[1].time);
    // re-send same payload → same normalized list (idempotent, never repaints)
    const before = JSON.stringify(last);
    msgListener2({
      source: sandbox2.window,
      data: { source: "CYBER_BINARY_CONTENT", kind: "markers", payload: {
        asset: "EURUSD_otc",
        markers: [
          { time: t0, price: 1.0850, dir: "CALL" },
          { time: t0 + 60000, price: 1.0855, dir: "PUT" },
        ],
        bars: [],
      } },
    });
    const after = JSON.stringify(setMarkersCalls[setMarkersCalls.length - 1]);
    check("re-render is idempotent (anchors unchanged)", before === after, before + " vs " + after);
    msgListener2({
      source: sandbox2.window,
      data: { source: "CYBER_BINARY_CONTENT", kind: "markers", payload: {
        asset: "EURUSD_otc", period: 300,
        markers: [{ time: t0 + 120000, price: 1.085, dir: "CALL" }],
        bars: [],
      } },
    });
    const fiveMinute = setMarkersCalls[setMarkersCalls.length - 1];
    check("native marker aligns to the visible 5m Quotex candle",
      fiveMinute.length === 1 && fiveMinute[0].time === Math.floor(Math.floor((t0 + 120000) / 1000) / 300) * 300,
      JSON.stringify(fiveMinute));
    return hk;
  })();
  void hk2;
}

storeTests();
hookTests();

console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nall marker tests pass");
process.exit(failed ? 1 : 0);
