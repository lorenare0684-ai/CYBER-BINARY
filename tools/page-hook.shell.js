/**
 * CYBER BINARY — MAIN-world WebSocket hook shell.
 *
 * This file is NOT loaded directly. `tools/build-hook.js` concatenates
 * `src/lib/quotex.js` (the pure Socket.IO decoder, exposed as
 * `window.CYBER_QUOTEX`) with this shell into `src/page-hook.js`.
 *
 * Why inline instead of dynamically loading the adapter?
 *   - The MAIN world has NO access to `chrome.runtime`, so the adapter can
 *     never be fetched via `chrome.runtime.getURL` from a document_start
 *     MAIN-world content script (the previous approach silently fell back to
 *     a regex text scanner and missed every structured frame: instruments,
 *     history, balance, orders).
 *   - Inlining guarantees the WebSocket wrapper is installed *synchronously*
 *     at document_start — before the page creates its socket — so no frame
 *     is ever missed. The decoder is used from the very first message.
 *
 * The shell stays small and idempotent; all protocol logic lives in
 * CYBER_QUOTEX (see src/lib/quotex.js). Rebuild after editing either file:
 *
 *     node tools/build-hook.js
 */
(function () {
  try { if (window.top && window.top !== window.self) return; } catch (_) { return; }
  // Stealth: guard flag is non-enumerable so Object.keys(window) cannot see it.
  var _G = typeof window !== "undefined" ? window : (typeof self !== "undefined" ? self : this);
  var _HK = "_\u0078k7";
  try {
    var _gd = Object.getOwnPropertyDescriptor(_G, _HK);
    if (_gd && _gd.value) return;
    Object.defineProperty(_G, _HK, { value: true, enumerable: false, configurable: true, writable: true });
  } catch (_) { return; }

  var Q = _G.CYBER_QUOTEX;
  if (!Q || typeof Q.createRouter !== "function") {
    // Should never happen (adapter is inlined above), but keep a graceful
    // fallback for third-party tampering.
    return;
  }

  // Stealth: postMessage uses a non-descriptive source tag so broker
  // fingerprinting scripts cannot grep for the extension's name.
  var _SRC_OUT = "_q1h";
  var _SRC_IN = "_q1c";
  var _cyberFrames = []; // closure-scoped; never leaks to window

  function emit(kind, payload) {
    try {
      window.postMessage({ source: _SRC_OUT, kind: kind, payload: payload }, "*");
    } catch (_) {}
  }

  var live = {
    candles: Object.create(null), // asset@period -> latest candles array
    candlesVerified: Object.create(null), // asset@period -> batch was symbol-verified
    ticks: Object.create(null),   // asset -> last tick { price, time }
    instruments: [],  // broker-discovered instruments
    balance: null,
    orders: [],       // rolling list of recent orders (last 50)
    status: { state: "idle", url: null },
    assetIdMap: {},   // broker numeric id -> symbol
    lastWsSymbol: null, // authoritative main-chart symbol (legacy snapshot field)
    lastWsPeriod: 60,
    activeChart: null,  // {symbol, period, source, at}; never derived from quote fan-out
  };

  var internalSubscriptionSend = false;
  var candleKeyOrder = [];
  var candlesVerified = Object.create(null); // asset@period -> batch was symbol-verified
  var tickKeyOrder = [];
  var backgroundTickAt = Object.create(null);
  var lastBackgroundEmitAt = 0;
  var seenOrderKeys = Object.create(null);
  var seenOrderOrder = [];
  var seenPlacementIds = Object.create(null);
  var seenPlacementOrder = [];
  var handle = {
    native: null,
    wrapper: null,
    router: null,
    lastWs: null,
    pending: function () { return handle.router ? handle.router.pending() : null; },
  };

  function selectActiveChart(hit, source) {
    if (!hit || !hit.symbol) return false;
    live.lastWsSymbol = hit.symbol;
    if (hit.period) live.lastWsPeriod = hit.period;
    live.activeChart = {
      symbol: hit.symbol,
      period: hit.period || live.lastWsPeriod || 60,
      source: source || hit.event || "socket",
      at: Date.now(),
    };
    emit("asset", {
      symbol: live.activeChart.symbol,
      period: live.activeChart.period,
      raw: live.activeChart.source,
      event: hit.event || null,
      main: true,
    });
    return true;
  }

  var routerHandlers = {
    onStatus: function (s) {
      live.status = s || live.status;
      emit("quotex_status", s || {});
    },
    onCandle: function (msg) {
      if (!msg) return;
      var asset = msg.asset || (live.activeChart && live.activeChart.symbol) || live.lastWsSymbol || "EURUSD";
      var period = msg.period || live.lastWsPeriod || 60;
      var key = asset + "@" + period;
      live.candles[key] = Array.isArray(msg.candles) ? msg.candles.slice(-5000) : [];
      if (msg.verified != null) live.candlesVerified[key] = !!msg.verified;
      var oldKeyAt = candleKeyOrder.indexOf(key);
      if (oldKeyAt >= 0) candleKeyOrder.splice(oldKeyAt, 1);
      candleKeyOrder.push(key);
      while (candleKeyOrder.length > 24) {
        var droppedKey = candleKeyOrder.shift();
        delete live.candles[droppedKey];
        delete live.candlesVerified[droppedKey];
      }
      // History is low-frequency and remains available per asset/timeframe;
      // it never changes activeChart.
      emit("candle", { asset: asset, period: period, candles: live.candles[key], verified: live.candlesVerified[key] === true });
    },
    onTick: function (q) {
      if (!q || !q.symbol) return;
      if (!Object.prototype.hasOwnProperty.call(live.ticks, q.symbol)) tickKeyOrder.push(q.symbol);
      live.ticks[q.symbol] = q;
      while (tickKeyOrder.length > 500) {
        var oldSymbol = tickKeyOrder.shift();
        delete live.ticks[oldSymbol];
        delete backgroundTickAt[oldSymbol];
      }
      // Quote streams can contain hundreds of subscribed instruments. Keep
      // bounded latest values for snapshots, but rate-limit background bridges
      // globally so they cannot dominate the selected chart's UI updates.
      var main = !!(live.activeChart &&
        Q.normalizeSymbol(live.activeChart.symbol) === Q.normalizeSymbol(q.symbol));
      var now = Date.now();
      var allowBackground = !main && now - lastBackgroundEmitAt >= 1000 &&
        now - (backgroundTickAt[q.symbol] || 0) >= 30000;
      if (main || allowBackground) {
        if (allowBackground) { backgroundTickAt[q.symbol] = now; lastBackgroundEmitAt = now; }
        emit("tick", {
          price: q.price, symbol: q.symbol, time: q.time, raw: "ws", main: main,
        });
      }
    },
    onInstruments: function (list) {
      live.instruments = Array.isArray(list) ? list.slice(0, 2000) : [];
      live.assetIdMap = Object.create(null);
      for (var i = 0; i < live.instruments.length; i++) {
        var it = live.instruments[i];
        if (it && it.symbol && it.id) live.assetIdMap[it.id] = it.symbol;
      }
      // Learn broker ids so numeric tick rows ([id, ts, price]) resolve.
      try { if (Q.rememberIds) Q.rememberIds(live.instruments); } catch (_) {}
      emit("instruments", live.instruments);
    },
    onAsset: function (symbol, hit) {
      // Generic follow events are only an initial candidate. Explicit
      // instruments/update and orders/open events are selected in send().
      if (!symbol || live.activeChart) return;
      selectActiveChart(hit || { symbol: symbol, period: 60 }, "ws_candidate");
    },
    onBalance: function (b) {
      live.balance = b;
      emit("balance", b);
    },
    onOrderError: function (e) {
      // Broker-side rejection of one of our own `orders/open` emits. Surfacing
      // it lets the extension report the real reason instead of waiting out
      // the confirmation timeout.
      if (!e || typeof e !== "object") return;
      emit("order_error", {
        requestId: e.requestId != null ? String(e.requestId).slice(0, 128) : null,
        error: String(e.error || "broker rejected the order").slice(0, 240),
      });
    },
    onOrder: function (e) {
      if (!e || typeof e !== "object") return;
      var data = e.data && typeof e.data === "object" ? e.data : {};
      var identity = data.id || data.requestId || "";
      var at = data.openTime || data.closeTime || "";
      var key = String(e.kind || "") + ":" + String(identity) + ":" + String(at);
      if (key !== "::" && seenOrderKeys[key]) return;
      if (key !== "::") {
        seenOrderKeys[key] = true;
        seenOrderOrder.push(key);
        while (seenOrderOrder.length > 500) delete seenOrderKeys[seenOrderOrder.shift()];
      }
      live.orders.unshift(e);
      if (live.orders.length > 50) live.orders.length = 50;
      emit("order", e);
    },
    onFrame: function (label, payload, frame) {
      // Do not allocate/debug-log high-frequency quote or candle events.
      if (label === "tick" || label === "candles") return;
      try {
        _cyberFrames.unshift({
          at: Date.now(),
          label: label,
          preview: frame && frame.raw ? String(frame.raw).slice(0, 160) : "",
        });
        if (_cyberFrames.length > 20) _cyberFrames.length = 20;
      } catch (_) {}
    },
  };
  var router = Q.createRouter(routerHandlers);
  handle.router = router;

  /* ====================================================================
   * v2.3.3 — non-repainting signal markers on the platform chart.
   *
   * Quotex's chart is TradingView "lightweight-charts". Arrows are anchored
   * to (bar time, price) by the content script (fixed once per closed bar),
   * so they can never repaint: re-rendering only re-projects fixed anchors.
   * Rendering here tries, in order:
   *   1. native `series.setMarkers()` (v4) — the chart scrolls/zooms and
   *      the arrows stay glued to their bars;
   *   2. native `LightweightCharts.createSeriesMarkers(series, …)` plugin
   *      (v5 removed series.setMarkers) — same glued-to-candles behaviour;
   *   3. an overlay canvas above the price chart (approximate mapping from
   *      the feed bars the content script sends alongside the markers),
   *      re-projected on every visible-range change so scroll/zoom can not
   *      detach the arrows from their candles.
   * The chart instance is captured by:
   *   a. wrapping window.LightweightCharts.createChart at document_start
   *      (the page-hook runs in the MAIN world before page scripts);
   *   b. `<lightweight-chart>` web components (chart property);
   *   c. a bounded React-fiber scan of the chart container (bundled builds
   *      that never expose the library globally).
   * ==================================================================== */
  // Stealth: WeakSet tracks wrapped/hooked objects without leaving enumerable
  // properties on the page's own objects (no __cyberWrapped / __cyberHooked).
  var _wrappedSet = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  function _isWrapped(o) { return _wrappedSet ? _wrappedSet.has(o) : false; }
  function _markWrapped(o) { if (_wrappedSet && o) try { _wrappedSet.add(o); } catch (_) {} }

  var MARKERS = (function () {
    var chart = null;        // selected (largest visible) lightweight-charts IChartApi
    var chartContainer = null;
    var series = null;       // main price series (the one that accepts setMarkers)
    var nativeList = [];     // last normalized native marker list
    var lastPayload = null;  // raw { asset, markers, bars } from content
    var overlay = null;      // { el, canvas, ctx, target }
    var mode = "none";       // "native" | "overlay" | "none"
    var lwcModule = null;     // window.LightweightCharts module ref (v5 createSeriesMarkers)
    var markersPlugin = null; // v5 ISeriesMarkersPluginApi bound to `series`
    var pluginSeries = null;  // series the markers plugin was created for
    var rangeBoundChart = null; // chart whose timeScale redraw subscription is installed
    var CALL_COLOR = "#3dff9a";
    var PUT_COLOR = "#ff5d7a";
    var MAX = 600;

    function isChartLike(o) {
      return !!o && typeof o === "object" &&
        typeof o.timeScale === "function" &&
        (typeof o.addCandlestickSeries === "function" || typeof o.addSeries === "function" ||
         typeof o.addLineSeries === "function" || typeof o.addBarSeries === "function");
    }

    function isSeriesLike(s) {
      return !!s && typeof s === "object" && (typeof s.setMarkers === "function" || typeof s.setData === "function");
    }

    // v5 charts create every series through addSeries(SeriesDefinition, …)
    // instead of addCandlestickSeries(). Detect whether a created series is
    // the PRICE series (candlestick/bar) from the series itself or from the
    // passed definition, so the marker target is never a moving average.
    function isPriceSeriesLike(s, definition) {
      var type = "";
      try { type = s && typeof s.seriesType === "function" ? String(s.seriesType()) : ""; } catch (_) {}
      if (/candlestick|bar/i.test(type)) return true;
      try {
        var d = definition && (typeof definition.type === "function" ? definition.type() : definition.type);
        return /candlestick|bar/i.test(String(d == null ? "" : d));
      } catch (_) { return false; }
    }

    function hookSeries(s) {
      if (!s || typeof s !== "object" || _isWrapped(s)) return s;
      _markWrapped(s);
      var origSetData = s.setData;
      if (typeof origSetData === "function") {
        s.setData = function (data) {
          try {
            if (Array.isArray(data) && data.length) {
              var sym = (live.activeChart && live.activeChart.symbol) || live.lastWsSymbol || "EURUSD";
              var parsed = Q.parseCandles(data, sym, live.lastWsPeriod || 60);
              var norm = Q.normalizeCandles(parsed || { raw: data });
              if (norm.length) {
                var p = (parsed && parsed.period) || live.lastWsPeriod || 60;
                routerHandlers.onCandle({ asset: sym, period: p, candles: norm, verified: true });
              }
            }
          } catch (_) {}
          return origSetData.apply(this, arguments);
        };
      }
      var origUpdate = s.update;
      if (typeof origUpdate === "function") {
        s.update = function (bar) {
          try {
            if (bar && typeof bar === "object") {
              var sym2 = (live.activeChart && live.activeChart.symbol) || live.lastWsSymbol || "EURUSD";
              var norm2 = Q.normalizeCandles({ raw: [bar] });
              if (norm2.length) {
                routerHandlers.onCandle({ asset: sym2, period: live.lastWsPeriod || 60, candles: norm2, verified: true });
              }
            }
          } catch (_) {}
          return origUpdate.apply(this, arguments);
        };
      }
      return s;
    }

    function seriesRank(s) {
      if (!s || typeof s !== "object") return -1;
      var type = "";
      try { type = typeof s.seriesType === "function" ? String(s.seriesType()) : ""; } catch (_) {}
      if (/candlestick/i.test(type)) return 100;
      if (/bar/i.test(type)) return 90;
      if (isSeriesLike(s) && typeof s.priceToCoordinate === "function") return 40;
      return isSeriesLike(s) ? 10 : -1;
    }

    function findExistingSeries(c) {
      var best = null, bestRank = -1;
      function consider(candidate) {
        if (!candidate) return;
        hookSeries(candidate);
        var rank = seriesRank(candidate);
        if (rank > bestRank) { best = candidate; bestRank = rank; }
      }
      try {
        var arr = c.series();
        if (Array.isArray(arr)) for (var ai = 0; ai < arr.length; ai++) consider(arr[ai]);
      } catch (_) {}
      try {
        var keys = Object.keys(c);
        var n = Math.min(keys.length, 40);
        for (var i = 0; i < n; i++) {
          var v = c[keys[i]];
          if (Array.isArray(v)) {
            for (var j = 0; j < v.length && j < 20; j++) consider(v[j]);
          } else consider(v);
        }
      } catch (_) {}
      return best;
    }

    function containerArea(el) {
      try {
        var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        return r && r.width > 0 && r.height > 0 ? r.width * r.height : 0;
      } catch (_) { return 0; }
    }

    function captureChart(c, container) {
      if (!isChartLike(c)) return false;
      if (chart === c) return true;
      // Multiple-chart mode creates several valid chart APIs. The main price
      // chart is the largest visible container; do not let a later mini chart
      // replace it merely because it was discovered last.
      var nextArea = containerArea(container);
      var currentArea = containerArea(chartContainer);
      if (chart && currentArea > 0 && (nextArea === 0 || nextArea < currentArea)) return true;
      chart = c;
      chartContainer = container || chartContainer;
      // The old chart's redraw subscription died with it; re-bind to the new
      // chart's timeScale immediately (a markers message may not follow).
      rangeBoundChart = null;
      if (mode === "overlay") bindOverlayRangeWatcher();
      series = findExistingSeries(c);
      if (series) hookSeries(series);
      // Wrap series adders so a re-created main series (asset / timeframe
      // switch) is captured too. Candlestick/bar adders REPLACE the marker
      // target (they are the price chart); overlays (line/area/…) only fill
      // in if we have no target yet. On v5 every series comes from
      // addSeries(), so the created series/definition type decides.
      var names = ["addCandlestickSeries", "addBarSeries", "addLineSeries",
        "addAreaSeries", "addBaselineSeries", "addHistogramSeries", "addSeries"];
      for (var i = 0; i < names.length; i++) (function (n) {
        var orig = c[n];
        if (typeof orig !== "function" || _isWrapped(orig)) return;
        c[n] = function () {
          var s = orig.apply(this, arguments);
          if (isSeriesLike(s)) {
            hookSeries(s);
            if (n === "addCandlestickSeries" || n === "addBarSeries") series = s;
            else if (n === "addSeries" && isPriceSeriesLike(s, arguments[0])) series = s;
            else if (!series) series = s;
            if (series === s) {
              // A new price series replaced the old one: its v5 markers
              // plugin (if any) died with the old series.
              pluginSeries = null;
              applyNative();
            }
          }
          return s;
        };
        _markWrapped(c[n]);
      })(names[i]);
      if (series) applyNative();
      return true;
    }

    function hasChart() { return !!chart; }

    function markerPeriod() {
      var raw = Number(lastPayload && lastPayload.period);
      return Number.isFinite(raw) && raw >= 1 && raw <= 86400 ? Math.floor(raw) : 60;
    }

    function markerSecond(value) {
      var time = Number(value);
      if (!Number.isFinite(time) || time <= 0) return null;
      while (time >= 1e14) time /= 1000;
      var sec = Math.floor(time >= 1e11 ? time / 1000 : time);
      if (!Number.isSafeInteger(sec) || sec <= 0) return null;
      // Post-normalization epoch sanity (2000-01-01 … 2100-01-01 UTC), the
      // same floor src/lib/markers.js applies — garbage epochs must never
      // project an arrow onto the chart.
      if (sec < 946684800 || sec > 4102444800) return null;
      var period = markerPeriod();
      return Math.floor(sec / period) * period;
    }

    /** Raw markers -> lightweight-charts setMarkers() format. */
    function normalize(list) {
      var byTime = Object.create(null);
      var arr = Array.isArray(list) ? list.slice(-MAX) : [];
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        var sec = markerSecond(m && m.time);
        if (!m || (m.dir !== "CALL" && m.dir !== "PUT") || sec == null) continue;
        var put = m.dir === "PUT";
        byTime[sec] = {
          time: sec,
          position: put ? "aboveBar" : "belowBar",
          color: put ? PUT_COLOR : CALL_COLOR,
          shape: put ? "arrowDown" : "arrowUp",
          text: put ? "PUT" : "CALL",
        };
      }
      var out = [];
      for (var t in byTime) {
        if (Object.prototype.hasOwnProperty.call(byTime, t)) out.push(byTime[t]);
      }
      out.sort(function (a, b) { return a.time - b.time; });
      if (out.length > MAX) out = out.slice(out.length - MAX);
      return out;
    }

    function applyMarkers(payload) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) payload = null;
      lastPayload = payload ? {
        asset: typeof payload.asset === "string" ? payload.asset.slice(0, 64) : "",
        period: Number.isFinite(Number(payload.period)) ? Math.max(1, Math.min(86400, Math.floor(Number(payload.period)))) : 60,
        markers: Array.isArray(payload.markers) ? payload.markers.slice(-MAX) : [],
        bars: Array.isArray(payload.bars) ? payload.bars.slice(-400) : [],
      } : null;
      var chartMismatch = !!(lastPayload && lastPayload.asset && live.activeChart && live.activeChart.symbol &&
        Q.normalizeSymbol(lastPayload.asset) !== Q.normalizeSymbol(live.activeChart.symbol));
      nativeList = chartMismatch ? [] : normalize(lastPayload && lastPayload.markers);
      // The platform may have recreated the main series (asset/timeframe
      // switch) since the last markers message — re-resolve it if needed.
      if (!series && chart) series = findExistingSeries(chart);
      applyNative();
    }

    // v5 removed series.setMarkers() in favour of
    // LightweightCharts.createSeriesMarkers(series, markers), whose plugin
    // owns .setMarkers(). Native markers stay glued to their candles through
    // every scroll/zoom; the overlay canvas below is only a last resort.
    function ensureMarkersPlugin() {
      if (!series) return null;
      if (markersPlugin && pluginSeries === series &&
          typeof markersPlugin.setMarkers === "function") return markersPlugin;
      if (markersPlugin) {
        try { if (typeof markersPlugin.detach === "function") markersPlugin.detach(); } catch (_) {}
      }
      markersPlugin = null;
      pluginSeries = null;
      var create = lwcModule && typeof lwcModule.createSeriesMarkers === "function"
        ? lwcModule.createSeriesMarkers : null;
      if (!create) return null;
      try {
        markersPlugin = create(series, []);
        pluginSeries = series;
      } catch (_) { markersPlugin = null; }
      return markersPlugin && typeof markersPlugin.setMarkers === "function" ? markersPlugin : null;
    }

    function applyNative() {
      // v3/v4: markers live on the series itself.
      if (series && typeof series.setMarkers === "function") {
        try {
          series.setMarkers(nativeList);
          mode = "native";
          hideOverlay();
          return true;
        } catch (_) { /* some builds throw on setMarkers — fall through */ }
      }
      // v5: markers are a series primitive owned by a plugin.
      var plugin = ensureMarkersPlugin();
      if (plugin) {
        try {
          plugin.setMarkers(nativeList);
          mode = "native";
          hideOverlay();
          return true;
        } catch (_) { /* fall back to overlay */ }
      }
      mode = "overlay";
      bindOverlayRangeWatcher();
      ensureOverlayHeartbeat();
      drawOverlay();
      return false;
    }

    // Overlay arrows are projected from fixed anchors, so they must be
    // re-projected whenever the visible range moves (scroll, zoom, new
    // bars). Without this the canvas kept stale pixel positions and the
    // arrows visibly detached from their candles.
    function bindOverlayRangeWatcher() {
      if (rangeBoundChart || !chart) return;
      try {
        var ts = chart.timeScale();
        if (ts && typeof ts.subscribeVisibleLogicalRangeChange === "function") {
          ts.subscribeVisibleLogicalRangeChange(function () { scheduleOverlayRedraw(); });
          rangeBoundChart = chart;
        }
      } catch (_) {}
    }

    // The price axis autoscales on new ticks WITHOUT moving the logical
    // range, so an exact-overlay's y can drift while x stays glued. A slow
    // repaint heartbeat keeps both honest; it no-ops outside overlay mode.
    var overlayHeartbeat = null;
    function ensureOverlayHeartbeat() {
      if (overlayHeartbeat || typeof setInterval !== "function") return;
      try {
        overlayHeartbeat = setInterval(function () {
          if (mode === "overlay") scheduleOverlayRedraw();
        }, 500);
      } catch (_) {}
    }

    /* ---------- overlay fallback ---------- */
    function findChartCanvas() {
      var all = document.querySelectorAll("canvas");
      var best = null, bestArea = 0;
      for (var i = 0; i < all.length; i++) {
        try {
          var r = all[i].getBoundingClientRect();
          var area = r && r.width > 240 && r.height > 140 ? r.width * r.height : 0;
          if (area > bestArea) { best = all[i]; bestArea = area; }
        } catch (_) {}
      }
      return best;
    }

    function ensureOverlay() {
      // Lightweight Charts coordinates are relative to its container. Prefer
      // that exact element over guessing the largest canvas on the page.
      var target = chartContainer && chartContainer.isConnected && containerArea(chartContainer) > 0
        ? chartContainer : findChartCanvas();
      if (overlay && overlay.el && overlay.el.isConnected && overlay.target === target) return overlay;
      if (overlay) hideOverlay();
      overlay = null;
      if (!target || !document.body) return null;
      var el = document.createElement("div");
      el.style.cssText = "position:fixed;pointer-events:none;z-index:2147483000;";
      var canvas = document.createElement("canvas");
      canvas.style.cssText = "display:block;width:100%;height:100%;";
      el.appendChild(canvas);
      document.body.appendChild(el);
      overlay = { el: el, canvas: canvas, ctx: (canvas.getContext && canvas.getContext("2d")) || null, target: target };
      try {
        if (window.ResizeObserver && overlay.target.parentElement) {
          overlay.ro = new window.ResizeObserver(function () { scheduleOverlayRedraw(); });
          overlay.ro.observe(overlay.target.parentElement);
        }
      } catch (_) {}
      return overlay;
    }

    function hideOverlay() {
      if (overlay && overlay.el) {
        try { if (overlay.ro) overlay.ro.disconnect(); } catch (_) {}
        try { overlay.el.remove(); } catch (_) {}
      }
      overlay = null;
    }

    var redrawTimer = null;
    function scheduleOverlayRedraw() {
      if (redrawTimer || mode !== "overlay") return;
      redrawTimer = setTimeout(function () { redrawTimer = null; drawOverlay(); }, 120);
    }

    function drawOverlay() {
      var ov = ensureOverlay();
      if (!ov || !ov.ctx || !ov.target) return;
      var rect = ov.target.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return;
      ov.el.style.left = rect.left + "px";
      ov.el.style.top = rect.top + "px";
      ov.el.style.width = rect.width + "px";
      ov.el.style.height = rect.height + "px";
      var rawDpr = Number(window.devicePixelRatio);
      var dpr = Number.isFinite(rawDpr) ? Math.max(1, Math.min(2, rawDpr)) : 1;
      var pixelW = Math.floor(rect.width * dpr), pixelH = Math.floor(rect.height * dpr);
      if (ov.canvas.width !== pixelW) ov.canvas.width = pixelW;
      if (ov.canvas.height !== pixelH) ov.canvas.height = pixelH;
      var ctx = ov.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      var bars = (lastPayload && lastPayload.bars) || [];
      var markers = (lastPayload && lastPayload.markers) || [];
      if (!bars.length || !markers.length) return;
      var t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
      for (var i = 0; i < bars.length; i++) {
        var b = bars[i];
        if (!b) continue;
        if (b.time < t0) t0 = b.time;
        if (b.time > t1) t1 = b.time;
        if (b.low < lo) lo = b.low;
        if (b.high > hi) hi = b.high;
      }
      if (!isFinite(t0) || !isFinite(t1) || t1 <= t0 || !isFinite(hi) || !isFinite(lo)) return;
      var pad = (hi - lo) * 0.08 || (hi * 0.001 || 0.001);
      lo -= pad; hi += pad;
      var W = rect.width, H = rect.height;
      var timeScale = null;
      try { timeScale = chart && typeof chart.timeScale === "function" ? chart.timeScale() : null; } catch (_) {}
      var exactTime = !!timeScale && typeof timeScale.timeToCoordinate === "function";
      var exactPrice = !!series && typeof series.priceToCoordinate === "function";
      if (!exactTime) {
        // No chart API → every x would be an approximation spread across the
        // viewport, freezing in place when the chart pans/zooms: the
        // "floating arrows" defect. Arrows are only ever drawn when they can
        // be glued to their bar; discovery keeps retrying in the background.
        try { scheduleScan(); } catch (_) {}
        return;
      }
      var periodMs = markerPeriod() * 1000;
      for (var k = 0; k < markers.length; k++) {
        var m = markers[k];
        var markerSec = markerSecond(m && m.time);
        var markerPrice = Number(m && m.price);
        if (!m || (m.dir !== "CALL" && m.dir !== "PUT") || markerSec == null ||
            !Number.isFinite(markerPrice) || markerPrice <= 0) continue;
        var markerTime = markerSec * 1000;
        if (markerTime < t0 || markerTime > t1 + periodMs) continue;

        // Find the matching broker-timeframe candle. This both avoids linear
        // timestamp drift across gaps and gives the true high/low for vertical
        // placement rather than drawing at the candle close.
        var barIndex = -1;
        for (var bi = bars.length - 1; bi >= 0; bi--) {
          var bt = Number(bars[bi] && bars[bi].time);
          while (bt >= 1e14) bt /= 1000;
          if (bt < 1e11) bt *= 1000;
          bt = Math.floor(bt / periodMs) * periodMs;
          if (bt === markerTime) { barIndex = bi; break; }
          if (bt < markerTime) break;
        }
        var matchedBar = barIndex >= 0 ? bars[barIndex] : null;
        var anchorPrice = m.dir === "PUT" && matchedBar ? Number(matchedBar.high)
          : (m.dir === "CALL" && matchedBar ? Number(matchedBar.low) : markerPrice);
        if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) anchorPrice = markerPrice;

        var x = NaN, y = NaN;
        if (exactTime) {
          try {
            var rawX = timeScale.timeToCoordinate(markerSec);
            x = rawX == null ? NaN : Number(rawX);
          } catch (_) {}
          // A null/off-screen coordinate must stay hidden, not be remapped to
          // the full cached history range.
          if (!Number.isFinite(x)) continue;
        } else if (barIndex >= 0) {
          x = ((barIndex + 0.5) / bars.length) * W;
        }
        if (exactPrice) {
          try {
            var rawY = series.priceToCoordinate(anchorPrice);
            y = rawY == null ? NaN : Number(rawY);
          } catch (_) {}
        }
        if (!Number.isFinite(y)) y = H - ((anchorPrice - lo) / (hi - lo)) * H;
        if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > W || y < -30 || y > H + 30) continue;
        drawArrow(ctx, x, y, m.dir === "PUT");
      }
    }

    function drawArrow(ctx, x, y, isPut) {
      var s = 9;
      ctx.fillStyle = isPut ? PUT_COLOR : CALL_COLOR;
      ctx.beginPath();
      if (isPut) {
        ctx.moveTo(x, y - 6);            // tip, ABOVE the price
        ctx.lineTo(x - s, y - 6 - s);
        ctx.lineTo(x + s, y - 6 - s);
      } else {
        ctx.moveTo(x, y + 6);            // tip, BELOW the price
        ctx.lineTo(x - s, y + 6 + s);
        ctx.lineTo(x + s, y + 6 + s);
      }
      ctx.closePath();
      ctx.fill();
    }

    /* ---------- chart discovery ---------- */
    var scanTimer = null;
    var inspectBudget = 0;
    var inspectSeen = null;
    function scheduleScan() {
      if (scanTimer) return;
      var tries = 0;
      scanTimer = setInterval(function () {
        tries++;
        try { scanOnce(); } catch (_) {}
        // Lazy SPAs mount the trade chart long after first paint, and asset
        // switches can re-mount it — a fixed burst gave up too early. After
        // the initial burst, keep a slow background lane forever so a
        // late-mounted chart is always eventually captured.
        if (tries === 15) {
          clearInterval(scanTimer);
          scanTimer = setInterval(function () { try { scanOnce(); } catch (_) {} }, 10000);
        }
      }, 2000);
    }

    function scanOnce() {
      var found = false;
      inspectBudget = 1600;
      inspectSeen = typeof WeakSet !== "undefined" ? new WeakSet() : null;
      // a) lightweight-charts web component
      try {
        var els = document.querySelectorAll("lightweight-chart");
        for (var i = 0; i < els.length; i++) {
          if (els[i] && els[i].chart && captureChart(els[i].chart, els[i])) found = true;
        }
      } catch (_) {}
      // b) React fiber scan on chart containers (bundled lightweight-charts)
      try {
        var containers = document.querySelectorAll("[class*='tv-lightweight-charts'], [class*='chart']");
        for (var c = 0; c < containers.length && c < 80; c++) {
          var inst = fiberScan(containers[c]);
          if (inst && captureChart(inst, containers[c])) found = true;
        }
      } catch (_) {}
      // b2) climb from the big canvases themselves — the definitive chart
      // leaf — up the ancestor chain looking for React fiber state.
      try {
        var canvases = document.querySelectorAll("canvas");
        for (var v = 0; v < canvases.length && v < 12; v++) {
          var cnode = canvases[v];
          for (var up = 0; cnode && up < 8; up++) {
            var viaCanvas = fiberScan(cnode);
            if (viaCanvas && captureChart(viaCanvas, cnode)) found = true;
            cnode = cnode.parentElement;
          }
        }
      } catch (_) {}
      // c) common window handles
      try {
        var cands = [window.chart, window.qxChart, window.quotexChart, window.tradeChart, window.activeChart];
        for (var j = 0; j < cands.length; j++) {
          if (captureChart(cands[j])) found = true;
        }
      } catch (_) {}
      return found;
    }

    function fiberScan(el) {
      var keys = [];
      try { keys = Object.keys(el); } catch (_) { return null; }
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("__reactFiber$") === 0 || keys[i].indexOf("__reactInternalInstance$") === 0) {
          var found = walkFiber(el[keys[i]], 0);
          if (found) return found;
        }
      }
      return null;
    }

    function walkFiber(fiber, depth) {
      if (!fiber || depth > 60 || inspectBudget <= 0) return null;
      var found = inspectObj(fiber.memoizedProps, 0);
      if (found) return found;
      found = inspectObj(fiber.memoizedState, 0);
      if (found) return found;
      found = inspectObj(fiber.stateNode, 0);
      if (found) return found;
      // Walk parent, first-child, and sibling links. The chart instance is
      // usually created inside a leaf component, so child/sibling links
      // matter as much as the parent chain; inspectBudget bounds the total
      // work so this can not blow up.
      found = fiber.return ? walkFiber(fiber.return, depth + 1) : null;
      if (found) return found;
      found = fiber.child ? walkFiber(fiber.child, depth + 1) : null;
      if (found) return found;
      return fiber.sibling ? walkFiber(fiber.sibling, depth + 1) : null;
    }

    function inspectObj(obj, depth) {
      if (!obj || typeof obj !== "object" || depth > 7 || inspectBudget-- <= 0) return null;
      try {
        if (inspectSeen) {
          if (inspectSeen.has(obj)) return null;
          inspectSeen.add(obj);
        }
        if (isChartLike(obj)) return obj;
        // React hook list / linked structures
        var probe = obj;
        var guard = 0;
        while (probe && probe.next && guard++ < 40) {
          if (isChartLike(probe.next)) return probe.next;
          probe = probe.next;
        }
        // ref objects often carry the chart instance
        if (obj.ref && obj.ref.current && isChartLike(obj.ref.current)) return obj.ref.current;
        var keys = Object.keys(obj);
        var n = Math.min(keys.length, 40);
        for (var i = 0; i < n; i++) {
          var v = obj[keys[i]];
          if (v && typeof v === "object") {
            var r = inspectObj(v, depth + 1);
            if (r) return r;
          }
        }
      } catch (_) {}
      return null;
    }

    // Trap chart-library globals (set by the page's bundle) so any chart
    // created later is captured. Installed synchronously at document_start.
    // The module ref is kept even for builds whose charts never touch our
    // wrappers: v5 marker rendering needs createSeriesMarkers() from it.
    function trapChartGlobal(name) {
      try {
        var _lwc = window[name];
        Object.defineProperty(window, name, {
          configurable: true,
          enumerable: true,
          get: function () { return _lwc; },
          set: function (v) {
            _lwc = v;
            if (name === "LightweightCharts") lwcModule = v;
            if (v && typeof v.createChart === "function" && !_isWrapped(v)) {
              var origCreate = v.createChart;
              v.createChart = function () {
                var container = arguments[0];
                var c = origCreate.apply(this, arguments);
                try { captureChart(c, container); } catch (_) {}
                return c;
              };
              _markWrapped(v);
            }
          },
        });
        if (_lwc && typeof _lwc.createChart === "function" && !_isWrapped(_lwc)) {
          if (name === "LightweightCharts") lwcModule = _lwc;
          var origCreate2 = _lwc.createChart;
          _lwc.createChart = function () {
            var container = arguments[0];
            var c = origCreate2.apply(this, arguments);
            try { captureChart(c, container); } catch (_) {}
            return c;
          };
          _markWrapped(_lwc);
        }
      } catch (_) {}
    }
    trapChartGlobal("LightweightCharts");
    trapChartGlobal("lightweightCharts");

    try {
      window.addEventListener("resize", scheduleOverlayRedraw);
      window.addEventListener("scroll", scheduleOverlayRedraw, true);
    } catch (_) {}

    return {
      captureChart: captureChart,
      applyMarkers: applyMarkers,
      hasChart: hasChart,
      isChartLike: isChartLike,
      mode: function () { return mode; },
      scheduleScan: scheduleScan,
    };
  })();

  function snapshot() {
    return {
      enabled: true,
      status: live.status,
      instruments: live.instruments,
      balance: live.balance,
      orders: live.orders.slice(0, 20),
      ticks: live.ticks,
      candles: live.candles,
      candlesVerified: live.candlesVerified,
      assetIdMap: live.assetIdMap,
      lastWsSymbol: live.lastWsSymbol,
      markersMode: MARKERS.mode(),
      markersChart: MARKERS.hasChart(),
      lastWsPeriod: live.lastWsPeriod,
      activeChart: live.activeChart,
      socket: !!handle.lastWs,
      frames: _cyberFrames.slice(0, 12),
    };
  }

  function isBrokerSocketUrl(url) {
    try {
      var parsed = new URL(String(url || ""), location.href);
      return (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
        Q.isQuotexHost(parsed.hostname) && /\/socket\.io(?:\/|$)/i.test(parsed.pathname);
    } catch (_) { return false; }
  }

  // Install the WebSocket wrapper *synchronously*. Handles text, Blob and
  // binary frames; all decoding happens inside the router. Also wraps
  // `send()` so OUTGOING frames reveal the active asset (see onAsset above).
  var Native = window.WebSocket;
  if (typeof Native === "function") {
    handle.native = Native;
    function Wrapped(url, protocols) {
      var ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      var brokerSocket = isBrokerSocketUrl(url);
      // Binary attachment headers are socket-local. A dedicated router per
      // WebSocket prevents interleaved sockets from stealing each other's
      // pending header/event context.
      var socketRouter = Q.createRouter(routerHandlers);
      if (brokerSocket) { handle.lastWs = ws; handle.router = socketRouter; }
      if (brokerSocket) try { emit("open", { url: url || "" }); } catch (_) {}
      // --- outgoing-frame sniffing: the client's own requests tell us the
      // active asset. This is what makes auto-detection work even when the
      // DOM uses hashed class names or ticks arrive with numeric ids. ---
      var nativeSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          var s = typeof data === "string" ? data : "";
          if (!s && typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer) {
            var u8 = new Uint8Array(data);
            var buf = "";
            for (var bi = 0; bi < u8.length; bi += 0x8000) {
              buf += String.fromCharCode.apply(null, u8.subarray(bi, bi + 0x8000));
            }
            s = buf;
          }
          var hit = s ? Q.sniffOutgoing(s) : null;
          if (hit && hit.symbol) {
            brokerSocket = true;
            handle.lastWs = ws;
            handle.router = socketRouter;
          }
          if (hit && hit.symbol && !internalSubscriptionSend) {
            if (hit.main) selectActiveChart(hit, "ws_out");
            else if (hit.candidate && !live.activeChart) selectActiveChart(hit, "ws_candidate");
            else if (live.activeChart && hit.symbol === live.activeChart.symbol && hit.period &&
                /history\/list\/v2|chart_notification\/get|loadHistoryPeriod/.test(hit.event || "")) {
              // Same selected symbol: learn the visible chart timeframe without
              // allowing another asset's background history to become main.
              selectActiveChart(hit, "ws_period");
            }
          }
        } catch (_) {}
        return nativeSend(data);
      };
      // Stealth: make the wrapped send look native to toString() probes.
      try {
        Object.defineProperty(ws.send, "toString", {
          value: function () { return "function send() { [native code] }"; },
          configurable: true, writable: true,
        });
      } catch (_) {}
      ws.addEventListener("open", function () {
        if (brokerSocket && handle.lastWs === ws) try { emit("quotex_status", { state: "open", url: url || "" }); } catch (_) {}
      });
      ws.addEventListener("close", function () {
        var wasCurrent = handle.lastWs === ws;
        if (wasCurrent) handle.lastWs = null;
        if (brokerSocket && wasCurrent) try { emit("quotex_status", { state: "closed", url: url || "" }); } catch (_) {}
      });
      ws.addEventListener("message", function (ev) {
        if (brokerSocket && handle.lastWs === ws) try { socketRouter.feedRaw(ev.data); } catch (_) {}
      });
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;
    try { Object.setPrototypeOf(Wrapped, Native); } catch (_) {}
    // Stealth: make toString() and name indistinguishable from the real constructor.
    try {
      Object.defineProperty(Wrapped, "name", { value: "WebSocket", configurable: true });
      Object.defineProperty(Wrapped, "toString", {
        value: function () { return "function WebSocket() { [native code] }"; },
        configurable: true, writable: true,
      });
    } catch (_) {}
    handle.wrapper = Wrapped;
    window.WebSocket = Wrapped;
  }

  // Stealth: internal handle is non-enumerable (invisible to Object.keys(window)).
  try {
    Object.defineProperty(_G, "_\u0078kh", {
      value: {
        adapter: Q,
        handle: handle,
        router: router,
        live: live,
        snapshot: snapshot,
        markers: MARKERS,
        detach: function () {
          if (handle.wrapper && window.WebSocket === handle.wrapper) window.WebSocket = handle.native;
          try { Object.defineProperty(_G, _HK, { value: false, enumerable: false, configurable: true, writable: true }); } catch (_) {}
        },
      },
      enumerable: false, configurable: true, writable: true,
    });
  } catch (_) {}

  // v2.3.3: try to capture the platform chart (web component / React fiber /
  // window handles) — the LightweightCharts.createChart trap above already
  // covers global-library builds.
  MARKERS.scheduleScan();

  emit("adapter_status", { loaded: true });

  // Answer content-script requests. The extension may attach after the
  // page's socket already connected, so:
  //   - sync_request  → replay accumulated state (instruments / balance /
  //                     candles / orders / status) so nothing is lost.
  //   - subscribe     → ask the broker for history + live ticks on the
  //                     page's own socket (mirrors the web client's frames).
  //   - place_ws      → send a real `orders/open` frame on the page socket.
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== _SRC_IN) return;
    if (ev.data.kind === "sync_request") {
      emit("snapshot", snapshot());
    } else if (ev.data.kind === "subscribe") {
      var sub = ev.data.payload || {};
      internalSubscriptionSend = true;
      var r;
      try { r = Q.subscribeHistory(handle.lastWs, sub.asset, sub.period, sub.limit); }
      finally { internalSubscriptionSend = false; }
      emit("subscribe_result", {
        requestId: sub.requestId != null ? String(sub.requestId).slice(0, 128) : "",
        asset: sub.asset != null ? String(sub.asset).slice(0, 96) : "",
        ok: !!(r && r.ok),
        payload: r || {},
      });
    } else if (ev.data.kind === "place_ws") {
      var args = ev.data.payload && typeof ev.data.payload === "object" ? ev.data.payload : {};
      var reqId = args.requestId != null ? String(args.requestId).slice(0, 128) : "";
      var res;
      if (!reqId) {
        res = { ok: false, confirmed: false, error: "request id required" };
      } else if (seenPlacementIds[reqId]) {
        res = { ok: false, confirmed: false, sent: true, error: "duplicate placement request" };
      } else {
        seenPlacementIds[reqId] = true;
        seenPlacementOrder.push(reqId);
        while (seenPlacementOrder.length > 500) delete seenPlacementIds[seenPlacementOrder.shift()];
        res = Q.placeTradeWs(handle.lastWs, args);
      }
      res = res || { ok: false, confirmed: false, error: "no result" };
      res.requestId = reqId;
      emit("ws_result", res);
    } else if (ev.data.kind === "markers") {
      // v2.3.3: non-repainting signal arrows — content script sends the full
      // list for the active asset; render natively or via the overlay.
      MARKERS.applyMarkers(ev.data.payload);
    }
  });

  // MutationObserver on the URL bar (SPA navigation).
  var lastHref = location.href;
  var hrefObserver = setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      try { emit("url", { href: lastHref }); } catch (_) {}
    }
  }, 600);
  window.addEventListener("beforeunload", function () {
    clearInterval(hrefObserver);
  });

  emit("ready", { href: location.href, ua: navigator.userAgent });
})();
