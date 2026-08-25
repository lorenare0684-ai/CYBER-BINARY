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
  // Stealth: guard is non-enumerable (invisible to Object.keys(window)).
  var _CHK = "_\u0078kc";
  try {
    var _cg = Object.getOwnPropertyDescriptor(window, _CHK);
    if (_cg && _cg.value) return;
    Object.defineProperty(window, _CHK, { value: true, enumerable: false, configurable: true, writable: true });
  } catch (_) { return; }

  // Stealth: non-descriptive postMessage channel tags (must match page-hook shell).
  var _SRC_OUT = "_q1c"; // content → hook
  var _SRC_IN  = "_q1h"; // hook → content

  const TF_MS = 60000;
  // The signal engine is intentionally 1m, while the dashboard chart may be
  // any broker timeframe. Keep this contract explicit so a chart switch can
  // never silently change the signal clock or expiry math.
  const ENGINE_TIMEFRAME_SEC = 60;

  // ---- broker clock v2.8 ----
  // Enhanced with median filtering, offset history, and robust skew handling.
  // Quotex server time is the source of truth for candle boundaries and
  // expiry math. Local Date.now() can drift by seconds to minutes.
  let brokerNow = null;
  let brokerLocalAt = 0;
  let brokerOffset = 0;
  const brokerOffsetHistory = []; // last 20 offsets for median filtering
  const brokerTimeHistory = [];   // last 20 broker timestamps for jump detection
  let lastBrokerClockLog = 0;

  function updateBrokerClock(brokerMs) {
    const ms = Number(brokerMs);
    if (!Number.isSafeInteger(ms) || ms < 946684800000) return;
    if (ms > Date.now() + 2 * 86400000) return; // far-future garbage
    if (ms < Date.now() - 7 * 86400000) return; // too far in past (7 days)

    const nowLocal = Date.now();
    const newOffset = ms - nowLocal;

    // Track time history for jump detection
    brokerTimeHistory.push({ broker: ms, local: nowLocal, at: nowLocal });
    while (brokerTimeHistory.length > 20) brokerTimeHistory.shift();

    // Detect large backward jumps (>10 min) — likely stale replay or clock reset
    if (brokerNow != null) {
      const backwardJump = brokerNow - ms;
      if (backwardJump > 10 * 60000) {
        // Allow only if we have evidence of broker clock moving backward legitimately
        // (e.g., multiple recent samples showing backward trend)
        let recentBackward = 0;
        for (let i = Math.max(0, brokerTimeHistory.length - 5); i < brokerTimeHistory.length - 1; i++) {
          if (brokerTimeHistory[i] && brokerTimeHistory[i+1] && brokerTimeHistory[i].broker > brokerTimeHistory[i+1].broker) recentBackward++;
        }
        if (recentBackward < 3) return; // reject isolated large backward jump
      }
    }

    // Track offset history for median filtering
    brokerOffsetHistory.push(newOffset);
    while (brokerOffsetHistory.length > 20) brokerOffsetHistory.shift();

    // Use median of recent offsets for stability, but allow forward movement
    if (brokerNow == null || ms > brokerNow) {
      brokerNow = ms;
      brokerLocalAt = nowLocal;
      // Median offset for stable estimate
      if (brokerOffsetHistory.length >= 3) {
        const sorted = brokerOffsetHistory.slice().sort((a,b)=>a-b);
        const median = sorted[Math.floor(sorted.length/2)];
        // Blend: 70% median, 30% latest for responsiveness
        brokerOffset = Math.round(median * 0.7 + newOffset * 0.3);
      } else {
        brokerOffset = newOffset;
      }
    } else if (ms === brokerNow) {
      brokerLocalAt = nowLocal;
      brokerOffset = newOffset;
    } else if (ms > brokerNow - 5 * 60000) {
      // Small backward (out-of-order batch) — update local reference but not brokerNow
      brokerLocalAt = nowLocal;
    }

    // Log significant clock skew for debugging (throttled)
    if (Math.abs(newOffset) > 60000 && Date.now() - lastBrokerClockLog > 60000) {
      lastBrokerClockLog = Date.now();
      try { console.warn("broker clock skew: " + Math.round(newOffset/1000) + "s (broker " + (newOffset>0?"ahead":"behind") + ")"); } catch (_) {}
    }
  }

  function getBrokerNow() {
    const nowLocal = Date.now();
    if (brokerNow != null) {
      const elapsed = nowLocal - brokerLocalAt;
      if (elapsed >= 0 && elapsed <= 120000) { // increased from 60s to 120s
        return brokerNow + elapsed;
      }
      return nowLocal + brokerOffset;
    }
    return nowLocal;
  }

  function getBrokerClockStats() {
    if (!brokerOffsetHistory.length) return null;
    const sorted = brokerOffsetHistory.slice().sort((a,b)=>a-b);
    return {
      offset: brokerOffset,
      median: sorted[Math.floor(sorted.length/2)],
      min: sorted[0],
      max: sorted[sorted.length-1],
      samples: brokerOffsetHistory.length,
      lastBroker: brokerNow,
      skewSec: Math.round(brokerOffset/1000)
    };
  }

  function brokerBucket(ms, periodMs) {
    const p = Number(periodMs) || TF_MS;
    return Math.floor(ms / p) * p;
  }

  function marketSession(ts, assetId) {
    const id = String(assetId || "").toUpperCase();
    if (/_OTC$/.test(id) || /CRYPTO|BTC|ETH|XRP|SOL|DOGE/.test(id)) return "otc-24h";
    const d = new Date(Number(ts) || Date.now());
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    if (mins >= 22 * 60 || mins < 7 * 60) return "asia-pacific";
    if (mins >= 7 * 60 && mins < 13 * 60) return "europe";
    if (mins >= 13 * 60 && mins < 17 * 60) return "overlap";
    return "new-york";
  }

  // v2.6.17: the noise gate reads a composite profile (flip ratio + Kaufman
  // efficiency + wick dominance + choppiness) instead of the flip ratio alone.
  // See CYBER_TA.noiseProfile for why each component is there.
  // Thresholds were measured, not guessed. Backtesting `confluence` over 25
  // mixed-regime series (28.7k decided trades, 3-bar expiry) and scoring the
  // window each trade was taken on:
  //
  //   no gate                 n=28719  WR 66.7%
  //   old flip gate  >= 0.78  n=27716  WR 67.4%   (blocks 3.5% of trades)
  //   composite      >= 0.62  n=15248  WR 81.7%
  //
  // The old gate barely fired because a flip ratio cannot see a retracing
  // walk or a wick-dominated bar. 0.62 keeps just over half the trades and
  // lifts win rate ~15 points; the trades it removes win 49.9%, i.e. coin
  // flips. Confirmed on 25 unseen seeds and again with the `sniper` preset
  // (63.2% → 76.4%), so it is not fitted to one series or one strategy.
  // Tightening to 0.58 buys ~4 more points but halves trade count.
  const NOISE_WINDOW = 20;
  const NOISE_GATE = 0.58;      // v2.7.0: tightened from 0.62 — buys ~4 WR points at cost of trade count
  const NOISE_HARD_GATE = 0.74; // so noisy even a liquid overlap session waits

  function noiseProfileFor(candles) {
    const TA = self.CYBER_TA;
    if (!TA || typeof TA.noiseProfile !== "function") {
      return { ready: false, score: 0, flip: 0, efficiency: 1, inefficiency: 0, wick: 0, chop: 0, bars: 0 };
    }
    return TA.noiseProfile(candles, NOISE_WINDOW);
  }

  function noiseScore(candles) {
    const profile = noiseProfileFor(candles);
    return profile.ready ? profile.score : 0;
  }

  /**
   * Session-aware noise decision. A deep, two-session overlap absorbs chop
   * that would wreck a thin Asia-Pacific book, so the tolerant session keeps a
   * higher bar — but it is no longer exempt: at NOISE_HARD_GATE the market is
   * churning regardless of who is at the desk. Returns the whole profile so
   * the reason string can name the dominant component instead of just
   * asserting "noisy".
   */
  function noiseDecision(profile, session) {
    if (!profile || !profile.ready) return { blocked: false, reason: "" };
    const tolerant = session === "overlap";
    const limit = tolerant ? NOISE_HARD_GATE : NOISE_GATE;
    if (profile.score < limit) return { blocked: false, reason: "" };
    const parts = [
      ["direction flips", profile.flip],
      ["price going nowhere", profile.inefficiency],
      ["candles all wick", profile.wick],
      ["choppy range", profile.chop],
    ].sort((a, b) => b[1] - a[1]);
    return {
      blocked: true,
      reason: "Noise filter (" + parts[0][0] + "; noise " +
        profile.score.toFixed(2) + " ≥ " + limit.toFixed(2) + "; session " + session + ")",
    };
  }
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
  const realBarCount = Object.create(null);     // assetId -> genuine 1m bars currently in the feed
  const ingestTrustLog = Object.create(null);   // assetId -> last console note about untrusted batches
  const historyRequestedAt = Object.create(null);
  const chartHistory = Object.create(null);    // assetId -> period -> {candles, ts}
  const lastAcceptedQuoteAt = Object.create(null);
  const lastDomPriceByAsset = Object.create(null);
  const lastVirtualBarByAsset = Object.create(null);
  const lastAutoBarByAsset = Object.create(null);
  let lastAutoSkipLog = 0; // v2.7.6: throttle auto-skip log messages
  let activeAsset = "EURUSD";
  let lastWsPrice = null;
  let lastWsTickAt = 0;
  let lastWsSymbol = null;       // authoritative MAIN chart symbol only
  let lastWsPeriod = 60;         // authoritative MAIN chart timeframe
  let activeFeed = createFeedFor(activeAsset);
  let autoController = null;
  let currentStrategy = "auto_adaptive";

  /**
   * v2.6.17: the concrete strategy id behind a signal.
   *
   * Under "auto_adaptive" the user's selection is a router, not a strategy —
   * the engine names its pick in `selectedStrategy`. Everything that displays
   * or logs "which strategy" must resolve through here so auto mode reports
   * the real strategy (e.g. "Sniper 90+ Confluence") instead of the router.
   * Falls back to the user's selection when the engine did not name one
   * (a preset run) and finally to the default preset.
   */
  function resolveSignalStrategyId(sig) {
    const candidates = [sig && sig.selectedStrategy, sig && sig.strategy, currentStrategy];
    for (const id of candidates) {
      if (typeof id === "string" && id && id !== "auto_adaptive" && STRAT.get(id)) return id;
    }
    return STRAT.get(currentStrategy) ? currentStrategy : "confluence";
  }

  function strategyLabelFor(id, fallbackLabel) {
    const preset = typeof id === "string" && id ? STRAT.get(id) : null;
    if (preset && preset.label) return preset.label;
    if (typeof fallbackLabel === "string" && fallbackLabel) return fallbackLabel;
    return typeof id === "string" && id ? id : "—";
  }
  let runtimeSettings = null;
  let attached = false;
  let dashOpened = false;
  let pollTimer = null;
  let manualAsset = null; // set by dashboard selection; null = auto-detect
  let manualAssetSetAt = 0; // timestamp when manualAsset was last set (for grace period)
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
  const openOrders = Object.create(null);      // ongoing broker trades: id/requestId -> order data
  const openOrdersQueue = [];                  // order of ids for bounded size
  const pendingWs = Object.create(null);       // page-hook send ack requestId -> resolver
  const pendingHistory = Object.create(null);  // page-hook history-subscription requestId -> resolver
  const pendingHistoryMeta = Object.create(null); // requestId -> {asset, period, limit, offset} for retry bookkeeping
  let historyRequestSequence = 0;
  // --- Enhanced data gathering state v2.8 ---
  const historyPagination = Object.create(null); // asset@period -> { totalReceived, lastOffset, hasMore, attempts, lastError, gaps }
  const dataQuality = Object.create(null); // asset -> { candleCount, tickCount, gaps, lastUpdate, qualityScore, continuity, freshness }
  const backgroundScanQueue = [];
  let backgroundScanTimer = null;
  let lastInstrumentsRequestAt = 0;
  let lastBalanceRequestAt = 0;
  let lastMtfRequestAt = 0;
  let lastGapCheckAt = 0;
  const MTF_PERIODS = [60, 300, 900, 1800, 3600];
  const GAP_CHECK_INTERVAL = 120000; // 2 min
  const MTF_PREFETCH_INTERVAL = 300000; // 5 min
  const pendingOrders = Object.create(null);
  const settledOrderIds = Object.create(null); // de-dupe broker close replays
  const settledOrderQueue = [];
  let pendingOrderEvent = null;                // single broker-order-event fallback waiter
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
  let lastMarkerPushAt = 0;    // v2.7.5: periodic re-push timer
  // v2.7.6: live candle cache by asset — populated from broker history
  // responses. Used by the autoHighAccuracy gate to evaluate asset quality.
  const liveCandlesByAsset = Object.create(null);

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
    // Use broker clock for synthetic seed alignment when available, so the
    // warm-up series lands on the same minute boundaries as broker history.
    const seedBase = getBrokerNow();
    f.setSeries(self.CYBER_FEED.syntheticSeries(profile, 120, {
      startTime: Math.floor(seedBase / TF_MS) * TF_MS - 120 * TF_MS,
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
    // v2.7.2: invalidate detection cache when asset changes so the next
    // scan finds the correct element for the new asset's display.
    cachedAssetElement = null;
    cachedAssetElementText = null;
    lastDomAssetResult = null;
    lastDomAssetScan = 0;
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
   * v2.7.2: Improved asset detection with caching, MutationObserver,
   * URL patterns, and TradingView chart widget extraction.
   *
   * Detection priority:
   * 1. WebSocket symbol (authoritative, instant)
   * 2. Cached DOM element (fast, ~0ms)
   * 3. URL pattern extraction (fast, ~0ms)
   * 4. TradingView chart widget symbol (fast, ~1ms)
   * 5. CSS selector scan (medium, ~5ms)
   * 6. Full text scan (slow, ~20ms, throttled)
   */

  // Cached element that previously showed the asset name. Re-checked first
  // before doing an expensive full scan.
  let cachedAssetElement = null;
  let cachedAssetElementText = null;
  let cachedAssetElementAt = 0;

  // MutationObserver for real-time asset change detection
  let assetMutationObserver = null;
  let assetMutationDetected = null;
  let assetMutationAt = 0;

  function setupAssetMutationObserver() {
    if (assetMutationObserver) return;
    if (typeof MutationObserver === "undefined") return;
    try {
      assetMutationObserver = new MutationObserver((mutations) => {
        // Only process if mutations touch text content in the header/top area
        for (const m of mutations) {
          const target = m.target;
          if (!target || !target.isConnected) continue;
          try {
            const r = target.getBoundingClientRect();
            if (r.top > 300) continue; // only care about top-of-page elements
          } catch (_) { continue; }
          if (m.type === "characterData" || (m.type === "childList" && m.addedNodes.length)) {
            const text = visibleText(target);
            if (!text || text.length < 3 || text.length > 40) continue;
            const det = ASSETS.detect(text);
            if (det) {
              assetMutationDetected = det;
              assetMutationAt = Date.now();
              return; // early exit - we found it
            }
          }
        }
      });
      // Observe the body subtree for text changes
      const observeTarget = document.body || document.documentElement;
      if (observeTarget) {
        assetMutationObserver.observe(observeTarget, {
          characterData: true,
          childList: true,
          subtree: true,
          characterDataOldValue: false,
        });
      }
    } catch (_) {}
  }

  /**
   * Extract asset from Quotex URL patterns.
   * Common patterns: /trade/EURUSD_otc, /trade?asset=EURUSD, #EURUSD
   */
  function detectAssetFromUrl() {
    try {
      const url = location.href;
      const pathname = location.pathname || "";
      const search = location.search || "";
      const hash = location.hash || "";

      // Pattern: /trade/ASSET_SYMBOL
      const pathMatch = pathname.match(/\/(?:trade|platform|chart)\/([A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*)/);
      if (pathMatch) {
        const det = ASSETS.detect(pathMatch[1].replace(/\//g, ""));
        if (det) return det;
      }

      // Pattern: ?asset=SYMBOL or ?symbol=SYMBOL
      const paramMatch = search.match(/[?&](?:asset|symbol|pair|instrument)=([A-Za-z0-9_\-]+)/i);
      if (paramMatch) {
        const det = ASSETS.detect(decodeURIComponent(paramMatch[1]));
        if (det) return det;
      }

      // Pattern: #ASSET_SYMBOL (hash routing)
      if (hash.length > 1) {
        const det = ASSETS.detect(hash.slice(1).replace(/\//g, ""));
        if (det) return det;
      }

      // Pattern: full URL contains asset name
      const det = ASSETS.detect(url);
      if (det) return det;
    } catch (_) {}
    return null;
  }

  /**
   * Extract the current symbol from TradingView chart widgets.
   * Quotex uses TradingView-style charts that store the symbol internally.
   */
  function detectAssetFromChartWidget() {
    try {
      // Method 1: Look for TradingView iframe and its data attributes
      const iframes = document.querySelectorAll("iframe");
      for (let i = 0; i < iframes.length && i < 5; i++) {
        const src = iframes[i].src || iframes[i].getAttribute("src") || "";
        if (/tradingview|chart/i.test(src)) {
          const symbolMatch = src.match(/symbol[=:]([A-Za-z0-9_:]+)/i);
          if (symbolMatch) {
            const det = ASSETS.detect(symbolMatch[1].replace(/:/g, "/"));
            if (det) return det;
          }
        }
      }

      // Method 2: Look for chart container data attributes
      const chartEls = document.querySelectorAll("[class*='chart'], [id*='chart'], [data-symbol], [data-asset]");
      for (let i = 0; i < chartEls.length && i < 10; i++) {
        const el = chartEls[i];
        const sym = el.getAttribute("data-symbol") || el.getAttribute("data-asset") ||
                    el.getAttribute("data-pair") || el.getAttribute("data-instrument") || "";
        if (sym && sym.length >= 3 && sym.length <= 30) {
          const det = ASSETS.detect(sym);
          if (det) return det;
        }
      }

      // Method 3: Look for symbol in chart title/legend elements
      const legendEls = document.querySelectorAll(
        "[class*='legend'] [class*='symbol'], [class*='chart-header'] span, " +
        "[class*='chart-title'], [class*='study-title'], [class*='series-title']"
      );
      for (let i = 0; i < legendEls.length && i < 10; i++) {
        const t = visibleText(legendEls[i]);
        if (t && t.length >= 3 && t.length <= 30) {
          const det = ASSETS.detect(t);
          if (det) return det;
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * v2.7.2: Check cached element first — avoids expensive full scans when
   * the asset label element is already known and still showing the same text.
   */
  function checkCachedAssetElement() {
    if (!cachedAssetElement || !cachedAssetElement.isConnected) {
      cachedAssetElement = null;
      return null;
    }
    const t = visibleText(cachedAssetElement);
    if (!t || t.length < 2 || t.length > 40) return null;
    const det = ASSETS.detect(t);
    if (!det) return null;
    // Verify OTC consistency
    const wantsOtc = /OTC|\(OT\)/i.test(t);
    const isOtc = /_otc$/i.test(det.id);
    if (wantsOtc !== isOtc) { cachedAssetElement = null; return null; }
    cachedAssetElementText = t;
    cachedAssetElementAt = Date.now();
    return det;
  }

  /**
   * v2.3 + v2.7.2 improvements: text-based fallback with improved scoring.
   * The modern Quotex UI ships hashed CSS-module class names, so selectors
   * miss it. Scans small leaf nodes for catalog matches with contextual
   * scoring: proximity to price/time elements, position, aria attributes.
   */
  function scanDomForAssetText(force) {
    const now = Date.now();
    if (!force && now - lastDomTextScan < 1500) return null; // 1.5s throttle
    lastDomTextScan = now;
    let best = null;
    let bestScore = -Infinity;
    const nodes = document.querySelectorAll("span, div, button, a, h1, h2, h3, td, p");
    const maxNodes = Math.min(nodes.length, 600); // reduced from 800
    for (let i = 0; i < maxNodes; i++) {
      const el = nodes[i];
      if (el.id === "qx-info-panel" || (el.closest && el.closest("#qx-info-panel"))) continue;
      if (el.closest && el.closest("[role='dialog'], [role='listbox'], [role='menu'], [class*='asset-list'], [class*='instruments-list'], [class*='modal']")) continue;
      if (el.children.length > 2) continue;
      if (!el.offsetParent && el.getClientRects().length === 0) continue;
      const t = visibleText(el);
      if (!t || t.length < 2 || t.length > 40) continue;
      if (/^[\d.,\s%+\-—:]+$/.test(t)) continue;
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
      // v2.7.2: proximity scoring — elements near the top of the page are
      // more likely to be the main chart header showing the current asset
      try {
        const r = el.getBoundingClientRect();
        if (r.top >= 0 && r.top < 120) score += 20;      // very top (header)
        else if (r.top >= 120 && r.top < 240) score += 12; // upper area
        else if (r.top > 400) score -= 15;                 // far down = less likely
        // v2.7.2: bonus for left-aligned elements (chart header is usually left)
        if (r.left >= 0 && r.left < 300) score += 8;
      } catch (_) {}
      // v2.7.2: bonus for elements near price displays (siblings/parent with price text)
      try {
        const parent = el.parentElement;
        if (parent && parent.children.length <= 8) {
          const parentText = visibleText(parent);
          if (parentText && /[\d.,]{3,}/.test(parentText) && /\d+\.\d+/.test(parentText)) {
            score += 15; // parent contains price-like text
          }
        }
      } catch (_) {}
      // v2.7.2: early termination for very high confidence matches
      if (score > 140) { best = det; bestScore = score; break; }
      if (score > bestScore) { bestScore = score; best = det; }
    }
    // Cache the winning element for fast subsequent checks
    if (best && bestScore > 0) {
      // Find the actual element that matched (re-scan briefly)
      for (let i = 0; i < maxNodes; i++) {
        const el = nodes[i];
        if (!el.offsetParent && el.getClientRects().length === 0) continue;
        const t = visibleText(el);
        if (t && ASSETS.detect(t) === best) {
          cachedAssetElement = el;
          cachedAssetElementText = t;
          cachedAssetElementAt = Date.now();
          break;
        }
      }
    }
    return best;
  }

  function detectAssetFromDom(force) {
    const now = Date.now();
    if (!force && now - lastDomAssetScan < 1500) return lastDomAssetResult;
    lastDomAssetScan = now;
    let found = null;

    // v2.7.2: Priority 1 — check MutationObserver result (instant)
    if (assetMutationDetected && now - assetMutationAt < 3000) {
      found = assetMutationDetected;
      assetMutationDetected = null;
    }

    // v2.7.2: Priority 2 — check cached element (instant, ~0ms)
    if (!found) found = checkCachedAssetElement();

    // Priority 3: the adapter's canonical DOM helpers.
    if (!found && QUOTEX && QUOTEX.findAssetHeader) {
      const h = QUOTEX.findAssetHeader();
      if (h && h.text) found = assetFromText(h.text);
    }

    // v2.7.2: Priority 4 — URL pattern extraction (fast, ~0ms)
    if (!found) found = detectAssetFromUrl();

    // v2.7.2: Priority 5 — TradingView chart widget (fast, ~1ms)
    if (!found) found = detectAssetFromChartWidget();

    // Priority 6: CSS selector scan
    if (!found) {
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
        for (let ei = 0; ei < els.length && ei < 50; ei++) {
          const t = visibleText(els[ei]);
          if (t && t.length >= 2 && t.length < 48) {
            found = assetFromText(t);
            if (found) {
              // Cache this element for fast subsequent checks
              cachedAssetElement = els[ei];
              cachedAssetElementText = t;
              cachedAssetElementAt = Date.now();
              break;
            }
          }
        }
      }
    }

    // Priority 7: Hashed-class text scan (slowest, throttled)
    if (!found) found = scanDomForAssetText(true);

    // Priority 8: page title and URL
    if (!found) found = ASSETS.detect(document.title);
    if (!found) found = ASSETS.detect(location.href);

    // Priority 9: WebSocket symbol (authoritative)
    if (!found && lastWsSymbol) found = assetFromText(lastWsSymbol);

    // v2.7.2: set up MutationObserver on first successful detection
    if (found && !assetMutationObserver) setupAssetMutationObserver();

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
    // v2.7.1: upper bound prevents a stale tick from settling a trade hours
    // after expiry. Allow 2x the expiry duration or 10 minutes, whichever is
    // larger, to tolerate broker delays but reject ancient ticks.
    const maxSettlementWindow = Math.max(p && p.expiryMinutes ? p.expiryMinutes * 120000 : 600000, 600000);
    if (!p || !Number.isFinite(close) || close <= 0 || close > 1e12 ||
        !Number.isSafeInteger(time) || time < p.expireAt || time > p.expireAt + maxSettlementWindow ||
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

  /** Per-strategy win rate (percent) from settled outcomes — historical
   * (restored from storage) and live (this session) combined, because
   * applyStoredStats() merges stored rows into stats.byStrategy and every
   * settled trade bumps the same map.
   *
   * The adaptive router's fitness function has always had a `strategyWinrates`
   * term, but nothing ever supplied it, so that term was permanently zero and
   * the router picked purely on the current bar's regime + confidence —
   * realtime data only. This is the missing input.
   *
   * Small samples are shrunk toward 50% (a Beta(5,5) prior) so one lucky trade
   * cannot make a strategy look unbeatable, and strategies with fewer than
   * `minSettled` decided trades are omitted rather than guessed at. Draws are
   * excluded: a refunded trade is not an outcome. */
  function strategyWinrates(minSettled) {
    const out = Object.create(null);
    const src = stats.byStrategy;
    if (!src || typeof src !== "object") return out;
    const rawFloor = Number(minSettled);
    const floor = Number.isFinite(rawFloor) && rawFloor > 0 ? Math.floor(rawFloor) : 10;
    const PRIOR = 10; // pseudo-observations at 50%
    for (const id of Object.keys(src)) {
      const row = src[id];
      if (!row || typeof row !== "object") continue;
      const w = Math.max(0, Math.floor(Number(row.w) || 0));
      const l = Math.max(0, Math.floor(Number(row.l) || 0));
      const settled = w + l;
      if (settled < floor) continue;
      const wr = ((w + PRIOR * 0.5) / (settled + PRIOR)) * 100;
      if (Number.isFinite(wr)) out[String(id).slice(0, 64)] = Math.round(wr * 10) / 10;
    }
    return out;
  }

  /** v2.8: expiry winrates per minute bucket for dynamic expiry learning */
  function expiryWinrates(minSettled) {
    const out = Object.create(null);
    const history = stats.history;
    if (!Array.isArray(history) || !history.length) return out;
    const floor = Number.isFinite(Number(minSettled)) && Number(minSettled) > 0 ? Math.floor(Number(minSettled)) : 8;
    const buckets = Object.create(null);
    for (const h of history) {
      if (!h || h.draw) continue;
      const exp = Number(h.expiryMinutes);
      if (!Number.isFinite(exp) || exp < 0.5 || exp > 1440) continue;
      const key = String(Math.round(exp * 2) / 2); // 0.5 steps
      if (!buckets[key]) buckets[key] = { w: 0, l: 0 };
      if (h.won === true) buckets[key].w++;
      else if (h.won === false) buckets[key].l++;
    }
    const PRIOR = 6;
    for (const k of Object.keys(buckets)) {
      const row = buckets[k];
      const settled = row.w + row.l;
      if (settled < floor) continue;
      const wr = ((row.w + PRIOR * 0.5) / (settled + PRIOR)) * 100;
      if (Number.isFinite(wr)) out[k] = Math.round(wr * 10) / 10;
    }
    return out;
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
        source: _SRC_OUT,
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
          const armBtn = document.getElementById("qxp-arm");
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
        // v2.7.6: live candle cache for the autoHighAccuracy gate
        get candlesByAsset() { return liveCandlesByAsset; },
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

    // v2.6.10: a balance event may have arrived before the controller
    // existed; push the detected account immediately so the account gate
    // and percent staking work from the first armed signal.
    syncAutoAccount();
      autoController.setMode(s.autoMode || "off");
      autoController.setArmed(isPrimaryContext && !!s.armed);
    }
    replayClosedOrders();
    const armBtn = document.getElementById("qxp-arm");
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
    const periodMs = p * 1000;
    const byPeriod = chartHistory[assetId] || (chartHistory[assetId] = Object.create(null));
    const prev = byPeriod[p] && Array.isArray(byPeriod[p].candles) ? byPeriod[p].candles : [];
    const map = Object.create(null);
    for (const c of prev) {
      if (!c || !Number.isFinite(Number(c.time))) continue;
      const t = brokerBucket(Number(c.time), periodMs);
      map[t] = Object.assign({}, c, { time: t });
    }
    for (const c of incoming || []) {
      if (!c || !Number.isFinite(Number(c.time))) continue;
      const t = brokerBucket(Number(c.time), periodMs);
      map[t] = Object.assign({}, c, { time: t });
    }
    const times = Object.keys(map).map(Number).sort((a, b) => a - b).slice(-400);
    const merged = times.map((t) => map[t]);
    byPeriod[p] = { period: p, candles: merged, ts: Date.now() };
    return byPeriod[p];
  }

  function synthesizeFrom1m(assetId, targetPeriod) {
    // Synthesize higher timeframe candles from 1m data when broker hasn't sent that TF yet
    if (!assetId || targetPeriod <= 60) return null;
    const byPeriod = chartHistory[assetId];
    if (!byPeriod) return null;
    const oneM = byPeriod[60];
    if (!oneM || !Array.isArray(oneM.candles) || oneM.candles.length < targetPeriod/60) return null;
    if (!self.CYBER_TA || typeof self.CYBER_TA.resample !== "function") return null;
    try {
      const minutes = Math.max(1, Math.round(targetPeriod / 60));
      const resampled = self.CYBER_TA.resample(oneM.candles, minutes);
      if (resampled && resampled.length) {
        return { period: targetPeriod, candles: resampled, ts: Date.now(), synthesized: true };
      }
    } catch (_) {}
    return null;
  }

  function chartForActiveAsset() {
    const periods = chartHistory[activeAsset];
    if (!periods) {
      // Try synthesize from 1m if we have it
      const synth = synthesizeFrom1m(activeAsset, lastWsPeriod);
      if (synth) return synth;
      return null;
    }
    let selected = null;
    if (periods[lastWsPeriod] && periods[lastWsPeriod].candles.length) selected = periods[lastWsPeriod];
    // v2.7.1: fall back to the most recent period's data if the requested
    // period hasn't arrived yet. Previously returned null, which made the
    // dashboard chart go blank until the user scrolled to trigger a history
    // batch. Now shows whatever data is available while waiting.
    if (!selected) {
      for (const p in periods) {
        const item = periods[p];
        if (item && item.candles && item.candles.length && (!selected || item.ts > selected.ts)) selected = item;
      }
    }
    // v2.8.1: if still no data, try synthesizing from 1m
    if (!selected) {
      const synth = synthesizeFrom1m(activeAsset, lastWsPeriod);
      if (synth) return synth;
    }
    if (!selected) return null;

    // Quotex re-sends history only occasionally, while the 1m feed receives
    // every live tick. Built from history batches alone, the dashboard chart
    // froze at the last response while the platform kept drawing the forming
    // candle — the newest bar (and every bar after it) then disagreed with
    // the broker chart. Extend the series with the live bar only: closed
    // buckets stay exactly as the broker sent them, because those are the
    // candles the dashboard is compared against.
    const period = Number(selected.period);
    // Never overlay resampled synthetic warm-up bars on genuine broker
    // history. Until a real 1m batch arrives, those two series can have
    // different price levels and create a fake final spike.
    if (historySeeded[activeAsset] && period >= 60 && period % 60 === 0 &&
        self.CYBER_TA && typeof self.CYBER_TA.resample === "function") {
      const minutes = Math.max(1, Math.round(period / 60));
      const live = self.CYBER_TA.resample(activeFeed.series(), minutes);
      const merged = overlayLiveBar(selected.candles, live.length ? live[live.length - 1] : null);
      if (merged !== selected.candles) {
        return { period, candles: merged, ts: Date.now() };
      }
    }
    return selected;
  }

  /**
   * Extend a broker candle series with the locally forming bar. Historical
   * buckets are never rewritten — resampled tick bars differ from the
   * broker's own candles (missed ticks, bid/ask), and overwriting them is
   * exactly what made the dashboard disagree with the platform chart. Only
   * append a new bucket if the live bar is newer than the broker's last candle.
   */
  function overlayLiveBar(bars, liveBar) {
    if (!Array.isArray(bars) || !bars.length) return bars;
    const liveTime = Number(liveBar && liveBar.time);
    if (!Number.isSafeInteger(liveTime) || liveTime <= 0) return bars;
    const lastIdx = bars.length - 1;
    const lastTime = Number(bars[lastIdx] && bars[lastIdx].time);
    if (!Number.isSafeInteger(lastTime)) return bars;
    if (liveTime < lastTime) return bars;
    if (liveTime === lastTime) {
      // Same bucket: merge live aggregation into broker's forming candle.
      // The broker history for the forming bar is stale between WS updates;
      // our resampled 1m live bar has fresher high/low/close from ticks.
      const last = bars[lastIdx];
      if (!last || typeof last !== "object") return bars;
      const merged = Object.assign({}, last, {
        high: Math.max(Number(last.high) || 0, Number(liveBar.high) || 0),
        low: Math.min(Number(last.low) || Number.MAX_VALUE, Number(liveBar.low) || Number.MAX_VALUE),
        close: Number.isFinite(Number(liveBar.close)) ? Number(liveBar.close) : last.close,
        volume: Math.max(Number(last.volume) || 0, Number(liveBar.volume) || 0),
      });
      // Guard low against NaN when both are 0
      if (!Number.isFinite(merged.low) || merged.low <= 0) merged.low = Math.min(last.low, liveBar.low);
      const out = bars.slice();
      out[lastIdx] = merged;
      return out;
    }
    return bars.concat([liveBar]);
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

  function ingestLiveCandles(asset, period, candles, verified) {
    if (!asset || !Array.isArray(candles) || !candles.length) return;
    const det = typeof asset === "string" && asset.length <= 80 ? ASSETS.ensureRegistered(asset) : null;
    if (!det) return;
    const id = det.id;
    const feed = createFeedFor(id);
    const rawPeriod = Number(period);
    const safePeriod = Number.isFinite(rawPeriod) && rawPeriod > 0 ? Math.min(86400, Math.floor(rawPeriod)) : 60;
    const periodMs = safePeriod * 1000;
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
      let time = Math.abs(rawTime) >= 1e14 ? Math.floor(rawTime / 1000)
        : Math.abs(rawTime) >= 1e11 ? Math.floor(rawTime) : Math.floor(rawTime * 1000);
      // Bucket to period boundary to match Quotex UTC alignment.
      // Broker candles are already aligned, but flooring ensures ticks and
      // history share the same slot even if ms offsets appear.
      time = brokerBucket(time, periodMs);
      const brokerNowEst = getBrokerNow();
      if (![time, open, close, rawHigh, rawLow].every(Number.isFinite) ||
          time < 946684800000 || time > brokerNowEst + 86400000 ||
          time > Date.now() + 2 * 86400000 ||
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
    // Update broker clock from newest candle (open + period = approx now)
    const newestTime = real[real.length - 1].time;
    updateBrokerClock(newestTime + periodMs);

    // The engine runs on 1m bars; accept 60s history directly and build 1m
    // from ticks for everything else (the chart shows the broker timeframe).
    // v2.6.6: the batch must ALSO be trusted. Symbol-verified batches (or
    // chart-library data) may seed/extend the engine feed. Batches that were
    // attributed to this asset by fallback can never seed it, and can extend
    // it only when their price scale matches — candles from a different
    // asset must never reach the signal computation.
    const seriesForScale = feed.series();
    const scaleRef = seriesForScale.length ? seriesForScale[seriesForScale.length - 1].close : null;
    const trust = self.CYBER_ENGINE.historyTrustDecision({
      verified: verified === true,
      historySeeded: !!historySeeded[id],
      feedClose: scaleRef,
      batchClose: real[real.length - 1].close,
    });
    if (!trust.engine && safePeriod === 60) {
      if (!ingestTrustLog[id] || Date.now() - ingestTrustLog[id] > 60000) {
        ingestTrustLog[id] = Date.now();
        try { console.warn("candle batch for " + id + " kept for display only: " + trust.reason); } catch (_) {}
      }
    }
    const useForEngine = safePeriod === 60 && trust.engine;
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
    if (useForEngine) realBarCount[id] = feed.series().length;
    if (useForEngine && feed.series().length >= 2) persistLiveCandles(id, true);
    // v2.7.6: reduced from 40 to 20 bars. 40 was excessive — the engine needs
    // ~50 bars for indicators to warm up (handled by minBars in analyze()),
    // but realHistoryReady gates auto-trade EXECUTION, not signal generation.
    // Signals already require 40+ candles internally; this gate just confirms
    // the feed has genuine broker data. 20 bars is enough to confirm the
    // asset is receiving real data while not blocking auto-trade for 40+
    // minutes after an asset switch.
    if (useForEngine && feed.series().length >= 20) realHistoryReady[id] = true;
    const newestRealTime = real[real.length - 1].time;
    // Use broker clock for freshness check — Date.now() may be off by minutes.
    const brokerNowForCheck = getBrokerNow();
    if (useForEngine && newestRealTime >= brokerNowForCheck - 2 * TF_MS && newestRealTime <= brokerNowForCheck + 86400000) {
      lastAcceptedQuoteAt[id] = Date.now();
    }
    // Track data quality and pagination with enhanced logic
    try {
      // Detect gaps in incoming batch
      let gapsInBatch = [];
      let continuity = 1;
      try {
        if (QUOTEX && QUOTEX.detectGaps && real.length >= 2) {
          gapsInBatch = QUOTEX.detectGaps(real, safePeriod);
          if (gapsInBatch.length) {
            const totalMissing = gapsInBatch.reduce((s,g)=>s+(g.missing||0),0);
            continuity = Math.max(0, 1 - totalMissing / real.length);
          }
        }
      } catch (_) {}

      updateDataQuality(id, feed.series().length, true, {
        gaps: gapsInBatch.length,
        gapList: gapsInBatch,
        continuity: continuity
      });

      const key = historyKey(id, safePeriod);
      if (!historyPagination[key]) {
        historyPagination[key] = { totalReceived: 0, lastOffset: 0, hasMore: true, attempts: 0, lastError: 0, gaps: [] };
      }
      const pag = historyPagination[key];
      pag.totalReceived += real.length;
      pag.attempts = 0; // reset on success
      if (gapsInBatch.length) pag.gaps = gapsInBatch.slice(0, 5);

      // Smart pagination: continue if we got a full batch or close to limit
      const receivedFullBatch = real.length >= 900;
      const isPaginated = safePeriod === 60 && pag.hasMore;
      if (receivedFullBatch && isPaginated) {
        const nextOffset = pag.lastOffset + real.length;
        if (nextOffset < 15000) {
          pag.lastOffset = nextOffset;
          // Use small jitter to avoid thundering herd
          const delay = 400 + Math.random() * 600;
          setTimeout(function() {
            try {
              // For active asset, continue pagination aggressively; for background, slower
              const isActive = id === activeAsset;
              const limit = isActive ? 5000 : 2000;
              requestPeriodHistory(id, safePeriod, true, limit, nextOffset);
            } catch (_) {}
          }, delay);
        } else {
          pag.hasMore = false;
        }
      } else {
        // If we got less than full batch, likely no more history
        if (real.length < 900) pag.hasMore = false;
      }

      // If gaps detected in active asset, trigger gap fill
      if (id === activeAsset && gapsInBatch.length > 0 && gapsInBatch.length <= 5) {
        setTimeout(function(){
          try { requestGapFill(id, safePeriod); } catch (_) {}
        }, 1000);
      }
    } catch (_) {}
    // Merge incremental batches instead of replacing the dashboard series
    // with whichever partial history response arrived last. Histories from
    // other open/mini charts are retained per asset+period but NEVER select
    // the active chart.
    mergeChartCandles(id, safePeriod, real);
    // v2.7.6: populate the live candle cache for the autoHighAccuracy gate.
    // Only store 1m bars (the engine's timeframe) — higher timeframes are
    // chart-only and would confuse the asset evaluator.
    if (safePeriod === 60 && useForEngine) {
      liveCandlesByAsset[id] = feed.series().slice(-500);
    }
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

  /** v2.6.9: push the detected account (demo/live + balance) into the
   * auto-trade controller so the account-mode gate and percent staking use
   * live broker facts, never assumptions. */
  function syncAutoAccount() {
    if (!autoController || typeof autoController.setAccountInfo !== "function" || !lastBalance) return;
    try {
      autoController.setAccountInfo({
        isDemo: typeof lastBalance.isDemo === "boolean" ? lastBalance.isDemo : null,
        balance: Number(lastBalance.balance),
        currency: lastBalance.currency,
      });
    } catch (_) {}
  }

  function normalizeBalance(value) {
    return QUOTEX && typeof QUOTEX.parseBalance === "function" ? QUOTEX.parseBalance(value) : null;
  }

  function confirmationLifecycle(data) {
    const receivedAt = getBrokerNow();
    const rawOpen = Number(data && data.openTime);
    const openTime = Number.isSafeInteger(rawOpen) && rawOpen >= receivedAt - 86400000 && rawOpen <= receivedAt + 86400000
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
    const now = getBrokerNow();
    const closeTime = Number(data.closeTime);
    const currentDate = new Date(now);
    const dayStart = Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), currentDate.getUTCDate());
    if (fromSnapshot && !Number.isSafeInteger(closeTime)) return false;
    // v2.6.13: the close-time upper bound must tolerate broker-server clock
    // skew, like every other broker-timestamp check. The old +5-minute bound
    // silently rejected real closes whenever the server clock ran ahead, so
    // losses never reached the daily-loss cap — the safety ledger disarmed
    // itself on a skewed clock. 24h still rejects unit-mixup garbage.
    if (Number.isSafeInteger(closeTime) && (closeTime < dayStart || closeTime > now + 86400000)) return false;
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

  function addOpenOrder(data) {
    if (!data) return;
    const id = String(data.id || data.requestId || "").trim().slice(0, 128);
    if (!id) return;
    // Don't add if already closed
    if (settledOrderIds[id]) return;
    const key = id;
    const now = getBrokerNow();
    const openTime = Number(data.openTime) || now;
    let expiryTime = Number(data.expiryTime || data.closeTime);
    if (!Number.isSafeInteger(expiryTime) || expiryTime <= openTime) {
      const dur = Number(data.duration);
      if (Number.isFinite(dur) && dur > 0) expiryTime = openTime + dur * 1000;
      else expiryTime = openTime + 180000; // fallback 3m
    }
    openOrders[key] = {
      id,
      requestId: data.requestId ? String(data.requestId).slice(0,128) : null,
      asset: data.asset || "",
      dir: data.direction || data.dir || "",
      direction: data.direction || data.dir || "",
      amount: Number(data.amount) || 0,
      openPrice: Number(data.openPrice) || 0,
      openTime,
      expiryTime,
      closeTime: expiryTime,
      duration: Math.max(0, Math.round((expiryTime - openTime)/1000)),
      status: "OPEN",
      raw: data,
    };
    if (openOrdersQueue.indexOf(key) === -1) openOrdersQueue.push(key);
    while (openOrdersQueue.length > 50) {
      const oldKey = openOrdersQueue.shift();
      if (oldKey && openOrders[oldKey]) delete openOrders[oldKey];
    }
  }

  function removeOpenOrder(data) {
    if (!data) return;
    const id = String(data.id || data.requestId || "").trim().slice(0, 128);
    if (id && openOrders[id]) {
      delete openOrders[id];
      const idx = openOrdersQueue.indexOf(id);
      if (idx >= 0) openOrdersQueue.splice(idx, 1);
      return;
    }
    // Try to match by asset+times if id missing
    const asset = data.asset ? String(data.asset) : "";
    const openT = Number(data.openTime);
    for (const k of Object.keys(openOrders)) {
      const o = openOrders[k];
      if (!o) continue;
      if (asset && o.asset && o.asset !== asset) continue;
      if (Number.isSafeInteger(openT) && Math.abs(o.openTime - openT) > 5000) continue;
      delete openOrders[k];
      const idx = openOrdersQueue.indexOf(k);
      if (idx >= 0) openOrdersQueue.splice(idx, 1);
      break;
    }
  }

  function cleanupExpiredOpenOrders() {
    const now = getBrokerNow();
    for (const k of Object.keys(openOrders)) {
      const o = openOrders[k];
      if (!o) continue;
      // If expiry passed + 2min grace, remove (broker should have sent close)
      if (o.expiryTime && now > o.expiryTime + 120000) {
        delete openOrders[k];
        const idx = openOrdersQueue.indexOf(k);
        if (idx >= 0) openOrdersQueue.splice(idx, 1);
      }
    }
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
      syncAutoAccount();
    }
    if (Array.isArray(snap.orders)) {
      lastOrders = snap.orders.map(normalizeOrderEvent).filter(Boolean).slice(0, 50);
      // Rebuild open orders from snapshot: opened without matching closed
      try {
        // Clear and rebuild
        for (const k of Object.keys(openOrders)) delete openOrders[k];
        openOrdersQueue.length = 0;
        const closedIds = new Set();
        for (const o of lastOrders) {
          if (o.kind === "closed" && o.data) {
            const cid = String(o.data.id || o.data.requestId || "").trim();
            if (cid) closedIds.add(cid);
          }
        }
        for (const o of lastOrders) {
          if (o.kind === "opened" && o.data) {
            const oid = String(o.data.id || o.data.requestId || "").trim();
            if (oid && !closedIds.has(oid)) addOpenOrder(o.data);
          }
        }
      } catch (_) {}
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
        Number.isSafeInteger(selectedTime) && Math.abs(Date.now() - selectedTime) <= 120000) {
      lastWsPrice = selectedPrice;
      lastWsTickAt = Date.now();
    }
    if (lastWsSymbol) {
      const det = ASSETS.ensureRegistered(lastWsSymbol);
      if (det) activateAsset(det.id);
    }
    const candlesMap = snap.candles && typeof snap.candles === "object" && !Array.isArray(snap.candles)
      ? snap.candles : {};
    const candlesVerified = snap.candlesVerified && typeof snap.candlesVerified === "object" && !Array.isArray(snap.candlesVerified)
      ? snap.candlesVerified : {};
    const candleKeys = Object.keys(candlesMap).slice(0, 50);
    for (const key of candleKeys) {
      const m = key.match(/^(.{1,80})@(\d{1,6})$/);
      if (!m) continue;
      const list = candlesMap[key];
      const period = Number(m[2]);
      if (Array.isArray(list) && list.length && period >= 1 && period <= 86400) {
        ingestLiveCandles(m[1], period, list, candlesVerified[key] === true);
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
    if (full.length > 1 && activeFeed.hasCurrent && activeFeed.hasCurrent()) a = full.slice(0, -1);
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
        // The adaptive router's fitness function reads this, but nothing ever
        // supplied it — so historical/live accuracy never influenced which
        // strategy got picked. Only the router consumes it.
        strategyWinrates: currentStrategy === "auto_adaptive" ? strategyWinrates() : null,
        expiryWinrates: expiryWinrates(),
        adaptiveExpiryMin: runtimeSettings && runtimeSettings.adaptiveExpiryMin,
        adaptiveExpiryMax: runtimeSettings && runtimeSettings.adaptiveExpiryMax,
      });
      sig.asset = asset ? asset.id : activeAsset;
      sig.assetName = asset ? asset.name : activeAsset;
      // `strategy` is what the USER selected; `selectedStrategy` is what
      // actually produced the signal. Under auto_adaptive those differ, and
      // it is the second one that must reach every display and log.
      sig.strategy = currentStrategy;
      const resolvedId = resolveSignalStrategyId(sig);
      sig.selectedStrategy = resolvedId;
      sig.selectedStrategyLabel = strategyLabelFor(resolvedId, sig.selectedStrategyLabel);
      // v2.6.6: live-data gate. Until the feed holds genuine broker history
      // for THIS asset, any CALL/PUT the engine computes is derived partly
      // from the synthetic warm-up seed — a false signal. Hold WAIT, show the
      // honest reason, and never attach a marker for it. Trade execution and
      // auto-trading were already blocked on realHistoryReady; this closes
      // the display/marker path so no synthetic-derived signal is ever shown.
      const liveGate = self.CYBER_ENGINE.liveSignalGate({
        historySeeded: !!historySeeded[activeAsset],
        realBars: realBarCount[activeAsset] || 0,
      });
      if (!liveGate.allowed) {
        if (sig.direction !== "WAIT") {
          sig.gateReason = "live-data";
          sig.direction = "WAIT";
          sig.ready = false;
        }
        sig.reason = liveGate.reason;
      }
      // Noise/session safety: do not manufacture a CALL/PUT during a
      // direction-flipping chop. Session is derived from the broker candle
      // clock (UTC), not the dashboard machine clock.
      const session = marketSession(closed && closed.time, activeAsset);
      const noise = noiseProfileFor(a);
      const noiseCall = sig.direction !== "WAIT" ? noiseDecision(noise, session) : { blocked: false, reason: "" };
      if (noiseCall.blocked) {
        sig.gateReason = "noise-filter";
        sig.direction = "WAIT";
        sig.ready = false;
        sig.confidence = 0;
        sig.reason = noiseCall.reason;
      }
      sig.session = session;
      sig.noiseScore = noise.ready ? noise.score : 0;
      sig.noise = {
        score: noise.ready ? noise.score : 0,
        flip: noise.flip,
        efficiency: noise.efficiency,
        wick: noise.wick,
        chop: noise.chop,
        bars: noise.bars,
        ready: noise.ready,
      };
      sig.engineTimeframeSec = ENGINE_TIMEFRAME_SEC;
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
    const brokerNowCheck = getBrokerNow();
    const liveClosedBar = Number.isFinite(closedAt) && closedAt <= brokerNowCheck + TF_MS &&
      brokerNowCheck - closedAt <= 10 * TF_MS;
    if (isPrimaryContext && authoritativeMain && realHistoryReady[activeAsset] && liveClosedBar &&
        sig && sig.ready && sig.direction !== "WAIT" && closed && a.length >= 2 && !pendingByAsset[activeAsset]) {
      const key = String(closed.time);
      if (key !== lastVirtualBarByAsset[activeAsset]) {
        // One virtual lifecycle per asset/bar even if strategy changes or the
        // user switches away and back before the next candle closes.
        lastVirtualBarByAsset[activeAsset] = key;
        // v2.8: dynamic expiry for accuracy
        let expiryMinutes;
        if (runtimeSettings && runtimeSettings.expiryMode === "adaptive" && sig && sig.suggestedExpiry) {
          const dyn = Number(sig.suggestedExpiry);
          if (Number.isFinite(dyn) && dyn >= 0.5 && dyn <= 1440) {
            const minB = Number(runtimeSettings.adaptiveExpiryMin);
            const maxB = Number(runtimeSettings.adaptiveExpiryMax);
            const clampedMin = Number.isFinite(minB) ? Math.max(0.5, minB) : 0.5;
            const clampedMax = Number.isFinite(maxB) ? Math.min(1440, maxB) : 1440;
            expiryMinutes = Math.max(Math.min(clampedMin, clampedMax), Math.min(Math.max(clampedMin, clampedMax), dyn));
          } else {
            expiryMinutes = Math.max(0.5, Math.min(1440, Number(runtimeSettings && runtimeSettings.expiry) || 3));
          }
        } else {
          expiryMinutes = Math.max(0.5, Math.min(1440, Number(runtimeSettings && runtimeSettings.expiry) || 3));
        }
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
          // Under auto_adaptive, currentStrategy is the literal "auto_adaptive",
          // so every adaptive outcome was bucketed under that one key and the
          // strategy the router actually chose never accumulated a record.
          // Attribute the outcome to the selected strategy so its win rate can
          // feed the next routing decision.
          strategy: resolveSignalStrategyId(sig),
          strategyLabel: strategyLabelFor(resolveSignalStrategyId(sig), sig.selectedStrategyLabel),
          routedBy: currentStrategy,
          payout,
        };
      }
    }

    paintHud(sig);
    queueStatePush(sig);

    // A signal is handed to auto once per closed bar and only by the browser
    // tab selected as primary in background.js. Other open Quotex charts can
    // collect data, but can never place duplicate trades.
    // v2.7.6: relaxed the authoritativeMain gate — when manualAsset is set
    // (dashboard-initiated switch), the WebSocket symbol may lag behind the
    // active asset by a few seconds. Requiring exact match blocked auto-trade
    // during the entire transition. Accept the signal when the feed has real
    // data for the active asset regardless of the WS symbol lag.
    const autoAuthoritative = authoritativeMain ||
      (manualAsset && lastWsSymbol && QUOTEX && realHistoryReady[activeAsset]);
    if (isPrimaryContext && autoAuthoritative && realHistoryReady[activeAsset] && liveClosedBar &&
        autoController && sig && sig.ready && sig.direction !== "WAIT") {
      const autoKey = String(sig.time || 0);
      if (autoKey !== lastAutoBarByAsset[sig.asset]) {
        lastAutoBarByAsset[sig.asset] = autoKey;
        try { autoController.handleSignal(sig); } catch (_) {}
      }
    } else if (isPrimaryContext && autoController && sig && sig.ready &&
               sig.direction !== "WAIT" && !autoAuthoritative) {
      // v2.7.6: log why auto-trade was skipped so users can debug
      const reason = !realHistoryReady[activeAsset]
        ? "waiting for broker history (need 20+ real candles)"
        : !liveClosedBar
          ? "no recently closed bar"
          : "chart asset not confirmed";
      if (Date.now() - (lastAutoSkipLog || 0) > 30000) {
        lastAutoSkipLog = Date.now();
        try {
          window.postMessage({
            source: _SRC_OUT,
            kind: "auto_log",
            payload: { level: "skip", msg: `Auto-trade skipped: ${reason}`, at: Date.now() },
          }, "*");
        } catch (_) {}
      }
    }
  }

  function stateFingerprint(sig) {
    const chart = chartForActiveAsset();
    const pending = pendingByAsset[activeAsset];
    const latestOrder = lastOrders[0] && lastOrders[0].data || {};
    const openCount = Object.keys(openOrders).length;
    const openFingerprint = openOrdersQueue.slice(-5).join(",");
    const dq = dataQuality[activeAsset];
    const dqFp = dq ? [dq.candleCount, dq.qualityScore, dq.gaps, dq.lastUpdate].join(",") : "";
    const clockStats = getBrokerClockStats ? getBrokerClockStats() : null;
    const clockFp = clockStats ? clockStats.skewSec : "";
    return [
      activeAsset, activeFeed.lastPrice(), cachedAnalysisKey,
      sig && sig.direction, sig && sig.confidence,
      stats.wins, stats.losses, stats.history.length,
      pending && pending.expireAt, isPrimaryContext, wsQuoteMatchesActive(),
      chart && chart.ts, chart && chart.candles && chart.candles.length,
      lastQuotexStatus && lastQuotexStatus.state,
      lastBalance && lastBalance.balance, lastInstruments.length,
      lastOrders.length, latestOrder.id || latestOrder.requestId || "",
      openCount, openFingerprint, dqFp, clockFp
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
    try { cleanupExpiredOpenOrders(); } catch (_) {}
    const total = stats.wins + stats.losses;
    const chart = chartForActiveAsset();
    const feedSeries = activeFeed.series().slice(-220);
    // Display only candles matching the broker's currently selected period.
    // Do not substitute the 1m engine feed while a new timeframe is loading.
    const chartSeries = (chart && Array.isArray(chart.candles) && chart.candles.length)
      ? chart.candles.slice(-220)
      : [];
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
      chartTimeBasis: "broker-utc",
      engineTimeframeSec: ENGINE_TIMEFRAME_SEC,
      session: latestStateSignal && latestStateSignal.session ? latestStateSignal.session : marketSession(Date.now(), activeAsset),
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
      // `strategy` = the user's selection (drives the dropdown).
      // `selectedStrategy`/`selectedStrategyLabel` = the strategy that actually
      // produced this signal, which under auto_adaptive is a concrete preset.
      strategy: currentStrategy,
      selectedStrategy: resolveSignalStrategyId(sig),
      selectedStrategyLabel: strategyLabelFor(resolveSignalStrategyId(sig), sig && sig.selectedStrategyLabel),
      markers: markerStore ? markerStore.list(activeAsset) : [],
      ts: Date.now(),
      quotex: {
        status: lastQuotexStatus,
        balance: lastBalance,
        instrumentsCount: lastInstruments.length,
        activeSymbol: lastWsSymbol || activeAsset,
        activePeriod: lastWsPeriod,
        lastOrders: lastOrders.slice(0, 10),
        openOrders: Object.values(openOrders).slice(0, 20),
        dataQuality: dataQuality[activeAsset] || null,
        allDataQuality: Object.keys(dataQuality).length,
        dataQualityMap: (function(){
          try {
            const out = {};
            let count = 0;
            for (const k in dataQuality) {
              if (Object.prototype.hasOwnProperty.call(dataQuality, k) && count < 30) {
                out[k] = dataQuality[k];
                count++;
              }
            }
            return out;
          } catch (_) { return {}; }
        })(),
        pagination: (function(){
          try {
            const out = {};
            let count = 0;
            for (const k in historyPagination) {
              if (Object.prototype.hasOwnProperty.call(historyPagination, k) && count < 20) {
                out[k] = historyPagination[k];
                count++;
              }
            }
            return out;
          } catch (_) { return {}; }
        })(),
        clockStats: getBrokerClockStats ? getBrokerClockStats() : null,
        liveCandlesCount: Object.keys(liveCandlesByAsset).length,
        chartHistoryKeys: (function(){
          try {
            const keys = [];
            for (const aid in chartHistory) {
              if (!Object.prototype.hasOwnProperty.call(chartHistory, aid)) continue;
              for (const per in chartHistory[aid]) {
                if (Object.prototype.hasOwnProperty.call(chartHistory[aid], per)) {
                  keys.push(aid + "@" + per);
                }
              }
            }
            return keys.slice(0, 50);
          } catch (_) { return []; }
        })(),
      },
    };
    try { chrome.runtime.sendMessage({ type: "CYBER_STATE", payload }).catch(() => {}); } catch (_) {}
  }

  function ensureHud() {
    let el = document.getElementById("qx-info-panel");
    if (el) return el;
    el = document.createElement("div");
    el.id = "qx-info-panel";
    el.innerHTML =
      '<div class="qxp-title">SIGNAL</div>' +
      '<div class="qxp-asset" id="qxp-asset">—</div>' +
      '<div class="qxp-dir">SCAN</div>' +
      '<div class="qxp-meta">Waiting for ticks…</div>' +
      '<div class="qxp-row">' +
        '<button type="button" class="qxp-btn" id="qxp-arm">ARM</button>' +
        '<button type="button" class="qxp-btn ghost" id="qxp-dash">Dashboard</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(el);
    el.querySelector("#qxp-dash").addEventListener("click", function () {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
    });
    el.querySelector("#qxp-arm").addEventListener("click", function () {
      const btn = el.querySelector("#qxp-arm");
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
    const modeTag = lastBalance && lastBalance.isDemo === false ? " LIVE" : (lastBalance && lastBalance.isDemo === true ? " DEMO" : "");
    const bal = Number.isFinite(balanceNumber) ? "\u00b7 bal " + balanceNumber.toFixed(2) + modeTag : "";
    // Name the strategy that produced this signal. Under auto_adaptive the
    // HUD used to show nothing at all, so a trader could not tell which
    // strategy the router had picked for the bar in front of them.
    const stratLabel = sig
      ? strategyLabelFor(resolveSignalStrategyId(sig), sig.selectedStrategyLabel)
      : strategyLabelFor(currentStrategy);
    const stratText = "strategy " + String(stratLabel).slice(0, 64) +
      (currentStrategy === "auto_adaptive" ? " (auto)" : "") + " · ";
    const metaText =
      stratText +
      (sig && sig.reason ? String(sig.reason).slice(0, 256) + " · " : "") +
      "WR " + wrTxt + " · " +
      stats.wins + "W / " + stats.losses + "L " + qstat + " " + bal + " · " +
      (sig && sig.regime ? "regime " + String(sig.regime).slice(0, 64) + " · " : "") +
      activeFeed.size() + " bars";
    const fingerprint = [d, assetText, metaText].join("|");
    if (fingerprint === lastHudFingerprint) return;
    lastHudFingerprint = fingerprint;
    el.querySelector(".qxp-dir").textContent = d;
    el.dataset.dir = d;
    el.querySelector("#qxp-asset").textContent = assetText;
    el.querySelector(".qxp-meta").textContent = metaText;
  }

  function ingest(price, assetOverride, tickTime, source) {
    const safePrice = Number(price);
    if (!Number.isFinite(safePrice) || safePrice <= 0 || safePrice > 1e12) return false;
    const targetAsset = assetOverride || activeAsset;
    const targetFeed = createFeedFor(targetAsset);
    const priorPrice = Number(targetFeed.lastPrice());
    const relativeMove = Number.isFinite(priorPrice) && priorPrice > 0
      ? Math.abs(safePrice / priorPrice - 1) : 0;

    // v2.8: Enhanced DOM+WS reconciliation
    // - DOM is fallback only, reject if >2% away from feed (existing)
    // - Additionally, if we have fresh WS price, validate DOM against WS (not just feed)
    // - For active asset, if WS price exists and DOM deviates >1% (FX) or >5% (crypto), reject DOM
    if (source === "dom") {
      if (historySeeded[targetAsset] && relativeMove > 0.02) return false;
      // Cross-check with WS price if available and fresh
      if (lastWsPrice && lastWsSymbol && QUOTEX) {
        try {
          const wsNorm = QUOTEX.normalizeSymbol(lastWsSymbol);
          const targetNorm = QUOTEX.normalizeSymbol(targetAsset);
          if (wsNorm === targetNorm && Date.now() - lastWsTickAt < 10000) {
            const wsPrice = Number(lastWsPrice);
            if (Number.isFinite(wsPrice) && wsPrice > 0) {
              const wsMove = Math.abs(safePrice / wsPrice - 1);
              const isCrypto = /BTC|ETH|XRP|SOL|DOGE|_otc/i.test(targetAsset) && /USD/i.test(targetAsset);
              const threshold = isCrypto ? 0.05 : 0.01;
              if (wsMove > threshold) return false;
            }
          }
        } catch (_) {}
      }
    }

    let ts;
    const isBrokerTick = source === "websocket" && tickTime != null;
    if (tickTime == null) {
      ts = getBrokerNow();
    } else {
      let parsed = Number(tickTime);
      if (!Number.isFinite(parsed)) return false;
      while (Math.abs(parsed) >= 1e14) parsed /= 1000;
      if (Math.abs(parsed) < 1e11) parsed *= 1000;
      ts = Math.floor(parsed);
    }
    if (!Number.isSafeInteger(ts) || ts < 946684800000) return false;
    // Validate against broker clock, not local clock. Local may be minutes off.
    const brokerNowEst = getBrokerNow();
    // Past: 7 days behind broker
    if (ts < brokerNowEst - 7 * 86400000) return false;
    // Future: 10 min ahead of broker, or 2 days ahead of local (garbage)
    if (ts > brokerNowEst + 600000) {
      // Allow small skew if broker clock hasn't been set yet
      if (brokerNow != null || ts > Date.now() + 600000) return false;
    }
    if (ts > Date.now() + 2 * 86400000) return false;
    if (typeof targetFeed.canIngest === "function" && !targetFeed.canIngest(ts)) return false;

    // Update broker clock from validated broker ticks only
    if (isBrokerTick) updateBrokerClock(ts);

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

  function historyKey(id, period) { return id + "@" + period; }

  /**
   * Ask the broker for real OHLC history on one asset + timeframe.
   *
   * The engine needs the 1m series; the dashboard chart needs whichever
   * timeframe the platform is showing. This used to request `period: 60`
   * only, keyed per asset — so after a timeframe switch (or when attaching
   * to a chart already set to 5m/15m) nothing ever asked the broker for that
   * timeframe and the dashboard sat on "Waiting for candles…" while Quotex
   * drew candles next to it.
   */
  function requestPeriodHistory(id, period, force, requestedLimit, offset) {
    const safePeriod = Number.isFinite(Number(period)) && Number(period) >= 1
      ? Math.min(86400, Math.max(1, Math.floor(Number(period)))) : 60;
    const key = historyKey(id, safePeriod);
    const at = historyRequestedAt[key] || 0;
    const safeOffset = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0;
    const isPagination = safeOffset > 0;
    const now = Date.now();

    // Enhanced throttling with attempt tracking
    if (!historyPagination[key]) {
      historyPagination[key] = { totalReceived: 0, lastOffset: 0, hasMore: true, attempts: 0, lastError: 0, gaps: [] };
    }
    const pag = historyPagination[key];

    if (!force && !isPagination) {
      if (safePeriod === 60) {
        // Once real history has arrived and no gaps, don't spam. But allow if:
        // - never seeded, or
        // - hasMore pagination pending, or
        // - gaps detected, or
        // - stale (>5 min for active asset, >10 min for others)
        const isActive = id === activeAsset;
        const staleThreshold = isActive ? 300000 : 600000;
        const cached = chartHistory[id] && chartHistory[id][safePeriod];
        const bars = cached && Array.isArray(cached.candles) ? cached.candles.length : 0;
        const isStale = !cached || now - (Number(cached.ts) || 0) > staleThreshold;
        const hasGaps = pag.gaps && pag.gaps.length > 0;
        if (historySeeded[id] && !pag.hasMore && !hasGaps && !isStale && bars >= 100) return null;
        // Backoff on repeated failures
        if (pag.attempts >= 3 && now - pag.lastError < 60000) return null;
      } else {
        const cached = chartHistory[id] && chartHistory[id][safePeriod];
        const bars = cached && Array.isArray(cached.candles) ? cached.candles.length : 0;
        const isActive = id === activeAsset && safePeriod === lastWsPeriod;
        const staleThreshold = isActive ? 120000 : 600000;
        if (bars && now - (Number(cached.ts) || 0) < staleThreshold) return null;
      }
      const throttleMs = id === activeAsset ? 10000 : 15000;
      if (now - at < throttleMs) return null;
    }

    // Exponential backoff for pagination retries
    if (isPagination && pag.attempts >= 5) {
      if (now - pag.lastError < 30000 * Math.min(4, pag.attempts)) return null;
    }

    const rawLimit = Number(requestedLimit);
    const wanted = Number.isFinite(rawLimit) ? Math.max(60, Math.min(10000, Math.floor(rawLimit))) : 5000;
    const limit = safePeriod === 60 ? wanted : Math.max(60, Math.min(wanted, 2000));
    const requestId = "history_" + now + "_" + (++historyRequestSequence % 1000000);
    if (!isPagination) historyRequestedAt[key] = now;
    pag.attempts = (pag.attempts || 0) + 1;

    try {
      window.postMessage({
        source: _SRC_OUT,
        kind: "subscribe",
        payload: { requestId, asset: id, period: safePeriod, limit, offset: safeOffset },
      }, "*");
      pendingHistoryMeta[requestId] = { asset: id, period: safePeriod, limit, offset: safeOffset, at: now };
      return requestId;
    } catch (_) {
      if (!isPagination) historyRequestedAt[key] = 0;
      pag.lastError = now;
      return null;
    }
  }

  function requestAllTimeframes(id, force) {
    if (!id) return;
    const now = Date.now();
    if (!force && now - lastMtfRequestAt < 60000) return; // throttle MTF to 1/min
    lastMtfRequestAt = now;
    for (let i = 0; i < MTF_PERIODS.length; i++) {
      const period = MTF_PERIODS[i];
      (function(p, idx) {
        setTimeout(function() {
          try {
            // For active asset, request more data; for background, less
            const isActive = id === activeAsset;
            const limit = p === 60 ? (isActive ? 5000 : 1000) : (isActive ? 2000 : 500);
            requestPeriodHistory(id, p, force, limit);
          } catch (_) {}
        }, idx * 180);
      })(period, i);
    }
  }

  function requestGapFill(id, period) {
    if (!id) return;
    const now = Date.now();
    if (now - lastGapCheckAt < GAP_CHECK_INTERVAL) return;
    lastGapCheckAt = now;
    try {
      if (!QUOTEX || !QUOTEX.detectGaps) return;
      const candles = liveCandlesByAsset[id];
      if (!candles || candles.length < 10) return;
      const gaps = QUOTEX.detectGaps(candles, period || 60);
      if (!gaps.length) return;
      // Track gaps in pagination state
      const key = historyKey(id, period || 60);
      if (historyPagination[key]) historyPagination[key].gaps = gaps.slice(0, 5);
      // Request missing history via page-hook
      try {
        window.postMessage({
          source: _SRC_OUT,
          kind: "request_gaps",
          payload: { asset: id, period: period || 60, gaps: gaps.slice(0, 3) }
        }, "*");
      } catch (_) {}
      // Also try direct history request to fill gaps
      for (let i = 0; i < Math.min(gaps.length, 2); i++) {
        const gap = gaps[i];
        if (gap.missing > 0) {
          setTimeout(function(){
            try { requestPeriodHistory(id, period || 60, false, Math.min(5000, gap.missing + 100)); } catch (_) {}
          }, i * 500);
        }
      }
    } catch (_) {}
  }

  function requestInstrumentsAndBalance(force) {
    const now = Date.now();
    if (!force) {
      if (now - lastInstrumentsRequestAt < 60000 && now - lastBalanceRequestAt < 30000) return;
    }
    try {
      if (now - lastInstrumentsRequestAt >= 60000 || force) {
        lastInstrumentsRequestAt = now;
        window.postMessage({ source: _SRC_OUT, kind: "request_instruments", payload: {} }, "*");
      }
      if (now - lastBalanceRequestAt >= 30000 || force) {
        lastBalanceRequestAt = now;
        window.postMessage({ source: _SRC_OUT, kind: "request_balance", payload: {} }, "*");
      }
    } catch (_) {}
  }

  function updateDataQuality(assetId, candleCount, isNewBatch, extra) {
    if (!assetId) return;
    const id = String(assetId).slice(0, 96);
    if (!dataQuality[id]) {
      dataQuality[id] = {
        candleCount: 0, tickCount: 0, gaps: 0, lastUpdate: 0, qualityScore: 0, batches: 0,
        continuity: 0, freshness: 0, gapList: [], lastGapCheck: 0
      };
    }
    const dq = dataQuality[id];
    const now = Date.now();
    if (isNewBatch) {
      dq.batches = (dq.batches || 0) + 1;
      if (Number.isFinite(candleCount)) dq.candleCount = Math.max(dq.candleCount, candleCount);
      dq.tickCount = (dq.tickCount || 0) + 1;
    }
    if (extra && typeof extra === "object") {
      if (Number.isFinite(extra.gaps)) dq.gaps = extra.gaps;
      if (Array.isArray(extra.gapList)) dq.gapList = extra.gapList.slice(0, 10);
      if (Number.isFinite(extra.continuity)) dq.continuity = extra.continuity;
    }
    dq.lastUpdate = now;

    // Gap detection if we have live candles
    try {
      if (QUOTEX && QUOTEX.detectGaps && liveCandlesByAsset[id] && liveCandlesByAsset[id].length >= 2) {
        const gaps = QUOTEX.detectGaps(liveCandlesByAsset[id], 60);
        dq.gaps = gaps.length;
        dq.gapList = gaps.slice(0, 5);
        dq.lastGapCheck = now;
        // Continuity: 1 - (gaps / expected)
        const expected = Math.max(1, dq.candleCount || liveCandlesByAsset[id].length);
        dq.continuity = Math.max(0, Math.min(1, 1 - (gaps.reduce((s,g)=>s+(g.missing||0),0) / expected)));
      }
    } catch (_) {}

    // Freshness: how recent is last update (0-1, 1 = very fresh)
    const ageMin = (now - dq.lastUpdate) / 60000;
    dq.freshness = Math.max(0, 1 - ageMin / 60);
    const recencyScore = dq.freshness;
    const countScore = Math.min(1, dq.candleCount / 500);
    const batchScore = Math.min(1, dq.batches / 3);
    const continuityScore = dq.continuity != null ? dq.continuity : 1;
    const gapPenalty = dq.gaps ? Math.max(0, 1 - dq.gaps * 0.05) : 1;
    // Weighted: count 40%, recency 20%, batches 15%, continuity 15%, gap penalty 10%
    dq.qualityScore = Math.round((recencyScore * 0.2 + countScore * 0.4 + batchScore * 0.15 + continuityScore * 0.15 + gapPenalty * 0.1) * 100);
    dq.qualityScore = Math.max(0, Math.min(100, dq.qualityScore));
  }

  function ensureHistorySubscription(det, force, requestedLimit) {
    if (!det || !QUOTEX || !QUOTEX.subscribeHistory) return null;
    const id = det.id;
    const engineRequestId = requestPeriodHistory(id, 60, force, requestedLimit);
    const visiblePeriod = Number(lastWsPeriod);
    if (Number.isFinite(visiblePeriod) && visiblePeriod >= 1 && visiblePeriod <= 86400 &&
        Math.floor(visiblePeriod) !== 60) {
      requestPeriodHistory(id, Math.floor(visiblePeriod), force, requestedLimit);
    }
    // v2.8: MTF prefetch — on force or when active asset has enough data, fetch other timeframes
    // Also trigger on asset switch (force) or periodically for active asset
    const shouldMtf = force || (id === activeAsset && historySeeded[id] && Date.now() - lastMtfRequestAt > MTF_PREFETCH_INTERVAL);
    if (shouldMtf) {
      try { requestAllTimeframes(id, force); } catch (_) {}
    }
    // Gap filling for active asset
    if (id === activeAsset && historySeeded[id]) {
      try { requestGapFill(id, 60); } catch (_) {}
    }
    try { requestInstrumentsAndBalance(false); } catch (_) {}
    return engineRequestId;
  }

  function scheduleBackgroundScan() {
    if (backgroundScanTimer) return;
    backgroundScanTimer = setInterval(function() {
      try {
        if (!isPrimaryContext) return;
        const now = Date.now();
        const candidates = [];
        for (const aid in liveCandlesByAsset) {
          if (!Object.prototype.hasOwnProperty.call(liveCandlesByAsset, aid)) continue;
          const dq = dataQuality[aid];
          const lastUp = dq ? dq.lastUpdate : 0;
          const age = now - lastUp;
          // Prioritize: stale (>2min) OR low quality (<60) OR has gaps
          const isStale = age > 120000;
          const isLowQuality = dq && dq.qualityScore < 60;
          const hasGaps = dq && dq.gaps > 0;
          if (isStale || isLowQuality || hasGaps) {
            candidates.push({
              id: aid,
              score: dq ? dq.qualityScore : 0,
              lastUp,
              age,
              gaps: dq ? dq.gaps : 0,
              priority: (hasGaps ? 100 : 0) + (isLowQuality ? 50 : 0) + Math.min(30, age / 60000)
            });
          }
        }
        if (lastInstruments && lastInstruments.length) {
          for (let i = 0; i < Math.min(lastInstruments.length, 30); i++) {
            const it = lastInstruments[i];
            if (!it || !it.symbol) continue;
            const det = ASSETS.get(it.symbol);
            if (!det) continue;
            if (det.id === activeAsset) continue;
            if (candidates.some(function(c){ return c.id === det.id; })) continue;
            const dq = dataQuality[det.id];
            const lastUp = dq ? dq.lastUpdate : 0;
            const age = now - lastUp;
            if (!dq || age > 300000 || (dq && dq.qualityScore < 50)) {
              candidates.push({
                id: det.id,
                score: dq ? dq.qualityScore : 0,
                lastUp,
                age,
                gaps: dq ? dq.gaps : 0,
                priority: (dq && dq.gaps ? 100 : 0) + (dq && dq.qualityScore < 50 ? 50 : 0) + Math.min(20, age / 60000)
              });
            }
          }
        }
        // Sort by priority descending, then by age descending
        candidates.sort(function(a,b){
          if (b.priority !== a.priority) return b.priority - a.priority;
          return b.age - a.age;
        });
        // Request up to 2 background assets per cycle, with quality-aware limits
        for (let j = 0; j < Math.min(2, candidates.length); j++) {
          const c = candidates[j];
          try {
            const limit = c.gaps > 0 ? 2000 : (c.score < 50 ? 1500 : 1000);
            requestPeriodHistory(c.id, 60, false, limit);
          } catch (_) {}
        }
        // Periodically refresh instruments/balance
        if (now - lastInstrumentsRequestAt > 120000) {
          try { requestInstrumentsAndBalance(false); } catch (_) {}
        }
      } catch (_) {}
    }, 25000);
  }

  function requestHistorySubscription(det, requestedLimit) {
    const requestId = ensureHistorySubscription(det, true, requestedLimit);
    if (!requestId) return Promise.resolve({ ok: false, requested: false, error: "history request could not be posted" });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!pendingHistory[requestId]) return;
        delete pendingHistory[requestId];
        const meta = pendingHistoryMeta[requestId];
        delete pendingHistoryMeta[requestId];
        if (meta) historyRequestedAt[historyKey(meta.asset, meta.period)] = 0;
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
    const brokerTime = getBrokerNow();
    // Periodic instruments/balance refresh
    if (currentTime % 15000 < 1200) {
      try { requestInstrumentsAndBalance(false); } catch (_) {}
    }
    // Periodic gap check for active asset (every 2 min)
    if (currentTime % 120000 < 1200) {
      try {
        if (activeAsset && historySeeded[activeAsset]) requestGapFill(activeAsset, 60);
      } catch (_) {}
    }
    // Periodic MTF refresh for active asset (every 5 min)
    if (currentTime % 300000 < 1200) {
      try {
        if (activeAsset && historySeeded[activeAsset]) requestAllTimeframes(activeAsset, false);
      } catch (_) {}
    }
    // A wall-clock close is valid only while real quote input is fresh. After
    // a disconnect, repeatedly closing bars at an old price fabricates candle
    // outcomes and can settle expiries without a broker quote.
    // Use broker time for bar close, but freshness check uses local time
    // since lastAcceptedQuoteAt is local.
    if (currentTime - (lastAcceptedQuoteAt[activeAsset] || 0) <= 15000) {
      const ev = activeFeed.forceClose(brokerTime);
      settleFeedEvent(ev, activeAsset);
    }
    // Real WS ticks are ingested by the message router with their broker
    // timestamps. DOM polling is a conservative fallback and is accepted only
    // when the rendered quote changes; an unchanged stale label is not a tick.
    if (!wsQuoteMatchesActive()) {
      const p = findPrice();
      if (p && p !== lastDomPriceByAsset[activeAsset]) {
        lastDomPriceByAsset[activeAsset] = p;
        ingest(p, det && det.id, brokerTime, "dom");
      }
    }
    maybeSignal();
    // v2.3.3: when the chart switches assets, push that asset's markers so
    // the arrows shown always belong to the visible chart.
    if (markerStore && lastMarkersAsset !== activeAsset) {
      lastMarkersAsset = activeAsset;
      sendMarkers();
    }
    // v2.7.5: periodic marker re-push every 5 seconds. The page-hook may
    // miss the initial markers message (chart not yet captured, asset
    // mismatch, or timing race). Re-sending ensures arrows eventually appear.
    if (markerStore && currentTime - (lastMarkerPushAt || 0) >= 5000) {
      lastMarkerPushAt = currentTime;
      sendMarkers();
    }
    ensureHistorySubscription(det || ASSETS.get(activeAsset));
  }

  function requestHookSync() {
    try {
      window.postMessage({ source: _SRC_OUT, kind: "sync_request", payload: {} }, "*");
    } catch (_) {}
  }

  /* -------- page-hook message router (v2.2: + snapshot/ws results) -------- */
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== _SRC_IN) return;
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
          // v2.7.2: respect a 5-second grace period after manual asset selection
          // to prevent old "asset" events from resetting the selection before
          // Quotex confirms the chart switch.
          if (manualAsset && det && det.id !== manualAsset && Date.now() - manualAssetSetAt > 5000) manualAsset = null;
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
          ingestLiveCandles(p.asset, p.period, p.candles, p.verified === true);
        }
        break;
      }
      case "balance": {
        const balance = normalizeBalance(p);
        if (!balance) break;
        lastBalance = balance;
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_BALANCE", payload: balance }).catch(() => {}); } catch (_) {}
        syncAutoAccount();
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
        if (order.kind === "opened") {
          try { addOpenOrder(order.data); } catch (_) {}
        }
        if (order.kind === "closed") {
          try { removeOpenOrder(order.data); } catch (_) {}
          processClosedOrder(order, false);
        }
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
          } else if (pendingOrderEvent && Date.now() - pendingOrderEvent.at < 10000 &&
              data.asset && (data.direction === "CALL" || data.direction === "PUT") &&
              QUOTEX.normalizeSymbol(pendingOrderEvent.asset) === QUOTEX.normalizeSymbol(data.asset) &&
              pendingOrderEvent.dir === data.direction && Number(data.amount) > 0 &&
              Math.abs(Number(data.amount) - pendingOrderEvent.amount) <=
                Math.max(0.000001, Math.abs(pendingOrderEvent.amount) * 0.000001)) {
            // Some broker builds push `s_orders/open` for the account without
            // echoing the client requestId, so a strictly matching order event
            // is the fallback confirmation for BOTH placement paths.
            const done = pendingOrderEvent.resolve;
            const waiterMode = pendingOrderEvent.mode === "ws" ? "ws_event" : "dom";
            pendingOrderEvent = null;
            done({
              ok: true, confirmed: true, mode: waiterMode, id: data.id || null,
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
      case "order_error": {
        // The broker answered our own `orders/open` emit with a rejection.
        // Report the real reason instead of letting the waiter run out its
        // full timeout with a generic "confirmation timeout".
        const reqId = p && p.requestId != null ? String(p.requestId).slice(0, 128) : "";
        const reason = String(p && p.error || "broker rejected the order").slice(0, 240);
        if (reqId && pendingOrders[reqId]) {
          const rejectOrder = pendingOrders[reqId];
          delete pendingOrders[reqId];
          // Resolve the correlated waiter only. The race in
          // waitForBrokerOrder() releases the asset/amount fallback itself;
          // resolving that one first would win the race with a result that
          // has no `sent` flag and send the caller down the DOM retry path.
          rejectOrder({ ok: false, confirmed: false, sent: true, mode: "ws", requestId: reqId, error: reason });
        }
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_TRADE_ERROR", payload: { requestId: reqId, error: reason } }).catch(() => {}); } catch (_) {}
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
        const requestMeta = requestId ? pendingHistoryMeta[requestId] : null;
        const metaKey = requestMeta ? historyKey(requestMeta.asset, requestMeta.period) : (asset ? historyKey(asset, result.period || 60) : null);
        if (metaKey && historyPagination[metaKey]) {
          if (result.ok) {
            historyPagination[metaKey].attempts = 0;
            historyPagination[metaKey].lastError = 0;
          } else {
            historyPagination[metaKey].lastError = Date.now();
          }
        }
        if (!result.ok && requestMeta) {
          historyRequestedAt[historyKey(requestMeta.asset, requestMeta.period)] = 0;
        } else if (!result.ok && asset && hasPendingRequest) {
          historyRequestedAt[historyKey(asset, result.period || 60)] = 0;
        }
        if (requestId) delete pendingHistoryMeta[requestId];
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
        // After primary confirmed, request fresh instruments/balance
        if (isPrimaryContext) {
          setTimeout(function(){ try { requestInstrumentsAndBalance(true); } catch (_) {} }, 1000);
          try { scheduleBackgroundScan(); } catch (_) {}
        }
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
    setTimeout(function(){ try { requestInstrumentsAndBalance(true); } catch (_) {} }, 2000);
    try { scheduleBackgroundScan(); } catch (_) {}
  }

  /* -------- confirmed real-platform trade placement -------- */
  function nextRequestId() {
    // Numeric and below Number.MAX_SAFE_INTEGER (the broker expects an int).
    return String(Date.now() * 1000 + Math.floor(Math.random() * 1000));
  }

  /**
   * Register the strict asset+direction+amount waiter that a broker
   * `order_opened` push resolves. Both placement paths use it: a DOM click
   * carries no client correlation id at all, and some broker builds push
   * `s_orders/open` without echoing the requestId of a WS placement.
   */
  function waitForOrderEvent(meta, timeoutMs, mode, timeoutResult) {
    return new Promise((resolve) => {
      let waiter = null;
      const timer = setTimeout(() => {
        if (pendingOrderEvent !== waiter) return;
        pendingOrderEvent = null;
        resolve(timeoutResult || { ok: false, confirmed: false, mode: mode || "dom", error: "broker did not confirm the order" });
      }, timeoutMs || 8000);
      waiter = {
        at: Date.now(), mode: mode || "dom",
        asset: meta.asset, dir: meta.dir, amount: meta.amount,
        resolve: (result) => { clearTimeout(timer); resolve(result); },
      };
      pendingOrderEvent = waiter;
    });
  }

  function cancelOrderEventWaiter(result) {
    if (!pendingOrderEvent) return;
    const done = pendingOrderEvent.resolve;
    pendingOrderEvent = null;
    done(result || { ok: false, confirmed: false, error: "confirmation superseded" });
  }

  /**
   * Wait for the broker to confirm one placement. Two independent sources can
   * confirm it, and the first one wins:
   *   1. the Socket.IO ACK / order-open event carrying our requestId;
   *   2. a strictly matching account order-open push (asset+dir+amount).
   * Returns { promise, cancel } so callers always release both waiters.
   */
  function waitForBrokerOrder(requestId, meta, timeoutMs) {
    const ms = timeoutMs || 8000;
    const timeoutResult = { ok: false, confirmed: false, sent: true, error: "broker order confirmation timeout" };
    const correlated = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pendingOrders[requestId]) delete pendingOrders[requestId];
        resolve(Object.assign({ mode: "ws" }, timeoutResult));
      }, ms);
      pendingOrders[requestId] = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
    const fallback = meta
      ? waitForOrderEvent(meta, ms, "ws", Object.assign({ mode: "ws" }, timeoutResult))
      : null;
    const cleanup = () => {
      // `sent: true` keeps a superseded waiter from ever looking like an
      // unsent frame, which would trigger the DOM retry path.
      cancelOrderEventWaiter({ ok: false, confirmed: false, sent: true, mode: "ws", error: "confirmation superseded" });
      if (pendingOrders[requestId]) {
        const drop = pendingOrders[requestId];
        delete pendingOrders[requestId];
        try { drop(Object.assign({ mode: "ws" }, timeoutResult, { error: "confirmation superseded" })); } catch (_) {}
      }
    };
    const promise = (fallback ? Promise.race([correlated, fallback]) : correlated)
      .then((result) => { cleanup(); return result; });
    return {
      promise,
      cancel: (result) => {
        cleanup();
        return result;
      },
    };
  }

  async function sendWsTrade(orderArgs) {
    const requestId = nextRequestId();
    // The strict asset+direction+amount waiter is registered BEFORE the frame
    // goes out so an order-open push that arrives immediately is never missed.
    const confirmation = waitForBrokerOrder(requestId, {
      asset: orderArgs.asset, dir: orderArgs.dir, amount: orderArgs.stake,
    }, 8000);
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
          source: _SRC_OUT,
          kind: "place_ws",
          payload: {
            requestId,
            asset: orderArgs.asset,
            dir: orderArgs.dir,
            amount: orderArgs.stake,
            expirySec: orderArgs.expirySec,
            // v2.6.18: use the caller's isDemo (which has DOM fallback and
            // safe demo default) instead of re-deriving from lastBalance
            // alone. When no balance event had arrived, !!null produced
            // false (live), the opposite of the safe default.
            isDemo: orderArgs.isDemo !== false,
            optionType: orderArgs.optionType,
            // Use broker clock for expiry math so Quotex and extension agree
            // on the absolute expiry epoch even if local clock drifts.
            nowMs: getBrokerNow(),
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
        confirmed = await confirmation.promise;
        if (!confirmed || !confirmed.ok) return confirmed || sent;
      } else {
        confirmation.cancel({ ok: false, confirmed: false, sent: false, error: "page socket send failed" });
        return sent || { ok: false, error: "page socket send failed" };
      }
    } else {
      confirmed = await confirmation.promise;
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
      confirmed.expiryTime = confirmed.expiryTime || (confirmed.openTime || getBrokerNow()) + orderArgs.expirySec * 1000;
      confirmed.expiry = orderArgs.expirySec;
      confirmed.requestId = requestId;
    }
    return confirmed;
  }

  function waitForDomOrder(meta, timeoutMs) {
    return waitForOrderEvent(meta, timeoutMs, "dom",
      { ok: false, confirmed: false, clicked: true, mode: "dom", error: "broker did not confirm DOM click" });
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
    // v2.6.9: args.stake carries the controller's decision (e.g. a
    // percent-of-balance computation from seconds ago); prefer it when valid,
    // otherwise fall back to the freshly loaded settings stake.
    const argsStake = Number(args.stake);
    const stake = Number.isFinite(argsStake) && argsStake > 0 && argsStake <= 1000000 ? argsStake : Number(s.stake);
    // v2.8: dynamic expiry — args.expiry (from auto controller) takes precedence when adaptive,
    // otherwise use suggestedExpiry from current signal if adaptive mode, else fixed setting.
    let expiry;
    const argsExpiry = Number(args.expiry);
    if (Number.isFinite(argsExpiry) && argsExpiry >= 0.5 && argsExpiry <= 1440) {
      expiry = argsExpiry;
    } else if (s.expiryMode === "adaptive" && cachedSignal && cachedSignal.suggestedExpiry) {
      const dyn = Number(cachedSignal.suggestedExpiry);
      if (Number.isFinite(dyn) && dyn >= 0.5 && dyn <= 1440) {
        const minB = Number(s.adaptiveExpiryMin);
        const maxB = Number(s.adaptiveExpiryMax);
        const clampedMin = Number.isFinite(minB) ? Math.max(0.5, minB) : 0.5;
        const clampedMax = Number.isFinite(maxB) ? Math.min(1440, maxB) : 1440;
        expiry = Math.max(Math.min(clampedMin, clampedMax), Math.min(Math.max(clampedMin, clampedMax), dyn));
      } else {
        expiry = Number(s.expiry);
      }
    } else {
      expiry = Number(s.expiry);
    }
    if (!Number.isFinite(stake) || stake <= 0 || stake > 1000000) {
      return { ok: false, confirmed: false, error: "stake must be between 0 and 1,000,000" };
    }
    if (!Number.isFinite(expiry) || expiry < 0.5 || expiry > 1440) {
      return { ok: false, confirmed: false, error: "expiry must be between 0.5 and 1,440 minutes" };
    }
    const expirySec = Math.max(30, Math.round(expiry * 60));
    if (!lastWsSymbol && !manualAsset) return { ok: false, confirmed: false, error: "authoritative main chart is not known" };
    const asset = args.asset || lastWsSymbol;
    // v2.7.6: relaxed the asset match check. When manualAsset is set
    // (dashboard switch), lastWsSymbol may lag behind the active asset.
    // Accept the trade if the asset matches EITHER lastWsSymbol OR the
    // manually selected activeAsset.
    const wsMatch = lastWsSymbol && QUOTEX.normalizeSymbol(asset) === QUOTEX.normalizeSymbol(lastWsSymbol);
    const manualMatch = manualAsset && QUOTEX.normalizeSymbol(asset) === QUOTEX.normalizeSymbol(activeAsset);
    if (!wsMatch && !manualMatch) {
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
      cancelOrderEventWaiter({ ok: false, confirmed: false, mode: "dom", error: "DOM placement failed" });
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
      confirmed.expiryTime = confirmed.expiryTime || (confirmed.openTime || getBrokerNow()) + expirySec * 1000;
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
      const armBtn = document.getElementById("qxp-arm");
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
      // If msg.allTimeframes, request MTF
      if (msg.allTimeframes) {
        try { requestAllTimeframes(det.id, true); } catch (_) {}
      }
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
      // v2.7.2: allow switching assets from the dashboard. The subscription
      // sends instruments/update to Quotex which switches the broker chart,
      // then history/list/v2 requests candle data for the new asset.
      manualAsset = det.id;
      manualAssetSetAt = Date.now();
      activateAsset(det.id);
      // Check if the WebSocket is connected - if not, the subscription will
      // fail silently and the user will need to open Quotex first.
      const wsConnected = !!lastWsSymbol && !!QUOTEX;
      sendResponse({
        ok: true,
        asset: det.id,
        name: det.name,
        manual: true,
        wsConnected,
        message: wsConnected
          ? "Switching to " + det.name + " — requesting candle data..."
          : "Open Quotex first to receive live candle data for " + det.name
      });
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
    // v2.7.2: invalidate cached DOM element and re-detect on URL changes.
    // Quotex uses client-side routing; navigating between assets may change
    // the URL without a full page reload.
    const invalidateAssetCache = () => {
      cachedAssetElement = null;
      cachedAssetElementText = null;
      lastDomAssetResult = null;
      lastDomAssetScan = 0;
      lastDomTextScan = 0;
    };
    window.addEventListener("popstate", invalidateAssetCache);
    window.addEventListener("hashchange", invalidateAssetCache);
  }
})();
