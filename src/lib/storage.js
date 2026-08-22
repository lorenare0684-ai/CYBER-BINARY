/**
 * Persistent state via chrome.storage.local. Used for:
 *   - settings (active strategy, risk limits, automation mode, etc.)
 *   - trade history (recent signal outcomes for accuracy on historic data)
 *   - per-asset historic accuracy
 *   - calibration snapshots
 *   - live candles buffer per asset (for offline backtest replay)
 */
(function (root) {
  "use strict";

  const KEY = "cyberBinaryV2";
  const DEFAULTS = {
    settings: {
      strategy: "confluence",
      autoMode: "off",            // "off" | "alerts" | "click"
      armed: false,
      stake: 1,                   // $ per trade
      expiry: 3,                  // minutes
      maxTradesPerHour: 12,
      maxTradesPerDay: 60,
      dailyLossCap: 30,           // $ — stop on loss
      dailyProfitCap: 0,          // $ — 0 = no cap
      minConfidence: 65,          // refuse signals below this confidence
      cooldownBars: 2,            // min bars between trades
      calibration: true,          // adjust confidence by observed hit rate
      perAssetStrategy: {},       // { ASSET: strategyId }
      notifySound: true,
      notifyDesktop: false,
    },
    stats: {
      wins: 0, losses: 0, history: [],
      byStrategy: {},             // { stratId: {w,l} }
      byAsset: {},                // { assetId: {w,l, history:[]} }
      byRegime: {},               // { regime: {w,l} }
      byDay: {},                  // { YYYY-MM-DD: {w,l,pnl} }
      dailyPnl: 0,
      dailyReset: 0,              // timestamp of last reset
    },
    candles: {},                  // { assetId: [lastN bars] }
    calibration: {
      buckets: {},                // { confidenceBucket: {pred, hit, n} }
      updated: 0,
    },
  };

  const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;

  function now() { return Date.now(); }

  function deepMerge(target, source) {
    if (typeof source !== "object" || source === null) return target;
    for (const k of Object.keys(source)) {
      if (Array.isArray(source[k])) target[k] = source[k].slice();
      else if (source[k] && typeof source[k] === "object") {
        if (!target[k] || typeof target[k] !== "object") target[k] = {};
        deepMerge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
    return target;
  }

  function clone(x) { return JSON.parse(JSON.stringify(x)); }

  let cache = null;
  let saveTimer = null;
  const listeners = new Set();

  function notify() {
    if (!cache) return;
    const snap = clone(cache);
    for (const fn of listeners) try { fn(snap); } catch (_) {}
  }

  function load() {
    return new Promise((resolve) => {
      if (!hasChrome) {
        // Fallback to in-memory for non-extension context
        if (!cache) cache = clone(DEFAULTS);
        resolve(cache);
        return;
      }
      // v2.3.2: flush-before-read. The old code re-read chrome.storage on
      // EVERY load() without first flushing the debounced save() — so two
      // rapid setSettings() calls (e.g. mode then arm) lost the earlier
      // patch: the second load() saw the pre-patch storage and the first
      // mutation was never written. Flushing pending writes first keeps the
      // in-memory sequence, while still re-reading storage afterwards so
      // changes from other contexts (dashboard popup, other tabs) are seen.
      const read = () => {
        chrome.storage.local.get(KEY, (d) => {
          cache = clone(DEFAULTS);
          if (d && d[KEY]) deepMerge(cache, d[KEY]);
          resolve(cache);
        });
      };
      if (saveTimer) flush().then(read); else read();
    });
  }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 200);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!cache) return Promise.resolve();
    if (!hasChrome) { notify(); return Promise.resolve(); }
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [KEY]: cache }, () => resolve());
      } catch (_) { resolve(); }
    }).then(notify);
  }

  async function getSettings() {
    const s = await load();
    return clone(s.settings);
  }

  async function setSettings(patch) {
    const s = await load();
    deepMerge(s.settings, patch);
    save();
    return clone(s.settings);
  }

  async function getStats() {
    const s = await load();
    return clone(s.stats);
  }

  async function getCalibration() {
    const s = await load();
    return clone(s.calibration);
  }

  async function getCandles(assetId) {
    const s = await load();
    return s.candles[assetId] ? s.candles[assetId].slice() : [];
  }

  async function setCandles(assetId, bars, max) {
    const s = await load();
    s.candles[assetId] = bars.slice(-(max || 1000));
    save();
  }

  /**
   * Record a settled trade outcome and update all breakdowns.
   */
  async function recordTrade(trade) {
    const s = await load();
    const st = s.stats;
    const t = now();
    const day = new Date(t).toISOString().slice(0, 10);
    const asset = trade.asset || "UNKNOWN";
    const strat = trade.strategy || "confluence";
    const regime = trade.regime || "unknown";

    if (t - (st.dailyReset || 0) > 24 * 36e5) { // reset daily P&L every 24h
      st.dailyPnl = 0;
      st.dailyReset = t;
    }

    if (trade.won) { st.wins++; st.dailyPnl += (trade.payout || 0.85); }
    else { st.losses++; st.dailyPnl -= 1; }

    st.history.unshift({
      at: t, asset, dir: trade.dir, won: trade.won, entry: trade.entry,
      exit: trade.exit, score: trade.score, confidence: trade.confidence,
      regime, strategy: strat, pnl: trade.won ? (trade.payout || 0.85) : -1,
    });
    if (st.history.length > 500) st.history.length = 500;

    if (!st.byStrategy[strat]) st.byStrategy[strat] = { w: 0, l: 0 };
    if (!st.byAsset[asset]) st.byAsset[asset] = { w: 0, l: 0, history: [] };
    if (!st.byRegime[regime]) st.byRegime[regime] = { w: 0, l: 0 };
    if (!st.byDay[day]) st.byDay[day] = { w: 0, l: 0, pnl: 0 };

    if (trade.won) {
      st.byStrategy[strat].w++; st.byAsset[asset].w++;
      st.byRegime[regime].w++; st.byDay[day].w++;
    } else {
      st.byStrategy[strat].l++; st.byAsset[asset].l++;
      st.byRegime[regime].l++; st.byDay[day].l++;
    }
    st.byAsset[asset].history = st.byAsset[asset].history || [];
    st.byAsset[asset].history.unshift({ at: t, dir: trade.dir, won: trade.won, confidence: trade.confidence, regime });
    if (st.byAsset[asset].history.length > 100) st.byAsset[asset].history.length = 100;
    st.byDay[day].pnl += trade.won ? (trade.payout || 0.85) : -1;

    // Calibration: bucket by confidence
    if (s.calibration && s.settings.calibration) {
      const b = Math.min(90, Math.floor((trade.confidence || 0) / 10) * 10);
      if (!s.calibration.buckets[b]) s.calibration.buckets[b] = { hits: 0, n: 0 };
      s.calibration.buckets[b].n++;
      if (trade.won) s.calibration.buckets[b].hits++;
      s.calibration.updated = t;
    }

    save();
    return clone(st);
  }

  /**
   * Convert bucket observations into a smooth function:
   * given predicted confidence, return adjusted confidence that better
   * matches observed hit rate. If we have no data, returns input as-is.
   */
  function calibrationAdjust(predicted, buckets) {
    if (!buckets || !Object.keys(buckets).length) return predicted;
    const b = Math.min(90, Math.floor((predicted || 0) / 10) * 10);
    const v = buckets[b];
    if (!v || v.n < 5) return predicted;
    // Shrink to observed rate, blended with predicted (Bayesian-ish).
    const obs = v.hits / v.n;
    const prior = predicted / 100;
    const weight = Math.min(1, v.n / 25);
    const blended = prior * (1 - weight) + obs * weight;
    return Math.round(blended * 100);
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  async function reset() {
    cache = clone(DEFAULTS);
    save();
    return clone(cache);
  }

  root.CYBER_STORE = {
    load, flush, save,
    getSettings, setSettings,
    getStats, getCalibration,
    getCandles, setCandles,
    recordTrade, calibrationAdjust,
    onChange, reset,
    DEFAULTS,
  };
})(typeof self !== "undefined" ? self : globalThis);
