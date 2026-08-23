"use strict";

/**
 * CYBER BINARY v2.6 — content script.
 *
 * Runs in the page's ISOLATED world. Reads the live state the page-hook
 * pushes via window.postMessage, keeps one feed per detected asset, runs
 * the confluence engine, and bridges results to the popup dashboard.
 *
 * v2.3 detection: the active asset now comes from (in order) the socket
 * symbol (outgoing-frame sniffing + incoming ticks/history), the adapter's
 * DOM helpers, class selectors, a text-scan of visible labels against the
 * full catalog (hashed CSS-module class names), page title and URL.
 *
 * v2.2 fixes:
 *   - Real broker history REPLACES the synthetic seed (no more mixed
 *     synthetic/real candles, no more "chart isn't similar").
 *   - History is accepted for ANY broker timeframe; the engine's 1m feed is
 *     built from real 60s bars + `quotes/stream` ticks.
 *   - Signals + MACD/indicator readings are computed on CLOSED bars only,
 *     so they no longer jitter with every tick.
 *   - Asset detection registers symbols on the fly (works with the broker's
 *     own `_otc` conventions), supports numeric broker IDs, and responds to
 *     CYBER_SET_ASSET / CYBER_DETECT_ASSET from the dashboard.
 *   - Late attach: requests a snapshot from the page-hook (instruments,
 *     balance, candles, orders, status) and replays it, then asks the broker
 *     for history on the page's own socket.
 */
(function () {
  // Defense in depth for users upgrading from an older all_frames manifest:
  // subframes must never run their own engine/auto controller.
  try { if (window.top && window.top !== window.self) return; } catch (_) { return; }
  if (window.__CYBER_BINARY__) return;
  window.__CYBER_BINARY__ = true;

  const TF_MS = 60000;
  const PRICE_RE = /(?:\d{1,8}(?:[.,]\d{1,8})?)/;
  const ASSETS = self.CYBER_ASSETS;
  const STORE = self.CYBER_STORE;
  const AUTO = self.CYBER_AUTO;
  const STRAT = self.CYBER_STRATEGIES;
  const QUOTEX = self.CYBER_QUOTEX || null;
  const MARKERS = self.CYBER_MARKERS || null;

  // Per-asset feeds + state.
  const feeds = Object.create(null);
  const historySeeded = Object.create(null);   // assetId -> first batch applied
  const realHistoryReady = Object.create(null); // assetId -> enough genuine 1m bars for execution
  const historyRequestedAt = Object.create(null);
  const chartHistory = Object.create(null);    // assetId -> period -> {candles, ts}
  const lastAcceptedQuoteAt = Object.create(null);
  const lastDomPriceByAsset = Object.create(null);
  const lastVirtualBarByAsset = Object.create(null);
  const lastAutoBarByAsset = Object.create(null);
  let activeAsset = "EURUSD";
  let lastWsPrice = null;
  let lastWsTickAt = 0;
  let lastWsSymbol = null;       // authoritative MAIN chart symbol only
  let lastWsPeriod = 60;         // authoritative MAIN chart timeframe
  let activeFeed = createFeedFor(activeAsset);
  let autoController = null;
  let currentStrategy = "auto_adaptive";
  let runtimeSettings = null;
  let attached = false;
  let dashOpened = false;
  let pollTimer = null;
  let manualAsset = null; // set by dashboard selection; null = auto-detect
  let isPrimaryContext = false;  // only the selected Quotex browser tab may auto-trade
  let primaryEpoch = 0;          // invalidates placement work across leadership changes
  let cachedSignal = null;
  let cachedAnalysisKey = "";
  let lastStatePushAt = 0;
  let lastStateFingerprint = "";
  let statePushTimer = null;
  let latestStateSignal = null;
  let lastHudFingerprint = "";
  let cachedDomPriceElement = null;
  // v2.3.2: cached confidence-calibration snapshot (settings.calibration +
  // recorded bucket hit rates), refreshed on every STORE change so the
  // per-tick signal path stays synchronous.
  let calCache = { enabled: true, buckets: null };
  let lastQuotexStatus = { state: "idle" };
  let lastInstruments = [];
  let lastBalance = null;
  let lastOrders = [];
  const pendingWs = Object.create(null);       // page-hook send ack requestId -> resolver
  const pendingHistory = Object.create(null);  // page-hook history-subscription requestId -> resolver
  let historyRequestSequence = 0;
  const pendingOrders = Object.create(null);   // broker order-open requestId -> resolver
  const settledOrderIds = Object.create(null); // de-dupe broker close replays
  const settledOrderQueue = [];
  let pendingDomOrder = null;                  // conservative single DOM fallback waiter
  let placementInFlight = false;               // serialize auto/manual placement paths
  let hudArmPending = false;                    // debounce the explicit HUD arm gesture
  let tickSignalQueued = false;                 // coalesce per-tick dashboard refreshes
  let lastTickSignalAt = 0;
  const candlePersistTimers = Object.create(null);
  const candlePersistLastAt = Object.create(null);

  // v2.3.3: non-repainting signal markers. Anchors are (asset, barTime,
  // price, direction) fixed at creation; the store dedupes per bar so an
  // arrow can never move or duplicate as new candles form.
  const markerStore = MARKERS ? MARKERS.createStore({ max: 600 }) : null;
  let lastMarkersAsset = null; // re-send to the page hook when the chart's asset changes

  const pendingByAsset = Object.create(null);
  const stats = {
    wins: 0, losses: 0, pending: null, history: [],
    byStrategy: Object.create(null),
    byAsset: Object.create(null),
    byRegime: Object.create(null),
  };

  function createFeedFor(assetId) {
    if (feeds[assetId]) return feeds[assetId];
    // Keep enough genuine 1m history for a useful multi-day backtest. The old
    // 400-bar cap silently discarded most of the broker's history response.
    const f = self.CYBER_FEED.createFeed({ tfMs: TF_MS, max: 5000 });
    feeds[assetId] = f;
    const a = ASSETS.get(assetId) || ASSETS.ensureRegistered(assetId) ||
      { id: assetId, basePrice: 1.0, vol: 0.0001, jumpRate: 0.005, decimals: 5 };
    const chart = chartHistory[assetId] && (chartHistory[assetId][lastWsPeriod] || chartHistory[assetId][60]);
    const lastChartBar = chart && Array.isArray(chart.candles) && chart.candles.length ? chart.candles[chart.candles.length - 1] : null;
    const basePrice = (assetId === activeAsset && lastWsPrice) || (lastChartBar && lastChartBar.close) || lastDomPriceByAsset[assetId] || a.basePrice || 1.0;
    const profile = Object.assign({}, a, { basePrice });
    f.setSeries(self.CYBER_FEED.syntheticSeries(profile, 120, {
      startTime: Math.floor(Date.now() / TF_MS) * TF_MS - 120 * TF_MS,
    }));
    return f;
  }

  function activateAsset(assetId) {
    if (!assetId || assetId === activeAsset) return false;
    activeAsset = assetId;
    activeFeed = createFeedFor(activeAsset);
    stats.pending = pendingByAsset[activeAsset] || null;
    cachedDomPriceElement = null;
    cachedAnalysisKey = "";
    lastHudFingerprint = "";
    lastStateFingerprint = "";
    ensureHistorySubscription(ASSETS.get(activeAsset) || ASSETS.ensureRegistered(activeAsset));
    return true;
  }

  function parsePrice(text) {
    if (!text) return null;
    if (QUOTEX && typeof QUOTEX.parsePrice === "function") return QUOTEX.parsePrice(text);
    const m = String(text).replace(/\s/g, "").match(PRICE_RE);
    if (!m) return null;
    const n = parseFloat(m[0].replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function visibleText(el) {
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  /* -------- automatic asset detection (v2.2) -------- */
  function assetFromText(text) {
    if (!text) return null;
    // DOM labels are detection-only. Never auto-register arbitrary UI words
    // ("Dashboard", "Current", "CALL"...) as broker symbols; live socket and
    // instruments messages use ensureRegistered/registerQuotexAsset directly.
    return ASSETS.detect(text);
  }

  let lastDomTextScan = 0;
  let lastDomAssetScan = 0;
  let lastDomAssetResult = null;

  /**
   * v2.3: text-based fallback. The modern Quotex UI ships hashed CSS-module
   * class names, so `[class*='asset']` style selectors miss it. Instead scan
   * small leaf nodes for strings that match the (now complete) asset catalog
   * — "EUR/USD", "EUR/USD OTC", "Bitcoin (OTC)", "Apple", "S&P 500" — and
   * prefer the shortest match (most specific label).
   */
  function scanDomForAssetText(force) {
    const now = Date.now();
    if (!force && now - lastDomTextScan < 2000) return null; // throttle
    lastDomTextScan = now;
    let best = null;
    let bestScore = -Infinity;
    const nodes = document.querySelectorAll("span, div, button, a, h1, h2, h3, td, p");
    for (let i = 0; i < nodes.length && i < 800; i++) {
      const el = nodes[i];
      if (el.id === "cyber-binary-hud" || (el.closest && el.closest("#cyber-binary-hud"))) continue;
      if (el.closest && el.closest("[role='dialog'], [role='listbox'], [role='menu'], [class*='asset-list'], [class*='instruments-list']")) continue;
      if (el.children.length > 2) continue; // skip containers with many children
      if (!el.offsetParent && el.getClientRects().length === 0) continue; // hidden
      const t = visibleText(el);
      if (!t || t.length < 2 || t.length > 40) continue;
      if (/^[\d.,\s%+\-—:]+$/.test(t)) continue; // pure price/percent text
      const det = ASSETS.detect(t);
      if (!det) continue;
      const wantsOtc = /OTC|\(OT\)/i.test(t);
      const isOtc = /_otc$/i.test(det.id);
      if (wantsOtc !== isOtc) continue;
      const meta = String(el.className || "") + " " +
        String(el.getAttribute && ((el.getAttribute("aria-selected") || "") + " " + (el.getAttribute("aria-current") || "")));
      let score = 50 - t.length;
      if (/active|current|selected|chosen|true/i.test(meta)) score += 100;
      if (/symbol|pair|asset.?name|trading.?pair/i.test(meta)) score += 30;
      if (/^(BUTTON|A|TD)$/.test(String(el.tagName || ""))) score -= 25;
      try {
        const r = el.getBoundingClientRect();
        if (r.top >= 0 && r.top < 240) score += 12;
      } catch (_) {}
      if (score > bestScore) { bestScore = score; best = det; }
    }
    return best;
  }

  function detectAssetFromDom(force) {
    // A full selector/text scan can allocate thousands of nodes on the broker
    // page. Cache even a miss so the several callers in one poll cycle do not
    // repeat the same expensive work.
    const now = Date.now();
    if (!force && now - lastDomAssetScan < 2000) return lastDomAssetResult;
    lastDomAssetScan = now;
    let found = null;

    // First choice: the adapter's canonical DOM helpers.
    if (QUOTEX && QUOTEX.findAssetHeader) {
      const h = QUOTEX.findAssetHeader();
      if (h && h.text) found = assetFromText(h.text);
    }
    const sels = [
      "[class*='current-symbol']",
      "[class*='asset-select']",
      "[class*='pair-name']",
      "[class*='symbol-name']",
      "[class*='assetName']",
      "[class*='asset-name']",
      "[class*='symbol']",
      "[class*='asset'] [class*='name']",
      "[class*='trading-pair']",
      "[class*='active-asset']",
      "header [class*='active']",
      "[data-testid*='asset']",
      "[data-test*='symbol']",
    ];
    for (let si = 0; !found && si < sels.length; si++) {
      const els = document.querySelectorAll(sels[si]);
      for (let ei = 0; ei < els.length && ei < 100; ei++) {
        const t = visibleText(els[ei]);
        if (t && t.length >= 2 && t.length < 48) {
          found = assetFromText(t);
          if (found) break;
        }
      }
    }
    // Hashed-class fallback — match visible text against the catalog.
    if (!found) found = scanDomForAssetText(true);
    if (!found) found = ASSETS.detect(document.title);
    if (!found) found = ASSETS.detect(location.href);
    if (!found && lastWsSymbol) found = assetFromText(lastWsSymbol);
    lastDomAssetResult = found || null;
    return lastDomAssetResult;
  }

  function syncActiveAsset() {
    // Manual dashboard selection pins the asset; auto-detection resumes only
    // when a different symbol arrives from the page WS (see message router).
    if (manualAsset) {
      const m = ASSETS.get(manualAsset) || ASSETS.ensureRegistered(manualAsset);
      if (m) activateAsset(m.id);
      return m;
    }
    // The page WS symbol is authoritative — DOM detection must never
    // overwrite it (that was the "chart flips between EURUSD and the OTC
    // pair / demo feed" bug: hidden DOM elements matched first).
    let detected = null;
    if (lastWsSymbol) detected = assetFromText(lastWsSymbol);
    if (!detected) detected = detectAssetFromDom();
    if (detected) activateAsset(detected.id);
    return detected;
  }

  function wsQuoteMatchesActive() {
    return !!lastWsSymbol && Number.isFinite(Number(lastWsPrice)) && !!QUOTEX &&
      Date.now() - lastWsTickAt >= 0 && Date.now() - lastWsTickAt <= 15000 &&
      QUOTEX.normalizeSymbol(activeAsset) === QUOTEX.normalizeSymbol(lastWsSymbol);
  }

  function findPrice() {
    if (wsQuoteMatchesActive()) return Number(lastWsPrice);
    // DOM price labels belong to the visible broker chart too. Never feed
    // that price into a manually selected, different laboratory asset.
    if (lastWsSymbol && QUOTEX &&
        QUOTEX.normalizeSymbol(activeAsset) !== QUOTEX.normalizeSymbol(lastWsSymbol)) return null;

    // Reuse the selected label while it remains attached. Re-running broad
    // selectors every second was expensive on the broker's large React DOM.
    if (cachedDomPriceElement && cachedDomPriceElement.isConnected !== false) {
      const cachedPrice = parsePrice(visibleText(cachedDomPriceElement));
      if (cachedPrice && cachedPrice <= 1e12) return cachedPrice;
      cachedDomPriceElement = null;
    }
    if (QUOTEX) {
      const hit = QUOTEX.findPriceLabel();
      if (hit && hit.price && hit.price <= 1e12) {
        cachedDomPriceElement = hit.el || null;
        return hit.price;
      }
    }
    // Fail closed: stake, payout, balance and current-profit elements are not
    // quote labels and must never fabricate broker candles.
    const selectors = [
      "[class*='current-price']",
      "[class*='currentPrice']",
      "[class*='chart-price']",
      "[class*='asset-price']",
      "[class*='price-info']",
      "[data-test*='price']",
      "[class*='quotes'] [class*='price']",
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (let ei = 0; ei < els.length && ei < 100; ei++) {
        const p = parsePrice(visibleText(els[ei]));
        if (p && p <= 1e12) {
          cachedDomPriceElement = els[ei];
          return p;
        }
      }
    }
    return null;
  }

  function assetName() {
    const det = syncActiveAsset();
    return det ? det.name : (document.title.replace(/[-|].*$/, "").trim() || "Quotex");
  }

  /* -------- pipeline -------- */
  function settlePending(close, time, assetId) {
    const key = assetId || activeAsset;
    const p = pendingByAsset[key];
    close = Number(close);
    time = Number(time);
    if (!p || !Number.isFinite(close) || close <= 0 || close > 1e12 ||
        !Number.isSafeInteger(time) || time < p.expireAt ||
        (p.dir !== "CALL" && p.dir !== "PUT") ||
        !Number.isFinite(Number(p.entry)) || Number(p.entry) <= 0) return;
    const draw = close === p.entry;
    const won = draw ? null :
      ((p.dir === "CALL" && close > p.entry) || (p.dir === "PUT" && close < p.entry));
    if (won === true) stats.wins = Math.min(1000000000, stats.wins + 1);
    else if (won === false) stats.losses = Math.min(1000000000, stats.losses + 1);
    const t = {
      // `at` remains the signal/entry anchor for marker compatibility.
      at: p.entryTime,
      entryTime: p.entryTime,
      expiryTime: p.expireAt,
      exitTime: time,
      expiryMinutes: p.expiryMinutes,
      asset: p.asset,
      dir: p.dir,
      won,
      draw,
      entry: p.entry,
      entryPrice: p.entry,
      exit: close,
      exitPrice: close,
      score: p.score,
      confidence: p.confidence,
      regime: p.regime,
      strategy: p.strategy,
      payout: p.payout,
      pnl: draw ? 0 : (won ? p.payout : -1),
    };
    stats.history.unshift(t);
    if (stats.history.length > 200) stats.history.length = 200;
    // v2.3.2: these breakdowns were never updated, so the Assets tab's
    // "Live WR" and the per-strategy/regime splits stayed permanently empty.
    const bk = (map, rawKey) => {
      let mapKey = String(rawKey == null ? "" : rawKey).trim().slice(0, 96) || "unknown";
      if (mapKey === "__proto__" || mapKey === "prototype" || mapKey === "constructor") mapKey = "unknown";
      if (!Object.prototype.hasOwnProperty.call(map, mapKey)) map[mapKey] = { w: 0, l: 0, d: 0 };
      const bucket = map[mapKey];
      if (won === true) bucket.w = Math.min(1000000000, (Number(bucket.w) || 0) + 1);
      else if (won === false) bucket.l = Math.min(1000000000, (Number(bucket.l) || 0) + 1);
      else bucket.d = Math.min(1000000000, (Number(bucket.d) || 0) + 1);
    };
    bk(stats.byStrategy, p.strategy || "confluence");
    bk(stats.byAsset, p.asset || "UNKNOWN");
    bk(stats.byRegime, p.regime || "unknown");
    delete pendingByAsset[key];
    stats.pending = pendingByAsset[activeAsset] || null;
    // This is a virtual signal outcome, not necessarily a placed order. Risk
    // limits are updated only from broker-confirmed closed orders below.
    persistAll();
  }

  function settleFeedEvent(ev, assetId) {
    if (!ev) return;
    const bars = Array.isArray(ev.closedBars) && ev.closedBars.length
      ? ev.closedBars : (ev.closed ? [ev.closed] : []);
    for (const bar of bars) {
      if (bar && Number.isFinite(Number(bar.close)) && Number.isFinite(Number(bar.time))) {
        // Candle timestamps are bar OPEN times. The broker outcome at expiry
        // is the bar's close, one timeframe later—not the next bar's close.
        settlePending(Number(bar.close), Number(bar.time) + TF_MS, assetId || activeAsset);
      }
      if (!pendingByAsset[assetId || activeAsset]) break;
    }
  }

  function persistAll() {
    try {
      STORE.recordTrade({
        asset: stats.history[0] && stats.history[0].asset,
        dir: stats.history[0] && stats.history[0].dir,
        won: stats.history[0] && stats.history[0].won,
        draw: stats.history[0] && stats.history[0].draw,
        strategy: stats.history[0] && stats.history[0].strategy,
        regime: stats.history[0] && stats.history[0].regime,
        confidence: stats.history[0] && stats.history[0].confidence,
        entry: stats.history[0] && stats.history[0].entry,
        exit: stats.history[0] && stats.history[0].exit,
        entryTime: stats.history[0] && stats.history[0].entryTime,
        expiryTime: stats.history[0] && stats.history[0].expiryTime,
        exitTime: stats.history[0] && stats.history[0].exitTime,
        expiryMinutes: stats.history[0] && stats.history[0].expiryMinutes,
        score: stats.history[0] && stats.history[0].score,
        at: stats.history[0] && stats.history[0].at,
        payout: stats.history[0] && stats.history[0].payout,
      }).catch(() => {});
    } catch (_) {}
  }

  let lastAppliedStatsSignature = "";
  function applyStoredStats(s) {
    if (!s || typeof s !== "object") return;
    const history = Array.isArray(s.history) ? s.history : [];
    const newest = history[0] || {};
    const signature = [s.wins, s.losses, history.length, newest.at, newest.asset, newest.dir, newest.won, newest.draw].join("|");
    if (signature === lastAppliedStatsSignature) return;
    lastAppliedStatsSignature = signature;
    stats.wins = Math.max(0, Math.floor(Number(s.wins) || 0));
    stats.losses = Math.max(0, Math.floor(Number(s.losses) || 0));
    stats.byStrategy = Object.assign(Object.create(null),
      s.byStrategy && typeof s.byStrategy === "object" && !Array.isArray(s.byStrategy) ? s.byStrategy : {});
    stats.byAsset = Object.assign(Object.create(null),
      s.byAsset && typeof s.byAsset === "object" && !Array.isArray(s.byAsset) ? s.byAsset : {});
    stats.byRegime = Object.assign(Object.create(null),
      s.byRegime && typeof s.byRegime === "object" && !Array.isArray(s.byRegime) ? s.byRegime : {});
    stats.history = history.slice(0, 200);
    // Historical arrows use fixed entry-time/price anchors and therefore
    // remain non-repainting across reloads.
    if (markerStore) markerStore.seedHistory(stats.history);
    sendMarkers();
  }

  function loadStats() {
    try { STORE.getStats().then(applyStoredStats).catch(() => {}); }
    catch (_) {}
  }

  /** Push the active asset's markers plus bars from the SAME timeframe shown
   *  by Quotex. Sending 1m bars while the platform displayed 5m/15m made the
   *  overlay project arrows into the wrong horizontal slots. */
  function sendMarkers() {
    if (!markerStore) return;
    try {
      const visibleChart = chartForActiveAsset();
      const period = visibleChart && Number.isFinite(Number(visibleChart.period))
        ? Math.max(1, Math.floor(Number(visibleChart.period))) : 60;
      const bars = visibleChart && Array.isArray(visibleChart.candles) && visibleChart.candles.length
        ? visibleChart.candles : activeFeed.series();
      window.postMessage({
        source: "CYBER_BINARY_CONTENT",
        kind: "markers",
        payload: {
          asset: activeAsset,
          period,
          markers: markerStore.list(activeAsset),
          bars: bars.slice(-400),
        },
      }, "*");
    } catch (_) {}
  }

  function applyCalibrationSnapshot(settings, calibration) {
    if (settings) calCache.enabled = !!settings.calibration;
    if (calibration) calCache.buckets = calibration.buckets || null;
  }

  function refreshCalCache() {
    try {
      Promise.all([STORE.getSettings(), STORE.getCalibration()]).then((values) => {
        applyCalibrationSnapshot(values[0], values[1]);
      }).catch(() => {});
    } catch (_) {}
  }

  async function loadSettingsAndArmAuto() {
    const s = await STORE.getSettings();
    runtimeSettings = s;
    currentStrategy = STRAT.get(s.strategy) ? s.strategy : "auto_adaptive";
    refreshCalCache();
    // Keep local settings/calibration snapshots fresh after this context
    // writes. canTrade() still reloads storage before every real action.
    try {
      STORE.onChange(function (state) {
        if (state && state.settings) {
          runtimeSettings = state.settings;
          const nextStrategy = STRAT.get(runtimeSettings.strategy) ? runtimeSettings.strategy : "confluence";
          if (nextStrategy !== currentStrategy) {
            currentStrategy = nextStrategy;
            cachedAnalysisKey = "";
          }
          if (autoController) {
            const auto = autoController.getState();
            const wantedMode = runtimeSettings.autoMode || "off";
            const wantedArmed = isPrimaryContext && !!runtimeSettings.armed;
            if (auto.mode !== wantedMode) autoController.setMode(wantedMode);
            if (auto.armed !== wantedArmed) autoController.setArmed(wantedArmed);
          }
          const armBtn = document.getElementById("cb-arm");
          if (armBtn && !hudArmPending) {
            const armed = isPrimaryContext && !!runtimeSettings.armed;
            armBtn.textContent = isPrimaryContext ? (armed ? "ARMED" : "ARM") : "MAIN TAB ONLY";
            armBtn.classList.toggle("armed", armed);
          }
        }
        if (state && state.stats) applyStoredStats(state.stats);
        applyCalibrationSnapshot(state && state.settings, state && state.calibration);
      });
    } catch (_) {}
    if (autoController) {
      autoController.setMode(s.autoMode || "off");
      autoController.setArmed(isPrimaryContext && !!s.armed);
    } else {
      autoController = AUTO.startAuto({
        config: s,
        executeTrade: placeTrade,
        notifyDesktop: function (signal) {
          try {
            chrome.runtime.sendMessage({
              type: "CYBER_NOTIFY",
              payload: {
                direction: signal && signal.direction,
                asset: signal && signal.asset,
                confidence: signal && signal.confidence,
                reason: signal && signal.reason,
              },
            }).catch(() => {});
          } catch (_) {}
        },
        onSignal: function () { },
        onTrade: function (decision) {
          try { chrome.runtime.sendMessage({ type: "CYBER_AUTO_DECISION", payload: decision }).catch(() => {}); } catch (_) {}
        },
        onLog: function (entry) {
          try { chrome.runtime.sendMessage({ type: "CYBER_AUTO_LOG", payload: entry }).catch(() => {}); } catch (_) {}
        },
        onState: function (state) {
          try { chrome.runtime.sendMessage({ type: "CYBER_AUTO_STATE", payload: state }).catch(() => {}); } catch (_) {}
        },
      });
      autoController.setMode(s.autoMode || "off");
      autoController.setArmed(isPrimaryContext && !!s.armed);
    }
    replayClosedOrders();
    const armBtn = document.getElementById("cb-arm");
    if (armBtn) {
      const armed = isPrimaryContext && !!s.armed;
      armBtn.textContent = isPrimaryContext ? (armed ? "ARMED" : "ARM") : "MAIN TAB ONLY";
      armBtn.classList.toggle("armed", armed);
    }
    return s;
  }

  /* -------- real-candle ingest from the page WS -------- */
  function mergeChartCandles(assetId, period, incoming) {
    const rawPeriod = Number(period);
    const p = Number.isFinite(rawPeriod) && rawPeriod > 0 ? Math.min(86400, Math.floor(rawPeriod)) : 60;
    const byPeriod = chartHistory[assetId] || (chartHistory[assetId] = Object.create(null));
    const prev = byPeriod[p] && Array.isArray(byPeriod[p].candles) ? byPeriod[p].candles : [];
    const map = Object.create(null);
    for (const c of prev) if (c && Number.isFinite(Number(c.time))) map[Number(c.time)] = c;
    for (const c of incoming || []) if (c && Number.isFinite(Number(c.time))) map[Number(c.time)] = c;
    const times = Object.keys(map).map(Number).sort((a, b) => a - b).slice(-400);
    const merged = times.map((t) => map[t]);
    byPeriod[p] = { period: p, candles: merged, ts: Date.now() };
    return byPeriod[p];
  }

  function chartForActiveAsset() {
    const periods = chartHistory[activeAsset];
    if (!periods) return null;
    let selected = null;
    if (periods[lastWsPeriod] && periods[lastWsPeriod].candles.length) selected = periods[lastWsPeriod];
    else if (periods[60] && periods[60].candles.length) selected = periods[60];
    else {
      for (const p in periods) {
        const item = periods[p];
        if (item && item.candles && item.candles.length && (!selected || item.ts > selected.ts)) selected = item;
      }
    }
    if (!selected) return null;

    // Quotex sends higher-timeframe history only occasionally, while the 1m
    // feed receives every live tick. Without this merge a 5m/15m dashboard
    // ended at the last history response and the next refreshed candle jumped
    // away from the live feed. Resample the genuine 1m feed into the visible
    // broker timeframe and replace matching buckets with those live values.
    const period = Number(selected.period);
    // Never overlay resampled synthetic warm-up bars on genuine higher-
    // timeframe broker history. Until a real 1m batch arrives, those two
    // series can have different price levels and create a fake final spike.
    if (historySeeded[activeAsset] && period > 60 && period % 60 === 0 &&
        self.CYBER_TA && typeof self.CYBER_TA.resample === "function") {
      const live = self.CYBER_TA.resample(activeFeed.series(), period / 60);
      if (live.length) {
        const byTime = Object.create(null);
        for (const bar of selected.candles) if (bar && Number.isFinite(Number(bar.time))) byTime[Number(bar.time)] = bar;
        for (const bar of live) if (bar && Number.isFinite(Number(bar.time))) byTime[Number(bar.time)] = bar;
        const times = Object.keys(byTime).map(Number).sort((a, b) => a - b).slice(-400);
        return { period, candles: times.map((time) => byTime[time]), ts: Date.now() };
      }
    }
    return selected;
  }

  function scheduleTickSignalRefresh() {
    if (tickSignalQueued) return;
    tickSignalQueued = true;
    const now = Date.now();
    const delay = Math.max(0, 150 - (now - lastTickSignalAt));
    setTimeout(function () {
      tickSignalQueued = false;
      lastTickSignalAt = Date.now();
      try { maybeSignal(); } catch (_) {}
    }, delay);
  }

  function persistLiveCandles(assetId, immediate) {
    const id = String(assetId || activeAsset || "").slice(0, 96);
    if (!id || !STORE || typeof STORE.setCandles !== "function") return;
    // Never persist the synthetic warm-up seed. The backtester consumes this
    // cache as Quotex-only data, so storage starts only after genuine broker
    // 1m history has replaced the seed.
    if (!historySeeded[id] && !realHistoryReady[id]) return;
    const now = Date.now();
    const minGap = immediate ? 1000 : 5000;
    const wait = Math.max(0, minGap - (now - (candlePersistLastAt[id] || 0)));
    if (candlePersistTimers[id]) return;
    candlePersistTimers[id] = setTimeout(function () {
      candlePersistTimers[id] = null;
      candlePersistLastAt[id] = Date.now();
      try {
        const feed = createFeedFor(id);
        const series = feed && typeof feed.series === "function" ? feed.series().slice(-5000) : [];
        if (series.length >= 2) STORE.setCandles(id, series, 5000).catch(function () {});
      } catch (_) {}
    }, wait);
  }

  function ingestLiveCandles(asset, period, candles) {
    if (!asset || !Array.isArray(candles) || !candles.length) return;
    const det = typeof asset === "string" && asset.length <= 80 ? ASSETS.ensureRegistered(asset) : null;
    if (!det) return;
    const id = det.id;
    const feed = createFeedFor(id);
    const rawPeriod = Number(period);
    const safePeriod = Number.isFinite(rawPeriod) && rawPeriod > 0 ? Math.min(86400, Math.floor(rawPeriod)) : 60;
    const real = [];
    const limit = Math.min(candles.length, 6000);
    const firstTime = Number(candles[0] && candles[0].time);
    const finalTime = Number(candles[candles.length - 1] && candles[candles.length - 1].time);
    const start = candles.length > limit && Number.isFinite(firstTime) && Number.isFinite(finalTime) && firstTime <= finalTime
      ? candles.length - limit : 0;
    for (let i = start; i < start + limit; i++) {
      const c = candles[i];
      if (!c || typeof c !== "object" || Array.isArray(c)) continue;
      const rawTime = Number(c.time), open = Number(c.open), close = Number(c.close);
      const rawHigh = Number(c.high), rawLow = Number(c.low);
      const time = Math.abs(rawTime) >= 1e14 ? Math.floor(rawTime / 1000)
        : Math.abs(rawTime) >= 1e11 ? Math.floor(rawTime) : Math.floor(rawTime * 1000);
      if (![time, open, close, rawHigh, rawLow].every(Number.isFinite) ||
          time < 946684800000 || time > Date.now() + 86400000 ||
          open <= 0 || close <= 0 || rawHigh <= 0 || rawLow <= 0 ||
          Math.max(open, close, rawHigh, rawLow) > 1e12) continue;
      const rawVolume = Number(c.volume);
      real.push({
        time, open, close,
        high: Math.max(rawHigh, rawLow, open, close),
        low: Math.min(rawHigh, rawLow, open, close),
        volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? Math.min(1e100, rawVolume) : 0,
      });
    }
    if (!real.length) return;
    real.sort((a, b) => a.time - b.time);

    // The engine runs on 1m bars; accept 60s history directly and build 1m
    // from ticks for everything else (the chart shows the broker timeframe).
    const useForEngine = safePeriod === 60;
    if (useForEngine && (!historySeeded[id] || feed.series().length <= 120)) {
      historySeeded[id] = true;
      // First real 1m batch REPLACES the synthetic seed wholesale (never
      // merge). A 5m/15m chart batch must not mark the 1m engine as seeded.
      feed.setSeries(real);
      const ev = feed.mergeCandles([]);
      settleFeedEvent(ev, id);
    } else if (useForEngine) {
      const ev = feed.mergeCandles(real);
      settleFeedEvent(ev, id);
    }
    if (useForEngine && feed.series().length >= 2) persistLiveCandles(id, true);
    if (useForEngine && feed.series().length >= 40) realHistoryReady[id] = true;
    const newestRealTime = real[real.length - 1].time;
    // v2.6.5: the upper bound tolerates broker-server clock skew (old bound
    // was +1 minute, which made "live" detection fail whenever the server
    // clock ran ahead of the user's PC).
    if (useForEngine && newestRealTime >= Date.now() - 2 * TF_MS && newestRealTime <= Date.now() + 86400000) {
      lastAcceptedQuoteAt[id] = Date.now();
    }
    // Merge incremental batches instead of replacing the dashboard series
    // with whichever partial history response arrived last. Histories from
    // other open/mini charts are retained per asset+period but NEVER select
    // the active chart.
    mergeChartCandles(id, safePeriod, real);
    if (id === activeAsset || id === lastWsSymbol || !historySeeded[activeAsset]) {
      if (activeAsset !== id && !manualAsset) {
        activateAsset(id);
      }
      if (id === activeAsset && safePeriod === lastWsPeriod) sendMarkers();
      scheduleTickSignalRefresh();
    }
  }

  function normalizeStatus(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return {
      state: typeof value.state === "string" ? value.state.slice(0, 64) : "unknown",
      url: value.url == null ? null : String(value.url).slice(0, 256),
    };
  }

  function normalizeOrderEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !QUOTEX) return null;
    const kind = value.kind === "opened" || value.kind === "closed" ? value.kind : null;
    if (!kind) return null;
    const source = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : null;
    if (!source) return null;
    const data = kind === "opened" ? QUOTEX.parseOrderOpened(source) : QUOTEX.parseOrderClosed(source);
    return data ? { kind, data } : null;
  }

  function normalizeInstruments(value) {
    if (!Array.isArray(value) || !QUOTEX || typeof QUOTEX.parseInstruments !== "function") return [];
    return QUOTEX.parseInstruments(value).slice(0, 2000);
  }

  function normalizeBalance(value) {
    return QUOTEX && typeof QUOTEX.parseBalance === "function" ? QUOTEX.parseBalance(value) : null;
  }

  function confirmationLifecycle(data) {
    const receivedAt = Date.now();
    const rawOpen = Number(data && data.openTime);
    const openTime = Number.isSafeInteger(rawOpen) && rawOpen >= receivedAt - 86400000 && rawOpen <= receivedAt + 300000
      ? rawOpen : receivedAt;
    const rawExpiry = Number(data && (data.expiryTime || data.closeTime));
    const duration = Math.max(0, Math.min(86400, Math.floor(Number(data && data.duration) || 0)));
    const expiryTime = Number.isSafeInteger(rawExpiry) && rawExpiry >= openTime && rawExpiry <= openTime + 86460000
      ? rawExpiry : (duration ? openTime + duration * 1000 : null);
    return { openTime, expiryTime, duration };
  }

  function processClosedOrder(order, fromSnapshot) {
    // Every open Quotex tab sees account-level order events. Only the selected
    // main tab may mutate the shared P&L/freeze ledger; otherwise one broker
    // close is counted once per open tab and races whole automation snapshots.
    if (!isPrimaryContext || !autoController || !order || order.kind !== "closed" || !order.data) return false;
    const data = order.data;
    const now = Date.now();
    const closeTime = Number(data.closeTime);
    const currentDate = new Date(now);
    const dayStart = Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate());
    if (fromSnapshot && !Number.isSafeInteger(closeTime)) return false;
    if (Number.isSafeInteger(closeTime) && (closeTime < dayStart || closeTime > now + 300000)) return false;
    const hasFallbackIdentity = data.asset && (data.openTime != null || data.closeTime != null);
    const closeKey = data.id != null && data.id !== "" ? data.id
      : (data.requestId != null && data.requestId !== "" ? data.requestId
        : (hasFallbackIdentity ? [data.asset, data.openTime, data.closeTime, data.amount].join(":") : ""));
    const rawPnl = data.netProfit != null ? data.netProfit : data.profit;
    const pnl = rawPnl == null ? NaN : Number(rawPnl);
    const stableCloseKey = String(closeKey || "").trim().slice(0, 256);
    if (!stableCloseKey || settledOrderIds[stableCloseKey] || !Number.isFinite(pnl) || Math.abs(pnl) > 1000000000) return false;
    settledOrderIds[stableCloseKey] = true;
    settledOrderQueue.push(stableCloseKey);
    while (settledOrderQueue.length > 500) delete settledOrderIds[settledOrderQueue.shift()];
    autoController.settleOrder(stableCloseKey, pnl, data.asset);
    return true;
  }

  function replayClosedOrders() {
    for (let i = lastOrders.length - 1; i >= 0; i--) processClosedOrder(lastOrders[i], true);
  }

  function applyHookSnapshot(snap) {
    if (!snap || typeof snap !== "object" || Array.isArray(snap)) return;
    const status = normalizeStatus(snap.status);
    if (status) lastQuotexStatus = status;
    if (Array.isArray(snap.instruments)) {
      lastInstruments = normalizeInstruments(snap.instruments);
      for (const it of lastInstruments) {
        if (it && it.symbol) { try { ASSETS.registerQuotexAsset(it); } catch (_) {} }
      }
      try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_INSTRUMENTS", payload: lastInstruments }).catch(() => {}); } catch (_) {}
    }
    const balance = normalizeBalance(snap.balance);
    if (balance) {
      lastBalance = balance;
      try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_BALANCE", payload: lastBalance }).catch(() => {}); } catch (_) {}
    }
    if (Array.isArray(snap.orders)) {
      lastOrders = snap.orders.map(normalizeOrderEvent).filter(Boolean).slice(0, 50);
      if (lastOrders[0]) {
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_TRADE_RESULT", payload: lastOrders[0] }).catch(() => {}); } catch (_) {}
      }
      replayClosedOrders();
    }
    // Only the hook's explicit main-chart selection is authoritative. Quote
    // streams contain every subscribed chart, so "latest tick wins" makes the
    // dashboard rapidly mimic all open charts.
    const main = snap.activeChart && typeof snap.activeChart === "object" && !Array.isArray(snap.activeChart)
      ? snap.activeChart : null;
    if (main && typeof main.symbol === "string" && main.symbol.length <= 80) {
      const changedMain = !lastWsSymbol || !QUOTEX ||
        QUOTEX.normalizeSymbol(lastWsSymbol) !== QUOTEX.normalizeSymbol(main.symbol);
      lastWsSymbol = main.symbol;
      if (changedMain) { lastWsPrice = null; lastWsTickAt = 0; }
      const period = Number(main.period);
      if (Number.isFinite(period) && period >= 1 && period <= 86400) lastWsPeriod = Math.floor(period);
    }
    const ticks = snap.ticks && typeof snap.ticks === "object" && !Array.isArray(snap.ticks) ? snap.ticks : {};
    const selectedTick = lastWsSymbol && ticks[lastWsSymbol];
    const selectedPrice = Number(selectedTick && selectedTick.price);
    const selectedTime = selectedTick && QUOTEX && typeof QUOTEX.toMs === "function"
      ? QUOTEX.toMs(selectedTick.time) : null;
    if (Number.isFinite(selectedPrice) && selectedPrice > 0 && selectedPrice <= 1e12 &&
        Number.isSafeInteger(selectedTime) && Date.now() - selectedTime >= 0 && Date.now() - selectedTime <= 15000) {
      lastWsPrice = selectedPrice;
      lastWsTickAt = Date.now();
    }
    if (lastWsSymbol) {
      const det = ASSETS.ensureRegistered(lastWsSymbol);
      if (det) activateAsset(det.id);
    }
    const candlesMap = snap.candles && typeof snap.candles === "object" && !Array.isArray(snap.candles)
      ? snap.candles : {};
    const candleKeys = Object.keys(candlesMap).slice(0, 50);
    for (const key of candleKeys) {
      const m = key.match(/^(.{1,80})@(\d{1,6})$/);
      if (!m) continue;
      const list = candlesMap[key];
      const period = Number(m[2]);
      if (Array.isArray(list) && list.length && period >= 1 && period <= 86400) {
        ingestLiveCandles(m[1], period, list);
      }
    }
  }

  function maybeSignal() {
    const asset = syncActiveAsset();
    const full = activeFeed.series();
    // Compute expensive indicators on CLOSED bars only. The result is cached
    // for the entire bar instead of re-running Hurst/ADX/MACD twice a second.
    let a = full;
    // Only remove the final bar when the feed actually has an in-progress
    // candle. forceClose() can leave an all-closed series; blindly slicing it
    // then delayed every signal by one extra bar.
    if (full.length > 1 && (!activeFeed.hasCurrent || activeFeed.hasCurrent())) a = full.slice(0, -1);
    if (a.length < 2) a = full;
    const closed = a.length ? a[a.length - 1] : null;
    const analysisKey = activeAsset + ":" + currentStrategy + ":" +
      (closed && closed.time != null ? closed.time : "none") + ":" + a.length + ":" +
      (closed ? [closed.open, closed.high, closed.low, closed.close].join(",") : "none");
    let sig = cachedSignal;
    const fresh = !sig || analysisKey !== cachedAnalysisKey;
    if (fresh) {
      const strat = STRAT.get(currentStrategy) || STRAT.defaults();
      sig = self.CYBER_ENGINE.analyze(a, {
        strategy: currentStrategy,
        params: strat.params,
        weights: strat.weights,
        lean: false,
      });
      sig.asset = asset ? asset.id : activeAsset;
      sig.assetName = asset ? asset.name : activeAsset;
      sig.strategy = currentStrategy;
      if (closed && closed.time != null) {
        sig.time = closed.time;
        // Signals are decided at the close of this 1m bar, not its open.
        sig.entryTime = closed.time + TF_MS;
        sig.entryPrice = closed.close;
      }
      try {
        if (sig.ready && sig.direction !== "WAIT" && calCache.enabled) {
          const adj = STORE.calibrationAdjust(sig.confidence, calCache.buckets);
          if (adj != null && Number.isFinite(adj)) sig.confidence = adj;
        }
      } catch (_) {}
      cachedSignal = sig;
      cachedAnalysisKey = analysisKey;

      if (markerStore && sig.ready && sig.direction !== "WAIT" && sig.entryTime != null && closed) {
        const added = markerStore.add({
          asset: sig.asset,
          // The decision is known at the closed bar boundary, which is the
          // opening timestamp of the actual entry candle on Quotex. Anchoring
          // to sig.time put live arrows one candle left of settled-history
          // arrows, which already use entryTime.
          time: sig.entryTime,
          price: sig.entryPrice != null ? sig.entryPrice : closed.close,
          dir: sig.direction,
          confidence: sig.confidence,
        });
        if (added) sendMarkers();
      }
    }

    const authoritativeMain = !!lastWsSymbol && !!QUOTEX &&
      QUOTEX.normalizeSymbol(activeAsset) === QUOTEX.normalizeSymbol(lastWsSymbol);
    const closedAt = closed && Number(closed.time) + TF_MS;
    const liveClosedBar = Number.isFinite(closedAt) && closedAt <= Date.now() + TF_MS &&
      Date.now() - closedAt <= 10 * TF_MS;
    if (isPrimaryContext && authoritativeMain && realHistoryReady[activeAsset] && liveClosedBar &&
        sig && sig.ready && sig.direction !== "WAIT" && closed && a.length >= 2 && !pendingByAsset[activeAsset]) {
      const key = String(closed.time);
      if (key !== lastVirtualBarByAsset[activeAsset]) {
        // One virtual lifecycle per asset/bar even if strategy changes or the
        // user switches away and back before the next candle closes.
        lastVirtualBarByAsset[activeAsset] = key;
        const expiryMinutes = Math.max(0.5, Math.min(1440, Number(runtimeSettings && runtimeSettings.expiry) || 3));
        const assetPayout = Number(asset && asset.payout);
        const payout = Number.isFinite(assetPayout) && assetPayout > 0
          ? Math.min(10, assetPayout > 1 ? assetPayout / 100 : assetPayout) : 0.85;
        pendingByAsset[activeAsset] = stats.pending = {
          asset: sig.asset,
          dir: sig.direction,
          entry: closed.close,
          entryPrice: closed.close,
          entryTime: closed.time + TF_MS,
          expireAt: closed.time + TF_MS + expiryMinutes * TF_MS,
          expiryTime: closed.time + TF_MS + expiryMinutes * TF_MS,
          expiryMinutes,
          score: sig.score,
          confidence: sig.confidence,
          regime: sig.regime,
          strategy: currentStrategy,
          payout,
        };
      }
    }

    paintHud(sig);
    queueStatePush(sig);

    // A signal is handed to auto once per closed bar and only by the browser
    // tab selected as primary in background.js. Other open Quotex charts can
    // collect data, but can never place duplicate trades.
    if (isPrimaryContext && authoritativeMain && realHistoryReady[activeAsset] && liveClosedBar &&
        autoController && sig && sig.ready && sig.direction !== "WAIT") {
      const autoKey = String(sig.time || 0);
      if (autoKey !== lastAutoBarByAsset[sig.asset]) {
        lastAutoBarByAsset[sig.asset] = autoKey;
        try { autoController.handleSignal(sig); } catch (_) {}
      }
    }
  }

  function stateFingerprint(sig) {
    const chart = chartForActiveAsset();
    const pending = pendingByAsset[activeAsset];
    const latestOrder = lastOrders[0] && lastOrders[0].data || {};
    return [
      activeAsset, activeFeed.lastPrice(), cachedAnalysisKey,
      sig && sig.direction, sig && sig.confidence,
      stats.wins, stats.losses, stats.history.length,
      pending && pending.expireAt, isPrimaryContext, wsQuoteMatchesActive(),
      chart && chart.ts, chart && chart.candles && chart.candles.length,
      lastQuotexStatus && lastQuotexStatus.state,
      lastBalance && lastBalance.balance, lastInstruments.length,
      lastOrders.length, latestOrder.id || latestOrder.requestId || "",
    ].join("|");
  }

  function queueStatePush(sig, force) {
    latestStateSignal = sig || latestStateSignal;
    const now = Date.now();
    const fingerprint = stateFingerprint(latestStateSignal);
    // Keep a low-rate heartbeat for dashboard stale-state detection, but do
    // not serialize two candle arrays every second when nothing changed.
    if (!force && fingerprint === lastStateFingerprint && now - lastStatePushAt < 10000) return;
    lastStateFingerprint = fingerprint;
    const minGap = 250;
    if (force || !lastStatePushAt || now - lastStatePushAt >= minGap) {
      if (statePushTimer) { clearTimeout(statePushTimer); statePushTimer = null; }
      lastStatePushAt = now;
      pushState(latestStateSignal);
      return;
    }
    if (!statePushTimer) {
      statePushTimer = setTimeout(() => {
        statePushTimer = null;
        lastStatePushAt = Date.now();
        pushState(latestStateSignal);
      }, minGap - (now - lastStatePushAt));
    }
  }

  function pushState(sig) {
    if (!sig) return;
    const total = stats.wins + stats.losses;
    const chart = chartForActiveAsset();
    const feedSeries = activeFeed.series().slice(-220);
    const chartSeries = (chart && Array.isArray(chart.candles) && chart.candles.length)
      ? chart.candles.slice(-220)
      : feedSeries;
    const payload = {
      attached: true,
      primary: isPrimaryContext,
      source: wsQuoteMatchesActive() ? "websocket" : "dom",
      asset: assetName(),
      assetId: activeAsset,
      price: activeFeed.lastPrice(),
      candles: feedSeries,
      // Keep messages compact while allowing the active 1m candle to move on
      // every accepted Quotex tick instead of waiting for a history refresh.
      chartCandles: chartSeries,
      chartPeriod: chart ? chart.period : 60,
      // Allows the dashboard backtester to consume the already-delivered
      // genuine 1m series directly while the storage write is still settling.
      // Synthetic warm-up bars must never be presented as broker history.
      realHistoryReady: !!realHistoryReady[activeAsset],
      signal: sig,
      wins: stats.wins,
      losses: stats.losses,
      pending: pendingByAsset[activeAsset] || null,
      history: stats.history.slice(0, 40),
      winrate: total ? (stats.wins / total) * 100 : 0,
      accuracy: total ? (stats.wins / total) * 100 : 0,
      autoState: autoController ? autoController.getState() : null,
      strategy: currentStrategy,
      markers: markerStore ? markerStore.list(activeAsset) : [],
      ts: Date.now(),
      quotex: {
        status: lastQuotexStatus,
        balance: lastBalance,
        instrumentsCount: lastInstruments.length,
        activeSymbol: lastWsSymbol || activeAsset,
        activePeriod: lastWsPeriod,
        lastOrders: lastOrders.slice(0, 5),
      },
    };
    try { chrome.runtime.sendMessage({ type: "CYBER_STATE", payload }).catch(() => {}); } catch (_) {}
  }

  function ensureHud() {
    let el = document.getElementById("cyber-binary-hud");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cyber-binary-hud";
    el.innerHTML =
      '<div class="cb-hud-title">CYBER BINARY</div>' +
      '<div class="cb-hud-asset" id="cb-asset">—</div>' +
      '<div class="cb-hud-dir">SCAN</div>' +
      '<div class="cb-hud-meta">Waiting for ticks…</div>' +
      '<div class="cb-hud-row">' +
        '<button type="button" class="cb-hud-btn" id="cb-arm">ARM</button>' +
        '<button type="button" class="cb-hud-btn ghost" id="cb-open-dash">Dashboard</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(el);
    el.querySelector("#cb-open-dash").addEventListener("click", function () {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
    });
    el.querySelector("#cb-arm").addEventListener("click", function () {
      const btn = el.querySelector("#cb-arm");
      if (!isPrimaryContext || hudArmPending) {
        if (!isPrimaryContext) btn.textContent = "MAIN TAB ONLY";
        return;
      }
      hudArmPending = true;
      btn.disabled = true;
      STORE.getSettings().then((s) => {
        const requested = s.autoMode !== "off" && !s.armed;
        return STORE.setSettings({ armed: requested });
      }).then((saved) => {
        const armed = isPrimaryContext && !!saved.armed;
        runtimeSettings = saved;
        if (autoController) autoController.setArmed(armed);
        btn.textContent = armed ? "ARMED" : "ARM";
        btn.classList.toggle("armed", armed);
      }).catch(() => {
        btn.textContent = "ARM";
        btn.classList.remove("armed");
      }).finally(() => {
        hudArmPending = false;
        btn.disabled = false;
      });
    });
    return el;
  }

  function paintHud(sig) {
    const el = ensureHud();
    const d = sig && sig.ready && (sig.direction === "CALL" || sig.direction === "PUT") ? sig.direction : "WARM";
    const assetText = (sig && sig.assetName) || assetName();
    const wr = stats.wins + stats.losses;
    const wrTxt = wr ? ((stats.wins / wr) * 100).toFixed(1) + "%" : "—";
    const qstat = lastQuotexStatus && typeof lastQuotexStatus.state === "string"
      ? "· qx:" + lastQuotexStatus.state.slice(0, 32) : "";
    const balanceNumber = Number(lastBalance && lastBalance.balance);
    const bal = Number.isFinite(balanceNumber) ? "· bal " + balanceNumber.toFixed(2) : "";
    const metaText =
      (sig && sig.reason ? String(sig.reason).slice(0, 256) + " · " : "") +
      "WR " + wrTxt + " · " +
      stats.wins + "W / " + stats.losses + "L " + qstat + " " + bal + " · " +
      (sig && sig.regime ? "regime " + String(sig.regime).slice(0, 64) + " · " : "") +
      activeFeed.size() + " bars";
    const fingerprint = [d, assetText, metaText].join("|");
    if (fingerprint === lastHudFingerprint) return;
    lastHudFingerprint = fingerprint;
    el.querySelector(".cb-hud-dir").textContent = d;
    el.dataset.dir = d;
    el.querySelector("#cb-asset").textContent = assetText;
    el.querySelector(".cb-hud-meta").textContent = metaText;
  }

  function ingest(price, assetOverride, tickTime, source) {
    const safePrice = Number(price);
    if (!Number.isFinite(safePrice) || safePrice <= 0 || safePrice > 1e12) return false;
    const targetAsset = assetOverride || activeAsset;
    const targetFeed = createFeedFor(targetAsset);
    const priorPrice = Number(targetFeed.lastPrice());
    const relativeMove = Number.isFinite(priorPrice) && priorPrice > 0
      ? Math.abs(safePrice / priorPrice - 1) : 0;

    // The DOM is only a fallback and can briefly point at a balance, payout,
    // strike, or another chart while the broker SPA is remounting. Once real
    // history anchors the feed, reject a single DOM value more than 2% away;
    // WebSocket quotes and broker OHLC remain authoritative.
    if (source === "dom" && historySeeded[targetAsset] && relativeMove > 0.02) return false;

    let ts = tickTime == null ? Date.now() : Number(tickTime);
    if (!Number.isFinite(ts)) return false;
    while (Math.abs(ts) >= 1e14) ts /= 1000;
    if (Math.abs(ts) < 1e11) ts *= 1000;
    ts = Math.floor(ts);
    if (!Number.isSafeInteger(ts) || ts < Date.now() - 7 * 86400000 || ts > Date.now() + 60000 ||
        (typeof targetFeed.canIngest === "function" && !targetFeed.canIngest(ts))) return false;

    // Before genuine 1m history is available the feed contains a synthetic
    // indicator warm-up. Align that warm-up to the first valid real quote (and
    // to a later source correction if it differs by >2%) instead of joining
    // two unrelated price levels with the giant candle in the bug report.
    if (!historySeeded[targetAsset] && typeof targetFeed.rebase === "function" &&
        (!lastAcceptedQuoteAt[targetAsset] || relativeMove > 0.02)) {
      targetFeed.rebase(safePrice);
    }

    if (assetOverride && assetOverride !== activeAsset) {
      // Keep background charts warm. Per-asset pending calls may settle only
      // from their own feed, never from the currently selected asset's price.
      const backgroundEvent = createFeedFor(assetOverride).ingest(safePrice, ts);
      // Reject stale/out-of-order packets before they can settle an expiry.
      if (!backgroundEvent) return false;
      lastAcceptedQuoteAt[assetOverride] = Date.now();
      // Settle fractional/minute expiries on the first accepted real quote at
      // or after the exact expiry rather than waiting for a later bar close.
      settlePending(safePrice, ts, assetOverride);
      settleFeedEvent(backgroundEvent, assetOverride);
      persistLiveCandles(assetOverride, false);
      return true;
    }
    const ev = activeFeed.ingest(safePrice, ts);
    if (!ev) return false;
    lastAcceptedQuoteAt[activeAsset] = Date.now();
    settlePending(safePrice, ts, activeAsset);
    settleFeedEvent(ev, activeAsset);
    persistLiveCandles(activeAsset, false);
    scheduleTickSignalRefresh();
    if (!dashOpened && attached && ev && isPrimaryContext) {
      dashOpened = true;
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
    }
    return true;
  }

  function ensureHistorySubscription(det, force, requestedLimit) {
    if (!det || !QUOTEX || !QUOTEX.subscribeHistory) return null;
    const id = det.id;
    const at = historyRequestedAt[id] || 0;
    // Once real history has arrived, live ticks extend the cache; do not pull a
    // 5,000-row batch on every periodic scan. The backtest button can still
    // force one refresh on demand.
    if (!force && historySeeded[id]) return null;
    if (!force && Date.now() - at < 30000) return null; // retry initial attachment at most every 30s
    const rawLimit = Number(requestedLimit);
    const limit = Number.isFinite(rawLimit) ? Math.max(60, Math.min(5000, Math.floor(rawLimit))) : 5000;
    const requestId = "history_" + Date.now() + "_" + (++historyRequestSequence % 1000000);
    historyRequestedAt[id] = Date.now();
    try {
      window.postMessage({
        source: "CYBER_BINARY_CONTENT",
        kind: "subscribe",
        payload: { requestId, asset: id, period: 60, limit },
      }, "*");
      return requestId;
    } catch (_) {
      historyRequestedAt[id] = 0;
      return null;
    }
  }

  function requestHistorySubscription(det, requestedLimit) {
    const requestId = ensureHistorySubscription(det, true, requestedLimit);
    if (!requestId) return Promise.resolve({ ok: false, requested: false, error: "history request could not be posted" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingHistory[requestId]) return;
        delete pendingHistory[requestId];
        if (det && det.id) historyRequestedAt[det.id] = 0;
        resolve({ ok: false, requested: false, asset: det && det.id || activeAsset, error: "history subscription acknowledgement timeout" });
      }, 4000);
      pendingHistory[requestId] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
  }

  function tick() {
    const det = syncActiveAsset();
    const currentTime = Date.now();
    // A wall-clock close is valid only while real quote input is fresh. After
    // a disconnect, repeatedly closing bars at an old price fabricates candle
    // outcomes and can settle expiries without a broker quote.
    if (currentTime - (lastAcceptedQuoteAt[activeAsset] || 0) <= 15000) {
      const ev = activeFeed.forceClose(currentTime);
      settleFeedEvent(ev, activeAsset);
    }
    // Real WS ticks are ingested by the message router with their broker
    // timestamps. DOM polling is a conservative fallback and is accepted only
    // when the rendered quote changes; an unchanged stale label is not a tick.
    if (!wsQuoteMatchesActive()) {
      const p = findPrice();
      if (p && p !== lastDomPriceByAsset[activeAsset]) {
        lastDomPriceByAsset[activeAsset] = p;
        ingest(p, det && det.id, currentTime, "dom");
      }
    }
    maybeSignal();
    // v2.3.3: when the chart switches assets, push that asset's markers so
    // the arrows shown always belong to the visible chart.
    if (markerStore && lastMarkersAsset !== activeAsset) {
      lastMarkersAsset = activeAsset;
      sendMarkers();
    }
    ensureHistorySubscription(det || ASSETS.get(activeAsset));
  }

  function requestHookSync() {
    try {
      window.postMessage({ source: "CYBER_BINARY_CONTENT", kind: "sync_request", payload: {} }, "*");
    } catch (_) {}
  }

  /* -------- page-hook message router (v2.2: + snapshot/ws results) -------- */
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== "CYBER_BINARY_HOOK") return;
    const p = ev.data.payload || {};
    switch (ev.data.kind) {
      case "snapshot": {
        applyHookSnapshot(p);
        break;
      }
      case "tick": {
        const symbol = p && typeof p.symbol === "string" && p.symbol.length <= 80 ? p.symbol : "";
        const price = Number(p && p.price);
        if (symbol && Number.isFinite(price) && price > 0 && price <= 1e12) {
          const det = ASSETS.ensureRegistered(symbol);
          const relevant = det && (det.id === activeAsset || !!pendingByAsset[det.id]);
          // Unrelated subscriptions from mini/open charts must not allocate a
          // synthetic feed or trigger analysis work on every quote.
          const accepted = relevant ? ingest(price, det.id, p.time, "websocket") : false;
          if (accepted && lastWsSymbol && QUOTEX &&
              QUOTEX.normalizeSymbol(symbol) === QUOTEX.normalizeSymbol(lastWsSymbol)) {
            lastWsPrice = price;
            lastWsTickAt = Date.now();
          }
        }
        break;
      }
      case "asset": {
        if (p && p.main === true && typeof p.symbol === "string" && p.symbol.length <= 80) {
          const changedMain = !lastWsSymbol || !QUOTEX ||
            QUOTEX.normalizeSymbol(lastWsSymbol) !== QUOTEX.normalizeSymbol(p.symbol);
          lastWsSymbol = p.symbol;
          if (changedMain) { lastWsPrice = null; lastWsTickAt = 0; }
          const period = Number(p.period);
          if (Number.isFinite(period) && period >= 1 && period <= 86400) lastWsPeriod = Math.floor(period);
          const det = ASSETS.ensureRegistered(p.symbol);
          if (manualAsset && det && det.id !== manualAsset) manualAsset = null;
          if (det && det.id !== activeAsset) {
            activateAsset(det.id);
            lastWsPrice = null;
            lastWsTickAt = 0;
          }
          sendMarkers();
        }
        break;
      }
      case "candle": {
        if (p && p.asset && Array.isArray(p.candles)) {
          ingestLiveCandles(p.asset, p.period, p.candles);
        }
        break;
      }
      case "balance": {
        const balance = normalizeBalance(p);
        if (!balance) break;
        lastBalance = balance;
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_BALANCE", payload: balance }).catch(() => {}); } catch (_) {}
        break;
      }
      case "instruments": {
        lastInstruments = normalizeInstruments(p);
        for (const it of lastInstruments) {
          if (it.symbol) {
            try { ASSETS.registerQuotexAsset(it); } catch (_) {}
          }
        }
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_INSTRUMENTS", payload: lastInstruments }).catch(() => {}); } catch (_) {}
        break;
      }
      case "order": {
        const order = normalizeOrderEvent(p);
        if (!order) break;
        const data = order.data;
        const orderIdentity = order.kind + ":" + String(data.id || data.requestId || "") + ":" +
          String(data.openTime || data.closeTime || "");
        if (!lastOrders.some((item) => {
          const d = item && item.data || {};
          return String(item && item.kind || "") + ":" + String(d.id || d.requestId || "") + ":" +
            String(d.openTime || d.closeTime || "") === orderIdentity;
        })) lastOrders.unshift(order);
        if (lastOrders.length > 50) lastOrders.length = 50;
        if (order.kind === "closed") processClosedOrder(order, false);
        if (order.kind === "opened") {
          const req = data.requestId != null ? String(data.requestId) : "";
          const lifecycle = confirmationLifecycle(data);
          if (req && pendingOrders[req]) {
            pendingOrders[req]({
              ok: true,
              confirmed: true,
              mode: "ws",
              id: data.id || req,
              requestId: req,
              asset: data.asset,
              dir: data.direction,
              amount: data.amount,
              openPrice: data.openPrice,
              openTime: lifecycle.openTime,
              expiryTime: lifecycle.expiryTime,
              duration: lifecycle.duration,
              order: data,
            });
            delete pendingOrders[req];
          } else if (pendingDomOrder && Date.now() - pendingDomOrder.at < 10000 &&
              data.asset && (data.direction === "CALL" || data.direction === "PUT") &&
              QUOTEX.normalizeSymbol(pendingDomOrder.asset) === QUOTEX.normalizeSymbol(data.asset) &&
              pendingDomOrder.dir === data.direction && Number(data.amount) > 0 &&
              Math.abs(Number(data.amount) - pendingDomOrder.amount) <=
                Math.max(0.000001, Math.abs(pendingDomOrder.amount) * 0.000001)) {
            const done = pendingDomOrder.resolve;
            pendingDomOrder = null;
            done({
              ok: true, confirmed: true, mode: "dom", id: data.id || null,
              asset: data.asset, dir: data.direction, amount: data.amount,
              openPrice: data.openPrice, openTime: lifecycle.openTime,
              expiryTime: lifecycle.expiryTime,
              duration: lifecycle.duration, order: data,
            });
          }
        }
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_TRADE_RESULT", payload: order }).catch(() => {}); } catch (_) {}
        break;
      }
      case "quotex_status": {
        const status = normalizeStatus(p);
        if (!status) break;
        lastQuotexStatus = status;
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_STATUS", payload: lastQuotexStatus }).catch(() => {}); } catch (_) {}
        break;
      }
      case "adapter_status": {
        // Surface a once-only log for the dashboard.
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_STATUS", payload: { state: p && p.loaded ? "adapter_loaded" : "fallback" } }).catch(() => {}); } catch (_) {}
        break;
      }
      case "ready": {
        requestHookSync();
        break;
      }
      case "ws_result": {
        const requestId = p && p.requestId != null ? String(p.requestId).slice(0, 128) : "";
        if (requestId && pendingWs[requestId]) {
          const result = {
            ok: p.ok === true,
            sent: p.sent === true,
            confirmed: false,
            requestId,
            error: p.error == null ? null : String(p.error).slice(0, 256),
          };
          try { pendingWs[requestId](result); } catch (_) {}
          delete pendingWs[requestId];
        }
        break;
      }
      case "subscribe_result": {
        const requestId = p && typeof p.requestId === "string" ? p.requestId.slice(0, 128) : "";
        const asset = p && typeof p.asset === "string" ? p.asset.slice(0, 96) : activeAsset;
        const detail = p && p.payload && typeof p.payload === "object" && !Array.isArray(p.payload) ? p.payload : {};
        const result = {
          ok: p && p.ok === true,
          requested: p && p.ok === true,
          requestId,
          asset,
          period: Number.isFinite(Number(detail.period)) ? Number(detail.period) : 60,
          limit: Number.isFinite(Number(detail.limit)) ? Number(detail.limit) : null,
          error: p && p.ok === true ? null : String(detail.error || "broker history subscription failed").slice(0, 256),
        };
        const hasPendingRequest = !!(requestId && pendingHistory[requestId]);
        if (!result.ok && asset && hasPendingRequest) historyRequestedAt[asset] = 0;
        if (hasPendingRequest) {
          const done = pendingHistory[requestId];
          delete pendingHistory[requestId];
          try { done(result); } catch (_) {}
        }
        break;
      }
      case "url": break;
      case "open": break;
    }
  });

  function attach() {
    if (attached) {
      if (isPrimaryContext) chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
      return;
    }
    attached = true;
    try {
      chrome.runtime.sendMessage({ type: "CYBER_REGISTER_SOURCE" }).then((r) => {
        const registeredPrimary = !!(r && r.primary);
        if (registeredPrimary !== isPrimaryContext) primaryEpoch++;
        isPrimaryContext = registeredPrimary;
        if (autoController) autoController.setArmed(isPrimaryContext && !!(runtimeSettings && runtimeSettings.armed));
        if (isPrimaryContext) replayClosedOrders();
        queueStatePush(cachedSignal, true);
      }).catch(() => {});
    } catch (_) {}
    loadStats();
    loadSettingsAndArmAuto();
    // page-hook.js is already injected in MAIN world by manifest.json. A
    // second 97KB script injection parsed the complete adapter again on every
    // attach and contributed to UI lag even though its shell guard returned.
    requestHookSync();
    ensureHud();
    pollTimer = setInterval(tick, 1000);
    tick();
    setTimeout(requestHookSync, 1200); // hook may still be loading
  }

  /* -------- confirmed real-platform trade placement -------- */
  function nextRequestId() {
    // Numeric and below Number.MAX_SAFE_INTEGER (the broker expects an int).
    return String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  }

  function waitForBrokerOrder(requestId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingOrders[requestId]) delete pendingOrders[requestId];
        resolve({ ok: false, confirmed: false, sent: true, error: "broker order confirmation timeout" });
      }, timeoutMs || 8000);
      pendingOrders[requestId] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
  }

  async function sendWsTrade(orderArgs) {
    const requestId = nextRequestId();
    const confirmation = waitForBrokerOrder(requestId, 8000);
    const sent = await new Promise((resolve) => {
      pendingWs[requestId] = resolve;
      const timer = setTimeout(() => {
        if (pendingWs[requestId]) {
          delete pendingWs[requestId];
          // The MAIN-world handler may have sent the frame before its ACK was
          // delayed. Treat timeout as an uncertain send so DOM fallback can
          // never duplicate a broker order.
          resolve({ ok: false, sent: true, error: "page socket send timeout" });
        }
      }, 3000);
      const original = pendingWs[requestId];
      pendingWs[requestId] = (result) => {
        clearTimeout(timer);
        original(result);
      };
      try {
        window.postMessage({
          source: "CYBER_BINARY_CONTENT",
          kind: "place_ws",
          payload: {
            requestId,
            asset: orderArgs.asset,
            dir: orderArgs.dir,
            amount: orderArgs.stake,
            expirySec: orderArgs.expirySec,
            isDemo: !!(lastBalance && lastBalance.isDemo),
            optionType: orderArgs.optionType,
          },
        }, "*");
      } catch (e) {
        if (pendingWs[requestId]) {
          delete pendingWs[requestId];
          resolve({ ok: false, error: String(e) });
        }
      }
    });
    let confirmed;
    if (!sent || !sent.ok) {
      if (sent && sent.sent) {
        // The MAIN-world ACK can time out after ws.send() succeeded. A
        // correlated broker order-open event is still authoritative; wait for
        // it instead of discarding an already received confirmation.
        confirmed = await confirmation;
        if (!confirmed || !confirmed.ok) return confirmed || sent;
      } else {
        const cancelConfirmation = pendingOrders[requestId];
        if (cancelConfirmation) {
          delete pendingOrders[requestId];
          cancelConfirmation({ ok: false, confirmed: false, sent: false, error: "page socket send failed" });
        }
        return sent || { ok: false, error: "page socket send failed" };
      }
    } else {
      confirmed = await confirmation;
    }
    if (confirmed && confirmed.ok) {
      const confirmedDir = String(confirmed.dir || "").toUpperCase();
      const assetMismatch = !confirmed.asset || !orderArgs.asset ||
        QUOTEX.normalizeSymbol(confirmed.asset) !== QUOTEX.normalizeSymbol(orderArgs.asset);
      const dirMismatch = confirmedDir !== orderArgs.dir;
      const confirmedAmount = Number(confirmed.amount);
      const amountMismatch = !Number.isFinite(confirmedAmount) || confirmedAmount <= 0 ||
        Math.abs(confirmedAmount - orderArgs.stake) > Math.max(0.000001, Math.abs(orderArgs.stake) * 0.000001);
      if (assetMismatch || dirMismatch || amountMismatch) {
        return { ok: false, confirmed: false, sent: true, requestId,
          error: "broker confirmation did not match the requested asset/direction/amount" };
      }
      confirmed.expiryTime = confirmed.expiryTime || (confirmed.openTime || Date.now()) + orderArgs.expirySec * 1000;
      confirmed.expiry = orderArgs.expirySec;
      confirmed.requestId = requestId;
    }
    return confirmed;
  }

  function waitForDomOrder(meta, timeoutMs) {
    return new Promise((resolve) => {
      let waiter = null;
      const timer = setTimeout(() => {
        if (pendingDomOrder !== waiter) return;
        pendingDomOrder = null;
        resolve({ ok: false, confirmed: false, clicked: true, mode: "dom", error: "broker did not confirm DOM click" });
      }, timeoutMs || 8000);
      waiter = {
        at: Date.now(), asset: meta.asset, dir: meta.dir, amount: meta.amount,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
      };
      pendingDomOrder = waiter;
    });
  }

  async function confirmPrimaryOwnership(expectedPrimaryEpoch) {
    if (!isPrimaryContext || primaryEpoch !== expectedPrimaryEpoch) return false;
    try {
      const response = await chrome.runtime.sendMessage({ type: "CYBER_IS_PRIMARY" });
      return !!(response && response.ok && response.primary) && isPrimaryContext && primaryEpoch === expectedPrimaryEpoch;
    } catch (_) { return false; }
  }

  async function placeTradeOnce(args, expectedPrimaryEpoch) {
    if (!QUOTEX) return { ok: false, confirmed: false, error: "adapter missing" };
    if (!isPrimaryContext) return { ok: false, confirmed: false, error: "not the selected main Quotex tab" };
    args = args || {};
    const dir = String(args.dir || "").toUpperCase();
    if (dir !== "CALL" && dir !== "PUT") return { ok: false, confirmed: false, error: "signal has no CALL/PUT direction" };
    const s = await STORE.getSettings();
    runtimeSettings = s;
    if (!await confirmPrimaryOwnership(expectedPrimaryEpoch)) {
      return { ok: false, confirmed: false, error: "main-tab ownership changed before placement" };
    }
    if (!s.armed || s.autoMode !== "click") {
      return { ok: false, confirmed: false, error: "automation was disarmed before placement" };
    }
    // This executor is automation-only; use the freshly loaded settings so a
    // stake/expiry change during eligibility cannot submit stale values.
    const stake = Number(s.stake);
    const expiry = Number(s.expiry);
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1000000) {
      return { ok: false, confirmed: false, error: "stake must be between 0 and 1,000,000" };
    }
    if (!Number.isFinite(expiry) || expiry < 0.5 || expiry > 1440) {
      return { ok: false, confirmed: false, error: "expiry must be between 0.5 and 1,440 minutes" };
    }
    const expirySec = Math.max(30, Math.round(expiry * 60));
    if (!lastWsSymbol) return { ok: false, confirmed: false, error: "authoritative main chart is not known" };
    const asset = args.asset || lastWsSymbol;
    if (QUOTEX.normalizeSymbol(asset) !== QUOTEX.normalizeSymbol(lastWsSymbol)) {
      return { ok: false, confirmed: false, error: "trade asset is not the authoritative main chart" };
    }

    // Prefer the page's already-authenticated socket. Unlike a raw DOM click,
    // this carries the exact asset/expiry and can be correlated with the
    // broker's s_orders/open response.
    const isDemo = (lastBalance && typeof lastBalance.isDemo === "boolean")
      ? lastBalance.isDemo
      : (QUOTEX.findAccountMode ? (QUOTEX.findAccountMode() || {}).isDemo : true);
    const wsResult = await sendWsTrade({
      asset,
      dir,
      stake,
      expirySec,
      optionType: args.optionType,
      isDemo: isDemo !== false,
    });
    if (wsResult && wsResult.ok) return wsResult;
    if (wsResult && wsResult.sent) {
      // The frame may have reached the broker; never click as a retry or we
      // could duplicate an order whose confirmation packet was delayed.
      return wsResult;
    }
    if (!await confirmPrimaryOwnership(expectedPrimaryEpoch)) {
      return { ok: false, confirmed: false, error: "main-tab ownership changed before DOM placement" };
    }

    // Conservative DOM fallback: amount + expiry must both be set and the
    // direction button must pass strict token/color-pair validation. Then wait
    // for the same broker order-open event before reporting success.
    const domConfirmation = waitForDomOrder({ asset, dir, amount: stake }, 8000);
    const domResult = QUOTEX.placeTradeDom({
      dir,
      amount: stake,
      expirySec,
    });
    if (!domResult || !domResult.ok) {
      if (pendingDomOrder) {
        const cancelDomWait = pendingDomOrder.resolve;
        pendingDomOrder = null;
        cancelDomWait({ ok: false, confirmed: false, mode: "dom", error: "DOM placement failed" });
      }
      const failure = String(domResult && domResult.error || "DOM placement failed");
      // Missing/rejected controls are deterministic page-integration failures,
      // not market rejections. Continuing to attempt every new candle only
      // repeats the same error (and could become unsafe if the DOM changes
      // mid-session), so fail closed and require an explicit re-arm.
      if (/stake input|expiry|trade button/i.test(failure)) {
        try {
          const saved = await STORE.setSettings({ armed: false });
          runtimeSettings = saved;
          if (autoController) autoController.setArmed(false);
        } catch (_) {
          if (autoController) autoController.setArmed(false);
        }
        return { ok: false, confirmed: false, mode: "dom", error: failure + " — automation disarmed" };
      }
      return Object.assign({ ok: false, confirmed: false, mode: "dom" }, domResult || { error: failure });
    }
    const confirmed = await domConfirmation;
    if (confirmed && confirmed.ok) {
      confirmed.expiry = expirySec;
      confirmed.expiryTime = confirmed.expiryTime || (confirmed.openTime || Date.now()) + expirySec * 1000;
    }
    return confirmed;
  }

  async function placeTrade(args) {
    if (placementInFlight) {
      return { ok: false, confirmed: false, error: "another placement is awaiting broker confirmation" };
    }
    placementInFlight = true;
    const expectedPrimaryEpoch = primaryEpoch;
    try {
      return await placeTradeOnce(args, expectedPrimaryEpoch);
    } finally {
      placementInFlight = false;
    }
  }

  chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
    if (msg && msg.type === "CYBER_PRIMARY_CHANGED") {
      const nextPrimary = !!msg.primary;
      if (nextPrimary !== isPrimaryContext) primaryEpoch++;
      isPrimaryContext = nextPrimary;
      // Disarm the local controller while secondary. Shared settings remain
      // intact so the newly selected primary tab can resume safely.
      if (!isPrimaryContext) {
        if (autoController) autoController.setArmed(false);
        // Virtual lifecycle tracking belongs to the selected main tab only.
        // Discard old pending signals so regaining leadership cannot settle a
        // stale secondary-tab prediction minutes or hours later.
        for (const key of Object.keys(pendingByAsset)) delete pendingByAsset[key];
        stats.pending = null;
      }
      const armBtn = document.getElementById("cb-arm");
      if (!isPrimaryContext && armBtn) {
        armBtn.textContent = "MAIN TAB ONLY";
        armBtn.classList.remove("armed");
      }
      if (isPrimaryContext) {
        // Events received while secondary were deliberately ignored. Replaying
        // the bounded normalized snapshot after takeover catches a close that
        // occurred during the leadership handoff without double-counting it.
        replayClosedOrders();
        STORE.getSettings().then((s) => {
          runtimeSettings = s;
          const resumedStrategy = STRAT.get(s.strategy) ? s.strategy : "confluence";
          if (resumedStrategy !== currentStrategy) {
            currentStrategy = resumedStrategy;
            cachedAnalysisKey = "";
          }
          applyCalibrationSnapshot(s, null);
          if (autoController) {
            autoController.setMode(s.autoMode || "off");
            autoController.setArmed(!!s.armed);
          }
          if (armBtn) {
            armBtn.textContent = s.armed ? "ARMED" : "ARM";
            armBtn.classList.toggle("armed", !!s.armed);
          }
        }).catch(() => {});
      }
      queueStatePush(cachedSignal, true);
      sendResponse({ ok: true, primary: isPrimaryContext });
      return;
    }
    if (msg && msg.type === "CYBER_ATTACH") {
      attach();
      sendResponse({ ok: true });
    }
    if (msg && msg.type === "CYBER_PING") {
      sendResponse({ ok: true, attached: attached, bars: activeFeed.series().length, asset: activeAsset });
    }
    if (msg && msg.type === "CYBER_REQUEST_HISTORY") {
      const det = ASSETS.get(activeAsset) || ASSETS.ensureRegistered(lastWsSymbol || activeAsset);
      requestHistorySubscription(det, msg.limit).then(sendResponse).catch((e) => {
        sendResponse({ ok: false, requested: false, asset: det && det.id || activeAsset,
          error: String(e && e.message || e || "history request failed").slice(0, 256) });
      });
      return true;
    }
    if (msg && msg.type === "CYBER_SET_STRATEGY") {
      const requested = typeof msg.strategy === "string" ? msg.strategy.trim() : "";
      if (!requested || !STRAT.get(requested)) {
        sendResponse({ ok: false, error: "unknown strategy" });
        return;
      }
      STORE.setSettings({ strategy: requested }).then((s) => {
        runtimeSettings = s;
        currentStrategy = requested;
        cachedAnalysisKey = "";
        sendResponse({ ok: true, strategy: currentStrategy });
      }).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
    if (msg && msg.type === "CYBER_SET_ASSET") {
      const requested = typeof msg.asset === "string" ? msg.asset.trim() : "";
      const det = requested ? ASSETS.get(requested) : null;
      if (!det) {
        sendResponse({ ok: false, error: "unknown or invalid asset", asset: activeAsset });
        return;
      }
      // The dashboard cannot safely switch the broker's chart. Pinning a
      // different local feed made the UI display synthetic candles for one
      // asset while Quotex was trading another. Only acknowledge the symbol
      // already selected on the authoritative main chart.
      const matchesMain = !!lastWsSymbol && !!QUOTEX &&
        QUOTEX.normalizeSymbol(det.id) === QUOTEX.normalizeSymbol(lastWsSymbol);
      if (!matchesMain) {
        sendResponse({ ok: false, asset: activeAsset,
          error: "Select " + det.name + " on the Quotex chart first" });
        return;
      }
      manualAsset = null;
      activateAsset(det.id);
      sendResponse({ ok: true, asset: det.id, manual: false });
      return;
    }
    if (msg && msg.type === "CYBER_DETECT_ASSET") {
      manualAsset = null; // explicit "Detect" re-enables auto-follow
      const det = detectAssetFromDom(true);
      const id = det ? det.id : (ASSETS.ensureRegistered(lastWsSymbol) ? ASSETS.get(lastWsSymbol).id : activeAsset);
      sendResponse({ ok: true, asset: id, name: det ? det.name : assetName() });
    }
    if (msg && msg.type === "CYBER_SET_AUTO") {
      const mode = msg.mode;
      if ((mode !== "off" && mode !== "alerts" && mode !== "click") || typeof msg.armed !== "boolean") {
        sendResponse({ ok: false, error: "invalid automation settings" });
        return;
      }
      const armed = isPrimaryContext && mode !== "off" && msg.armed;
      STORE.setSettings({ autoMode: mode, armed }).then((s) => {
        runtimeSettings = s;
        if (autoController) {
          autoController.setMode(s.autoMode);
          autoController.setArmed(isPrimaryContext && s.armed);
        }
        sendResponse({ ok: true, mode: s.autoMode, armed: isPrimaryContext && s.armed });
      }).catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
      return true;
    }
    if (msg && msg.type === "CYBER_QUOTEX_SET_AUTH") {
      // The extension never reads the SSID itself; the page-hook already
      // captured it from the page's traffic. We just flip the ws mode flag.
      sendResponse({ ok: true, mode: "ws_ready" });
    }
  });

  if (/qxbroker|quotex/i.test(location.host)) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
    } else {
      attach();
    }
  }
})();
