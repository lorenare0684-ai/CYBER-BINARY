#!/usr/bin/env node
"use strict";
/**
 * Signal clarity regressions (v2.6.17) — three user-reported defects.
 *
 *  A. STRATEGY NAME. A signal must name the strategy that produced it,
 *     including in auto mode. Under "auto_adaptive" the user's setting is a
 *     ROUTER, so reporting it is reporting nothing: the concrete strategy the
 *     router picked has to reach the HUD, the pushed state, the pending trade,
 *     the automation log and the Auto tab's "Last trade" tile.
 *
 *  B. NOISE DETECTION. The gate scored only close-to-close direction flips,
 *     which cannot see a retracing walk or a wick-dominated bar. It now reads
 *     a composite profile and must measurably raise win rate on the trades it
 *     keeps.
 *
 *  C. TIME BASIS. Quotex is a UTC platform on a 24-hour clock. Every
 *     dashboard timestamp must read UTC regardless of the machine zone, so a
 *     trade time can be matched to the Quotex candle it belongs to.
 *
 * Run against v2.6.16 (with only indicators.js taken from this change so the
 * harness can load) these fail 36 checks and pass 20.
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

function loadLibs(sandbox, files) {
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f), "utf8"), sandbox);
  }
}

/* ===================================================================
 * Part A1 — engine: every analysis names its strategy
 * =================================================================== */
function engineTests() {
  const sandbox = { self: {}, console, Date, Math, JSON };
  sandbox.globalThis = sandbox.self;
  vm.createContext(sandbox);
  loadLibs(sandbox, ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js"]);
  const ENG = sandbox.self.CYBER_ENGINE;
  const STRAT = sandbox.self.CYBER_STRATEGIES;

  function series(n, drift) {
    const out = [];
    let px = 1.1;
    for (let i = 0; i < n; i++) {
      const o = px;
      px = px * (1 + drift + Math.sin(i / 9) * 0.00005);
      out.push({ time: i * 60000, open: o, high: Math.max(o, px) * 1.0001, low: Math.min(o, px) * 0.9999, close: px });
    }
    return out;
  }
  const candles = series(260, 0.0006);

  // A direct preset run names itself.
  const direct = ENG.analyze(candles, { strategy: "sniper", lean: false });
  check("a preset analysis names the strategy that produced it",
    direct.selectedStrategy === "sniper", String(direct.selectedStrategy));
  check("a preset analysis carries the preset's human label",
    direct.selectedStrategyLabel === STRAT.get("sniper").label,
    String(direct.selectedStrategyLabel));

  // The adaptive router still names its concrete pick, never itself.
  const adaptive = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false });
  check("the adaptive router names a concrete strategy",
    typeof adaptive.selectedStrategy === "string" &&
    adaptive.selectedStrategy && adaptive.selectedStrategy !== "auto_adaptive",
    String(adaptive.selectedStrategy));
  check("the adaptive pick resolves to a real preset",
    !!STRAT.get(adaptive.selectedStrategy), String(adaptive.selectedStrategy));

  // Early returns used to come back anonymous, so a warming/short/invalid
  // signal had nothing to display.
  const tooFew = ENG.analyze(candles.slice(0, 10), { strategy: "trend" });
  check("a too-short analysis still names its strategy",
    tooFew.ready === false && tooFew.selectedStrategy === "trend",
    JSON.stringify({ ready: tooFew.ready, s: tooFew.selectedStrategy }));

  const broken = candles.map((c) => Object.assign({}, c));
  broken[200].high = -1;
  const invalid = ENG.analyze(broken, { strategy: "scalp", lean: false });
  check("an invalid-data analysis still names its strategy",
    invalid.ready === false && invalid.selectedStrategy === "scalp",
    JSON.stringify({ ready: invalid.ready, s: invalid.selectedStrategy }));

  const warming = ENG.analyze(series(45, 0.0004), { strategy: "ribbon", lean: false });
  check("a warm-up analysis still names its strategy",
    warming.selectedStrategy === "ribbon", String(warming.selectedStrategy));

  // A flat series trips the ATR floor, which was its own unnamed exit.
  const flat = [];
  for (let i = 0; i < 260; i++) flat.push({ time: i * 60000, open: 1.1, high: 1.1, low: 1.1, close: 1.1 });
  const atrGated = ENG.analyze(flat, { strategy: "breakout", lean: false });
  check("an ATR-floor WAIT still names its strategy",
    atrGated.selectedStrategy === "breakout", String(atrGated.selectedStrategy));

  // An unknown id must resolve to the default rather than echoing garbage.
  const unknown = ENG.analyze(candles, { strategy: "no_such_strategy", lean: false });
  check("an unknown strategy id resolves to the default preset",
    unknown.selectedStrategy === "confluence", String(unknown.selectedStrategy));

  // Tagging must not disturb the decision itself.
  const before = ENG.analyze(candles, { strategy: "confluence", lean: false });
  check("naming the strategy does not change the decision",
    before.direction === "CALL" && before.score > 0 && before.confidence > 0,
    JSON.stringify({ d: before.direction, s: before.score, c: before.confidence }));
}

/* ===================================================================
 * Part B — noise detection
 * =================================================================== */
function noiseTests() {
  const sandbox = { self: {}, console, Date, Math, JSON };
  sandbox.globalThis = sandbox.self;
  vm.createContext(sandbox);
  loadLibs(sandbox, ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js"]);
  const TA = sandbox.self.CYBER_TA;
  const ENG = sandbox.self.CYBER_ENGINE;

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  function build(n, step, wickMul, seed) {
    const r = rng(seed);
    const out = [];
    let px = 1.1;
    for (let i = 0; i < n; i++) {
      const o = px;
      const d = step(i, r);
      px = px * (1 + d);
      const w = Math.abs(d) * wickMul * px + px * 1e-6;
      out.push({ time: i * 60000, open: o, high: Math.max(o, px) + w, low: Math.min(o, px) - w, close: px });
    }
    return out;
  }

  const clean = build(120, (i, r) => 0.0008 + (r() - 0.5) * 0.0002, 0.3, 11);
  const flipChop = build(120, (i, r) => (i % 2 ? 1 : -1) * (0.0004 + r() * 0.0003), 0.5, 22);
  // Price walks up then gives it all back: FEW flips, no net travel. The old
  // flip-ratio score called this clean.
  const retrace = build(120, (i, r) => (i % 10 < 6 ? 0.0006 : -0.0009) + (r() - 0.5) * 0.0002, 0.4, 33);
  // Tiny bodies, huge wicks: rejected in both directions inside every bar.
  // A close-to-close measure cannot see this at all.
  const wicky = build(120, (i, r) => (r() - 0.5) * 0.00015, 12, 44);

  const pClean = TA.noiseProfile(clean, 20);
  const pFlip = TA.noiseProfile(flipChop, 20);
  const pRetrace = TA.noiseProfile(retrace, 20);
  const pWicky = TA.noiseProfile(wicky, 20);

  check("noiseProfile scores a clean trend as quiet",
    pClean.ready && pClean.score < 0.3, "score=" + pClean.score.toFixed(3));
  check("noiseProfile scores alternating chop as noisy",
    pFlip.ready && pFlip.score > 0.7, "score=" + pFlip.score.toFixed(3));

  // The two defects the flip ratio was blind to.
  function flipRatio(c) {
    const t = c.slice(-12);
    let f = 0, m = 0, p = 0;
    for (let i = 1; i < t.length; i++) {
      const d = t[i].close > t[i - 1].close ? 1 : t[i].close < t[i - 1].close ? -1 : 0;
      if (d && p && d !== p) f++;
      if (d) { m++; p = d; }
    }
    return m ? f / Math.max(1, m - 1) : 1;
  }
  check("a retracing walk is caught though the flip ratio calls it clean",
    pRetrace.score > flipRatio(retrace) + 0.2,
    "composite=" + pRetrace.score.toFixed(3) + " flipRatio=" + flipRatio(retrace).toFixed(3));
  // The old gate fired at flipRatio >= 0.78; this market scores 0.40 there, so
  // it sailed straight through. The composite ranks it far above a clean trend
  // and attributes it to the wick component that a close-to-close measure
  // cannot observe at all.
  check("wick-dominated chop is caught though the flip ratio calls it clean",
    flipRatio(wicky) < 0.78 && pWicky.score > flipRatio(wicky) + 0.15 &&
    pWicky.score > pClean.score + 0.35 && pWicky.wick > 0.9,
    "composite=" + pWicky.score.toFixed(3) + " flipRatio=" + flipRatio(wicky).toFixed(3) +
    " wick=" + pWicky.wick.toFixed(3) + " clean=" + pClean.score.toFixed(3));

  // Components are reported so a gate decision can be explained.
  check("the profile reports its components, not just a score",
    ["flip", "efficiency", "wick", "chop", "bars"].every((k) => typeof pFlip[k] === "number") &&
    pFlip.bars === 20,
    JSON.stringify(pFlip));
  check("every component stays inside [0,1]",
    [pClean, pFlip, pRetrace, pWicky].every((p) =>
      [p.score, p.flip, p.efficiency, p.wick, p.chop].every((v) => v >= 0 && v <= 1)),
    JSON.stringify([pClean.score, pFlip.score, pRetrace.score, pWicky.score]));

  // Fails OPEN: the gate it feeds may only ever suppress a signal, so an
  // unscorable window must never look noisy.
  const openCases = [
    ["not an array", TA.noiseProfile(null, 20)],
    ["too few bars", TA.noiseProfile(clean.slice(0, 5), 20)],
    ["malformed bars", TA.noiseProfile([{ open: "x" }, {}, null, 1, 2, 3, 4, 5, 6, 7], 20)],
    ["symbol-valued", TA.noiseProfile([{ open: Symbol("o"), high: 1, low: 1, close: 1 }], 20)],
  ];
  check("an unscorable window fails open (score 0, not noisy)",
    openCases.every(([, p]) => p && p.ready === false && p.score === 0),
    JSON.stringify(openCases.map(([n, p]) => n + "=" + (p && p.score))));

  // A degenerate window (every close identical) must not throw or NaN.
  const flat = [];
  for (let i = 0; i < 30; i++) flat.push({ time: i * 60000, open: 1.1, high: 1.1, low: 1.1, close: 1.1 });
  const pFlat = TA.noiseProfile(flat, 20);
  check("a perfectly flat window scores finitely",
    pFlat.ready && Number.isFinite(pFlat.score) && pFlat.score >= 0 && pFlat.score <= 1,
    JSON.stringify(pFlat));

  /* --- the gate has to actually improve accuracy --------------------
   * A noise filter that does not raise the win rate of the trades it keeps
   * is just a trade-count reduction. Backtest a mixed-regime market and
   * compare the kept population against the blocked one. */
  function market(seed, n) {
    const r = rng(seed);
    const out = [];
    let px = 1.1, mode = 0, left = 0, drift = 0;
    for (let i = 0; i < n; i++) {
      if (left <= 0) {
        mode = Math.floor(r() * 3);
        left = 40 + Math.floor(r() * 80);
        drift = (r() < 0.5 ? -1 : 1) * (0.0003 + r() * 0.0007);
      }
      left--;
      let d, wick;
      if (mode === 0) { d = drift + (r() - 0.5) * 0.0003; wick = 0.4; }
      else if (mode === 1) { d = (r() - 0.5) * 0.0009; wick = 1.2; }
      else { d = (r() - 0.5) * 0.0002; wick = 10; }
      const o = px;
      px = px * (1 + d);
      const w = Math.abs(d) * wick * px + px * 2e-6;
      out.push({ time: i * 60000, open: o, high: Math.max(o, px) + w, low: Math.min(o, px) - w, close: px });
    }
    return out;
  }
  // Read the real threshold out of content.js so this can never silently
  // drift from the value the extension actually gates on.
  const gateSrc = fs.readFileSync(path.join(root, "src/content.js"), "utf8");
  const gateMatch = /const NOISE_GATE = ([0-9.]+)/.exec(gateSrc);
  check("the noise gate threshold is declared in content.js", !!gateMatch);
  const GATE = gateMatch ? Number(gateMatch[1]) : 0.62;
  const kept = [], blocked = [];
  for (let s = 1; s <= 8; s++) {
    const c = market(s * 104729, 1200);
    const res = ENG.backtest(c, { strategy: "confluence", horizon: 3, minBars: 200, warmup: 200 });
    const idxByTime = new Map(c.map((bar, i) => [bar.time, i]));
    for (const t of res.trades || []) {
      if (t.draw) continue;
      const idx = idxByTime.get(t.entryTime - 60000);
      if (idx == null || idx < 25) continue;
      const score = TA.noiseProfile(c.slice(0, idx + 1), 20).score;
      (score < GATE ? kept : blocked).push(!!t.won);
    }
  }
  const wr = (l) => (l.length ? (100 * l.filter(Boolean).length / l.length) : 0);
  const keptWr = wr(kept), blockedWr = wr(blocked), allWr = wr(kept.concat(blocked));
  check("the noise gate has a meaningful sample to judge",
    kept.length > 500 && blocked.length > 500,
    "kept=" + kept.length + " blocked=" + blocked.length);
  check("trades the gate keeps beat the ungated population by 10+ points",
    keptWr >= allWr + 10,
    "kept=" + keptWr.toFixed(1) + "% ungated=" + allWr.toFixed(1) + "%");
  check("trades the gate blocks are near coin-flips",
    blockedWr < 55, "blocked=" + blockedWr.toFixed(1) + "%");
}

/* ===================================================================
 * Parts A2 + C — content.js and dashboard.js through their real paths
 * =================================================================== */
const RealDate = Date;
let fakeNow = Date.UTC(2026, 7, 24, 9, 45, 0);
class FakeDate extends RealDate {}
FakeDate.now = () => fakeNow;

/* ---- content.js: HUD + pushed state name the routed strategy ---- */
function contentTests() {
  const timers = [];
  let nextTimerId = 1;
  const sent = [];
  const intervalFns = [];
  const hudEls = {};

  const sandbox = {
    self: {}, console, Date: FakeDate, globalThis: null, Math, JSON,
    location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/en/trade?type=demo", host: "qxbroker.com", title: "Quotex" },
    navigator: { userAgent: "node" },
    Event: function (t) { this.type = t; },
    Notification: function () {},
    setTimeout: (fn, ms) => { const id = nextTimerId++; timers.push({ id, fn, at: fakeNow + (Number(ms) || 0) }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    setInterval: (fn) => { intervalFns.push(fn); return intervalFns.length; },
    clearInterval: () => {},
    postMessage: () => {},
  };
  sandbox.globalThis = sandbox.self;
  sandbox.window = sandbox.self;
  sandbox.__contentMsgListeners = [];
  sandbox.window.addEventListener = (type, fn) => {
    if (type === "message") sandbox.__contentMsgListeners.push(fn);
  };
  sandbox.window.postMessage = sandbox.postMessage;

  function makeEl(text, cls) {
    const el = {
      children: [], id: "", className: cls || "", textContent: text || "",
      offsetParent: {}, getClientRects: () => [{ width: 10, height: 10 }],
      querySelectorAll: () => [], closest: () => null, addEventListener: () => {},
      appendChild: () => {}, remove: () => {}, innerHTML: "", style: {}, dataset: {},
      getBoundingClientRect: () => ({ width: 10, height: 10 }),
      classList: { add: () => {}, remove: () => {}, toggle: () => {} },
    };
    // The HUD is built by innerHTML and then read back through querySelector;
    // hand out a stable element per selector so paintHud's writes are visible.
    el.querySelector = (sel) => {
      const key = String(sel);
      if (!hudEls[key]) hudEls[key] = makeEl("");
      return hudEls[key];
    };
    return el;
  }
  const hudRoot = makeEl("");
  sandbox.document = {
    readyState: "complete", title: "Quotex - Trade EUR/USD OTC",
    location: { href: "https://qxbroker.com/en/trade?type=demo" },
    querySelector: () => null,
    querySelectorAll: (sel) => (String(sel).indexOf("#cyber-binary-hud") !== -1 ? [] : [makeEl("EUR/USD OTC", "sc-h")]),
    getElementById: (id) => (id === "cyber-binary-hud" ? hudRoot : null),
    createElement: () => makeEl(""), addEventListener: () => {},
    body: makeEl(""), documentElement: makeEl(""),
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
  sandbox.chrome = {
    runtime: {
      id: "test-ext", getURL: (p) => "chrome-extension://test/" + p,
      sendMessage: (m) => {
        sent.push(m);
        if (m && m.type === "CYBER_STORAGE_PATCH") applyStoragePatch(m.patch);
        return Promise.resolve({ ok: true, primary: true });
      },
      onMessage: { addListener: () => {} },
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
  loadLibs(sandbox, ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js",
    "storage.js", "auto.js", "backtest.js", "quotex.js", "markers.js"]);
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
  function lastState() {
    const states = sent.filter((m) => m.type === "CYBER_STATE");
    return states.length ? states[states.length - 1].payload : null;
  }

  return (async () => {
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

    // Run the router, exactly as the extension ships (strategy=auto_adaptive).
    applyStoragePatch([{ path: ["settings"], value: {
      autoMode: "off", armed: false, stake: 5, expiry: 1, cooldownBars: 0, minConfidence: 0,
      minIntervalMs: 0, strategy: "auto_adaptive",
    } }]);
    await settle();

    // The REAL router runs here — the point is that whichever concrete
    // strategy it lands on reaches every surface identically, so no stub.
    const ENG = sandbox.self.CYBER_ENGINE;
    ENG.liveSignalGate = () => ({ allowed: true, reason: "test" });

    fakeNow = minute + 60000;
    forceTick();
    await settle();

    const st = lastState();
    const STRAT = sandbox.self.CYBER_STRATEGIES;
    const picked = st && st.selectedStrategy;
    const preset = picked ? STRAT.get(picked) : null;

    check("pushed state names the strategy that produced the signal",
      typeof picked === "string" && picked && picked !== "auto_adaptive" && !!preset,
      st && JSON.stringify({ strategy: st.strategy, selected: picked }));
    check("pushed state carries that strategy's human label",
      !!preset && st.selectedStrategyLabel === preset.label,
      st && JSON.stringify({ label: st.selectedStrategyLabel, expected: preset && preset.label }));
    check("pushed state still reports the user's router selection separately",
      st && st.strategy === "auto_adaptive", st && String(st.strategy));
    check("the signal itself names the same concrete strategy",
      st && st.signal && st.signal.selectedStrategy === picked,
      st && st.signal && String(st.signal.selectedStrategy));
    check("the pending trade is attributed to the routed strategy",
      st && st.pending && st.pending.strategy === picked,
      st && st.pending && JSON.stringify({ s: st.pending.strategy, picked }));
    check("the pending trade records the router it came from",
      st && st.pending && st.pending.routedBy === "auto_adaptive",
      st && st.pending && String(st.pending.routedBy));
    check("no surface reports the router as if it were the strategy",
      st && st.selectedStrategy !== "auto_adaptive" &&
      st.signal.selectedStrategy !== "auto_adaptive" &&
      (!st.pending || st.pending.strategy !== "auto_adaptive"),
      st && JSON.stringify({ sel: st.selectedStrategy, pend: st.pending && st.pending.strategy }));

    // The on-page HUD is the only surface a trader sees without the dashboard.
    const meta = hudEls[".cb-hud-meta"];
    const hudText = meta ? String(meta.textContent) : "";
    check("the on-page HUD names the routed strategy",
      !!preset && hudText.indexOf(preset.label) !== -1,
      JSON.stringify(hudText.slice(0, 160)));
    check("the HUD marks an auto-routed strategy as auto-selected",
      /\(auto\)/.test(hudText), JSON.stringify(hudText.slice(0, 160)));

    // The composite noise profile reaches the dashboard for display.
    check("the signal carries the composite noise profile",
      st && st.signal && st.signal.noise && typeof st.signal.noise.score === "number" &&
      typeof st.signal.noise.wick === "number",
      st && st.signal && JSON.stringify(st.signal.noise));
    return st;
  })();
}

/* ---- auto.js: the controller reports the strategy it acted on ---- */
function autoTests() {
  const sandbox = { self: {}, console, Date, Math, JSON, setTimeout, clearTimeout, setInterval, clearInterval };
  sandbox.globalThis = sandbox.self;
  vm.createContext(sandbox);
  loadLibs(sandbox, ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "storage.js", "auto.js"]);
  const AUTO = sandbox.self.CYBER_AUTO;

  const logs = [];
  const trades = [];
  const states = [];
  const ctl = AUTO.startAuto({
    onLog: (e) => logs.push(e),
    onTrade: (t) => trades.push(t),
    onState: (s) => states.push(s),
  });
  ctl.setMode("alerts");
  ctl.setArmed(true);
  // Without a known account the eligibility gate blocks before any action, so
  // the alert path (and lastTrade) would never be reached.
  ctl.setAccountInfo({ isDemo: true, balance: 500, currency: "USD" });

  const signal = {
    ready: true, direction: "CALL", asset: "EURUSD_otc", confidence: 88, score: 9,
    regime: "trending", reason: "test", time: Date.now() - 1000,
    entryTime: Date.now(), entryPrice: 1.086,
    // What the adaptive router produced: the user picked the router, the
    // engine picked sniper.
    strategy: "auto_adaptive",
    selectedStrategy: "sniper",
    selectedStrategyLabel: "Sniper 90+ Confluence",
  };

  return ctl.handleSignal(signal).then(() => {
    const log = trades[trades.length - 1];
    check("the automation decision records the routed strategy id",
      log && log.strategy === "sniper", log && JSON.stringify({ s: log.strategy }));
    check("the automation decision records the strategy label",
      log && log.strategyLabel === "Sniper 90+ Confluence", log && String(log.strategyLabel));
    check("the automation decision records the router separately",
      log && log.routedBy === "auto_adaptive", log && String(log.routedBy));

    const line = logs.map((l) => l.msg).filter((m) => /ALERT|Skip|Trade/.test(m)).pop();
    check("the automation log line names the strategy",
      !!line && /Sniper 90\+ Confluence/.test(line), String(line));
    check("the automation log line marks it auto-routed",
      !!line && /\(auto\)/.test(line), String(line));

    const snap = ctl.getState();
    check("the controller snapshot keeps the strategy on lastTrade",
      snap && snap.lastTrade && snap.lastTrade.strategy === "sniper",
      snap && JSON.stringify(snap.lastTrade));
    check("the snapshot keeps the strategy label on lastTrade",
      snap && snap.lastTrade && snap.lastTrade.strategyLabel === "Sniper 90+ Confluence",
      snap && JSON.stringify(snap.lastTrade));

    // A plain preset run must report itself and NOT be marked auto-routed.
    logs.length = 0;
    return ctl.handleSignal(Object.assign({}, signal, {
      strategy: "trend", selectedStrategy: "trend", selectedStrategyLabel: "Trend Rider",
      time: Date.now() - 500, asset: "GBPUSD_otc",
    })).then(() => {
      const presetLine = logs.map((l) => l.msg).filter((m) => /ALERT|Skip/.test(m)).pop();
      check("a preset signal names itself without the auto tag",
        !!presetLine && /Trend Rider/.test(presetLine) && !/\(auto\)/.test(presetLine),
        String(presetLine));
      ctl.stop();
    });
  });
}

/* ---- dashboard.js: UTC everywhere + strategy on every surface ---- */
function dashboardTests(contentState) {
  const drawn = [];
  function makeCtx() {
    const noop = () => {};
    return {
      setTransform: noop, clearRect: noop, fillRect: noop, strokeRect: noop,
      beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, stroke: noop,
      fill: noop, arc: noop, save: noop, restore: noop, setLineDash: noop,
      createLinearGradient: () => ({ addColorStop: noop }),
      measureText: (t) => ({ width: String(t).length * 5 }),
      fillText: (text) => { drawn.push(String(text)); },
      strokeText: noop,
      fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "",
    };
  }
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
      prepend: (c) => { el.children.unshift(c); return c; },
      removeChild: (c) => { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
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
    documentElement: makeEl("html"), body: makeEl("body"), head: makeEl("head"),
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
    document: documentStub, chrome: chromeStub,
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: undefined, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 900,
    localStorage: { getItem: () => null, setItem: () => {} },
    Blob: function () {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
    Worker: undefined,
  };
  sandbox.globalThis = sandbox.self;
  sandbox.window = sandbox.self;
  sandbox.window.addEventListener = (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); };
  sandbox.window.removeEventListener = () => {};
  sandbox.window.document = documentStub;
  sandbox.window.postMessage = () => {};
  sandbox.window.getComputedStyle = () => ({ backgroundColor: "rgb(10,10,10)", color: "rgb(255,255,255)" });
  sandbox.window.matchMedia = () => ({ matches: false, addListener: () => {}, addEventListener: () => {} });

  vm.createContext(sandbox);
  loadLibs(sandbox, ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js",
    "storage.js", "auto.js", "backtest.js", "workers.js", "asset-selector.js", "quotex.js"]);
  vm.runInContext(fs.readFileSync(path.join(root, "src/dashboard.js"), "utf8"), sandbox);

  // 09:41–09:47 UTC on 2026-08-24 — the timestamps from the reported bug.
  // In Asia/Kolkata those render as 15:11–15:17 local: the shift the user saw.
  const baseUtc = Date.UTC(2026, 7, 24, 9, 41, 0);
  const candles = [];
  let price = 1.0850;
  for (let i = 0; i < 7; i++) {
    const open = price;
    price = price + 0.0002;
    candles.push({
      time: baseUtc + i * 60000, open,
      high: Math.max(open, price) + 0.0001, low: Math.min(open, price) - 0.0001,
      close: price, volume: 10,
    });
  }
  const entryTime = Date.UTC(2026, 7, 24, 9, 47, 0);
  const expiryTime = Date.UTC(2026, 7, 24, 9, 50, 0);

  function push(payload) {
    for (const fn of listeners.runtime || []) {
      fn({ type: "CYBER_STATE_PUSH", payload }, {}, () => {});
    }
    for (let pass = 0; pass < 4; pass++) {
      const due = timeouts.splice(0, timeouts.length);
      for (const fn of due) { try { fn(); } catch (_) {} }
    }
  }

  push({
    attached: true, primary: true, source: "websocket",
    asset: "EUR/USD OTC", assetId: "EURUSD_otc", price,
    candles, chartCandles: candles, chartPeriod: 60, chartTimeBasis: "broker-utc",
    signal: {
      ready: true, direction: "CALL", reason: "test", confidence: 88, regime: "trending",
      session: "europe", entryTime, entryPrice: 1.0862,
      selectedStrategy: "sniper", selectedStrategyLabel: "Sniper 90+ Confluence",
      strategy: "auto_adaptive",
      noise: { ready: true, score: 0.21, flip: 0.2, efficiency: 0.9, wick: 0.1, chop: 0.2, bars: 20 },
    },
    strategy: "auto_adaptive", selectedStrategy: "sniper",
    selectedStrategyLabel: "Sniper 90+ Confluence",
    wins: 1, losses: 0, winrate: 100, accuracy: 100, markers: [],
    history: [{
      dir: "CALL", asset: "EURUSD_otc", confidence: 88, won: true, pnl: 4.25,
      regime: "trending", strategy: "sniper",
      entryTime, expiryTime, exitTime: expiryTime,
      entryPrice: 1.0862, exitPrice: 1.0871, expiryMinutes: 3,
    }],
    autoState: {
      mode: "click", armed: true, tradesToday: 1, tradesHour: 1, dailyPnl: 4.25,
      account: { isDemo: false, balance: 1337.42, currency: "USD" },
      lastTrade: {
        dir: "CALL", asset: "EURUSD_otc", at: entryTime, entryTime, expiryTime,
        strategy: "sniper", strategyLabel: "Sniper 90+ Confluence",
      },
    },
    ts: Date.now(),
  });

  /* --- C. UTC time basis --- */
  const timing = String(byIdGet("signal-timing").textContent);
  check("the hero timing line reads the broker's UTC clock, not machine local",
    /09:47/.test(timing) && !/15:17/.test(timing), JSON.stringify(timing));
  check("the hero timing line states its UTC basis",
    /UTC/.test(timing), JSON.stringify(timing));
  check("the hero timing line uses a 24-hour clock like Quotex",
    !/\b(am|pm|AM|PM)\b/.test(timing), JSON.stringify(timing));

  const histHtml = String((byIdGet("history").children[0] || {}).innerHTML || "");
  check("a history row timestamps in UTC, not machine local",
    /09:47/.test(histHtml) && !/15:17/.test(histHtml), JSON.stringify(histHtml.slice(0, 200)));
  check("a history row expiry is UTC too",
    /09:50/.test(histHtml) && !/15:20/.test(histHtml), JSON.stringify(histHtml.slice(0, 200)));

  const lastTrade = String(byIdGet("last-trade").textContent);
  check("the Auto tab's last-trade time is UTC, not machine local",
    /09:47/.test(lastTrade) && !/15:17/.test(lastTrade) && /UTC/.test(lastTrade),
    JSON.stringify(lastTrade));

  /* --- A. strategy on every dashboard surface --- */
  const regimeRow = String(byIdGet("regime-row").textContent);
  check("the live hero names the strategy that produced the signal",
    /Sniper 90\+ Confluence/.test(regimeRow), JSON.stringify(regimeRow));
  check("the live hero flags that the strategy was auto-routed",
    /\(auto\)/.test(regimeRow), JSON.stringify(regimeRow));
  check("the live hero never shows the router as the strategy",
    !/strategy: *auto_adaptive/.test(regimeRow), JSON.stringify(regimeRow));
  check("the live hero surfaces the noise score",
    /noise: *0\.21/.test(regimeRow), JSON.stringify(regimeRow));

  check("a history row names the strategy that produced the trade",
    /Sniper 90\+ Confluence/.test(histHtml), JSON.stringify(histHtml.slice(0, 260)));
  check("the Auto tab's last trade names the strategy",
    /Sniper 90\+ Confluence/.test(lastTrade), JSON.stringify(lastTrade));

  // The adaptive cockpit must keep working unchanged.
  check("the adaptive cockpit still names the selected strategy",
    /Sniper 90\+ Confluence/.test(String(byIdGet("adaptive-strategy-label").textContent)),
    JSON.stringify(String(byIdGet("adaptive-strategy-label").textContent)));

  // The chart axis was already UTC — prove the fix did not regress it.
  check("the chart axis is still labelled in UTC",
    drawn.some((t) => /^09:4\d$/.test(t)) && !drawn.some((t) => /^15:1\d$/.test(t)),
    JSON.stringify(drawn.filter((t) => /^\d\d:\d\d$/.test(t))));
  const header = drawn.find((t) => t.indexOf("CYBER BINARY ·") === 0);
  check("the chart header still states the UTC basis and newest candle",
    !!header && /UTC/.test(header) && /09:47/.test(header), String(header));

  // A preset (non-router) signal must name itself and drop the auto tag.
  push({
    attached: true, primary: true, source: "websocket",
    asset: "EUR/USD OTC", assetId: "EURUSD_otc", price,
    candles, chartCandles: candles, chartPeriod: 60, chartTimeBasis: "broker-utc",
    signal: {
      ready: true, direction: "PUT", reason: "test", confidence: 70, regime: "ranging",
      session: "europe", entryTime, selectedStrategy: "trend", strategy: "trend",
    },
    strategy: "trend", selectedStrategy: "trend",
    wins: 1, losses: 0, winrate: 100, accuracy: 100, markers: [], history: [],
    ts: Date.now(),
  });
  const presetRow = String(byIdGet("regime-row").textContent);
  check("a preset signal names itself without the auto tag",
    /strategy: *Trend/i.test(presetRow) && !/\(auto\)/.test(presetRow),
    JSON.stringify(presetRow));

  // An unnamed signal must degrade to a dash, never to "undefined".
  push({
    attached: true, primary: true, source: "websocket",
    asset: "EUR/USD OTC", assetId: "EURUSD_otc", price,
    candles, chartCandles: candles, chartPeriod: 60, chartTimeBasis: "broker-utc",
    signal: { ready: false, direction: "WAIT", reason: "warming", confidence: 0 },
    wins: 0, losses: 0, winrate: 0, accuracy: 0, markers: [], history: [],
    ts: Date.now(),
  });
  const emptyRow = String(byIdGet("regime-row").textContent);
  check("an unnamed signal degrades to a dash, not 'undefined'",
    /strategy: —/.test(emptyRow) && !/undefined/.test(emptyRow), JSON.stringify(emptyRow));
}

/* ===================================================================
 * Part E — per-asset price precision (v2.6.19)
 *
 * JPY-quoted pairs are priced to 3 decimals with a 0.01 pip. The catalog
 * hardcoded 5/0.0001 for every FX pair, and the dashboard's fmtPx picked
 * decimals from magnitude alone (>= 20 -> 2), rendering CADJPY as 115.01
 * while Quotex shows 115.012.
 * =================================================================== */
function precisionTests() {
  const sandbox = { self: {}, console, Date, Math, JSON, RegExp };
  sandbox.globalThis = sandbox.self;
  vm.createContext(sandbox);
  loadLibs(sandbox, ["indicators.js", "assets.js"]);
  const ASSETS = sandbox.self.CYBER_ASSETS;

  const jpy = ["USDJPY", "EURJPY", "GBPJPY", "CADJPY", "CHFJPY", "NZDJPY", "AUDJPY", "USDJPY_otc"];
  for (const id of jpy) {
    const a = ASSETS.get(id);
    check("JPY pair " + id + " quotes 3 decimals with a 0.01 pip",
      !!a && a.decimals === 3 && Math.abs(a.pipSize - 0.01) < 1e-12,
      a ? "decimals=" + a.decimals + " pipSize=" + a.pipSize : "asset missing");
  }
  for (const id of ["EURUSD", "GBPUSD", "AUDUSD", "EURGBP"]) {
    const a = ASSETS.get(id);
    check("non-JPY pair " + id + " keeps 5 decimals / 0.0001 pip",
      !!a && a.decimals === 5 && Math.abs(a.pipSize - 0.0001) < 1e-12,
      a ? "decimals=" + a.decimals + " pipSize=" + a.pipSize : "asset missing");
  }

  // The dashboard formatter must honour those decimals, not the magnitude
  // heuristic. Mirrors src/dashboard.js fmtPx/assetDecimals.
  function fmtPx(n, assetId) {
    const a = assetId ? ASSETS.get(assetId) : null;
    const d = a && Number.isFinite(Number(a.decimals)) ? Math.floor(Number(a.decimals)) : null;
    if (d != null) return n.toFixed(d);
    return Math.abs(n) >= 20 ? n.toFixed(2) : n.toFixed(5);
  }
  check("CADJPY 115.012 keeps its third decimal (was 115.01)",
    fmtPx(115.012, "CADJPY") === "115.012", fmtPx(115.012, "CADJPY"));
  check("USDJPY 156.423 keeps its third decimal",
    fmtPx(156.423, "USDJPY") === "156.423", fmtPx(156.423, "USDJPY"));
  check("EURUSD still renders 5 decimals",
    fmtPx(1.08542, "EURUSD") === "1.08542", fmtPx(1.08542, "EURUSD"));
  check("unknown asset falls back to the magnitude heuristic",
    fmtPx(1.08542, null) === "1.08542" && fmtPx(2412.35, null) === "2412.35",
    fmtPx(1.08542, null) + " / " + fmtPx(2412.35, null));
}

/* =================================================================== */
engineTests();
noiseTests();
contentTests()
  .then((state) => autoTests().then(() => state))
  .then(() => {
    dashboardTests();
    precisionTests();
    if (failed) { console.error("FAILED " + failed); process.exitCode = 1; return; }
    console.log("OK — strategy naming, noise detection and UTC time-basis regressions passed");
  })
  .catch((e) => { console.error(e); process.exit(1); });
