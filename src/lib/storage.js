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
      strategy: "auto_adaptive",
      autoMode: "off",            // "off" | "alerts" | "click"
      armed: false,
      stake: 1,                   // $ per trade
      expiry: 3,                  // minutes — used when expiryMode=fixed
      expiryMode: "adaptive",     // "fixed" | "adaptive" — dynamic expiry for accuracy
      adaptiveExpiryMin: 1,       // min adaptive expiry (minutes)
      adaptiveExpiryMax: 5,       // max adaptive expiry (minutes)
      maxTradesPerHour: 12,
      maxTradesPerDay: 60,
      dailyLossCap: 30,           // $ — stop on loss
      dailyProfitCap: 0,          // $ — 0 = no cap
      minConfidence: 90,          // v2.7.0: only 90+ confidence has real edge (81.5% WR)
      cooldownBars: 2,            // min bars between trades
      accountMode: "demo",        // v2.6.9 demo|live|any — auto refuses the wrong account type
      stakeMode: "fixed",         // v2.6.9 fixed|percent
      stakePercent: 1,            // v2.6.9 percent of balance per trade (0.1-10)
      minBalance: 0,              // v2.6.9 stop auto below this balance (0 = off)
      minIntervalMs: 5000,        // hard anti-double-submit interval
      calibration: true,          // adjust confidence by observed hit rate
      autoHighAccuracy: true,     // filter trades by high-accuracy assets EV > 0
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
    automation: {
      dayKey: "", hourKey: "", dayStart: 0, hourStart: 0,
      tradesToday: 0, tradesHour: 0, dailyPnl: 0,
      lastTrade: null, lastAttemptAt: 0,
      lastSignalKey: "", recentSignalKeys: [], recentClosedOrderIds: [], frozenAssets: {},
    },
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
      if (k === "__proto__" || k === "prototype" || k === "constructor") continue;
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
  let syncedCache = null;
  let saveTimer = null;
  let mutationQueue = Promise.resolve();
  const listeners = new Set();

  function safeKey(value, fallback) {
    const s = String(value == null ? "" : value).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 96);
    return !s || s === "__proto__" || s === "prototype" || s === "constructor" ||
      Object.prototype.hasOwnProperty.call(Object.prototype, s) ? fallback : s;
  }

  function finiteIn(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function timestampMs(value, fallback) {
    if (value == null || value === "") return fallback;
    let n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    while (n >= 1e14) n /= 1000;
    if (n > 0 && n < 1e11) n *= 1000;
    n = Math.floor(n);
    return Number.isSafeInteger(n) ? n : fallback;
  }

  function sanitizeSettings(input) {
    const s = deepMerge(clone(DEFAULTS.settings), input || {});
    s.strategy = typeof s.strategy === "string" && s.strategy ? s.strategy.slice(0, 64) : DEFAULTS.settings.strategy;
    s.autoMode = s.autoMode === "alerts" || s.autoMode === "click" ? s.autoMode : "off";
    s.armed = s.autoMode !== "off" && !!s.armed;
    s.stake = finiteIn(s.stake, DEFAULTS.settings.stake, 0.01, 1000000);
    s.expiry = finiteIn(s.expiry, DEFAULTS.settings.expiry, 0.5, 1440);
    s.expiryMode = s.expiryMode === "fixed" ? "fixed" : "adaptive";
    s.adaptiveExpiryMin = finiteIn(s.adaptiveExpiryMin, DEFAULTS.settings.adaptiveExpiryMin, 0.5, 1440);
    s.adaptiveExpiryMax = finiteIn(s.adaptiveExpiryMax, DEFAULTS.settings.adaptiveExpiryMax, 0.5, 1440);
    if (s.adaptiveExpiryMin > s.adaptiveExpiryMax) {
      const tmp = s.adaptiveExpiryMin;
      s.adaptiveExpiryMin = s.adaptiveExpiryMax;
      s.adaptiveExpiryMax = tmp;
    }
    s.maxTradesPerHour = Math.floor(finiteIn(s.maxTradesPerHour, DEFAULTS.settings.maxTradesPerHour, 0, 10000));
    s.maxTradesPerDay = Math.floor(finiteIn(s.maxTradesPerDay, DEFAULTS.settings.maxTradesPerDay, 0, 100000));
    s.dailyLossCap = finiteIn(s.dailyLossCap, DEFAULTS.settings.dailyLossCap, 0, 1000000000);
    s.dailyProfitCap = finiteIn(s.dailyProfitCap, DEFAULTS.settings.dailyProfitCap, 0, 1000000000);
    s.minConfidence = finiteIn(s.minConfidence, DEFAULTS.settings.minConfidence, 0, 100);
    s.cooldownBars = finiteIn(s.cooldownBars, DEFAULTS.settings.cooldownBars, 0, 1440);
    s.accountMode = s.accountMode === "live" || s.accountMode === "any" ? s.accountMode : "demo";
    s.stakeMode = s.stakeMode === "percent" ? "percent" : "fixed";
    s.stakePercent = finiteIn(s.stakePercent, DEFAULTS.settings.stakePercent, 0.1, 10);
    s.minBalance = finiteIn(s.minBalance, DEFAULTS.settings.minBalance, 0, 1e9);
    s.minIntervalMs = finiteIn(s.minIntervalMs, DEFAULTS.settings.minIntervalMs, 1000, 3600000);
    s.calibration = !!s.calibration;
    s.autoHighAccuracy = s.autoHighAccuracy !== false;
    s.notifySound = !!s.notifySound;
    s.notifyDesktop = !!s.notifyDesktop;
    if (!s.perAssetStrategy || typeof s.perAssetStrategy !== "object" || Array.isArray(s.perAssetStrategy)) s.perAssetStrategy = {};
    const perAsset = {};
    for (const key of Object.keys(s.perAssetStrategy).slice(0, 500)) {
      const id = safeKey(key, "");
      const strategy = s.perAssetStrategy[key];
      if (id && typeof strategy === "string" && strategy) perAsset[id] = strategy.slice(0, 64);
    }
    s.perAssetStrategy = perAsset;
    for (const key of Object.keys(s)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.settings, key)) delete s[key];
    }
    return s;
  }

  function sanitizeFrozenAssets(input) {
    const out = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) return out;
    const current = now();
    for (const rawId of Object.keys(input).slice(-500)) {
      const id = safeKey(rawId, "");
      const until = timestampMs(input[rawId], 0);
      if (id && until > current && until <= current + 7 * 86400000) out[id] = until;
    }
    return out;
  }

  function sanitizeBreakdown(input, maxKeys, assetHistory) {
    const out = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) return out;
    for (const rawKey of Object.keys(input).slice(-maxKeys)) {
      const key = safeKey(rawKey, "");
      const value = input[rawKey];
      if (!key || !value || typeof value !== "object" || Array.isArray(value)) continue;
      const row = {
        w: Math.floor(finiteIn(value.w, 0, 0, 1000000000)),
        l: Math.floor(finiteIn(value.l, 0, 0, 1000000000)),
      };
      const draws = Math.floor(finiteIn(value.d, 0, 0, 1000000000));
      if (draws) row.d = draws;
      if (assetHistory) row.history = sanitizeHistory(value.history, 100, key);
      if (value.pnl != null) row.pnl = finiteIn(value.pnl, 0, -1000000000, 1000000000);
      out[key] = row;
    }
    return out;
  }

  function sanitizeAutomation(input) {
    const a = deepMerge(clone(DEFAULTS.automation),
      input && typeof input === "object" && !Array.isArray(input) ? input : {});
    a.tradesToday = Math.floor(finiteIn(a.tradesToday, 0, 0, 100000));
    a.tradesHour = Math.floor(finiteIn(a.tradesHour, 0, 0, 100000));
    a.dailyPnl = finiteIn(a.dailyPnl, 0, -1000000000, 1000000000);
    a.dayStart = timestampMs(a.dayStart, 0);
    a.hourStart = timestampMs(a.hourStart, 0);
    a.lastAttemptAt = timestampMs(a.lastAttemptAt, 0);
    a.dayKey = typeof a.dayKey === "string" ? a.dayKey.slice(0, 16) : "";
    a.hourKey = typeof a.hourKey === "string" ? a.hourKey.slice(0, 20) : "";
    a.lastSignalKey = typeof a.lastSignalKey === "string" ? a.lastSignalKey.slice(0, 256) : "";
    const signalKeys = Array.isArray(a.recentSignalKeys) ? a.recentSignalKeys : [];
    a.recentSignalKeys = Array.from(new Set(signalKeys
      .filter((key) => typeof key === "string" && key)
      .map((key) => key.slice(0, 256)))).slice(-100);
    const closedIds = Array.isArray(a.recentClosedOrderIds) ? a.recentClosedOrderIds : [];
    a.recentClosedOrderIds = Array.from(new Set(closedIds
      .filter((id) => typeof id === "string" && id.trim())
      .map((id) => id.trim().slice(0, 256)))).slice(-500);
    a.frozenAssets = sanitizeFrozenAssets(a.frozenAssets);
    if (!a.lastTrade || typeof a.lastTrade !== "object" || Array.isArray(a.lastTrade)) {
      a.lastTrade = null;
    } else {
      const source = a.lastTrade;
      const at = timestampMs(source.at != null ? source.at : source.entryTime, 0);
      const entryTime = timestampMs(source.entryTime, at);
      if (entryTime <= 0) {
        a.lastTrade = null;
      } else {
        let expiryTime = timestampMs(source.expiryTime, 0);
        if (expiryTime && expiryTime < entryTime) expiryTime = entryTime;
        a.lastTrade = {
          at: entryTime, entryTime, expiryTime,
          entryPrice: finiteIn(source.entryPrice, 0, 0, 1e100),
          asset: safeKey(source.asset, "UNKNOWN"),
          dir: source.dir === "CALL" || source.dir === "PUT" ? source.dir : null,
          id: source.id == null ? null : String(source.id).slice(0, 128),
          confirmed: source.confirmed === true,
        };
      }
    }
    for (const key of Object.keys(a)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.automation, key)) delete a[key];
    }
    return a;
  }

  function sanitizeHistory(input, limit, defaultAsset) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const value of input.slice(0, limit)) {
      if (!value || typeof value !== "object" || Array.isArray(value) ||
          (value.dir !== "CALL" && value.dir !== "PUT")) continue;
      const hasWon = Object.prototype.hasOwnProperty.call(value, "won");
      const draw = value.draw === true || (hasWon && value.won === null);
      if (!draw && value.won !== true && value.won !== false) continue;
      const entryTime = timestampMs(value.entryTime != null ? value.entryTime : value.at, 0);
      if (entryTime <= 0) continue;
      const rawMinutes = Number(value.expiryMinutes);
      const expiryMinutes = Number.isFinite(rawMinutes) && rawMinutes >= 0 ? Math.min(1440, rawMinutes) : null;
      let expiryTime = timestampMs(value.expiryTime,
        expiryMinutes != null ? entryTime + expiryMinutes * 60000 : null);
      if (expiryTime != null && expiryTime < entryTime) expiryTime = entryTime;
      let exitTime = timestampMs(value.exitTime, expiryTime != null ? expiryTime : entryTime);
      if (exitTime < entryTime || (expiryTime != null && exitTime < expiryTime)) exitTime = expiryTime != null ? expiryTime : entryTime;
      const entryRaw = Number(value.entryPrice != null ? value.entryPrice : value.entry);
      const exitRaw = Number(value.exitPrice != null ? value.exitPrice : value.exit);
      const entry = Number.isFinite(entryRaw) && entryRaw > 0 && entryRaw <= 1e100 ? entryRaw : null;
      const exit = Number.isFinite(exitRaw) && exitRaw > 0 && exitRaw <= 1e100 ? exitRaw : null;
      const asset = safeKey(value.asset, defaultAsset || "UNKNOWN");
      out.push({
        at: entryTime, entryTime, expiryTime, exitTime, expiryMinutes,
        asset, dir: value.dir, won: draw ? null : value.won === true, draw,
        entry, entryPrice: entry, exit, exitPrice: exit,
        score: Number.isFinite(Number(value.score)) ? Math.max(-1000000, Math.min(1000000, Number(value.score))) : null,
        confidence: Number.isFinite(Number(value.confidence)) ? Math.max(0, Math.min(100, Number(value.confidence))) : null,
        regime: safeKey(value.regime, "unknown"),
        strategy: safeKey(value.strategy, "confluence"),
        pnl: finiteIn(value.pnl, draw ? 0 : (value.won === true ? 0.85 : -1), -1000000, 1000000),
      });
    }
    return out;
  }

  function sanitizeCandleRows(input, limit) {
    if (!Array.isArray(input)) return [];
    const byTime = new Map();
    for (const b of input.slice(-Math.min(10000, limit * 2))) {
      if (!b || typeof b !== "object" || Array.isArray(b)) continue;
      let time = timestampMs(b.time, null);
      let open = Number(b.open), high = Number(b.high), low = Number(b.low), close = Number(b.close);
      if (time == null || ![open, high, low, close].every(Number.isFinite) ||
          open <= 0 || high <= 0 || low <= 0 || close <= 0 || Math.max(open, high, low, close) > 1e100) continue;
      high = Math.max(open, high, low, close);
      low = Math.min(open, high, low, close);
      byTime.set(time, { time, open, high, low, close, volume: finiteIn(b.volume, 0, 0, 1e100) });
    }
    return Array.from(byTime.values()).sort((a, b) => a.time - b.time).slice(-limit);
  }

  function sanitizeLoadedState(value) {
    const s = value && typeof value === "object" && !Array.isArray(value) ? value : clone(DEFAULTS);
    s.settings = sanitizeSettings(s.settings);
    if (!s.stats || typeof s.stats !== "object" || Array.isArray(s.stats)) s.stats = clone(DEFAULTS.stats);
    const st = s.stats;
    st.wins = Math.floor(finiteIn(st.wins, 0, 0, 1000000000));
    st.losses = Math.floor(finiteIn(st.losses, 0, 0, 1000000000));
    st.dailyPnl = finiteIn(st.dailyPnl, 0, -1000000000, 1000000000);
    st.dailyReset = timestampMs(st.dailyReset, 0);
    st.history = sanitizeHistory(st.history, 500, "UNKNOWN");
    st.byStrategy = sanitizeBreakdown(st.byStrategy, 500, false);
    st.byAsset = sanitizeBreakdown(st.byAsset, 500, true);
    st.byRegime = sanitizeBreakdown(st.byRegime, 500, false);
    st.byDay = sanitizeBreakdown(st.byDay, 400, false);
    for (const key of Object.keys(st)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.stats, key)) delete st[key];
    }
    s.automation = sanitizeAutomation(s.automation);
    if (!s.calibration || typeof s.calibration !== "object" || Array.isArray(s.calibration)) s.calibration = clone(DEFAULTS.calibration);
    if (!s.calibration.buckets || typeof s.calibration.buckets !== "object" || Array.isArray(s.calibration.buckets)) s.calibration.buckets = {};
    const buckets = {};
    for (const key of Object.keys(s.calibration.buckets).slice(0, 20)) {
      const n = Number(key), row = s.calibration.buckets[key];
      if (!Number.isInteger(n) || n < 0 || n > 90 || n % 10 !== 0 || !row || typeof row !== "object") continue;
      const count = Math.floor(finiteIn(row.n, 0, 0, 1000000000));
      buckets[n] = { n: count, hits: Math.floor(finiteIn(row.hits, 0, 0, count)) };
    }
    s.calibration.buckets = buckets;
    s.calibration.updated = timestampMs(s.calibration.updated, 0);
    for (const key of Object.keys(s.calibration)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS.calibration, key)) delete s.calibration[key];
    }
    if (!s.candles || typeof s.candles !== "object" || Array.isArray(s.candles)) s.candles = {};
    const candles = {};
    for (const rawId of Object.keys(s.candles).slice(-200)) {
      const id = safeKey(rawId, "");
      const rows = s.candles[rawId];
      if (id && Array.isArray(rows)) candles[id] = sanitizeCandleRows(rows, 5000);
    }
    s.candles = candles;
    for (const key of Object.keys(s)) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) delete s[key];
    }
    return s;
  }

  function equalJson(a, b) {
    if (Object.is(a, b)) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!equalJson(a[i], b[i])) return false;
      return true;
    }
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const ak = Object.keys(a), bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const key of ak) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !equalJson(a[key], b[key])) return false;
    }
    return true;
  }

  function stateDiff(before, after, path, out) {
    path = path || [];
    out = out || [];
    if (Object.is(before, after) || equalJson(before, after)) return out;
    const beforeObject = before && typeof before === "object" && !Array.isArray(before);
    const afterObject = after && typeof after === "object" && !Array.isArray(after);
    if (beforeObject && afterObject) {
      const keys = new Set(Object.keys(before).concat(Object.keys(after)));
      for (const key of keys) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
        if (!Object.prototype.hasOwnProperty.call(after, key)) {
          out.push({ path: path.concat(key), remove: true });
        } else {
          stateDiff(before[key], after[key], path.concat(key), out);
        }
      }
      return out;
    }
    if (after === undefined) out.push({ path: path.slice(), remove: true });
    else out.push({ path: path.slice(), value: clone(after) });
    return out;
  }

  function pathValue(value, path) {
    let current = value;
    for (const key of path) {
      if (!current || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  function sendPatch(patch) {
    if (!patch.length) return Promise.resolve();
    const canBroker = hasChrome && chrome.runtime && typeof chrome.runtime.sendMessage === "function";
    if (!canBroker) return null;
    return chrome.runtime.sendMessage({ type: "CYBER_STORAGE_PATCH", patch }).then((response) => {
      if (!response || !response.ok) throw new Error(response && response.error || "storage patch failed");
    });
  }

  function serializeMutation(fn, dirtyPaths) {
    const task = mutationQueue.then(async () => {
      const state = await load();
      const paths = Array.isArray(dirtyPaths) && dirtyPaths.length ? dirtyPaths : [[]];
      const before = paths.map((path) => {
        const value = pathValue(state, path);
        return value === undefined ? undefined : clone(value);
      });
      const result = await fn(state);
      // storage.onChanged can replace the module-level cache while an async
      // mutator is in flight. Commit the exact object that fn mutated rather
      // than whichever object cache happens to reference at flush time.
      const snapshot = state;
      const patch = [];
      for (let i = 0; i < paths.length; i++) {
        stateDiff(before[i], pathValue(snapshot, paths[i]), paths[i], patch);
      }
      cache = snapshot;
      await flush(patch, snapshot);
      return result;
    });
    mutationQueue = task.catch(() => {});
    return task;
  }

  function notify() {
    if (!cache) return;
    const snap = clone(cache);
    for (const fn of listeners) try { fn(snap); } catch (_) {}
  }

  // Keep long-lived content scripts synchronized with dashboard writes.
  // onChange() previously fired only for writes made by the same JS context,
  // leaving expiry/mode/armed stale until some unrelated read occurred.
  try {
    if (hasChrome && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !changes || !changes[KEY]) return;
        const next = changes[KEY].newValue;
        cache = clone(DEFAULTS);
        if (next) deepMerge(cache, next);
        cache = sanitizeLoadedState(cache);
        syncedCache = clone(cache);
        notify();
      });
    }
  } catch (_) {}

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
        try {
          chrome.storage.local.get(KEY, (d) => {
            const err = chrome.runtime && chrome.runtime.lastError;
            if (err) {
              if (!cache) cache = clone(DEFAULTS);
              cache = sanitizeLoadedState(cache);
              resolve(cache);
              return;
            }
            cache = clone(DEFAULTS);
            if (d && d[KEY]) deepMerge(cache, d[KEY]);
            cache = sanitizeLoadedState(cache);
            syncedCache = clone(cache);
            resolve(cache);
          });
        } catch (_) {
          if (!cache) cache = clone(DEFAULTS);
          cache = sanitizeLoadedState(cache);
          syncedCache = clone(cache);
          resolve(cache);
        }
      };
      if (saveTimer) flush().then(read, read); else read();
    });
  }

  function save() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 200);
  }

  function flush(patch, exactSnapshot) {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (!cache) return Promise.resolve();
    if (!hasChrome) { notify(); return Promise.resolve(); }
    const snapshot = exactSnapshot ? clone(exactSnapshot) : clone(cache);
    const outgoingPatch = Array.isArray(patch) ? patch
      : (syncedCache ? stateDiff(syncedCache, snapshot) : []);
    const brokered = sendPatch(outgoingPatch);
    if (brokered) return brokered.then(() => {
      syncedCache = clone(snapshot);
      notify();
    });
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        const err = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve();
      };
      try {
        const result = chrome.storage.local.set({ [KEY]: snapshot }, finish);
        if (result && typeof result.then === "function") result.then(finish, reject);
      } catch (e) { reject(e); }
    }).then(() => {
      syncedCache = clone(snapshot);
      notify();
    });
  }

  async function getSettings() {
    const s = await load();
    return clone(s.settings);
  }

  async function setSettings(patch) {
    return serializeMutation((s) => {
      s.settings = sanitizeSettings(deepMerge(s.settings, patch || {}));
      return clone(s.settings);
    }, [["settings"]]);
  }

  async function getStats() {
    const s = await load();
    return clone(s.stats);
  }

  async function getAutomation() {
    const s = await load();
    return clone(s.automation || DEFAULTS.automation);
  }

  async function setAutomation(patch) {
    return serializeMutation((s) => {
      const current = s.automation && typeof s.automation === "object" && !Array.isArray(s.automation)
        ? s.automation : clone(DEFAULTS.automation);
      deepMerge(current, patch && typeof patch === "object" && !Array.isArray(patch) ? patch : {});
      s.automation = sanitizeAutomation(current);
      return clone(s.automation);
    }, [["automation"]]);
  }

  async function getCalibration() {
    const s = await load();
    return clone(s.calibration);
  }

  async function getCandles(assetId) {
    const id = safeKey(assetId, "");
    if (!id) return [];
    const s = await load();
    return Object.prototype.hasOwnProperty.call(s.candles, id) && Array.isArray(s.candles[id])
      ? s.candles[id].map(clone) : [];
  }

  async function setCandles(assetId, bars, max) {
    const id = safeKey(assetId, "");
    if (!id || !Array.isArray(bars)) return false;
    const limit = Math.floor(finiteIn(max, 1000, 1, 5000));
    const clean = sanitizeCandleRows(bars, limit);
    return serializeMutation((s) => {
      s.candles[id] = clean;
      return true;
    }, [["candles", id]]);
  }

  /**
   * Record a settled trade outcome and update all breakdowns.
   */
  async function recordTrade(trade) {
    if (!trade || typeof trade !== "object" || Array.isArray(trade)) return null;
    if (trade.dir !== "CALL" && trade.dir !== "PUT") return null;
    if (!(trade.draw === true || trade.won === true || trade.won === false)) return null;
    return serializeMutation((s) => {
    const st = s.stats;
    const t = now();
    const day = new Date(t).toISOString().slice(0, 10);
    const asset = safeKey(trade.asset, "UNKNOWN");
    const strat = safeKey(trade.strategy, "confluence");
    const regime = safeKey(trade.regime, "unknown");

    const resetAt = timestampMs(st.dailyReset, 0);
    const resetDay = resetAt ? new Date(resetAt).toISOString().slice(0, 10) : "";
    if (resetDay !== day) {
      st.dailyPnl = 0;
      st.dailyReset = t;
    }

    const payoutRaw = Number(trade.payout);
    const payout = Number.isFinite(payoutRaw) && payoutRaw >= 0 ? Math.min(1000000, payoutRaw) : 0.85;
    const isDraw = trade.draw === true || trade.won == null;
    const won = trade.won === true;
    if (isDraw) { /* refunded/no result */ }
    else if (won) {
      st.wins = Math.min(1000000000, st.wins + 1);
      st.dailyPnl = Math.min(1000000000, st.dailyPnl + payout);
    } else {
      st.losses = Math.min(1000000000, st.losses + 1);
      st.dailyPnl = Math.max(-1000000000, st.dailyPnl - 1);
    }

    const entryTime = timestampMs(trade.entryTime != null ? trade.entryTime : (trade.at != null ? trade.at : t), t);
    const rawExpiryMinutes = trade.expiryMinutes != null ? Number(trade.expiryMinutes) : null;
    const expiryMinutes = Number.isFinite(rawExpiryMinutes) && rawExpiryMinutes >= 0
      ? Math.min(1440, rawExpiryMinutes) : null;
    let expiryTime = timestampMs(trade.expiryTime,
      expiryMinutes != null ? entryTime + expiryMinutes * 60000 : null);
    if (expiryTime != null && expiryTime < entryTime) {
      expiryTime = expiryMinutes != null ? entryTime + expiryMinutes * 60000 : null;
    }
    let exitTime = timestampMs(trade.exitTime, expiryTime != null ? expiryTime : t);
    if (exitTime < entryTime || (expiryTime != null && exitTime < expiryTime)) {
      exitTime = expiryTime != null ? expiryTime : entryTime;
    }
    const rawEntryPrice = trade.entryPrice != null ? Number(trade.entryPrice) : Number(trade.entry);
    const rawExitPrice = trade.exitPrice != null ? Number(trade.exitPrice) : Number(trade.exit);
    const entryPrice = Number.isFinite(rawEntryPrice) && rawEntryPrice > 0 && rawEntryPrice <= 1e100 ? rawEntryPrice : null;
    const exitPrice = Number.isFinite(rawExitPrice) && rawExitPrice > 0 && rawExitPrice <= 1e100 ? rawExitPrice : null;
    st.history.unshift({
      at: entryTime,
      entryTime,
      expiryTime,
      exitTime,
      expiryMinutes,
      asset,
      dir: trade.dir === "CALL" || trade.dir === "PUT" ? trade.dir : null,
      won: isDraw ? null : won,
      draw: isDraw,
      entry: Number.isFinite(entryPrice) ? entryPrice : null,
      entryPrice: Number.isFinite(entryPrice) ? entryPrice : null,
      exit: Number.isFinite(exitPrice) ? exitPrice : null,
      exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
      score: Number.isFinite(Number(trade.score)) ? Math.max(-1000000, Math.min(1000000, Number(trade.score))) : null,
      confidence: Number.isFinite(Number(trade.confidence)) ? Math.max(0, Math.min(100, Number(trade.confidence))) : null,
      regime,
      strategy: strat,
      pnl: isDraw ? 0 : (won ? payout : -1),
    });
    if (st.history.length > 500) st.history.length = 500;

    if (!st.byStrategy[strat]) st.byStrategy[strat] = { w: 0, l: 0 };
    if (!st.byAsset[asset]) st.byAsset[asset] = { w: 0, l: 0, history: [] };
    if (!st.byRegime[regime]) st.byRegime[regime] = { w: 0, l: 0 };
    if (!st.byDay[day]) st.byDay[day] = { w: 0, l: 0, pnl: 0 };

    const bump = (row, field) => {
      row[field] = Math.min(1000000000, Math.max(0, Math.floor(Number(row[field]) || 0)) + 1);
    };
    if (isDraw) {
      bump(st.byStrategy[strat], "d"); bump(st.byAsset[asset], "d");
      bump(st.byRegime[regime], "d"); bump(st.byDay[day], "d");
    } else if (won) {
      bump(st.byStrategy[strat], "w"); bump(st.byAsset[asset], "w");
      bump(st.byRegime[regime], "w"); bump(st.byDay[day], "w");
    } else {
      bump(st.byStrategy[strat], "l"); bump(st.byAsset[asset], "l");
      bump(st.byRegime[regime], "l"); bump(st.byDay[day], "l");
    }
    st.byAsset[asset].history = st.byAsset[asset].history || [];
    st.byAsset[asset].history.unshift({
      at: entryTime, entryTime, expiryTime, exitTime, expiryMinutes,
      dir: trade.dir, won: isDraw ? null : won, draw: isDraw,
      confidence: Number.isFinite(Number(trade.confidence)) ? Math.max(0, Math.min(100, Number(trade.confidence))) : null,
      regime,
      entry: Number.isFinite(entryPrice) ? entryPrice : null,
      exit: Number.isFinite(exitPrice) ? exitPrice : null,
    });
    if (st.byAsset[asset].history.length > 100) st.byAsset[asset].history.length = 100;
    st.byDay[day].pnl = finiteIn(
      Number(st.byDay[day].pnl || 0) + (isDraw ? 0 : (won ? payout : -1)),
      0, -1000000000, 1000000000
    );
    const capMap = (map, limit, keep) => {
      const keys = Object.keys(map);
      let excess = keys.length - limit;
      for (let i = 0; i < keys.length && excess > 0; i++) {
        if (keys[i] === keep) continue;
        delete map[keys[i]];
        excess--;
      }
    };
    capMap(st.byStrategy, 500, strat);
    capMap(st.byAsset, 500, asset);
    capMap(st.byRegime, 500, regime);
    capMap(st.byDay, 400, day);

    // Calibration: bucket by confidence; draws carry no directional outcome.
    if (!isDraw && s.calibration && s.settings.calibration) {
      const conf = Number.isFinite(Number(trade.confidence)) ? Math.max(0, Math.min(100, Number(trade.confidence))) : 0;
      const b = Math.min(90, Math.floor(conf / 10) * 10);
      if (!s.calibration.buckets[b]) s.calibration.buckets[b] = { hits: 0, n: 0 };
      s.calibration.buckets[b].n = Math.min(1000000000, s.calibration.buckets[b].n + 1);
      if (won) s.calibration.buckets[b].hits = Math.min(s.calibration.buckets[b].n, s.calibration.buckets[b].hits + 1);
      s.calibration.updated = t;
    }

    return clone(st);
    }, [["stats"], ["calibration"]]);
  }

  /**
   * Convert bucket observations into a smooth function:
   * given predicted confidence, return adjusted confidence that better
   * matches observed hit rate. If we have no data, returns input as-is.
   */
  function calibrationAdjust(predicted, buckets) {
    const p = Number(predicted);
    if (!Number.isFinite(p)) return 0;
    const bounded = Math.max(0, Math.min(100, p));
    if (!buckets || !Object.keys(buckets).length) return bounded;
    const b = Math.min(90, Math.floor(bounded / 10) * 10);
    const v = buckets[b];
    if (!v || !Number.isFinite(Number(v.n)) || Number(v.n) < 5) return bounded;
    // Shrink to observed rate, blended with predicted (Bayesian-ish).
    const hits = Math.max(0, Math.min(Number(v.n), Number(v.hits) || 0));
    const obs = hits / Number(v.n);
    const prior = bounded / 100;
    const weight = Math.min(1, Number(v.n) / 25);
    const blended = prior * (1 - weight) + obs * weight;
    const calibrated = Math.round(blended * 100);
    // Calibration must not permanently starve its own sample stream. With 25
    // early losses, the old full-weight adjustment changed any confidence to
    // 0%; the confidence gate then rejected every future signal, so that
    // bucket could never recover. Bound one calibration step to ±25 points.
    return Math.max(0, Math.min(100,
      Math.max(bounded - 25, Math.min(bounded + 25, calibrated))));
  }

  function onChange(fn) {
    if (typeof fn !== "function") return () => false;
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  async function resetStats() {
    return serializeMutation((s) => {
      s.stats = clone(DEFAULTS.stats);
      return clone(s.stats);
    }, [["stats"]]);
  }

  async function resetAnalytics() {
    return serializeMutation((s) => {
      s.stats = clone(DEFAULTS.stats);
      s.candles = clone(DEFAULTS.candles);
      s.calibration = clone(DEFAULTS.calibration);
      return { stats: clone(s.stats), candles: {}, calibration: clone(s.calibration) };
    }, [["stats"], ["candles"], ["calibration"]]);
  }

  async function reset() {
    return serializeMutation((s) => {
      s.settings = clone(DEFAULTS.settings);
      s.stats = clone(DEFAULTS.stats);
      s.candles = clone(DEFAULTS.candles);
      s.automation = clone(DEFAULTS.automation);
      s.calibration = clone(DEFAULTS.calibration);
      return clone(s);
    }, [["settings"], ["stats"], ["candles"], ["automation"], ["calibration"]]);
  }

  root.CYBER_STORE = {
    load, flush, save,
    getSettings, setSettings,
    getStats, getAutomation, setAutomation, getCalibration,
    getCandles, setCandles,
    recordTrade, calibrationAdjust,
    onChange, resetStats, resetAnalytics, reset,
    DEFAULTS: clone(DEFAULTS),
  };
})(typeof self !== "undefined" ? self : globalThis);
