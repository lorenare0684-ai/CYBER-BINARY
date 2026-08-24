#!/usr/bin/env node
"use strict";

/**
 * Adversarial / fuzz regression suite.
 *
 * Born out of the v2.6.1 critical-bug sweep: every public API is fed
 * hostile inputs (null/NaN/Infinity values, prototype keys, microsecond
 * and negative epochs, garbage protocol frames, giant buffers, symbol
 * assets) and must either fail closed or keep every output invariant
 * (OHLC bounds, finite counters, safe integer times, no prototype
 * pollution, no unhandled throws).
 *
 * Sync probes run first, then storage/auto probes against a stubbed
 * chrome.storage. Exits non-zero on the first report of any issue.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const LIBS = ["indicators", "assets", "strategy", "feed", "engine", "storage",
  "auto", "backtest", "workers", "quotex", "markers", "asset-selector"];

let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

function loadSandbox(extra) {
  const sb = Object.assign({
    self: {}, console,
    setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    URL, TextDecoder,
    window: {}, document: { querySelector: () => null, querySelectorAll: () => [] },
    Event: function () {}, location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/trade" },
  }, extra || {});
  sb.globalThis = sb.self;
  sb.window = sb.window || {};
  sb.window.WebSocket = undefined;
  vm.createContext(sb);
  for (const f of LIBS) vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f + ".js"), "utf8"), sb);
  return sb;
}

function chromeStorageStub() {
  const backing = new Map();
  return {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const k of [].concat(keys)) if (backing.has(k)) out[k] = JSON.parse(JSON.stringify(backing.get(k)));
          setTimeout(() => cb(out), 0);
        },
        set(obj, cb) {
          for (const k of Object.keys(obj)) backing.set(k, obj[k]);
          setTimeout(() => cb && cb(), 0);
        },
      },
    },
  };
}

/* ---------- sync probes ---------- */
function syncProbes() {
  const sb = loadSandbox();

  // 1) marker store: prototype keys rejected, adversarial toNative times
  const M = sb.self.CYBER_MARKERS;
  const store = M.createStore({});
  check("marker store rejects prototype asset keys",
    store.add({ asset: "__proto__", time: 1e12, price: 1, dir: "CALL" }) === false &&
    store.add({ asset: "constructor", time: 1e12, price: 1, dir: "PUT" }) === false);
  check("marker store never pollutes Object.prototype", !({}).CALL && !({}).PUT);
  const native = M.toNative([
    { time: Infinity, dir: "CALL" }, { time: -5, dir: "PUT" }, { time: 1e21, dir: "CALL" },
    { time: 1760000000123.9, dir: "PUT" }, { time: 0, dir: "CALL" },
  ]);
  check("toNative keeps only safe integer UTC seconds",
    native.every((m) => Number.isSafeInteger(m.time) && m.time > 0), JSON.stringify(native));

  // 2) engine.analyze: hostile series must not leak NaN decisions/scores
  const E = sb.self.CYBER_ENGINE;
  const hostileSeries = [
    [], [1],
    Array.from({ length: 300 }, (_, i) => ({ time: i * 60000, open: NaN, high: 1, low: 1, close: 1 })),
    Array.from({ length: 300 }, (_, i) => ({ time: i * 60000, open: 1e308, high: 1e308, low: 1e-320, close: 1e308 })),
    Array.from({ length: 300 }, (_, i) => ({ time: -i * 60000, open: 1, high: 1, low: 1, close: 1 })),
  ];
  let nanLeak = null;
  for (const series of hostileSeries) {
    for (const strategy of ["confluence", "auto_adaptive", "sniper"]) {
      const r = E.analyze(series, { strategy });
      if (!r) continue;
      if (Number.isNaN(r.score)) nanLeak = "score(" + strategy + ")";
      if (Number.isNaN(r.confidence) && r.direction === "CALL") nanLeak = "confidence(" + strategy + ")";
    }
  }
  check("analyze never emits NaN scores/confidence on hostile series", !nanLeak, nanLeak || "");

  // 3) engine.backtest: extreme options stay clamped, outputs finite
  // (an oversized warmup+horizon legitimately yields zero trades; the
  // engine result itself carries no `horizon` field — the matrix layer adds it)
  const bt = E.backtest(
    Array.from({ length: 400 }, (_, i) => ({ time: i * 60000, open: 1, high: 2, low: 0.5, close: i % 2 ? 1.5 : 0.9 })),
    { strategy: "trend", horizon: 1e9, minConf: -5, warmup: 1e9 });
  check("backtest hostile options produce finite, safe results",
    [bt.wins, bt.losses, bt.pnl, bt.maxDrawdown, bt.total].every(Number.isFinite) && bt.total === 0,
    JSON.stringify({ total: bt.total, pnl: bt.pnl }));

  // 4) engine.walkForward: undersized folds rejected
  const wf = E.walkForward(
    Array.from({ length: 120 }, (_, i) => ({ time: i * 60000, open: 1, high: 1.01, low: 0.99, close: 1 + Math.sin(i / 9) * 0.01 })),
    { folds: 2, strategy: "trend" });
  check("walkForward returns finite winrate or an explicit error",
    !wf || !!wf.error || Number.isFinite(wf.winrate));
  check("walkForward rejects undersized input",
    !!E.walkForward([], { folds: 5 }).error);

  // 5) feed: adversarial ingest keeps OHLC invariants
  const F = sb.self.CYBER_FEED;
  const feed = F.createFeed({ tfMs: 60000 });
  feed.ingest(1.0854, Date.now());
  feed.ingest(NaN, Date.now());
  feed.ingest(-1, Date.now());
  feed.ingest(1e308, "not-a-number");
  feed.ingest(1.0854, -5);
  feed.ingest(0, 8e15);
  const bars = feed.series();
  check("feed adversarial ingest keeps bars finite",
    bars.every((b) => [b.open, b.high, b.low, b.close].every(Number.isFinite)));
  check("feed adversarial ingest keeps OHLC bounds",
    bars.every((b) => b.high >= b.low && b.high >= b.open && b.low <= b.open && b.low <= b.close));

  // 6) syntheticSeries: extreme asset profile still yields valid candles
  const syn = F.syntheticSeries({ id: "X", basePrice: 1e12, vol: 2, jumpRate: 1, drift: 1 }, 500);
  check("syntheticSeries extreme profile keeps OHLC invariants",
    syn.length === 500 && syn.every((b) =>
      [b.open, b.high, b.low, b.close].every(Number.isFinite) && b.low > 0 &&
      b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)));

  // 7) workers: invalid assets/strategies filtered, no proto pollution
  const W = sb.self.CYBER_WORKERS;
  const job = W.buildJob(["EURUSD", "NOPE", "__proto__"], ["trend", "nope"],
    { days: NaN, seed: "x", horizon: Infinity, minConf: -1, minBars: 0 });
  check("buildJob drops unknown assets/strategies under hostile options",
    Object.keys(job.seriesByAsset).join(",") === "EURUSD" && job.jobs.length === 1,
    JSON.stringify(Object.keys(job.seriesByAsset)));
  check("buildJob never pollutes prototypes via asset ids", !({}).trend);

  // 8) historic getSeries: poisoned cache rows are dropped
  const H = sb.self.CYBER_HIST;
  const poisoned = Object.create(null);
  poisoned.EURUSD = [
    { time: "garbage" }, null,
    { time: 1e15, open: -1, high: -1, low: -1, close: -1 },
    { time: 1760000000000, open: 1, high: 1.1, low: 0.9, close: 1 },
  ];
  const cleaned = H.getSeries(sb.self.CYBER_ASSETS.get("EURUSD"), { days: 1, cachedByAsset: poisoned });
  check("getSeries drops invalid cached bars",
    cleaned.every((b) => Number.isFinite(b.close) && b.close > 0));

  // 9) quotex decoder: random text/binary frames never throw
  const Q = sb.self.CYBER_QUOTEX;
  const router = Q.createRouter({
    onCandles() {}, onTick() {}, onInstruments() {}, onStatus() {},
    onAsset() {}, onBalance() {}, onOrder() {}, onError() {},
  });
  let rng = 12345;
  const rand = () => (rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296;
  const alphabet = '42["instruments/list",{"a":[1,2,{"b":"c"}]},null]\0\xff\n {"x":1}42["success"';
  let decoderCrash = null;
  try {
    for (let i = 0; i < 3000; i++) {
      let s = "";
      const len = Math.floor(rand() * 120);
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * alphabet.length)];
      router.feedRaw(s);
      router.feedRaw(new Uint8Array(64).map(() => Math.floor(rand() * 256)));
    }
    router.feedRaw(new Uint8Array(5 * 1024 * 1024).fill(65).buffer); // giant frame
  } catch (e) { decoderCrash = e && e.message; }
  check("decoder survives 6000+ random frames and a 5MB frame", !decoderCrash, decoderCrash || "");

  // 10) subscribeHistory: invalid input fails closed without any frame
  const sent = [];
  const fakeWs = { readyState: 1, send: (s) => sent.push(String(s)) };
  const badSub = Q.subscribeHistory(fakeWs, 'EURUSD"', 60, 500);
  check("subscribeHistory rejects quote-injected asset and sends nothing",
    badSub && badSub.ok === false && sent.length === 0);
  check("subscribeHistory reports a missing socket",
    Q.subscribeHistory(null, "EURUSD_otc", 60, 500).ok === false);

  // 11) asset catalog: adversarial detection never yields unsafe ids
  const A = sb.self.CYBER_ASSETS;
  let unsafe = null;
  for (const t of ["EUR/USD", "eurusd_otc", "  GBP-JPY ", "OTC-123", "", "XAU/USD (OTC)", ".constructor", "toString"]) {
    const a = A.detect(t);
    if (a && !/^[A-Za-z0-9._-]+$/.test(a.id)) unsafe = JSON.stringify(t) + " -> " + a.id;
  }
  check("asset detect never returns unsafe ids", !unsafe, unsafe || "");
  check("asset byKind returns arrays for every class",
    ["otc", "fx", "crypto", "commodity", "index", "stock", "garbage"].every((k) => Array.isArray(A.byKind(k))));

  // 12) asset-selector: hostile inputs never leak NaN EV/scores
  const AS = sb.self.CYBER_ASSET_SELECTOR;
  let selectorNan = null;
  for (const a of [null, { id: "__proto__" }, { id: "EURUSD", payout: "abc" }, "NOPE", { id: "EURUSD_otc" }]) {
    const r = AS.evaluateAsset(a, { stats: { byAsset: { EURUSD_otc: { w: 1e400, l: -5 } } } });
    if (r && (Number.isNaN(r.expectedValue) || Number.isNaN(r.accuracyScore))) selectorNan = JSON.stringify(a && a.id);
  }
  check("asset selector keeps finite EV/accuracy on hostile inputs", !selectorNan, selectorNan || "");

  // 13) parseCandles: garbage payloads never throw or emit bad bars
  let parseCrash = null, parseBad = null;
  for (const g of [null, [], [[]], [["x"]], [{ time: "abc" }], { raw: [{ open: NaN }] }, "string", 42, { candles: "nope" }]) {
    try {
      const r = Q.parseCandles(g, "EURUSD_otc", 60);
      if (r && Array.isArray(r.candles) && r.candles.some((c) => !(Number(c.close) > 0))) parseBad = JSON.stringify(String(g));
    } catch (e) { parseCrash = JSON.stringify(String(g)) + ": " + e.message; }
  }
  check("parseCandles survives garbage without throwing", !parseCrash, parseCrash || "");
  check("parseCandles never emits non-positive closes", !parseBad, parseBad || "");
}

/* ---------- async probes (stubbed chrome.storage) ---------- */
async function asyncProbes() {
  // 14) storage: proto keys rejected, trade roundtrip intact
  const sbStore = loadSandbox(chromeStorageStub());
  const STORE = sbStore.self.CYBER_STORE;
  const protoKey = await STORE.setCandles("__proto__", [{ time: 1, open: 1, high: 1, low: 1, close: 1 }]);
  check("storage rejects __proto__ candle keys", protoKey === false);
  await STORE.recordTrade({ dir: "CALL", won: true, asset: "EURUSD", strategy: "t", regime: "r", confidence: 50, entry: 1, exit: 2, pnl: 1 });
  const stats = await STORE.getStats();
  check("storage trade roundtrip keeps finite counters and history",
    Number.isFinite(stats.wins) && stats.wins >= 1 && Array.isArray(stats.history) && stats.history.length >= 1);

  // 15) auto controller: hostile signals, dedup, loss freeze, sane counters
  const sbAuto = loadSandbox(Object.assign(chromeStorageStub(), { Notification: undefined }));
  const AUTO = sbAuto.self.CYBER_AUTO;
  const trades = [];
  const ctrl = AUTO.startAuto({
    onTrade: (t) => trades.push(t),
    onLog() {}, onState() {},
    executeTrade: async () => ({ ok: true, confirmed: true, openTime: Date.now(), expiryTime: Date.now() + 60000, openPrice: 1.1 }),
  });
  ctrl.setMode("click");
  ctrl.setArmed(true);
  ctrl.setAccountInfo({ isDemo: true, balance: 1000, currency: "USD" });
  const barTime = Date.now();
  const hostileSignals = [
    null, {},
    { ready: true, direction: "SIDEWAYS" },
    { ready: true, direction: "CALL", confidence: "abc" },
    { ready: true, direction: "CALL", confidence: 99, asset: "EURUSD", time: barTime + 9e6 }, // future
    { ready: true, direction: "CALL", confidence: 99, asset: "EURUSD", time: barTime },      // good
    { ready: true, direction: "CALL", confidence: 99, asset: "EURUSD", time: barTime },      // dup
    { ready: true, direction: "PUT", confidence: 99, asset: Symbol("x"), time: barTime + 60000 },
  ];
  let threw = null;
  for (const s of hostileSignals) {
    try { await ctrl.handleSignal(s); } catch (e) { threw = e && e.message; break; }
  }
  check("auto controller never throws on hostile signals", !threw, threw || "");
  const confirmed = trades.filter((t) => t.ok);
  check("auto controller places exactly one trade per closed bar", confirmed.length === 1,
    "confirmed=" + confirmed.length);
  await ctrl.settleOrder(null, 1, "X");
  await ctrl.settleOrder("o1", NaN, "X");
  await ctrl.settleOrder("o1", -1, "EURUSD");
  await ctrl.settleOrder("o1", -1, "EURUSD"); // duplicate settlement
  const st = ctrl.getState();
  check("auto ledger stays finite; duplicate settlements ignored",
    Number.isFinite(st.tradesToday) && st.tradesToday >= 1 && st.dailyPnl === -1,
    JSON.stringify({ tradesToday: st.tradesToday, dailyPnl: st.dailyPnl }));
  check("losing settlement freezes the asset",
    st.frozenAssets && Object.prototype.hasOwnProperty.call(st.frozenAssets, "EURUSD"));
  ctrl.stop();
}

(async () => {
  syncProbes();
  await asyncProbes();
  console.log(failed ? "\n" + failed + " FUZZ FAILURE(S)" : "\nall fuzz/adversarial checks pass");
  process.exit(failed ? 1 : 0);
})();
