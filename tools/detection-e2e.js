#!/usr/bin/env node
"use strict";
/**
 * End-to-end smoke test for the v2.3 auto-detection pipeline:
 *
 *   page-hook (MAIN world)  →  window.postMessage  →  content.js router
 *
 * Verifies:
 *   1. An `asset` message (from outgoing-frame sniffing) switches the active
 *      asset immediately, including `_otc` symbols.
 *   2. A `tick` message ingests price data into the correct feed.
 *   3. An `instruments` message registers every broker asset (catalog grows
 *      to the full live list).
 *   4. A `snapshot` replay with `lastWsSymbol` restores detection on late
 *      attaches.
 *   5. DOM text-scan detection matches "EUR/USD OTC" from hashed-class DOM.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
// Deterministic intervals: content.js registers its 500ms `tick` loop through
// setInterval; we capture the callback instead of letting it fire on its own.
const intervalFns = [];
const postedMessages = [];
const sandbox = { self: {}, console, globalThis: null, location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com", title: "Quotex" }, navigator: { userAgent: "node" }, Event: function () {}, Notification: undefined, setTimeout: (fn) => 0, clearInterval: () => {}, setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; }, postMessage: (m) => { postedMessages.push(m); } };
sandbox.globalThis = sandbox.self;
sandbox.window = sandbox.self;
sandbox.__contentMsgListeners = [];
sandbox.window.addEventListener = (type, fn) => {
  if (type === "message") sandbox.__contentMsgListeners.push(fn);
};
sandbox.window.postMessage = sandbox.postMessage;

// --- minimal DOM stub -------------------------------------------------------
function makeEl(text, cls) {
  const el = {
    children: [], id: "", className: cls || "", textContent: text || "",
    offsetParent: {}, getClientRects: () => [{ width: 10, height: 10 }],
    querySelectorAll: () => [], closest: () => null,
    addEventListener: () => {}, appendChild: () => {}, remove: () => {},
    innerHTML: "", style: {}, dataset: {},
    querySelector: () => makeEl(""),
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    classList: { add: () => {}, remove: () => {}, toggle: () => {} },
  };
  return el;
}
const domNodes = [
  makeEl("EUR/USD OTC", "sc-hashed123"),
  makeEl("1.0854", "sc-hashed456"),
  makeEl("CYBER BINARY", "cyber-binary-hud"),
];
const documentStub = {
  readyState: "complete",
  title: "Quotex - Trade EUR/USD OTC",
  location: { href: "https://qxbroker.com/en/trade?type=demo" },
  querySelector: () => null,
  querySelectorAll: (sel) => {
    if (sel.includes("#cyber-binary-hud")) return [];
    return domNodes.filter((n) => !/cyber-binary-hud/.test(n.className));
  },
  getElementById: () => null,
  createElement: () => makeEl(""),
  addEventListener: () => {},
  body: makeEl(""),
  documentElement: makeEl(""),
};
sandbox.document = documentStub;

// --- chrome stub ------------------------------------------------------------
const sent = [];
let onMsg = null;
const chromeStub = {
  runtime: {
    id: "test-ext",
    getURL: (p) => "chrome-extension://test/" + p,
    sendMessage: (m) => { sent.push(m); return Promise.resolve({ ok: true }); },
    onMessage: { addListener: (fn) => { onMsg = fn; } },
    lastError: null,
  },
  storage: {
    local: { get: (k, cb) => cb && cb({}), set: () => {} },
    session: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
  },
  tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve({}) },
  windows: { create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve() },
  action: { onClicked: { addListener: () => {} } },
};
sandbox.chrome = chromeStub;

vm.createContext(sandbox);
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js", "quotex.js", "markers.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}
// content.js runs in the ISOLATED world of the page — same sandbox here.
vm.runInContext(fs.readFileSync(path.join(root, "src/content.js"), "utf8"), sandbox);

let failed = 0;
const A = sandbox.self.CYBER_ASSETS;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

function hookMsg(kind, payload) {
  const ev = { data: { source: "CYBER_BINARY_HOOK", kind: kind, payload: payload } };
  const fns = sandbox.__contentMsgListeners || [];
  for (const fn of fns) fn(ev);
}
function lastState() {
  const states = sent.filter((m) => m.type === "CYBER_STATE");
  return states.length ? states[states.length - 1].payload : null;
}
function forceTick() {
  // content.js's pollTimer callback = the first captured interval fn
  for (const fn of intervalFns) { try { fn(); } catch (_) {} }
}

console.log("NOTE: content.js message listener captured count=" + sandbox.__contentMsgListeners.length);
check("content message listener captured", sandbox.__contentMsgListeners.length > 0);

// 0. initial tick after attach: the DOM stub has hashed class names but the
//    visible text "EUR/USD OTC" — the text-scan fallback must detect it
//    (this is the path that was broken with hashed CSS-module class names).
forceTick();
check("DOM text-scan detects EUR/USD OTC at attach", lastState() && lastState().assetId === "EURUSD_otc", lastState() && lastState().assetId);

// v2.3.3: the content script pushes its marker list to the MAIN-world hook
// (kind "markers") so arrows can be drawn on the platform chart.
const markersMsg = postedMessages.find((m) => m && m.kind === "markers");
check("markers message posted to the page hook", !!markersMsg, "posted kinds=" + postedMessages.map((m) => m && m.kind).join(","));
check("markers payload has per-asset list + bars for the overlay",
  markersMsg && Array.isArray(markersMsg.payload && markersMsg.payload.markers) && Array.isArray(markersMsg.payload && markersMsg.payload.bars),
  markersMsg && JSON.stringify(markersMsg.payload && { n: markersMsg.payload.markers.length, bars: markersMsg.payload.bars.length }));
const state0 = lastState();
check("state payload carries markers for the dashboard chart",
  state0 && Array.isArray(state0.markers), state0 && String(state0.markers));

// 1. outgoing-sniff asset message
hookMsg("asset", { symbol: "EURUSD_otc", raw: "ws_out" });
forceTick();
const state1 = lastState();
check("active asset is EURUSD_otc", state1 && state1.payload ? state1.payload.assetId : state1.assetId === "EURUSD_otc", state1 && state1.assetId);

// 2. tick ingest
hookMsg("tick", { price: 1.0855, symbol: "EURUSD_otc", time: Date.now(), raw: "ws" });
forceTick();
const state2 = lastState();
check("tick price ingested", state2 && state2.price === 1.0855, state2 && String(state2.price));

// 3. instruments registration
const before = A.list().length;
const fakeInstruments = [
  { id: 1, symbol: "EURUSD", name: "EUR/USD", type: "currency", payout: 85, isOpen: true, isOtc: false },
  { id: 66, symbol: "EURUSD_otc", name: "EUR/USD", type: "currency", payout: 88, isOpen: true, isOtc: true },
  { id: 999, symbol: "ZZZUSD_otc", name: "Zeta/USD", type: "currency", payout: 82, isOpen: true, isOtc: true },
];
hookMsg("instruments", fakeInstruments);
const after = A.list().length;
check("instruments register into catalog", after === before + 1, before + " -> " + after);
check("ZZZUSD_otc registered", A.get("ZZZUSD_otc") && A.get("ZZZUSD_otc").brokerId === 999);

// 4. snapshot replay with lastWsSymbol
hookMsg("snapshot", {
  status: { state: "authenticated" },
  instruments: [],
  balance: { balance: 1000, currency: "USD", isDemo: true },
  orders: [],
  ticks: {},
  candles: {},
  assetIdMap: {},
  lastWsSymbol: "XAUUSD_otc",
});
forceTick();
const state4 = lastState();
check("snapshot lastWsSymbol drives active asset", state4 && state4.assetId === "XAUUSD_otc", state4 && state4.assetId);

// 5. DOM text-scan: hidden hashed classes, but text "EUR/USD OTC" visible
//    Simulate: remove ws symbol so detection falls back to DOM, then tick.
sandbox.window.__CYBER_BINARY__ = false; // force re-load? no — instead call detect via new asset msg absence:
// We trigger the DOM path by sending a tick for an unknown symbol and then a
// state push; content.js's syncActiveAsset uses lastWsSymbol when set, so to
// exercise the DOM scan we must clear it. We can't reach internals — instead
// verify ASSETS.detect handles the hashed-DOM label correctly (the function
// content.js uses).
const det = A.detect("EUR/USD OTC");
check("DOM text 'EUR/USD OTC' detects", det && det.id === "EURUSD_otc", det && det.id);
const det2 = A.detect("EUR/USD");
check("DOM text 'EUR/USD' detects base", det2 && det2.id === "EURUSD", det2 && det2.id);

// 6. full live list coverage: every instrument symbol resolves via assets
let unresolved = 0;
for (const it of fakeInstruments) {
  const g = A.get(it.symbol);
  if (!g) unresolved++;
}
check("all live instruments resolvable", unresolved === 0);

if (failed) { console.error("FAILED " + failed); process.exit(1); }
console.log("OK — detection pipeline e2e passed");
