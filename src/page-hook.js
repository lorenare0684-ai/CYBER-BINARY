/**
 * Runs in the page world so it can wrap Quotex WebSocket constructors.
 * Extracts: ticks, asset symbols, candles when available.
 */
(function () {
  if (window.__CYBER_WS_HOOK__) return;
  window.__CYBER_WS_HOOK__ = true;

  function emit(kind, payload) {
    try {
      window.postMessage({ source: "CYBER_BINARY_HOOK", kind, payload }, "*");
    } catch (_) {}
  }

  // Try a handful of patterns to pull a price out of any string payload.
  function scanText(text) {
    if (!text || typeof text !== "string") return null;
    if (text.length > 12000) text = text.slice(0, 12000);

    // Common Quotex-shaped JSON
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

  // Try to extract an asset symbol (e.g. "EURUSD_otc", "BTCUSD", etc.)
  function scanSymbol(text) {
    if (!text || typeof text !== "string") return null;
    if (text.length > 12000) text = text.slice(0, 12000);
    const m = text.match(/"(?:asset|symbol|pair|instrument|ticker)"\s*:\s*"([^"]{3,16})"/i);
    return m ? m[1] : null;
  }

  const Native = window.WebSocket;
  if (typeof Native === "function") {
    function Wrapped(url, protocols) {
      const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      const meta = { url: url || "" };
      try { emit("open", meta); } catch (_) {}
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

  // MutationObserver on the URL bar (SPA navigation).
  let lastHref = location.href;
  const hrefObserver = setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      try { emit("url", { href: lastHref }); } catch (_) {}
    }
  }, 600);
  // Survive long-lived pages
  window.addEventListener("beforeunload", function () {
    clearInterval(hrefObserver);
  });

  emit("ready", { href: location.href, ua: navigator.userAgent });
})();
