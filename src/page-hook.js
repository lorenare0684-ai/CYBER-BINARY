/**
 * v2.1 — Runs in the page world so it can wrap Quotex WebSocket constructors.
 *
 * Loads the CYBER_QUOTEX adapter from the extension's web-accessible
 * resources and hooks every page-owned WebSocket. The adapter normalizes
 * Socket.IO v3 frames (engine.io control, `42["event", payload]`,
 * `451-["event"]` headers, `\x04<json>` bodies) and routes them to typed
 * event handlers. We forward the same events to the content script via
 * `window.postMessage`.
 *
 * The hook itself stays small and idempotent — it does no decoding of its
 * own. The content script can read `window.__cyber` (set below) for the
 * live adapter handle and the most recent state.
 */
(function () {
  if (window.__CYBER_WS_HOOK__) return;
  window.__CYBER_WS_HOOK__ = true;

  function emit(kind, payload) {
    try {
      window.postMessage({ source: "CYBER_BINARY_HOOK", kind, payload }, "*");
    } catch (_) {}
  }

  // Load the adapter from the extension, then wire it up.
  function loadAdapter(cb) {
    if (window.CYBER_QUOTEX) return cb(window.CYBER_QUOTEX);
    try {
      const url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL("src/lib/quotex.js")
        : "src/lib/quotex.js";
      const s = document.createElement("script");
      s.src = url;
      s.onload = function () {
        s.remove();
        cb(window.CYBER_QUOTEX || null);
      };
      s.onerror = function () { s.remove(); cb(null); };
      (document.head || document.documentElement).appendChild(s);
    } catch (_) { cb(null); }
  }

  // Fallback text scraper (used only if the adapter fails to load).
  function scanText(text) {
    if (!text || typeof text !== "string") return null;
    if (text.length > 12000) text = text.slice(0, 12000);
    const patterns = [
      /"price"\s*:\s*"?(\d+\.?\d+)/i,
      /"value"\s*:\s*"?(\d+\.?\d+)/i,
      /"close"\s*:\s*"?(\d+\.?\d+)/i,
      /"current"\s*:\s*"?(\d+\.?\d+)/i,
      /"bid"\s*:\s*"?(\d+\.?\d+)/i,
      /"ask"\s*:\s*"?(\d+\.?\d+)/i,
    ];
    for (const p of patterns) {
      const m = text.match(p);
      if (m) return parseFloat(m[1]);
    }
    return null;
  }
  function scanSymbol(text) {
    if (!text || typeof text !== "string") return null;
    if (text.length > 12000) text = text.slice(0, 12000);
    const m = text.match(/"(?:asset|symbol|pair|instrument|ticker)"\s*:\s*"([^"]{3,16})"/i);
    return m ? m[1] : null;
  }

  loadAdapter(function (Q) {
    if (!Q) {
      // Fallback to the original behavior.
      const Native = window.WebSocket;
      if (typeof Native === "function") {
        function Wrapped(url, protocols) {
          const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
          try { emit("open", { url: url || "" }); } catch (_) {}
          ws.addEventListener("message", function (ev) {
            try {
              if (typeof ev.data !== "string") return;
              const price = scanText(ev.data);
              if (price) emit("tick", { price, raw: "ws" });
              const sym = scanSymbol(ev.data);
              if (sym) emit("asset", { symbol: sym, raw: "ws" });
            } catch (_) {}
          });
          return ws;
        }
        Wrapped.prototype = Native.prototype;
        Wrapped.CONNECTING = Native.CONNECTING;
        Wrapped.OPEN = Native.OPEN;
        Wrapped.CLOSING = Native.CLOSING;
        Wrapped.CLOSED = Native.CLOSED;
        window.WebSocket = Wrapped;
      }
      emit("adapter_status", { loaded: false });
      return;
    }

    // Real path: hook the WebSocket constructor and dispatch events.
    const live = {
      candles: {},     // asset -> latest candles array (per timeframe)
      ticks: {},       // asset -> last tick { price, time }
      instruments: [], // broker-discovered instruments
      balance: null,
      orders: [],      // rolling list of recent orders (last 50)
      status: { state: "idle", url: null },
      assetIdMap: {},  // broker numeric id -> symbol
    };

    const result = Q.attachPageSocket({
      onStatus: function (s) {
        live.status = s || live.status;
        emit("quotex_status", s || {});
      },
      onCandle: function (msg) {
        if (!msg || !msg.asset) return;
        const key = msg.asset + "@" + (msg.period || 60);
        live.candles[key] = msg.candles || [];
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
        for (const it of (list || [])) {
          if (it && it.symbol) live.assetIdMap[it.id] = it.symbol;
        }
        emit("instruments", list || []);
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
        // Reserved for future debugging — keep the last 20 frames for the dashboard.
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

    // Expose the live state to the content script and the dashboard.
    try {
      window.__cyber = {
        adapter: Q,
        handle: result && result.handle,
        live: live,
        detach: function () { if (result && result.detach) result.detach(); },
      };
    } catch (_) {}

    emit("adapter_status", { loaded: true, url: result && result.handle && result.handle.url ? result.handle.url : null });
  });

  // MutationObserver on the URL bar (SPA navigation).
  let lastHref = location.href;
  const hrefObserver = setInterval(function () {
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
