#!/usr/bin/env node
"use strict";
/**
 * Auto-trade + placement regression tests (v2.3):
 *
 *   1. handleSignal is called once per tick (like content.js does): the
 *      controller must place ONE trade per (asset, bar, direction), not one
 *      per tick (the "spams trades" bug).
 *   2. A different bar (new closed candle) → a fresh trade is allowed.
 *   3. cooldownBars actually blocks trades right after a trade (old check
 *      read signal.metrics.closeTime which the engine never sets → cooldown
 *      never fired).
 *   4. findDirButton / setStake / placeTradeDom work against a hashed-class
 *      DOM with green/red buttons (the "doesn't place trades" bug).
 *
 * A fake clock (FakeDate) makes the min-interval / cooldown gates
 * deterministic without real sleeps.
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

// ---------- fake DOM with hashed CSS-module classes ----------
function makeEl(tag, cls, text, extra) {
  const el = {
    tagName: tag.toUpperCase(),
    className: cls || "",
    textContent: text || "",
    children: [],
    parentElement: null,
    style: {},
    dataset: {},
    listeners: {},
    _rect: (extra && extra.rect) || { top: 100, left: 100, width: 120, height: 44 },
    getBoundingClientRect() { return this._rect; },
    offsetParent: {},
    getClientRects: () => [{ width: 10, height: 10 }],
    addEventListener(n, fn) { (this.listeners[n] = this.listeners[n] || []).push(fn); },
    dispatchEvent(ev) { const fns = this.listeners[ev.type] || []; for (const fn of fns) fn(ev); return true; },
    click() { this.clicked = (this.clicked || 0) + 1; },
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getAttribute: (n) => (n === "aria-label" ? ((extra && extra.label) || "") : null),
  };
  return el;
}

const callBtn = makeEl("button", "_hashed_call_xyz", "", { rect: { top: 300, left: 900, width: 160, height: 48 } });
const putBtn = makeEl("button", "_hashed_put_xyz", "", { rect: { top: 370, left: 900, width: 160, height: 48 } });
// Regression: `/up/` used to classify "popup" as CALL and click this icon.
const openChartIcon = makeEl("button", "_hashed_popup_open-chart_xyz", "", { rect: { top: 50, left: 40, width: 36, height: 36 }, label: "Open chart" });
const stakeInput = makeEl("input", "_hashed_amount_xyz", "", { rect: { top: 260, left: 900, width: 160, height: 36 }, label: "amount" });
stakeInput.type = "number";
stakeInput.value = "1";
const expiryInput = makeEl("input", "_hashed_expiry_xyz", "", { rect: { top: 215, left: 900, width: 160, height: 36 }, label: "expiry" });
expiryInput.type = "number";
expiryInput.value = "1";
callBtn.parentElement = putBtn.parentElement = stakeInput.parentElement = expiryInput.parentElement = { contains: () => false };

const styleMap = new Map([[callBtn, "rgb(0, 200, 100)"], [putBtn, "rgb(220, 40, 60)"]]);

const sandbox = {
  self: {}, console, globalThis: null, Date: FakeDate,
  location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com", title: "Quotex" },
  navigator: { userAgent: "node" },
  Event: function (t) { this.type = t; },
  Notification: function () {},
  // Run scheduled callbacks immediately so storage.save() flushes and the
  // controller's async paths complete deterministically.
  setTimeout: (fn) => { try { fn(); } catch (_) {} return 0; },
  clearInterval: () => {}, setInterval: (fn) => 0,
  getComputedStyle: (el) => ({ backgroundColor: styleMap.get(el) || "rgb(20, 30, 40)" }),
  postMessage: () => {},
};
sandbox.globalThis = sandbox.self;
sandbox.window = sandbox.self;
sandbox.window.HTMLInputElement = { prototype: {} };
sandbox.window.HTMLTextAreaElement = { prototype: {} };
sandbox.window.AudioContext = undefined;
sandbox.window.addEventListener = () => {};

const allEls = [openChartIcon, callBtn, putBtn, stakeInput, expiryInput];
sandbox.document = {
  readyState: "complete", title: "Quotex", location: { href: "https://qxbroker.com/en/trade" },
  querySelectorAll: (sel) => {
    const s = String(sel);
    // Attribute-value matching on the selector string (never plain substring
    // — "input" contains "put"!).
    if (/class\*='(call|up|buy)'|data-type='CALL'|data-direction='CALL'/.test(s)) return [callBtn];
    if (/class\*='(put|down|sell)'|data-type='PUT'|data-direction='PUT'/.test(s)) return [putBtn];
    if (/expir|duration|time/.test(s)) return [expiryInput];
    if (/class\*='(amount|stake|sum)'|aria-label\*='(amount|stake)'|placeholder\*='(amount|stake)'|name='(amount|sum)'|testid\*='(amount|stake)'|inputmode=|type='number'/.test(s)) return [stakeInput];
    if (/panel|sidebar|deals/.test(s)) return [];
    return allEls;
  },
  querySelector: (sel) => sandbox.document.querySelectorAll(sel)[0] || null,
  getElementById: () => null,
  createElement: () => makeEl("div", "", ""),
  addEventListener: () => {},
  body: makeEl("div", "", ""),
  documentElement: makeEl("div", "", ""),
};

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
sandbox.chrome = chromeStub;
vm.createContext(sandbox);

for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js", "backtest.js", "quotex.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
}

let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

const Q = sandbox.self.CYBER_QUOTEX;

// ---------- 4. DOM placement ----------
check("findCallButton finds green hashed button", Q.findCallButton() === callBtn);
check("findPutButton finds red hashed button", Q.findPutButton() === putBtn);
check("findExpirySelect discovers expiration control", Q.findExpirySelect() === expiryInput);
const okExpiry = Q.setExpiry(60);
check("setExpiry safely sets expiration", okExpiry && okExpiry.ok === true, "error=" + (okExpiry && okExpiry.error));
const okStake = Q.setStake(5);
check("setStake writes into amount input", okStake && stakeInput.value === "5", "ok=" + okStake + " value=" + stakeInput.value);
const placed = Q.placeTradeDom({ dir: "CALL", amount: 5, expirySec: 60 });
check("placeTradeDom clicks CALL button", placed && placed.ok && callBtn.clicked === 1, placed && placed.error);
check("open-chart/popup icon is never clicked", !openChartIcon.clicked, "clicked=" + (openChartIcon.clicked || 0));

// ---------- auto controller (spam regression) ----------
const AUTO = sandbox.self.CYBER_AUTO;
const STORE = sandbox.self.CYBER_STORE;
const log = [];
const decisions = [];

function makeSignal(dir, t, conf, asset) {
  return { ready: true, direction: dir, asset: asset || "EURUSD_otc", confidence: conf != null ? conf : 80, score: 8, regime: "trending", reason: "test", time: t };
}
function okTradesSince(idx) {
  return decisions.slice(idx).filter((d) => d.ok && d.action && d.action.ok).length;
}
function skipReasonsSince(idx) {
  return decisions.slice(idx).filter((d) => !d.ok).map((d) => d.blockedReason);
}

async function main() {
  const adapter = sandbox.self.CYBER_QUOTEX;
  sandbox.self.CYBER_QUOTEX = null;
  check("no-adapter fallback cannot match the popup/open-chart icon", AUTO.findTradeButton("PUT") === null);
  const refusedFallback = await AUTO.clickTrade({ dir: "PUT", stake: 1, expiry: 1 });
  check("no-adapter fallback refuses an unverified click", refusedFallback && refusedFallback.ok === false && !openChartIcon.clicked);
  sandbox.self.CYBER_QUOTEX = adapter;
  const malformedStake = await AUTO.clickTrade({ dir: "CALL", stake: Symbol("stake"), expiry: 1 });
  const malformedExpiry = await AUTO.clickTrade({ dir: "PUT", stake: 1, expiry: Symbol("expiry") });
  check("symbol-valued direct placement fields fail closed", malformedStake.ok === false && malformedExpiry.ok === false);

  await STORE.setSettings({ autoMode: "click", armed: true, stake: 1, expiry: 1, cooldownBars: 0, minConfidence: 0, minIntervalMs: 1000, maxTradesPerHour: 100, maxTradesPerDay: 1000 });
  const controller = AUTO.startAuto({
    config: await STORE.getSettings(),
    executeTrade: async (args) => ({
      ok: true, confirmed: true, id: "test_" + args.dir,
      openTime: Date.now(), expiryTime: Date.now() + args.expiry * 60000,
    }),
    onLog: (e) => log.push(e),
    onTrade: (d) => decisions.push(d),
  });
  controller.setMode("click");
  controller.setArmed(true);
  controller.setAccountInfo({ isDemo: true, balance: 1000, currency: "USD" });

  const recentBar = () => Math.floor(fakeNow / 60000) * 60000 - 60000;
  // 20 identical signals for the SAME bar (content.js calls per tick)
  const barT = recentBar();
  const start = decisions.length;
  for (let i = 0; i < 20; i++) {
    await controller.handleSignal(makeSignal("CALL", barT));
  }
  check("one trade per bar (20 ticks → 1 trade)", okTradesSince(start) === 1, "placed=" + okTradesSince(start));

  const staleStart = decisions.length;
  await controller.handleSignal(makeSignal("PUT", fakeNow - 11 * 60000, 80, "STALEUSD"));
  check("stale closed-bar signals cannot execute", okTradesSince(staleStart) === 0 &&
    skipReasonsSince(staleStart).some((r) => /stale|future/i.test(r || "")));

  // next bar → allowed (advance clock to a genuinely new closed minute)
  advance(60000);
  const start2 = decisions.length;
  await controller.handleSignal(makeSignal("PUT", recentBar()));
  check("next bar gets a fresh trade", okTradesSince(start2) === 1, "puts=" + okTradesSince(start2));

  // cooldown: block trades for 5 minutes (clock advanced so min-interval
  // passes — cooldown must be the ONLY blocker)
  await STORE.setSettings({ cooldownBars: 5 });
  advance(60000);
  const start3 = decisions.length;
  await controller.handleSignal(makeSignal("CALL", recentBar()));
  check("cooldown blocks immediate re-trade", okTradesSince(start3) === 0, "trades=" + okTradesSince(start3));
  check("cooldown reason surfaced", skipReasonsSince(start3).some((r) => /Cooldown/.test(r || "")), skipReasonsSince(start3).join("|"));

  // min-interval gate: after a real trade, a DIFFERENT bar within 5s is blocked
  await STORE.setSettings({ cooldownBars: 0, minIntervalMs: 5000 });
  advance(60000);
  const start4 = decisions.length;
  const intervalBar = recentBar();
  await controller.handleSignal(makeSignal("CALL", intervalBar, 80, "EURUSD"));
  await controller.handleSignal(makeSignal("PUT", intervalBar, 80, "GBPUSD"));
  check("5s minimum-interval gate blocks 2nd", okTradesSince(start4) === 1, "trades=" + okTradesSince(start4));
  check("minimum-interval reason surfaced", skipReasonsSince(start4).some((r) => /Minimum interval/.test(r || "")), skipReasonsSince(start4).join("|"));

  // duplicate signal AFTER a successful trade must NOT fire again
  const start5 = decisions.length;
  await controller.handleSignal(makeSignal("CALL", intervalBar, 80, "EURUSD")); // same asset+bar as start4's CALL
  check("same bar+dir never re-fires", okTradesSince(start5) === 0);

  // Extension execution must count only a broker-confirmed order. A frame that
  // was sent but timed out is NOT a trade and must not trigger a DOM retry.
  await STORE.setSettings({ cooldownBars: 0, minIntervalMs: 1000 });
  let executeCalls = 0;
  const unconfirmedDecisions = [];
  const confirmedController = AUTO.startAuto({
    config: await STORE.getSettings(),
    executeTrade: async () => { executeCalls++; return { ok: false, sent: true, confirmed: false, error: "confirmation timeout" }; },
    onTrade: (decision) => unconfirmedDecisions.push(decision),
  });
  confirmedController.setMode("click");
  confirmedController.setArmed(true);
  confirmedController.setAccountInfo({ isDemo: true, balance: 1000, currency: "USD" });
  advance(60000);
  // Wait for persisted safety-ledger hydration before taking the baseline.
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  const confirmedBefore = confirmedController.getState().tradesToday;
  await confirmedController.handleSignal(makeSignal("PUT", recentBar(), 80, "AUDUSD"));
  check("sent-but-unconfirmed order is not counted", confirmedController.getState().tradesToday === confirmedBefore,
    "before=" + confirmedBefore + " after=" + confirmedController.getState().tradesToday);
  check("sent-but-unconfirmed order is attempted once (no click retry)", executeCalls === 1, "calls=" + executeCalls);
  check("unconfirmed execution is reported as a failed decision",
    unconfirmedDecisions.length === 1 && unconfirmedDecisions[0].ok === false && /confirmation/i.test(unconfirmedDecisions[0].blockedReason || ""));

  let releaseExecution;
  let concurrentCalls = 0;
  const concurrentController = AUTO.startAuto({
    config: await STORE.getSettings(),
    executeTrade: () => {
      concurrentCalls++;
      return new Promise((resolve) => { releaseExecution = resolve; });
    },
  });
  concurrentController.setMode("click");
  concurrentController.setArmed(true);
  concurrentController.setAccountInfo({ isDemo: true, balance: 1000, currency: "USD" });
  advance(60000);
  const concurrentBar = recentBar();
  const firstPending = concurrentController.handleSignal(makeSignal("CALL", concurrentBar, 80, "NZDUSD"));
  await concurrentController.handleSignal(makeSignal("PUT", concurrentBar, 80, "USDCAD"));
  // Let the storage-backed canTrade() path finish and enter executeTrade().
  for (let i = 0; i < 20 && !releaseExecution; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  check("async in-flight lock allows only one concurrent placement", concurrentCalls === 1, "calls=" + concurrentCalls);
  if (!releaseExecution) throw new Error("concurrent placement never reached its executor");
  releaseExecution({ ok: true, confirmed: true, id: "test" });
  await firstPending;
  const detachedState = concurrentController.getState();
  if (detachedState.lastTrade) detachedState.lastTrade.asset = "MUTATED";
  check("getState cannot mutate controller last-trade safety state",
    concurrentController.getState().lastTrade && concurrentController.getState().lastTrade.asset !== "MUTATED");

  // The first write commits signal dedup; the second commits lastAttemptAt.
  // If the latter fails, touching the broker would let a reload bypass the
  // minimum interval with a different bar.
  const originalSetAutomation = STORE.setAutomation;
  let safetyWrites = 0;
  let failedPersistExecutions = 0;
  const persistenceDecisions = [];
  STORE.setAutomation = async (patch) => {
    safetyWrites++;
    if (safetyWrites >= 2) throw new Error("simulated attempt-ledger failure");
    return originalSetAutomation(patch);
  };
  try {
    const persistenceController = AUTO.startAuto({
      config: await STORE.getSettings(),
      executeTrade: async () => { failedPersistExecutions++; return { ok: true, confirmed: true }; },
      onTrade: (decision) => persistenceDecisions.push(decision),
    });
    persistenceController.setMode("click");
    persistenceController.setArmed(true);
    persistenceController.setAccountInfo({ isDemo: true, balance: 1000, currency: "USD" });
    advance(60000);
    await persistenceController.handleSignal(makeSignal("CALL", recentBar(), 80, "FAILSAFEUSD"));
  } finally {
    STORE.setAutomation = originalSetAutomation;
  }
  check("attempt-ledger write failure suppresses broker execution", failedPersistExecutions === 0,
    "executions=" + failedPersistExecutions);
  check("attempt-ledger failure is surfaced", persistenceDecisions.length === 1 &&
    /safety state/i.test(persistenceDecisions[0].blockedReason || ""));

  const pnlBefore = concurrentController.getState().dailyPnl;
  const firstSettlement = await concurrentController.settleOrder("closed-order-1", -1, "NZDUSD");
  const duplicateSettlement = await concurrentController.settleOrder("closed-order-1", -1, "NZDUSD");
  check("broker close id updates P&L exactly once", firstSettlement === true && duplicateSettlement === false &&
    concurrentController.getState().dailyPnl === pnlBefore - 1);
  check("broker loss freezes its asset", concurrentController.getState().frozenAssets.NZDUSD > fakeNow);
  const reloadedController = AUTO.startAuto({ config: await STORE.getSettings() });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
  const replay = await reloadedController.settleOrder("closed-order-1", -1, "NZDUSD");
  check("settled-order dedup survives controller reload", replay === false &&
    reloadedController.getState().dailyPnl === pnlBefore - 1 && reloadedController.getState().frozenAssets.NZDUSD > fakeNow);

  let malformedController = null;
  try { malformedController = AUTO.startAuto({ maxLog: Symbol("max") }); } catch (_) {}
  check("symbol-valued controller limits do not break startup", !!malformedController);
  if (malformedController) {
    malformedController.setMode("alerts");
    malformedController.setArmed(true);
    const malformedDecisions = [];
    const safeSignalController = AUTO.startAuto({
      maxLog: Symbol("max"), onTrade: (decision) => malformedDecisions.push(decision),
    });
    safeSignalController.setMode("alerts");
    safeSignalController.setArmed(true);
    await safeSignalController.handleSignal(makeSignal("CALL", Symbol("time"), 80, Symbol("asset")));
    check("symbol-valued signal metadata is rejected without a promise rejection",
      malformedDecisions.length === 1 && /timestamp/i.test(malformedDecisions[0].blockedReason || ""));
    check("symbol-valued P&L APIs fail closed",
      await safeSignalController.updateDailyPnl(Symbol("pnl")) === false &&
      await safeSignalController.settleOrder("order-symbol", Symbol("pnl"), "EURUSD") === false);
  }

  // ---- v2.6.9: account mode + balance detection ----
  {
    const decisions = [];
    const stakes = [];
    const acct = AUTO.startAuto({
      onTrade: (d) => decisions.push(d),
      executeTrade: async (args) => { stakes.push(args.stake); return { ok: true, confirmed: true, id: "acct" }; },
    });
    acct.setMode("click");
    acct.setArmed(true);
    acct.setAccountInfo({ isDemo: false, balance: 250, currency: "USD" }); // LIVE account
    advance(60000);
    const liveBar = recentBar();
    await acct.handleSignal(makeSignal("CALL", liveBar, 85, "EURUSD_otc"));
    check("demo-only default blocks a LIVE account",
      decisions.length === 1 && /demo-only/i.test(decisions[0].blockedReason || ""), decisions[0] && decisions[0].blockedReason);

    await STORE.setSettings({ accountMode: "any", cooldownBars: 0 });
    await acct.handleSignal(makeSignal("PUT", liveBar + 1, 85, "EURUSD_otc"));
    check("accountMode=any allows the LIVE account",
      decisions.length === 2 && decisions[1].ok === true && stakes.length === 1);

    advance(10000);
    await STORE.setSettings({ accountMode: "live", stakeMode: "percent", stakePercent: 2, cooldownBars: 0 });
    acct.setAccountInfo({ isDemo: false, balance: 1000, currency: "USD" });
    await acct.handleSignal(makeSignal("CALL", liveBar + 2, 85, "EURUSD_otc"));
    check("percent staking: 2% of 1000 sends stake 20",
      stakes.length === 2 && Math.abs(stakes[1] - 20) < 0.01, "stake=" + stakes[1]);

    advance(10000);
    await STORE.setSettings({ minBalance: 5000, cooldownBars: 0 });
    acct.setAccountInfo({ isDemo: false, balance: 120, currency: "USD" });
    await acct.handleSignal(makeSignal("PUT", liveBar + 3, 85, "EURUSD_otc"));
    check("min-balance stop blocks trades below the floor",
      decisions.length === 4 && /below minimum/i.test(decisions[3].blockedReason || ""), decisions[3] && decisions[3].blockedReason);

    advance(10000);
    const unknown = AUTO.startAuto({ onTrade: (d) => decisions.push(d) });
    unknown.setMode("alerts");
    unknown.setArmed(true);
    // deliberately NO setAccountInfo — account mode unknown
    await unknown.handleSignal(makeSignal("CALL", recentBar(), 85, "GBPCAD_otc"));
    check("unknown account (no balance event) is blocked for safety",
      decisions.length >= 5 && /unknown/i.test(decisions[decisions.length - 1].blockedReason || ""),
      decisions.map((d) => d.blockedReason || ("ok:" + (d.action && d.action.kind || "trade"))).join(" | "));
    await STORE.setSettings({ accountMode: "demo", stakeMode: "fixed", minBalance: 0 });
  }

  if (failed) { console.error("FAILED " + failed); process.exitCode = 1; return; }
  console.log("OK — auto/placement regressions passed");
}
main().catch((e) => { console.error(e); process.exit(1); });
