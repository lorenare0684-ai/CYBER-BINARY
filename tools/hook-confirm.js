#!/usr/bin/env node
"use strict";
/**
 * MAIN-world hook end-to-end confirmation test (v2.6.15).
 *
 * tools/trade-confirm.js covers the adapter (src/lib/quotex.js) and the
 * content script separately. This one closes the loop on the file that is
 * actually injected into the page — the GENERATED bundle src/page-hook.js
 * (adapter + tools/page-hook.shell.js) — driving the real message path:
 *
 *   content.js  --postMessage(place_ws)-->  shell  --ws.send-->  broker
 *   broker      --43<ackId>[{order}]-->     shell  --postMessage(order)-->  content.js
 *
 * Without this, a wiring mistake in the shell's router handlers (e.g. a
 * missing onOrderError) would pass every other suite while the shipped
 * extension still timed out on every trade.
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

/* ---------- fake broker socket ---------- */
const sockets = [];
function FakeWS(url) {
  this.url = String(url || "");
  this.readyState = 1;
  this.sent = [];
  this._listeners = {};
  sockets.push(this);
}
FakeWS.prototype.addEventListener = function (n, fn) { (this._listeners[n] = this._listeners[n] || []).push(fn); };
FakeWS.prototype.send = function (m) { this.sent.push(String(m)); };
FakeWS.prototype.close = function () { this.readyState = 3; };
FakeWS.prototype.receive = function (data) {
  for (const fn of this._listeners.message || []) fn({ data });
};

/* ---------- DOM stubs (the shell scans for its chart/overlay) ---------- */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    style: {}, children: [], className: "", id: "", textContent: "", innerHTML: "",
    isConnected: true, width: 0, height: 0,
    appendChild(c) { this.children.push(c); return c; },
    remove() { this.isConnected = false; },
    querySelector: () => null, querySelectorAll: () => [],
    getContext: () => ({ setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, fill() {}, fillRect() {}, closePath() {} }),
    getBoundingClientRect: () => ({ width: 800, height: 400, left: 0, top: 0, right: 800, bottom: 400 }),
    addEventListener: () => {}, getClientRects: () => [],
  };
  return el;
}

const posted = [];
let contentListener = null;
const sandbox = {
  console, Date,
  location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com" },
  navigator: { userAgent: "node-test" },
  postMessage: (m) => { posted.push(m); },
  addEventListener: (type, fn) => { if (type === "message") contentListener = fn; },
  setInterval: () => 0, clearInterval: () => {},
  setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
  clearTimeout: () => {},
  devicePixelRatio: 1,
  WebSocket: FakeWS,
  URL,
  document: {
    body: makeEl("body"),
    documentElement: makeEl("html"),
    createElement: (tag) => makeEl(tag),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    contains: () => true,
  },
};
// In the page, window === self === globalThis. The shell reads
// `window.WebSocket`, so these must be the same object as the vm global.
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// The GENERATED bundle — the exact file the manifest injects at document_start.
vm.runInContext(fs.readFileSync(path.join(root, "src/page-hook.js"), "utf8"), sandbox);

// The shell only accepts messages whose `source` is the page window itself.
// Inside a vm context that is the global proxy, not the host sandbox object.
const vmWindow = vm.runInContext("window", sandbox);

check("hook bundle installed its WebSocket wrapper",
  sandbox.window.WebSocket !== FakeWS && typeof sandbox.window.WebSocket === "function");
check("hook exposes the adapter + message bridge",
  !!sandbox.window._xkh && typeof contentListener === "function");

/* ---------- the page opens its broker socket ---------- */
const ws = new sandbox.window.WebSocket("wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket");
ws.receive("40");
ws.receive('42["s_authorization",{"isDemo":1}]');
// The platform announces its main chart by *sending* instruments/update; the
// hook learns the selected asset/period from that outgoing frame.
ws.send('42["instruments/update",{"asset":"EURUSD_otc","period":60}]');
check("the page's own outgoing frames reveal the main chart",
  !!sandbox.window._xkh.live.activeChart &&
  sandbox.window._xkh.live.activeChart.symbol === "EURUSD_otc" &&
  sandbox.window._xkh.live.activeChart.period === 60,
  JSON.stringify(sandbox.window._xkh.live.activeChart));

function hookMessages(kind) {
  return posted.filter((m) => m && m.source === "_q1h" && m.kind === kind);
}
function contentSend(payload) {
  contentListener({ source: vmWindow, data: Object.assign({ source: "_q1c" }, payload) });
}

/* ---------- 1. placement: content.js asks the page to place an order ---------- */
const requestId = "1787564761000111";
contentSend({ kind: "place_ws", payload: {
  requestId, asset: "EURUSD_otc", dir: "CALL", amount: 5, expirySec: 60, isDemo: true,
} });

const sendResult = hookMessages("ws_result").pop();
check("hook reports the socket send result back to content.js",
  !!sendResult && sendResult.payload && sendResult.payload.ok === true &&
  sendResult.payload.requestId === requestId,
  JSON.stringify(sendResult && sendResult.payload));

const orderFrame = ws.sent.find((s) => s.indexOf("orders/open") !== -1);
check("the page socket emitted orders/open with a callback id",
  !!orderFrame && /^42\d+\["orders\/open",/.test(orderFrame), orderFrame);
const ackId = orderFrame ? orderFrame.slice(2, orderFrame.indexOf("[")) : "";
check("orders/open carries the asset/direction/amount we asked for",
  !!orderFrame && /"asset":"EURUSD_otc"/.test(orderFrame) && /"action":"call"/.test(orderFrame) &&
  /"amount":5/.test(orderFrame), orderFrame);

/* ---------- 2. the broker answers on the ACK channel ---------- */
posted.length = 0;
ws.receive('43' + ackId + '[{"id":555001,"openPrice":1.0855,"openTime":1787564761,"closeTime":1787564821}]');

const orderMsg = hookMessages("order").pop();
check("ACK on the page socket becomes an order event for content.js",
  !!orderMsg && orderMsg.payload && orderMsg.payload.kind === "opened",
  JSON.stringify(hookMessages("order").map((m) => m.payload)));
check("that order carries OUR requestId (the confirmation key)",
  !!orderMsg && orderMsg.payload.data.requestId === requestId,
  JSON.stringify(orderMsg && orderMsg.payload.data));
check("the broker order id and open price survive the round trip",
  !!orderMsg && orderMsg.payload.data.id === "555001" && orderMsg.payload.data.openPrice === 1.0855,
  JSON.stringify(orderMsg && orderMsg.payload.data));

/* ---------- 3. a rejection ACK reports the broker's own reason ---------- */
posted.length = 0;
contentSend({ kind: "place_ws", payload: {
  requestId: "1787564761000222", asset: "EURUSD_otc", dir: "PUT", amount: 7, expirySec: 60, isDemo: true,
} });
const orderFrame2 = ws.sent.filter((s) => s.indexOf("orders/open") !== -1).pop();
const ackId2 = orderFrame2.slice(2, orderFrame2.indexOf("["));
ws.receive('43' + ackId2 + '[{"error":"Not enough funds"}]');

const errorMsg = hookMessages("order_error").pop();
check("a rejected order surfaces the broker reason to content.js",
  !!errorMsg && /Not enough funds/i.test(errorMsg.payload.error) &&
  errorMsg.payload.requestId === "1787564761000222",
  JSON.stringify(errorMsg && errorMsg.payload));
check("a rejected order is NOT reported as an opened trade",
  hookMessages("order").length === 0, JSON.stringify(hookMessages("order").map((m) => m.payload)));

/* ---------- 4. the account-wide order push still reaches content.js ---------- */
posted.length = 0;
ws.receive('42["s_orders/open",[{"id":555002,"asset":"EURUSD_otc","command":0,"amount":5,"openPrice":1.086,"openTime":1787564761,"closeTime":1787564821}]]');
const pushMsg = hookMessages("order").pop();
check("account order-open push is forwarded (fallback confirmation source)",
  !!pushMsg && pushMsg.payload.kind === "opened" && pushMsg.payload.data.asset === "EURUSD_otc" &&
  pushMsg.payload.data.direction === "CALL",
  JSON.stringify(pushMsg && pushMsg.payload.data));

if (failed) { console.error("FAILED " + failed); process.exitCode = 1; }
else console.log("OK — MAIN-world hook confirmation round trip passed");
