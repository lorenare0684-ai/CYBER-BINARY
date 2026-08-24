#!/usr/bin/env node
"use strict";
/**
 * Broker trade-confirmation regression tests (v2.6.15).
 *
 * Reproduces the "Trade not confirmed: broker order confirmation timeout"
 * failure end to end:
 *
 *   1. `orders/open` is now sent with a Socket.IO callback id, so the broker
 *      answers on the ACK channel (43<ackId>[{order…}]).
 *   2. decodeFrame() treats a 43 packet whose first element is an object as
 *      an ACK body (and still decodes the headered 43["tick",{…}] variant).
 *   3. The router attributes that ACK to the request that sent it and emits
 *      an `opened` order carrying OUR requestId — the value content.js waits
 *      on. A minimal ACK body still confirms, filled from the request.
 *   4. A rejection ACK surfaces the broker's own reason (orderError) instead
 *      of a generic timeout.
 *   5. content.js: a WS placement is confirmed by a strictly matching
 *      account order-open push that carries no requestId at all, and reports
 *      the broker's rejection text when the ACK is an error.
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

/* ===================================================================
 * Part 1 — adapter: ACK wire format + correlation
 * =================================================================== */
function adapterTests() {
  const sandbox = { self: {}, console, Date, location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade" }, navigator: { userAgent: "node" } };
  sandbox.globalThis = sandbox.self;
  sandbox.window = sandbox.self;
  sandbox.window.HTMLInputElement = { prototype: {} };
  sandbox.window.HTMLTextAreaElement = { prototype: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib/quotex.js"), "utf8"), sandbox);
  const Q = sandbox.self.CYBER_QUOTEX;

  // --- wire format -------------------------------------------------
  const headered = Q.decodeFrame('43["tick",{"tick":[["EURUSD_otc",1700000000000,1.0857]]}]');
  check("headered 43[\"event\",…] still decodes as an event",
    headered && headered.event === "tick" && Q.normalizeEvent(headered) === "quote",
    headered && JSON.stringify({ event: headered.event, norm: Q.normalizeEvent(headered) }));

  const ack = Q.decodeFrame('43900001[{"id":777,"openPrice":1.0855}]');
  check("43<ackId>[{order}] decodes as an ACK body",
    ack && ack.type === "sio" && ack.ack === true && ack.ackBody === true &&
    ack.id === 900001 && ack.payload && ack.payload.id === 777,
    ack && JSON.stringify({ type: ack.type, ack: ack.ack, body: ack.ackBody, id: ack.id, payload: ack.payload }));

  // --- placement carries a callback id ------------------------------
  const sentFrames = [];
  const fakeWs = { readyState: 1, send: (s) => { sentFrames.push(String(s)); } };
  const placed = Q.placeTradeWs(fakeWs, {
    asset: "EURUSD_otc", dir: "CALL", amount: 5, expirySec: 60, isDemo: true, requestId: "1700000000000123",
  });
  const orderFrame = sentFrames.find((s) => s.indexOf("orders/open") !== -1);
  check("placeTradeWs succeeds on an open socket", placed && placed.ok === true && placed.sent === true,
    placed && placed.error);
  check("orders/open is sent with a Socket.IO callback id",
    !!orderFrame && /^42\d+\["orders\/open",/.test(orderFrame), orderFrame);
  check("placeTradeWs reports the ack id it registered",
    placed && Number.isInteger(placed.ackId) && placed.ackId > 0, placed && String(placed.ackId));
  const frameAckId = orderFrame ? Number(orderFrame.slice(2, orderFrame.indexOf("["))) : null;
  check("the ack id on the wire matches the reported one", frameAckId === placed.ackId,
    "wire=" + frameAckId + " reported=" + (placed && placed.ackId));

  // --- ACK correlation ---------------------------------------------
  const opened = [];
  const errors = [];
  const router = Q.createRouter({
    onOrder: (e) => opened.push(e),
    onOrderError: (e) => errors.push(e),
  });
  router.feedRaw('43' + placed.ackId + '[{"id":777,"openPrice":1.0855,"openTime":1700000000}]');
  check("ACK is routed as an opened order", opened.length === 1 && opened[0].kind === "opened",
    JSON.stringify(opened));
  check("ACK order carries OUR requestId (content.js correlation key)",
    opened[0] && opened[0].data && opened[0].data.requestId === "1700000000000123",
    opened[0] && JSON.stringify(opened[0].data));
  check("ACK order keeps the broker id + open price",
    opened[0] && opened[0].data.id === "777" && opened[0].data.openPrice === 1.0855,
    opened[0] && JSON.stringify(opened[0].data));

  // A bare ACK ({"id":…} only) must still confirm: asset/dir/amount come from
  // the request the ack id proves this answer belongs to.
  const placed2 = Q.placeTradeWs(fakeWs, {
    asset: "GBPUSD_otc", dir: "PUT", amount: 12.5, expirySec: 120, isDemo: true, requestId: "1700000000000999",
  });
  opened.length = 0;
  router.feedRaw('43' + placed2.ackId + '[{"id":888}]');
  check("minimal ACK still confirms the placement",
    opened.length === 1 && opened[0].data.requestId === "1700000000000999" &&
    opened[0].data.asset === "GBPUSD_otc" && opened[0].data.direction === "PUT" &&
    opened[0].data.amount === 12.5,
    opened[0] && JSON.stringify(opened[0].data));

  // --- rejection ACK ------------------------------------------------
  const placed3 = Q.placeTradeWs(fakeWs, {
    asset: "EURUSD_otc", dir: "CALL", amount: 5, expirySec: 60, isDemo: true, requestId: "1700000000000555",
  });
  opened.length = 0;
  router.feedRaw('43' + placed3.ackId + '[{"error":"Not enough funds"}]');
  check("rejection ACK reports the broker reason",
    errors.length === 1 && /Not enough funds/i.test(errors[0].error) &&
    errors[0].requestId === "1700000000000555" && opened.length === 0,
    JSON.stringify({ errors, opened }));

  // An ACK for an unknown id must not fabricate a confirmation.
  opened.length = 0; errors.length = 0;
  router.feedRaw('43123456[{"id":999,"openPrice":1.1}]');
  check("unrelated ACK is not attributed to a pending placement",
    opened.length === 1 && (opened[0].data.requestId == null || opened[0].data.requestId === ""),
    JSON.stringify(opened[0] && opened[0].data));

  // --- the authorization frame is also the account snapshot ------------
  // Quotex reports {uid, balance, isDemo, currency} inside s_authorization,
  // and for many sessions that is the only balance frame that ever arrives.
  // mapEventName maps it to "authenticated", so the status branch used to
  // swallow the balance and the dashboard sat on "waiting for a balance event".
  const balances = [];
  const statuses = [];
  const acctRouter = Q.createRouter({
    onBalance: (b) => balances.push(b),
    onStatus: (s) => statuses.push(s),
  });
  acctRouter.feedRaw('42["s_authorization",{"uid":4242,"balance":1337.42,"currency":"USD","isDemo":1}]');
  check("s_authorization still reports the authenticated status",
    statuses.some((s) => s && s.state === "authenticated"), JSON.stringify(statuses));
  check("s_authorization also yields the account balance",
    balances.length === 1 && balances[0].balance === 1337.42 &&
    balances[0].currency === "USD" && balances[0].isDemo === true,
    JSON.stringify(balances));

  // A dedicated balance frame must keep working unchanged.
  balances.length = 0;
  acctRouter.feedRaw('42["s_balance",{"uid":4242,"balance":900.5,"currency":"USD","isDemo":0}]');
  check("a dedicated s_balance frame still yields the balance",
    balances.length === 1 && balances[0].balance === 900.5 && balances[0].isDemo === false,
    JSON.stringify(balances));

  // An authorization frame that carries no account fields must not invent one.
  balances.length = 0;
  acctRouter.feedRaw('42["s_authorization",{"status":"ok"}]');
  check("an authorization frame with no account fields invents no balance",
    balances.length === 0, JSON.stringify(balances));
}

/* ===================================================================
 * Part 2 — content.js: confirmation through the real message router
 * =================================================================== */
const RealDate = Date;
let fakeNow = Date.UTC(2026, 7, 24, 9, 45, 0);
class FakeDate extends RealDate {}
FakeDate.now = () => fakeNow;

function contentTests() {
  const timers = [];
  let nextTimerId = 1;
  const postedMessages = [];
  const sent = [];
  const intervalFns = [];
  let onMsg = null;

  const sandbox = {
    self: {}, console, Date: FakeDate, globalThis: null,
    location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com", title: "Quotex" },
    navigator: { userAgent: "node" },
    Event: function (t) { this.type = t; },
    Notification: function () {},
    setTimeout: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, at: fakeNow + (Number(ms) || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; },
    clearInterval: () => {},
    postMessage: (m) => { postedMessages.push(m); },
  };
  sandbox.globalThis = sandbox.self;
  sandbox.window = sandbox.self;
  sandbox.__contentMsgListeners = [];
  sandbox.window.addEventListener = (type, fn) => {
    if (type === "message") sandbox.__contentMsgListeners.push(fn);
  };
  sandbox.window.postMessage = sandbox.postMessage;

  function makeEl(text, cls) {
    return {
      children: [], id: "", className: cls || "", textContent: text || "",
      offsetParent: {}, getClientRects: () => [{ width: 10, height: 10 }],
      querySelectorAll: () => [], closest: () => null, addEventListener: () => {},
      appendChild: () => {}, remove: () => {}, innerHTML: "", style: {}, dataset: {},
      querySelector: () => makeEl(""), getBoundingClientRect: () => ({ width: 10, height: 10 }),
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    };
  }
  sandbox.document = {
    readyState: "complete", title: "Quotex - Trade EUR/USD OTC",
    location: { href: "https://qxbroker.com/en/trade?type=demo" },
    querySelector: () => null,
    querySelectorAll: (sel) => (String(sel).indexOf("#cyber-binary-hud") !== -1 ? [] : [makeEl("EUR/USD OTC", "sc-h")]),
    getElementById: () => null, createElement: () => makeEl(""), addEventListener: () => {},
    body: makeEl(""), documentElement: makeEl(""),
  };

  // chrome.storage with the patch protocol storage.js uses.
  const storageMap = {};
  // Seed recorded per-strategy outcomes so the adaptive router has a real
  // track record to route on (sniper strong, scalp weak).
  storageMap.cyberBinaryV2 = {
    stats: {
      wins: 35, losses: 35,
      byStrategy: { sniper: { w: 30, l: 5 }, scalp: { w: 5, l: 30 } },
    },
  };
  function applyStoragePatch(patch) {
    const key = "cyberBinaryV2";
    const state = storageMap[key] && typeof storageMap[key] === "object" ? JSON.parse(JSON.stringify(storageMap[key])) : {};
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
  sandbox.chrome = {
    runtime: {
      id: "test-ext", getURL: (p) => "chrome-extension://test/" + p,
      sendMessage: (m) => {
        sent.push(m);
        if (m && m.type === "CYBER_STORAGE_PATCH") applyStoragePatch(m.patch);
        if (m && m.type === "CYBER_IS_PRIMARY") return Promise.resolve({ ok: true, primary: true });
        return Promise.resolve({ ok: true, primary: true });
      },
      onMessage: { addListener: (fn) => { onMsg = fn; } },
      lastError: null,
    },
    storage: {
      local: {
        get: (key, cb) => {
          const out = {};
          if (typeof key === "string") out[key] = storageMap[key];
          else if (Array.isArray(key)) for (const k of key) out[k] = storageMap[k];
          else Object.assign(out, storageMap);
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: (obj, cb) => { Object.assign(storageMap, obj); if (cb) cb(); return Promise.resolve(); },
      },
      session: { get: (k, cb) => { if (cb) cb({}); return Promise.resolve({}); }, set: () => Promise.resolve() },
    },
    tabs: { query: (q, cb) => cb && cb([]), sendMessage: () => Promise.resolve({}) },
    windows: { create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve() },
    action: { onClicked: { addListener: () => {} } },
  };

  vm.createContext(sandbox);
  for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js", "quotex.js", "markers.js"]) {
    vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
  }
  vm.runInContext(fs.readFileSync(path.join(root, "src/content.js"), "utf8"), sandbox);

  function hookMsg(kind, payload) {
    const ev = { source: sandbox.window, data: { source: "CYBER_BINARY_HOOK", kind, payload } };
    for (const fn of sandbox.__contentMsgListeners || []) fn(ev);
  }
  function runDue() {
    for (let pass = 0; pass < 6; pass++) {
      const due = timers.filter((t) => t.at <= fakeNow);
      if (!due.length) break;
      for (const t of due) {
        const i = timers.indexOf(t);
        if (i >= 0) timers.splice(i, 1);
        try { t.fn(); } catch (_) {}
      }
    }
  }
  async function settle() {
    for (let i = 0; i < 12; i++) { runDue(); await new Promise((r) => setImmediate(r)); }
  }
  function forceTick() {
    fakeNow += 1000;
    runDue();
    for (const fn of intervalFns) { try { fn(); } catch (_) {} }
    runDue();
  }
  function decisions() { return sent.filter((m) => m.type === "CYBER_AUTO_DECISION").map((m) => m.payload); }
  function lastState() {
    const states = sent.filter((m) => m.type === "CYBER_STATE");
    return states.length ? states[states.length - 1].payload : null;
  }

  return (async () => {
    // Authoritative main chart + a verified 1m history batch.
    hookMsg("asset", { symbol: "EURUSD_otc", period: 60, main: true });
    hookMsg("balance", { balance: 1000, currency: "USD", isDemo: true, uid: 1 });
    const minute = Math.floor(fakeNow / 60000) * 60000;
    const candles = [];
    let px = 1.085;
    for (let i = 70; i >= 1; i--) {
      const t = minute - i * 60000;
      const open = px;
      px = px * (1 + (i % 7 === 0 ? 0.0006 : 0.0002));
      candles.push({ time: t, open, high: Math.max(open, px) * 1.0001, low: Math.min(open, px) * 0.9999, close: px, volume: 10 });
    }
    hookMsg("candle", { asset: "EURUSD_otc", period: 60, candles, verified: true });
    await settle();

    // Arm click-mode automation.
    applyStoragePatch([{ path: ["settings"], value: {
      autoMode: "click", armed: true, stake: 5, expiry: 1, cooldownBars: 0, minConfidence: 0,
      minIntervalMs: 0, maxTradesPerHour: 100, maxTradesPerDay: 1000, accountMode: "any",
      stakeMode: "fixed", minBalance: 0, strategy: "auto_adaptive", calibration: false,
    } }]);
    await settle();
    onMsg({ type: "CYBER_SET_AUTO", mode: "click", armed: true }, {}, () => {});
    await settle();

    // Force a fresh CALL on the next closed bar (engine output is stubbed so
    // the test exercises placement/confirmation, not signal generation).
    const ENG = sandbox.self.CYBER_ENGINE;
    const realGate = ENG.liveSignalGate;
    ENG.liveSignalGate = () => ({ allowed: true, reason: "test" });
    const analyzeOpts = [];
    ENG.analyze = (candles, o) => {
      analyzeOpts.push(o);
      return {
        ready: true, direction: "CALL", confidence: 88, score: 9, regime: "trending",
        reason: "test", votes: [], metrics: {},
      };
    };

    // --- A. account order-open push without a requestId confirms the WS trade
    fakeNow = minute + 60000;              // a new bar closes
    forceTick();
    await settle();
    const placeMsg = postedMessages.filter((m) => m && m.kind === "place_ws").pop();
    check("WS placement frame handed to the page hook", !!placeMsg, JSON.stringify(postedMessages.map((m) => m && m.kind)));
    const requestId = placeMsg && placeMsg.payload && placeMsg.payload.requestId;
    check("placement carries a numeric requestId", !!requestId && /^\d+$/.test(String(requestId)), String(requestId));

    hookMsg("ws_result", { ok: true, sent: true, requestId });
    await settle();
    // The broker pushes the new deal for the account WITHOUT echoing our id.
    hookMsg("order", {
      kind: "opened",
      data: { id: "9001", asset: "EURUSD_otc", direction: "CALL", amount: 5, openPrice: 1.086, openTime: fakeNow, closeTime: fakeNow + 60000, duration: 60 },
    });
    await settle();
    const confirmed = decisions();
    check("un-correlated broker order-open push confirms the WS trade",
      confirmed.length === 1 && confirmed[0].ok === true,
      JSON.stringify(confirmed.map((d) => ({ ok: d.ok, reason: d.blockedReason }))));
    check("confirmed trade is recorded by the controller",
      confirmed[0] && confirmed[0].action && confirmed[0].action.confirmed === true,
      JSON.stringify(confirmed[0] && confirmed[0].action));

    // A new placement only happens when a genuinely new bar closes.
    async function closeNewBar(price) {
      fakeNow = Math.floor(fakeNow / 60000) * 60000 + 60000 + 500;
      hookMsg("tick", { symbol: "EURUSD_otc", price, time: fakeNow, main: true });
      await settle();
      forceTick();
      await settle();
    }

    // --- B. a broker rejection ACK surfaces the real reason
    await closeNewBar(px * 1.0002);
    const placeMsg2 = postedMessages.filter((m) => m && m.kind === "place_ws").pop();
    const requestId2 = placeMsg2 && placeMsg2.payload && placeMsg2.payload.requestId;
    check("a second placement uses a new requestId", !!requestId2 && requestId2 !== requestId, String(requestId2));
    hookMsg("ws_result", { ok: true, sent: true, requestId: requestId2 });
    hookMsg("order_error", { requestId: requestId2, error: "Not enough funds" });
    await settle();
    const afterReject = decisions();
    const rejected = afterReject[afterReject.length - 1];
    check("broker rejection text reaches the automation log",
      afterReject.length === 2 && rejected.ok === false && /Not enough funds/i.test(rejected.blockedReason || ""),
      JSON.stringify(rejected));

    // --- C. no confirmation at all still fails closed with a timeout
    await closeNewBar(px * 1.0004);
    const placeMsg3 = postedMessages.filter((m) => m && m.kind === "place_ws").pop();
    const requestId3 = placeMsg3 && placeMsg3.payload && placeMsg3.payload.requestId;
    hookMsg("ws_result", { ok: true, sent: true, requestId: requestId3 });
    await settle();
    fakeNow += 9000;
    runDue();
    await settle();
    const afterTimeout = decisions();
    const timedOut = afterTimeout[afterTimeout.length - 1];
    check("silence still fails closed as a confirmation timeout",
      afterTimeout.length === 3 && timedOut.ok === false && /confirmation timeout/i.test(timedOut.blockedReason || ""),
      JSON.stringify(timedOut));

    // --- D. the dashboard chart series follows the live tick
    ENG.liveSignalGate = realGate;
    const beforeChart = lastState();
    check("chart series is the broker batch for the selected timeframe",
      beforeChart && Array.isArray(beforeChart.chartCandles) && beforeChart.chartCandles.length > 40 &&
      beforeChart.chartPeriod === 60,
      beforeChart && JSON.stringify({ n: (beforeChart.chartCandles || []).length, p: beforeChart.chartPeriod }));
    const lastBrokerClose = beforeChart.chartCandles[beforeChart.chartCandles.length - 1].close;
    const lastBrokerTime = beforeChart.chartCandles[beforeChart.chartCandles.length - 1].time;
    const livePrice = lastBrokerClose * 1.0004;
    hookMsg("tick", { symbol: "EURUSD_otc", price: livePrice, time: lastBrokerTime + 30000, main: true });
    forceTick();
    await settle();
    const afterChart = lastState();
    const lastChartBar = afterChart.chartCandles[afterChart.chartCandles.length - 1];
    check("newest chart candle follows the live tick (matches the platform)",
      Math.abs(lastChartBar.close - livePrice) < 1e-12,
      "close=" + lastChartBar.close + " tick=" + livePrice);
    check("closed chart candles stay exactly as the broker sent them",
      afterChart.chartCandles[afterChart.chartCandles.length - 2].close ===
        beforeChart.chartCandles[beforeChart.chartCandles.length - 2].close &&
      afterChart.chartCandles[0].time === beforeChart.chartCandles[0].time,
      JSON.stringify({
        now: afterChart.chartCandles[afterChart.chartCandles.length - 2].close,
        was: beforeChart.chartCandles[beforeChart.chartCandles.length - 2].close,
      }));
    check("the live bar extends the newest broker bucket (no duplicate bar)",
      lastChartBar.time === lastBrokerTime &&
      afterChart.chartCandles.length === beforeChart.chartCandles.length,
      "len " + beforeChart.chartCandles.length + " -> " + afterChart.chartCandles.length);

    // --- E. higher timeframe: broker 5m candles stay intact, only the
    //        forming 5m bucket follows the live 1m feed.
    postedMessages.length = 0;
    hookMsg("asset", { symbol: "EURUSD_otc", period: 300, main: true });
    forceTick();
    await settle();
    const fiveMinSubs = postedMessages.filter((m) => m && m.kind === "subscribe" &&
      m.payload && Number(m.payload.period) === 300);
    check("switching the platform timeframe requests that timeframe's history",
      fiveMinSubs.length >= 1 && fiveMinSubs[0].payload.asset === "EURUSD_otc",
      JSON.stringify(postedMessages.filter((m) => m && m.kind === "subscribe").map((m) => m.payload)));
    const fiveMin = Math.floor(fakeNow / 300000) * 300000;
    const broker5m = [];
    let p5 = 1.09;
    for (let i = 5; i >= 0; i--) {
      const t = fiveMin - i * 300000;
      const open = p5;
      p5 = p5 * 1.0008;
      broker5m.push({ time: t, open, high: Math.max(open, p5) * 1.0002, low: Math.min(open, p5) * 0.9998, close: p5, volume: 40 });
    }
    hookMsg("candle", { asset: "EURUSD_otc", period: 300, candles: broker5m, verified: true });
    await settle();
    forceTick();
    await settle();
    const chart5 = lastState();
    check("5m chart uses the broker timeframe",
      chart5 && chart5.chartPeriod === 300 && chart5.chartCandles.length === broker5m.length,
      chart5 && JSON.stringify({ p: chart5.chartPeriod, n: (chart5.chartCandles || []).length }));
    check("closed 5m candles are the broker's own (not resampled ticks)",
      chart5.chartCandles.every((bar, i) => i === broker5m.length - 1 ||
        Math.abs(bar.close - broker5m[i].close) < 1e-12),
      JSON.stringify(chart5.chartCandles.map((b) => b.close).concat(broker5m.map((b) => b.close))));
    // A live tick inside the forming 5m bucket (broker 5m bars are anchored
    // on the same UTC epoch grid, so the buckets line up exactly).
    const live5 = 1.096;
    hookMsg("tick", { symbol: "EURUSD_otc", price: live5, time: fakeNow, main: true });
    forceTick();
    await settle();
    const chart5b = lastState();
    check("forming 5m candle follows the live tick",
      Math.abs(chart5b.chartCandles[chart5b.chartCandles.length - 1].close - live5) < 1e-12 &&
      chart5b.chartCandles.length === broker5m.length,
      "close=" + chart5b.chartCandles[chart5b.chartCandles.length - 1].close + " tick=" + live5 +
      " n=" + chart5b.chartCandles.length);
    check("the live 5m bucket is the broker's newest bucket (no extra bar)",
      chart5b.chartCandles[chart5b.chartCandles.length - 1].time === broker5m[broker5m.length - 1].time,
      "chart=" + chart5b.chartCandles[chart5b.chartCandles.length - 1].time +
      " broker=" + broker5m[broker5m.length - 1].time);

    // --- L. the adaptive router must route on recorded accuracy ---
    // Tick across two minute boundaries so a genuinely new bar closes and the
    // engine is re-run (maybeSignal caches on the closed bar's key).
    const baseMin = Math.floor(fakeNow / 60000) * 60000;
    for (let k = 1; k <= 2; k++) {
      fakeNow = baseMin + k * 60000;
      hookMsg("tick", { symbol: "EURUSD_otc", price: 1.086 + k * 0.0001, time: fakeNow, main: true });
      forceTick();
      await settle();
    }
    const adaptiveOpts = analyzeOpts.filter((o) => o && o.strategy === "auto_adaptive").pop();
    check("auto_adaptive analysis receives recorded per-strategy win rates",
      !!adaptiveOpts && !!adaptiveOpts.strategyWinrates &&
      typeof adaptiveOpts.strategyWinrates === "object",
      adaptiveOpts ? JSON.stringify(adaptiveOpts.strategyWinrates) : "(no auto_adaptive analysis)");
    const wr = (adaptiveOpts && adaptiveOpts.strategyWinrates) || {};
    check("a strong recorded strategy outranks a weak one",
      Number(wr.sniper) > 50 && Number(wr.scalp) < 50 && Number(wr.sniper) > Number(wr.scalp),
      JSON.stringify(wr));
    check("small samples are shrunk toward 50%, not reported raw",
      Number(wr.sniper) > 50 && Number(wr.sniper) < 100,
      "sniper=" + wr.sniper + " (raw would be 85.7)");

    if (failed) { console.error("FAILED " + failed); process.exitCode = 1; return; }
    console.log("OK — broker confirmation + chart-alignment regressions passed");
  })();
}

adapterTests();
contentTests().catch((e) => { console.error(e); process.exit(1); });
