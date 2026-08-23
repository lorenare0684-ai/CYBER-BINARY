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
  if (window.__CYBER_WS_HOOK__) return;
  window.__CYBER_WS_HOOK__ = true;

  var Q = window.CYBER_QUOTEX;
  if (!Q || typeof Q.createRouter !== "function") {
    // Should never happen (adapter is inlined above), but keep a graceful
    // fallback for third-party tampering.
    return;
  }

  function emit(kind, payload) {
    try {
      window.postMessage({ source: "CYBER_BINARY_HOOK", kind: kind, payload: payload }, "*");
    } catch (_) {}
  }

  var live = {
    candles: Object.create(null), // asset@period -> latest candles array
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
      if (!msg || !msg.asset) return;
      var key = msg.asset + "@" + (msg.period || 60);
      live.candles[key] = Array.isArray(msg.candles) ? msg.candles.slice(-400) : [];
      var oldKeyAt = candleKeyOrder.indexOf(key);
      if (oldKeyAt >= 0) candleKeyOrder.splice(oldKeyAt, 1);
      candleKeyOrder.push(key);
      while (candleKeyOrder.length > 12) delete live.candles[candleKeyOrder.shift()];
      // History is low-frequency and remains available per asset/timeframe;
      // it never changes activeChart.
      emit("candle", { asset: msg.asset, period: msg.period, candles: live.candles[key] });
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
        if (!window.__cyber_frames) window.__cyber_frames = [];
        window.__cyber_frames.unshift({
          at: Date.now(),
          label: label,
          preview: frame && frame.raw ? String(frame.raw).slice(0, 160) : "",
        });
        if (window.__cyber_frames.length > 20) window.__cyber_frames.length = 20;
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
   *   1. native `series.setMarkers()` — best: the chart scrolls/zooms and
   *      the arrows stay glued to their bars;
   *   2. an overlay canvas above the price chart (approximate mapping from
   *      the feed bars the content script sends alongside the markers).
   * The chart instance is captured by:
   *   a. wrapping window.LightweightCharts.createChart at document_start
   *      (the page-hook runs in the MAIN world before page scripts);
   *   b. `<lightweight-chart>` web components (chart property);
   *   c. a bounded React-fiber scan of the chart container (bundled builds
   *      that never expose the library globally).
   * ==================================================================== */
  var MARKERS = (function () {
    var chart = null;        // selected (largest visible) lightweight-charts IChartApi
    var chartContainer = null;
    var series = null;       // main price series (the one that accepts setMarkers)
    var nativeList = [];     // last normalized native marker list
    var lastPayload = null;  // raw { asset, markers, bars } from content
    var overlay = null;      // { el, canvas, ctx, target }
    var mode = "none";       // "native" | "overlay" | "none"
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
      return !!s && typeof s === "object" && typeof s.setMarkers === "function";
    }

    function findExistingSeries(c) {
      try {
        var arr = c.series();
        if (Array.isArray(arr) && arr.length && isSeriesLike(arr[0])) return arr[0];
      } catch (_) {}
      try {
        var keys = Object.keys(c);
        var n = Math.min(keys.length, 40);
        for (var i = 0; i < n; i++) {
          var v = c[keys[i]];
          if (Array.isArray(v)) {
            for (var j = 0; j < v.length && j < 20; j++) if (isSeriesLike(v[j])) return v[j];
          } else if (isSeriesLike(v)) return v;
        }
      } catch (_) {}
      return null;
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
      series = findExistingSeries(c);
      // Wrap series adders so a re-created main series (asset / timeframe
      // switch) is captured too. Candlestick/bar adders REPLACE the marker
      // target (they are the price chart); overlays (line/area/…/addSeries)
      // only fill in if we have no target yet.
      var names = ["addCandlestickSeries", "addBarSeries", "addLineSeries",
        "addAreaSeries", "addBaselineSeries", "addHistogramSeries", "addSeries"];
      for (var i = 0; i < names.length; i++) (function (n) {
        var orig = c[n];
        if (typeof orig !== "function" || orig.__cyberWrapped) return;
        c[n] = function () {
          var s = orig.apply(this, arguments);
          if (isSeriesLike(s)) {
            if (n === "addCandlestickSeries" || n === "addBarSeries") series = s;
            else if (!series) series = s;
          }
          return s;
        };
        try { c[n].__cyberWrapped = true; } catch (_) {}
      })(names[i]);
      if (series) applyNative();
      return true;
    }

    function hasChart() { return !!chart; }

    /** Raw markers -> lightweight-charts setMarkers() format. */
    function normalize(list) {
      var byTime = Object.create(null);
      var arr = Array.isArray(list) ? list.slice(-MAX) : [];
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        var time = Number(m && m.time);
        if (!m || (m.dir !== "CALL" && m.dir !== "PUT") || !Number.isFinite(time) || time <= 0) continue;
        while (time >= 1e14) time /= 1000;
        var sec = Math.floor(time >= 1e11 ? time / 1000 : time);
        if (!Number.isSafeInteger(sec) || sec <= 0) continue;
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
        markers: Array.isArray(payload.markers) ? payload.markers.slice(-MAX) : [],
        bars: Array.isArray(payload.bars) ? payload.bars.slice(-400) : [],
      } : null;
      var chartMismatch = !!(lastPayload && lastPayload.asset && live.activeChart && live.activeChart.symbol &&
        Q.normalizeSymbol(lastPayload.asset) !== Q.normalizeSymbol(live.activeChart.symbol));
      nativeList = chartMismatch ? [] : normalize(lastPayload && lastPayload.markers);
      // The platform may have recreated the main series (asset/timeframe
      // switch) since the last markers message — re-resolve it if needed.
      if (!series && chart) series = findExistingSeries(chart);
      if (series && typeof series.setMarkers === "function") {
        try {
          series.setMarkers(nativeList);
          mode = "native";
          hideOverlay();
          return;
        } catch (_) { /* some builds throw on setMarkers — fall back */ }
      }
      mode = "overlay";
      drawOverlay();
    }

    function applyNative() {
      if (!series || typeof series.setMarkers !== "function") return;
      try {
        series.setMarkers(nativeList);
        mode = "native";
        hideOverlay();
      } catch (_) {
        mode = "overlay";
        drawOverlay();
      }
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
      var target = findChartCanvas();
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
      for (var k = 0; k < markers.length; k++) {
        var m = markers[k];
        var markerTime = Number(m && m.time), markerPrice = Number(m && m.price);
        if (!m || (m.dir !== "CALL" && m.dir !== "PUT") || !Number.isFinite(markerTime) ||
            !Number.isFinite(markerPrice) || markerPrice <= 0) continue;
        while (markerTime >= 1e14) markerTime /= 1000;
        if (markerTime < 1e11) markerTime *= 1000;
        if (markerTime < t0 || markerTime > t1) continue;
        var x = ((markerTime - t0) / (t1 - t0)) * W;
        var y = H - ((markerPrice - lo) / (hi - lo)) * H;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
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
        // Keep scanning briefly after the first capture: multi-chart layouts
        // often mount mini charts first and the large main chart later.
        if (tries > 12) { clearInterval(scanTimer); scanTimer = null; }
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
      if (!fiber || depth > 60) return null;
      var found = inspectObj(fiber.memoizedProps, 0);
      if (found) return found;
      found = inspectObj(fiber.memoizedState, 0);
      if (found) return found;
      found = inspectObj(fiber.stateNode, 0);
      if (found) return found;
      // Only walk the `return` chain (parent components) — bounded and
      // linear, avoids exponential blowup from child/sibling traversal.
      if (fiber.return) return walkFiber(fiber.return, depth + 1);
      return null;
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

    // Trap window.LightweightCharts (set by the page's bundle) so any chart
    // created later is captured. Installed synchronously at document_start.
    try {
      var _lwc = window.LightweightCharts;
      Object.defineProperty(window, "LightweightCharts", {
        configurable: true,
        enumerable: true,
        get: function () { return _lwc; },
        set: function (v) {
          _lwc = v;
          if (v && typeof v.createChart === "function" && !v.__cyberWrapped) {
            var origCreate = v.createChart;
            v.createChart = function () {
              var container = arguments[0];
              var c = origCreate.apply(this, arguments);
              try { captureChart(c, container); } catch (_) {}
              return c;
            };
            try { v.__cyberWrapped = true; } catch (_) {}
          }
        },
      });
      if (_lwc && typeof _lwc.createChart === "function" && !_lwc.__cyberWrapped) {
        var origCreate2 = _lwc.createChart;
        _lwc.createChart = function () {
          var container = arguments[0];
          var c = origCreate2.apply(this, arguments);
          try { captureChart(c, container); } catch (_) {}
          return c;
        };
        try { _lwc.__cyberWrapped = true; } catch (_) {}
      }
    } catch (_) {}

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
      assetIdMap: live.assetIdMap,
      lastWsSymbol: live.lastWsSymbol,
      lastWsPeriod: live.lastWsPeriod,
      activeChart: live.activeChart,
      socket: !!handle.lastWs,
      frames: (window.__cyber_frames || []).slice(0, 12),
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
    handle.wrapper = Wrapped;
    window.WebSocket = Wrapped;
  }

  try {
    window.__cyber = {
      adapter: Q,
      handle: handle,
      router: router,
      live: live,
      snapshot: snapshot,
      markers: MARKERS,
      detach: function () {
        if (handle.wrapper && window.WebSocket === handle.wrapper) window.WebSocket = handle.native;
        window.__CYBER_WS_HOOK__ = false;
      },
    };
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
    if (ev.source !== window || !ev.data || ev.data.source !== "CYBER_BINARY_CONTENT") return;
    if (ev.data.kind === "sync_request") {
      emit("snapshot", snapshot());
    } else if (ev.data.kind === "subscribe") {
      var sub = ev.data.payload || {};
      internalSubscriptionSend = true;
      var r;
      try { r = Q.subscribeHistory(handle.lastWs, sub.asset, sub.period); }
      finally { internalSubscriptionSend = false; }
      emit("subscribe_result", { ok: !!(r && r.ok), payload: r || {} });
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
