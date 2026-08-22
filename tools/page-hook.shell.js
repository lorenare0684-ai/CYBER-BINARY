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
          var s = typeof data === "string" ? data
            : (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer ? String.fromCharCode.apply(null, new Uint8Array(data)) : null);
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
      detach: function () {
        if (handle.wrapper && window.WebSocket === handle.wrapper) window.WebSocket = handle.native;
        window.__CYBER_WS_HOOK__ = false;
      },
    };
  } catch (_) {}

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
