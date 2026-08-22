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
    candles: {},      // asset@period -> latest candles array
    ticks: {},        // asset -> last tick { price, time }
    instruments: [],  // broker-discovered instruments
    balance: null,
    orders: [],       // rolling list of recent orders (last 50)
    status: { state: "idle", url: null },
    assetIdMap: {},   // broker numeric id -> symbol
    lastWsSymbol: null, // most recent asset seen on the socket (in or out)
  };

  var handle = {
    native: null,
    wrapper: null,
    router: null,
    lastWs: null,
    pending: function () { return handle.router ? handle.router.pending() : null; },
  };

  var router = Q.createRouter({
    onStatus: function (s) {
      live.status = s || live.status;
      emit("quotex_status", s || {});
    },
    onCandle: function (msg) {
      if (!msg || !msg.asset) return;
      var key = msg.asset + "@" + (msg.period || 60);
      live.candles[key] = msg.candles || [];
      // Incoming history payloads name their asset — another reliable
      // active-asset signal (covers builds that never stream quotes/stream).
      live.lastWsSymbol = msg.asset;
      emit("asset", { symbol: msg.asset, raw: "ws_candle" });
      emit("candle", { asset: msg.asset, period: msg.period, candles: msg.candles });
    },
    onTick: function (q) {
      if (!q || !q.symbol) return;
      live.ticks[q.symbol] = q;
      emit("tick", { price: q.price, symbol: q.symbol, time: q.time, raw: "ws" });
      // Also emit an `asset` message so content.js keeps the active asset up-to-date.
      emit("asset", { symbol: q.symbol, raw: "ws" });
    },
    onInstruments: function (list) {
      live.instruments = list || [];
      live.assetIdMap = {};
      for (var i = 0; i < (list || []).length; i++) {
        var it = list[i];
        if (it && it.symbol) live.assetIdMap[it.id] = it.symbol;
      }
      // Learn broker ids so numeric tick rows ([id, ts, price]) resolve.
      try { if (Q.rememberIds) Q.rememberIds(list); } catch (_) {}
      emit("instruments", list || []);
    },
    onAsset: function (symbol) {
      // Active-asset hint from OUTGOING frames (the web client tells the
      // server which asset it charts — the most reliable detector of all).
      if (!symbol) return;
      live.lastWsSymbol = symbol;
      emit("asset", { symbol: symbol, raw: "ws_out" });
    },
    onBalance: function (b) {
      live.balance = b;
      emit("balance", b);
    },
    onOrder: function (e) {
      if (!e) return;
      live.orders.unshift(e);
      if (live.orders.length > 50) live.orders.length = 50;
      emit("order", e);
    },
    onFrame: function (label, payload, frame) {
      // Reserved for debugging — keep the last 20 frames for the dashboard.
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
  });
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
    var chart = null;        // lightweight-charts IChartApi
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

    function captureChart(c) {
      if (!isChartLike(c)) return false;
      if (chart === c) return true;
      chart = c;
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
      var arr = Array.isArray(list) ? list : [];
      for (var i = 0; i < arr.length; i++) {
        var m = arr[i];
        if (!m || m.time == null || !isFinite(m.time)) continue;
        var sec = Math.floor(Number(m.time) / 1000);
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
      lastPayload = payload || null;
      nativeList = normalize(lastPayload && lastPayload.markers);
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
        drawOverlay();
      }
    }

    /* ---------- overlay fallback ---------- */
    function findChartCanvas() {
      var all = document.querySelectorAll("canvas");
      for (var i = 0; i < all.length; i++) {
        try {
          var r = all[i].getBoundingClientRect();
          if (r && r.width > 240 && r.height > 140) return all[i];
        } catch (_) {}
      }
      return null;
    }

    function ensureOverlay() {
      if (overlay && overlay.el && overlay.el.isConnected) return overlay;
      overlay = null;
      var target = findChartCanvas();
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
      var dpr = window.devicePixelRatio || 1;
      ov.canvas.width = Math.floor(rect.width * dpr);
      ov.canvas.height = Math.floor(rect.height * dpr);
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
        if (!m || m.time == null || m.price == null) continue;
        if (m.time < t0 || m.time > t1) continue;
        var x = ((m.time - t0) / (t1 - t0)) * W;
        var y = H - ((m.price - lo) / (hi - lo)) * H;
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
    function scheduleScan() {
      if (scanTimer) return;
      var tries = 0;
      scanTimer = setInterval(function () {
        tries++;
        try {
          if (hasChart() || scanOnce()) { clearInterval(scanTimer); scanTimer = null; return; }
        } catch (_) {}
        if (tries > 30) { clearInterval(scanTimer); scanTimer = null; }
      }, 2000);
    }

    function scanOnce() {
      // a) lightweight-charts web component
      try {
        var els = document.querySelectorAll("lightweight-chart");
        for (var i = 0; i < els.length; i++) {
          if (els[i] && els[i].chart && captureChart(els[i].chart)) return true;
        }
      } catch (_) {}
      // b) React fiber scan on chart containers (bundled lightweight-charts)
      try {
        var containers = document.querySelectorAll("[class*='tv-lightweight-charts'], [class*='chart']");
        for (var c = 0; c < containers.length; c++) {
          var inst = fiberScan(containers[c]);
          if (inst && captureChart(inst)) return true;
        }
      } catch (_) {}
      // c) common window handles
      try {
        var cands = [window.chart, window.qxChart, window.quotexChart, window.tradeChart, window.activeChart];
        for (var j = 0; j < cands.length; j++) {
          if (captureChart(cands[j])) return true;
        }
      } catch (_) {}
      return false;
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
      if (!obj || typeof obj !== "object" || depth > 7) return null;
      try {
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
              var c = origCreate.apply(this, arguments);
              try { captureChart(c); } catch (_) {}
              return c;
            };
            try { v.__cyberWrapped = true; } catch (_) {}
          }
        },
      });
      if (_lwc && typeof _lwc.createChart === "function" && !_lwc.__cyberWrapped) {
        var origCreate2 = _lwc.createChart;
        _lwc.createChart = function () {
          var c = origCreate2.apply(this, arguments);
          try { captureChart(c); } catch (_) {}
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
      socket: !!handle.lastWs,
      frames: (window.__cyber_frames || []).slice(0, 12),
    };
  }

  // Install the WebSocket wrapper *synchronously*. Handles text, Blob and
  // binary frames; all decoding happens inside the router. Also wraps
  // `send()` so OUTGOING frames reveal the active asset (see onAsset above).
  var Native = window.WebSocket;
  if (typeof Native === "function") {
    handle.native = Native;
    function Wrapped(url, protocols) {
      var ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      handle.lastWs = ws;
      try { emit("open", { url: url || "" }); } catch (_) {}
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
            live.lastWsSymbol = hit.symbol;
            emit("asset", { symbol: hit.symbol, raw: "ws_out", event: hit.event });
          }
        } catch (_) {}
        return nativeSend(data);
      };
      ws.addEventListener("open", function () {
        try { emit("quotex_status", { state: "open", url: url || "" }); } catch (_) {}
      });
      ws.addEventListener("close", function () {
        try { emit("quotex_status", { state: "closed", url: url || "" }); } catch (_) {}
      });
      ws.addEventListener("message", function (ev) {
        try { router.feedRaw(ev.data); } catch (_) {}
      });
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;
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
    if (!ev.data || ev.data.source !== "CYBER_BINARY_CONTENT") return;
    if (ev.data.kind === "sync_request") {
      emit("snapshot", snapshot());
    } else if (ev.data.kind === "subscribe") {
      var sub = ev.data.payload || {};
      var r = Q.subscribeHistory(handle.lastWs, sub.asset, sub.period);
      emit("subscribe_result", { ok: !!(r && r.ok), payload: r || {} });
    } else if (ev.data.kind === "place_ws") {
      var args = ev.data.payload || {};
      var reqId = args.requestId;
      var res = Q.placeTradeWs(handle.lastWs, args);
      res = res || { ok: false, error: "no result" };
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
