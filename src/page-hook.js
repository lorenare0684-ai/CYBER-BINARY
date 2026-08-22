/**
 * Runs in the page world so it can wrap Quotex WebSocket constructors.
 */
(function () {
  if (window.__CYBER_WS_HOOK__) return;
  window.__CYBER_WS_HOOK__ = true;

  function emit(kind, payload) {
    try {
      window.postMessage({ source: "CYBER_BINARY_HOOK", kind, payload }, "*");
    } catch (_) {}
  }

  function scanText(text) {
    if (!text || typeof text !== "string") return;
    if (text.length > 8000) text = text.slice(0, 8000);
    const nums = text.match(/"?(?:value|price|close|quote|current)"?\s*[:=]\s*"?(\d+\.\d+)/gi);
    if (nums && nums.length) {
      const last = nums[nums.length - 1].match(/(\d+\.\d+)/);
      if (last) emit("tick", { price: parseFloat(last[1]), raw: "ws" });
    }
  }

  const Native = window.WebSocket;
  if (typeof Native === "function") {
    function Wrapped(url, protocols) {
      const ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      ws.addEventListener("message", function (ev) {
        try {
          if (typeof ev.data === "string") scanText(ev.data);
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

  emit("ready", { href: location.href });
})();
