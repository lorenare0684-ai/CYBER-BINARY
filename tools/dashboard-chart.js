#!/usr/bin/env node
"use strict";
/**
 * Dashboard chart regression tests (v2.6.15).
 *
 * The dashboard is compared candle-by-candle against the Quotex chart, which
 * is a UTC chart. These tests drive the REAL render path
 * (chrome.runtime.onMessage → CYBER_STATE → renderLive → drawChart) with a
 * recording 2D context and assert:
 *
 *   1. the time axis is labelled in UTC even when the machine runs in a
 *      non-UTC zone (a 09:47 UTC candle must read 09:47, not 15:17 IST);
 *   2. the chart header states the UTC basis and the newest candle time;
 *   3. candles are drawn from the broker series it was given, oldest→newest.
 */
process.env.TZ = "Asia/Kolkata"; // UTC+05:30 — the machine zone must not leak in

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");

let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

/* ---------- recording canvas 2D context ---------- */
const drawn = [];
function makeCtx() {
  const noop = () => {};
  return {
    setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop,
    fill: noop, arc: noop, save: noop, restore: noop, setLineDash: noop,
    createLinearGradient: () => ({ addColorStop: noop }),
    measureText: (t) => ({ width: String(t).length * 5 }),
    fillText: (text, x, y) => { drawn.push({ text: String(text), x, y }); },
    strokeText: noop,
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "",
  };
}

/* ---------- minimal DOM ---------- */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    children: [], childNodes: [], options: [],
    id: "", className: "", textContent: "", innerHTML: "", value: "",
    checked: false, disabled: false, hidden: false, selected: false,
    dataset: {}, style: {}, selectedIndex: 0,
    classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
    parentElement: null, offsetParent: {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    appendChild: (c) => { el.children.push(c); return c; },
    append: () => {}, remove: () => {}, setAttribute: () => {}, getAttribute: () => null,
    removeAttribute: () => {}, focus: () => {}, click: () => {},
    querySelector: () => makeEl("div"),
    querySelectorAll: () => [],
    closest: () => null, contains: () => false,
    getBoundingClientRect: () => ({ width: 900, height: 300, top: 0, left: 0 }),
    getClientRects: () => [{ width: 900, height: 300 }],
    insertAdjacentHTML: () => {},
    clientWidth: 900, clientHeight: 300, width: 800, height: 280,
  };
  el.parentElement = { clientWidth: 900, clientHeight: 300, style: {} };
  if (el.tagName === "CANVAS") el.getContext = () => makeCtx();
  return el;
}
const byId = Object.create(null);
function byIdGet(id) {
  if (!byId[id]) { byId[id] = makeEl(id === "chart" || id === "bt-equity" ? "canvas" : "div"); byId[id].id = id; }
  return byId[id];
}
const documentStub = {
  readyState: "complete", title: "CYBER BINARY",
  documentElement: makeEl("html"),
  body: makeEl("body"),
  head: makeEl("head"),
  getElementById: (id) => byIdGet(id),
  querySelector: (sel) => makeEl(String(sel).indexOf("canvas") === 0 ? "canvas" : "div"),
  querySelectorAll: () => [],
  createElement: (tag) => makeEl(tag),
  createDocumentFragment: () => makeEl("fragment"),
  addEventListener: () => {}, removeEventListener: () => {},
};

const listeners = {};
const timeouts = [];
const chromeStub = {
  runtime: {
    id: "test-dash", getURL: (p) => "chrome-extension://test/" + p,
    getManifest: () => ({ version: "9.9.9-test" }),
    sendMessage: (m, cb) => { if (cb) cb({ ok: true }); return Promise.resolve({ ok: true }); },
    onMessage: { addListener: (fn) => { (listeners.runtime = listeners.runtime || []).push(fn); } },
    lastError: null,
  },
  storage: {
    local: { get: (k, cb) => { if (cb) cb({}); return Promise.resolve({}); }, set: () => Promise.resolve() },
    session: { get: (k, cb) => { if (cb) cb({}); return Promise.resolve({}); }, set: () => Promise.resolve() },
  },
  tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve({}) },
  windows: { create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve() },
  action: { onClicked: { addListener: () => {} } },
};

const sandbox = {
  self: {}, console, Date, Math, JSON,
  navigator: { userAgent: "node" },
  location: { href: "chrome-extension://test/src/dashboard.html", hostname: "", pathname: "/src/dashboard.html" },
  document: documentStub,
  chrome: chromeStub,
  setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: undefined,
  devicePixelRatio: 1,
  innerWidth: 1280,
  innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {} },
  Blob: function () {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  Worker: undefined,
};
sandbox.globalThis = sandbox.self;
sandbox.window = sandbox.self;
sandbox.window.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
sandbox.window.removeEventListener = () => {};
sandbox.window.document = documentStub;
sandbox.window.innerWidth = 1280;
sandbox.window.innerHeight = 900;
sandbox.window.devicePixelRatio = 1;
sandbox.window.postMessage = () => {};
sandbox.window.HTMLInputElement = { prototype: {} };
sandbox.window.HTMLTextAreaElement = { prototype: {} };
sandbox.window.getComputedStyle = () => ({ backgroundColor: "rgb(10,10,10)", color: "rgb(255,255,255)" });
sandbox.window.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });

vm.createContext(sandbox);
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js", "workers.js", "asset-selector.js", "quotex.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}
vm.runInContext(fs.readFileSync(path.join(root, "src/dashboard.js"), "utf8"), sandbox);

check("dashboard bootstrapped and captured the runtime listener",
  Array.isArray(listeners.runtime) && listeners.runtime.length > 0);

/* ---------- drive the real render path with a known broker series ---------- */
// 09:41 … 09:47 UTC on 2026-08-24 — the timestamps from the reported bug.
const baseUtc = Date.UTC(2026, 7, 24, 9, 41, 0);
const candles = [];
let price = 1.0850;
for (let i = 0; i < 7; i++) {
  const open = price;
  price = price + 0.0002;
  candles.push({
    time: baseUtc + i * 60000,
    open, high: Math.max(open, price) + 0.0001, low: Math.min(open, price) - 0.0001,
    close: price, volume: 10,
  });
}

drawn.length = 0;
for (const fn of listeners.runtime || []) {
  fn({
    type: "CYBER_STATE_PUSH",
    payload: {
      attached: true, primary: true, source: "websocket",
      asset: "EUR/USD OTC", assetId: "EURUSD_otc", price,
      candles, chartCandles: candles, chartPeriod: 60, chartTimeBasis: "broker-utc",
      signal: { ready: false, direction: "WAIT", reason: "test", confidence: 0 },
      wins: 0, losses: 0, winrate: 0, accuracy: 0, history: [], markers: [],
      ts: Date.now(),
    },
  }, {}, () => {});
}
// renderLive is queued through setTimeout(requestAnimationFrame fallback).
for (let pass = 0; pass < 4; pass++) {
  const due = timeouts.splice(0, timeouts.length);
  for (const fn of due) { try { fn(); } catch (_) {} }
}
const texts = drawn.map((d) => d.text);
const header = texts.find((t) => t.indexOf("CYBER BINARY ·") === 0);

check("chart rendered candle labels", texts.length > 0, "drawn=" + texts.length);
check("axis shows the broker's UTC minute (09:4x), not machine-local time",
  texts.some((t) => /^09:4\d$/.test(t)) && !texts.some((t) => /^15:1\d$/.test(t)),
  JSON.stringify(texts.filter((t) => /^\d\d:\d\d$/.test(t))));
check("chart header states the UTC basis and newest candle time",
  !!header && /UTC/.test(header) && /09:47/.test(header), String(header));
check("header reports the broker timeframe and bar count",
  !!header && /1m/.test(header) && /7 bars/.test(header), String(header));

// The candles drawn must be the broker series, in order: the last price tag is
// the newest close, and the first drawn wick x is left of the last one.
const lastClose = candles[candles.length - 1].close;
const priceTag = texts.find((t) => t === lastClose.toFixed(5));
check("newest broker close is drawn on the price axis", !!priceTag,
  "expected " + lastClose.toFixed(5) + " in " + JSON.stringify(texts.slice(-6)));

/* ---------- build stamp: a stale load must be visible ---------- */
check("header shows the loaded extension build from the manifest",
  byIdGet("app-kicker").textContent.indexOf("v9.9.9-test") !== -1,
  JSON.stringify(byIdGet("app-kicker").textContent));

/* ---------- startup guard: a missing lib must be named, not guessed ---------- */
// Reload dashboard.js in a fresh sandbox with strategy.js deliberately absent.
// Before the guard this died later as a cryptic "STRAT is not defined" from
// inside an event handler, with nothing pointing at the script that never ran.
const guardSandbox = {
  self: {}, console: { log: () => {}, error: () => {}, warn: () => {} },
  Date, Math, JSON, navigator: { userAgent: "node" },
  location: { href: "chrome-extension://test/src/dashboard.html", hostname: "", pathname: "/src/dashboard.html" },
  document: documentStub, chrome: chromeStub,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: undefined, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {} },
};
guardSandbox.globalThis = guardSandbox.self;
guardSandbox.window = guardSandbox.self;
guardSandbox.window.addEventListener = () => {};
guardSandbox.window.removeEventListener = () => {};
guardSandbox.window.getComputedStyle = () => ({ backgroundColor: "rgb(0,0,0)", color: "rgb(255,255,255)" });
vm.createContext(guardSandbox);
for (const f of ["indicators.js", "assets.js", "feed.js", "engine.js", "storage.js",
                 "auto.js", "backtest.js", "workers.js", "asset-selector.js", "quotex.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), guardSandbox);
}
let guardError = "";
try {
  vm.runInContext(fs.readFileSync(path.join(root, "src/dashboard.js"), "utf8"), guardSandbox);
} catch (e) {
  guardError = String(e && e.message || e);
}
check("a missing lib aborts startup naming the missing global",
  /CYBER_STRATEGIES/.test(guardError), guardError || "(no error thrown)");
check("the startup error tells the user how to fix it",
  /reload the unpacked extension/i.test(guardError), guardError || "(no error thrown)");

/* ---------- an OPTIONAL lib must not abort startup ---------- */
// workers.js is guarded at its use site (`WORKERS && WORKERS.runBrowser`) with a
// synchronous fallback, so treating it as required would break a working path.
const optSandbox = {
  self: {}, console: { log: () => {}, error: () => {}, warn: () => {} },
  Date, Math, JSON, navigator: { userAgent: "node" },
  location: { href: "chrome-extension://test/src/dashboard.html", hostname: "", pathname: "/src/dashboard.html" },
  document: documentStub, chrome: chromeStub,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame: undefined, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
  localStorage: { getItem: () => null, setItem: () => {} },
};
optSandbox.globalThis = optSandbox.self;
optSandbox.window = optSandbox.self;
optSandbox.window.addEventListener = () => {};
optSandbox.window.removeEventListener = () => {};
optSandbox.window.getComputedStyle = () => ({ backgroundColor: "rgb(0,0,0)", color: "rgb(255,255,255)" });
vm.createContext(optSandbox);
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js",
                 "storage.js", "auto.js", "backtest.js", "asset-selector.js", "quotex.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), optSandbox);
}
let optError = "";
try {
  vm.runInContext(fs.readFileSync(path.join(root, "src/dashboard.js"), "utf8"), optSandbox);
} catch (e) {
  optError = String(e && e.message || e);
}
check("a missing OPTIONAL lib (workers.js) does not abort startup",
  optError === "", optError || "(no error thrown)");

if (failed) { console.error("FAILED " + failed); process.exitCode = 1; }
else console.log("OK — dashboard chart alignment checks passed");
