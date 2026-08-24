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
  // Overlay-mode chart: v4-style marker calls fail and the module must fall
  // back to the overlay canvas, re-projecting on visible-range changes.
  let rangeChangeCb = null;
  let overlayClears = 0;
  const chartB = {
    timeScale: () => ({ subscribeVisibleLogicalRangeChange: (cb) => { rangeChangeCb = cb; } }),
    series: () => [seriesB],
    addCandlestickSeries: () => seriesB,
  };

  // v5 chart: series has NO setMarkers; markers come from
  // LightweightCharts.createSeriesMarkers(series, markers) plugins.
  const pluginCalls = [];
  let pluginTarget = null;
  const plugin = { setMarkers(list) { pluginCalls.push(JSON.parse(JSON.stringify(list))); } };
  const seriesV5a = { setData() {}, update() {}, seriesType: () => "Candlestick" };
  const seriesV5b = { setData() {}, update() {}, seriesType: () => "Candlestick" };
  const lineSeriesV5 = { setData() {}, update() {}, seriesType: () => "Line" };
  let v5CandleCalls = 0;
  const chartV5 = {
    timeScale: () => ({}),
    series: () => [seriesV5a],
    addSeries(def) {
      return def && String(def.type && def.type()) === "Candlestick"
        ? (++v5CandleCalls === 1 ? seriesV5a : seriesV5b)
        : lineSeriesV5;
    },
  };

  // ---- DOM stubs ----
  const ctxStub = {
    setTransform() {}, clearRect() { overlayClears++; }, beginPath() {}, moveTo() {}, lineTo() {},
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
  const timerFns = [];
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
    setTimeout: (fn) => { timerFns.push(fn); return timerFns.length; },
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
  const HK = sandbox.window._xkh && sandbox.window._xkh.markers;
  check("hook exposes markers API", !!HK && typeof HK.applyMarkers === "function", String(HK));

  // History requests are correlated and report the actual socket-send result.
  // Previously content received an uncorrelated event while the dashboard was
  // told success merely because postMessage itself succeeded.
  msgListener({ source: sandbox.window, data: {
    source: "_q1c", kind: "subscribe",
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
  msgListener({ source: sandbox.window, data: { source: "_q1c", kind: "markers", payload: { asset: "EURUSD_otc", markers: [{ time: t0, price: 1.085, dir: "CALL" }], bars: [] } } });
  check("setMarkers failure falls back to overlay mode", HK.mode() === "overlay", HK.mode());
  check("overlay canvas element created", created.some((el) => el.tagName === "canvas"));

  // 2b) overlay arrows must re-project when the chart's visible range moves
  // (scroll / zoom / new bars) instead of freezing at stale pixels.
  check("overlay subscribes to visible-range changes", typeof rangeChangeCb === "function");
  overlayClears = 0;
  rangeChangeCb();
  const redrawTimer = timerFns[timerFns.length - 1];
  check("range change schedules an overlay redraw", typeof redrawTimer === "function");
  if (typeof redrawTimer === "function") redrawTimer();
  check("overlay redraw repaints the canvas", overlayClears >= 1, "clears=" + overlayClears);

  // 2c) v5 chart: series.setMarkers does not exist; markers must render
  // natively through a createSeriesMarkers() plugin glued to the price
  // series, not through the approximate overlay.
  sandbox.window.LightweightCharts = {
    createChart: () => chartV5,
    createSeriesMarkers: (s) => { pluginTarget = s; return plugin; },
  };
  const madeV5 = sandbox.window.LightweightCharts.createChart({});
  // page adds its candlestick through the v5 addSeries(SeriesDefinition) API
  const firstCandle = madeV5.addSeries({ type: () => "Candlestick" }, {});
  check("v5 addSeries(Candlestick) captured as the price series", firstCandle === seriesV5a);
  // a moving average must NOT steal the marker target
  madeV5.addSeries({ type: () => "Line" }, {});
  msgListener({ source: sandbox.window, data: { source: "_q1c", kind: "markers", payload: {
    asset: "EURUSD_otc",
    markers: [{ time: t0, price: 1.085, dir: "PUT" }, { time: t0 + 60000, price: 1.086, dir: "CALL" }],
    bars: [],
  } } });
  check("v5 renders natively via createSeriesMarkers plugin", HK.mode() === "native" && pluginCalls.length >= 1, HK.mode() + " calls=" + pluginCalls.length);
  check("v5 plugin targets the candlestick series", pluginTarget === seriesV5a);
  const pluginList = pluginCalls[pluginCalls.length - 1];
  check("v5 plugin receives timeframe-aligned native list",
    pluginList.length === 2 && pluginList[0].time === Math.floor(Math.floor(t0 / 1000) / 60) * 60 &&
    pluginList[0].shape === "arrowDown" && pluginList[1].shape === "arrowUp",
    JSON.stringify(pluginList));
  // asset/timeframe switch: page re-creates the candlestick series → the
  // plugin must be re-created for the new series (the old one died with it).
  pluginTarget = null;
  madeV5.addSeries({ type: () => "Candlestick" }, {});
  check("v5 re-created price series becomes the marker target", pluginTarget === seriesV5b, String(pluginTarget === seriesV5b));
  check("v5 native mode survives series switch", HK.mode() === "native", HK.mode());

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
    const hk = sandbox2.window._xkh.markers;
    // run the scheduled chart scan → fiber discovery
    for (const fn of intervalFns2) { try { fn(); } catch (_) {} }
    check("fiber scan discovers chart + series", hk.hasChart());
    // send markers through the content protocol
    msgListener2({
      source: sandbox2.window,
      data: { source: "_q1c", kind: "markers", payload: {
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
      data: { source: "_q1c", kind: "markers", payload: {
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
      data: { source: "_q1c", kind: "markers", payload: {
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


// ---------- Part 4: floating-arrow regressions (v2.6.14) ----------
// The live bug: on builds where the chart API is never captured, the overlay
// drew APPROXIMATE arrows (all cached bars spread across the viewport) and
// nothing re-projected on pan/zoom → arrows floated on screen. Rules now:
//   - no chart API → arrows are NOT drawn (a floating arrow is a false visual)
//   - chart captured → exact overlay projection draws and tracks
//   - discovery keeps scanning forever (lazy-mounted charts)
//   - the range watcher re-binds after a chart switch
function floatingArrowTests() {
  const vm = require("vm");
  let fills = 0, clears = 0;
  const ctx2 = {
    setTransform() {}, clearRect() { clears++; }, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() { fills++; }, fillRect() {},
  };
  function el(tag) {
    return {
      tagName: tag, style: {}, children: [], isConnected: true,
      appendChild(c) { this.children.push(c); return c; }, remove() { this.isConnected = false; },
      width: 0, height: 0,
      getContext: tag === "canvas" ? () => ctx2 : undefined,
      getBoundingClientRect: () => ({ width: 900, height: 450, left: 0, top: 0, right: 900, bottom: 450 }),
    };
  }
  const bigCanvas = el("canvas");
  const intervals = [];
  let subCalls = 0;
  let chartApi = null;
  const t0 = 1717000000000;
  const chartStub = () => ({
    timeScale: () => ({
      timeToCoordinate: () => 120,
      subscribeVisibleLogicalRangeChange: () => { subCalls++; },
    }),
    addSeries: () => seriesStub(),
    series: () => [],
  });
  const seriesStub = () => ({
    setData: () => {}, update: () => {},
    priceToCoordinate: () => 200,
    setMarkers: () => { throw new Error("v5 removed setMarkers"); },
  });
  const sandbox = {
    self: {}, console, Date,
    location: { hostname: "qxbroker.com", pathname: "/trade", href: "x", host: "qxbroker.com" },
    navigator: { userAgent: "node-test" },
    postMessage: () => {}, addEventListener: () => {},
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {}, setTimeout: (fn) => (typeof fn === "function" ? (fn(), undefined) : 0),
    devicePixelRatio: 1, WebSocket: function () {},
    document: {
      body: el("body"), documentElement: el("div"),
      createElement: (t) => el(t),
      querySelectorAll: (sel) => (String(sel) === "canvas" ? [bigCanvas] : []),
      contains: () => true,
    },
  };
  sandbox.globalThis = sandbox.self; sandbox.window = sandbox.self;
  sandbox.window.addEventListener = sandbox.addEventListener;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src/page-hook.js"), "utf8"), sandbox);
  const HK = sandbox.window._xkh && sandbox.window._xkh.markers;
  if (!HK || typeof HK.applyMarkers !== "function") { check("floating-arrow hook API", false); return; }

  // bar times live on the period grid (the real feed normalizes them there);
  // the marker anchor may be mid-minute and is bucketed onto the grid.
  const barT = Math.floor(t0 / 60000) * 60000;
  const bars = [
    { time: barT, open: 1.084, high: 1.087, low: 1.083, close: 1.086 },
    { time: barT + 60000, open: 1.086, high: 1.088, low: 1.085, close: 1.087 },
  ];
  const mk = [{ time: t0, price: 1.085, dir: "CALL" }];

  // 1) no chart API anywhere → overlay mode, canvas cleared, ZERO arrows drawn
  HK.applyMarkers({ asset: "EURUSD_otc", period: 60, markers: mk, bars });
  check("no chart API → overlay mode", HK.mode() === "overlay", HK.mode());
  check("no chart API → NO floating arrows drawn (fills=0)", fills === 0, "fills=" + fills);
  check("no chart API → canvas still cleared (no stale frame)", clears >= 1, "clears=" + clears);

  // 2) chart appears later → exact projection draws arrows (suppression is
  //    chart-gated, not dead code)
  chartApi = chartStub();
  sandbox.window.LightweightCharts = { createChart: () => chartApi };
  sandbox.window.LightweightCharts.createChart(bigCanvas);
  check("late-mounted chart captured via global trap", HK.hasChart());
  HK.applyMarkers({ asset: "EURUSD_otc", period: 60, markers: mk, bars });
  check("chart captured → exact-overlay arrows drawn", fills >= 1, "fills=" + fills);
  check("chart captured → range watcher bound", subCalls >= 1, "sub=" + subCalls);

  // 3) chart switch → the watcher must re-bind to the NEW chart's timeScale
  const before = subCalls;
  const bigger = el("div");
  bigger.getBoundingClientRect = () => ({ width: 1200, height: 600, left: 0, top: 0, right: 1200, bottom: 600 });
  const chart2 = chartStub();
  // a NEW library object creates a genuinely different chart (the old trap
  // already wrapped the previous one); bigger container wins the swap
  sandbox.window.LightweightCharts = { createChart: () => chart2 };
  sandbox.window.LightweightCharts.createChart(bigger);
  check("larger chart replaces the marker chart", HK.hasChart());
  check("range watcher re-binds after chart switch", subCalls > before, subCalls + " vs " + before);

  // 4) discovery persists: after the burst, a slow 10s lane is installed and
  //    still finds charts (lazy SPA mounts)
  const burst = intervals.find((i) => i.ms === 2000);
  check("scan burst lane installed", !!burst);
  for (let i = 0; i < 15; i++) burst.fn();
  const slow = intervals.filter((i) => i.ms === 10000);
  check("slow discovery lane installed after burst", slow.length >= 1, "lanes=" + slow.length);
}

storeTests();
hookTests();
floatingArrowTests();

storeTests();
hookTests();

console.log(failed ? "\n" + failed + " FAILURE(S)" : "\nall marker tests pass");
process.exit(failed ? 1 : 0);
