/**
 * CYBER BINARY v2.1 — Quotex adapter.
 *
 * Pure library (no side effects on import). Wires the extension to a real
 * Quotex.io / QxBroker.com trading page. The adapter:
 *
 *   - Decodes the page's Socket.IO v3 frames (`0{...}` engine.io open,
 *     `40` connect, `2`/`3` ping/pong, `42["event", payload]` and the
 *     `451-["event",{_placeholder:true}]` header that announces a
 *     following `\\x04<json>` binary payload).
 *
 *   - Hooks the page's `window.WebSocket` constructor (no separate
 *     connection; no broker credentials are ever read, stored, or
 *     sent by the extension).
 *
 *   - Knows the full Quotex asset catalog (84 assets, including the
 *     `_otc` synthetic variants), with the broker-internal numeric IDs.
 *
 *   - Locates the live trading panel in the DOM (asset, price, stake,
 *     expiry, CALL/PUT buttons, balance) and offers a `placeTrade()`
 *     that prefers a real `orders/open` Socket.IO frame, falling back
 *     to clicking the visible button.
 *
 *   - Exposes a typed event bus (candles / ticks / instruments /
 *     balance / orders / status) that the page-hook can rebroadcast
 *     to the content script via `window.postMessage`.
 *
 * Educational only. No SSID is ever read from the page or sent by the
 * extension. To place a real trade without a DOM click we need the
 * session token, and we only get that by inspecting what the page
 * itself sends over its own socket — never by prompting the user.
 *
 * Pure functions, no module-level state except the catalog.
 */
(function (root) {
  "use strict";

  /* ============================================================
   * 1. Asset catalog (from quotexapi constants — official IDs).
   * ============================================================ */
  var ASSET_IDS = {
    "ADAUSD_otc": 376, "APTUSD_otc": 377, "ARBUSD_otc": 378, "ATOUSD_otc": 368,
    "AUDCAD": 36, "AUDCAD_otc": 67, "AUDCHF": 37, "AUDCHF_otc": 68,
    "AUDJPY": 38, "AUDJPY_otc": 69, "AUDNZD": 39, "AUDNZD_otc": 70,
    "AUDUSD": 40, "AUDUSD_otc": 71, "AXJAUD": 315, "AXP_otc": 291,
    "BA_otc": 292, "BCHUSD_otc": 363, "BNBUSD_otc": 362, "BONUSD_otc": 358,
    "BRLUSD_otc": 332, "BTCUSD_otc": 352, "CADCHF": 41, "CADCHF_otc": 72,
    "CADJPY": 42, "CADJPY_otc": 73, "CHFJPY": 43, "CHFJPY_otc": 74,
    "CHIA50": 328, "DJIUSD": 317, "DOGUSD_otc": 353, "ETHUSD_otc": 360,
    "EURAUD": 44, "EURAUD_otc": 75, "EURCAD": 45, "EURCAD_otc": 76,
    "EURCHF": 46, "EURCHF_otc": 77, "EURGBP": 47, "EURGBP_otc": 78,
    "EURJPY": 48, "EURJPY_otc": 79, "EURNZD": 49, "EURNZD_otc": 80,
    "EURSGD": 123, "EURSGD_otc": 303, "EURUSD": 1, "EURUSD_otc": 66,
    "F40EUR": 318, "FB_otc": 187, "FLOUSD_otc": 356, "FTSGBP": 319,
    "GBPAUD": 51, "GBPAUD_otc": 81, "GBPCAD": 52, "GBPCAD_otc": 82,
    "GBPCHF": 53, "GBPCHF_otc": 83, "GBPJPY": 54, "GBPJPY_otc": 84,
    "GBPUSD": 56, "GBPUSD_otc": 86, "GEREUR": 316, "HSIHKD": 320,
    "IBXEUR": 321, "INTC_otc": 190, "IT4EUR": 326, "JNJ_otc": 296,
    "JPXJPY": 327, "MCD_otc": 175, "MSFT_otc": 176, "NDXUSD": 322,
    "NZDJPY": 58, "NZDJPY_otc": 89, "NZDUSD": 60, "NZDUSD_otc": 90,
    "PFE_otc": 297, "SPXUSD": 323, "STXEUR": 325, "UKBrent_otc": 164,
    "USCrude_otc": 165, "USDCAD": 61, "USDCAD_otc": 91, "USDCHF": 62,
    "USDCHF_otc": 92, "USDJPY": 63, "USDJPY_otc": 93, "XAGUSD": 65,
    "XAGUSD_otc": 167, "XAUUSD": 2, "XAUUSD_otc": 169, "XRPUSD_otc": 364,
    "AVAUSD_otc": 379, "AXSUSD_otc": 380,
  };

  var KNOWN_TIMEFRAMES = {
    30: "30s", 60: "1m", 120: "2m", 180: "3m", 300: "5m", 600: "10m",
    900: "15m", 1800: "30m", 2700: "45m", 3600: "1h", 7200: "2h",
    10800: "3h", 14400: "4h",
  };

  // Build reverse index: numeric id -> symbol
  var ID_TO_SYMBOL = {};
  for (var k in ASSET_IDS) {
    if (Object.prototype.hasOwnProperty.call(ASSET_IDS, k)) {
      ID_TO_SYMBOL[ASSET_IDS[k]] = k;
    }
  }

  function isQuotexHost(host) {
    if (!host) return false;
    return /(^|\.)(qxbroker|quotex)\.com$/i.test(host);
  }

  function isQuotexPage() {
    try {
      return isQuotexHost(location.hostname) &&
        /trade|chart|trader|platform|cabinet/i.test(location.pathname + " " + location.href);
    } catch (_) {
      return false;
    }
  }

  /* ============================================================
   * 2. Frame decoder. Accepts either a string or a Uint8Array/ArrayBuffer.
   *
   * Quotex uses Socket.IO v3 (EIO=3) over a single WebSocket. Engine.IO
   * frames are:
   *   0{...}  open
   *   40      connect ack
   *   2       ping (we reply with 3)
   *   3       pong
   *   41      disconnect
   *   42["event", payload]   Socket.IO event
   *   451-["event",{...}]    header announcing a following binary payload
   *   \x04<json>             binary payload body for the announced event
   *
   * The decoder returns either:
   *   null  — not a Quotex-shaped frame
   *   {type:"eio",   kind, ...}      engine.io control
   *   {type:"sio",   event, payload} socket.io event (text)
   *   {type:"hdr",   event, payload} 451- header (sets next-event context)
   *   {type:"bin",   event?, payload} binary body after a header (or headerless)
   *   {type:"unknown", raw}          anything else we couldn't classify
   * ============================================================ */
  function asString(raw) {
    if (typeof raw === "string") return raw;
    if (raw == null) return "";
    if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) {
      try { return String.fromCharCode.apply(null, new Uint8Array(raw)); } catch (_) { return ""; }
    }
    if (typeof Uint8Array !== "undefined" && raw instanceof Uint8Array) {
      try { return String.fromCharCode.apply(null, raw); } catch (_) { return ""; }
    }
    if (typeof Blob !== "undefined" && raw && typeof raw.text === "function") {
      // async path — return a sentinel; caller will await `raw.text()`
      return "";
    }
    try { return String(raw); } catch (_) { return ""; }
  }

  function safeJSON(s) {
    if (!s || typeof s !== "string") return null;
    try { return JSON.parse(s); } catch (_) { return null; }
  }

  function decodeFrame(raw) {
    var s = asString(raw);
    if (!s) return null;

    // Engine.IO open: 0{...}
    if (s.charAt(0) === "0" && s.length > 1 && s.charAt(1) === "{" ) {
      var p = safeJSON(s.slice(1));
      return { type: "eio", kind: "open", payload: p, raw: s };
    }
    // Engine.IO ping/pong
    if (s === "2") return { type: "eio", kind: "ping", raw: s };
    if (s === "3") return { type: "eio", kind: "pong", raw: s };
    // Socket.IO connect ack
    if (s === "40" || s.indexOf("40") === 0) {
      var p2 = null;
      if (s.length > 2) p2 = safeJSON(s.slice(2));
      return { type: "eio", kind: "connect", payload: p2, raw: s };
    }
    // Socket.IO disconnect
    if (s.indexOf("41") === 0) return { type: "eio", kind: "disconnect", raw: s };
    // 451-["event", {...}] binary header
    if (s.indexOf("451-[") === 0) {
      var arr = safeJSON(s.slice(4));
      if (Array.isArray(arr) && arr.length >= 1) {
        return { type: "hdr", event: String(arr[0] || ""), payload: arr[1] || null, raw: s };
      }
      return { type: "unknown", raw: s };
    }
    // 42["event", payload]
    if (s.indexOf("42") === 0) {
      var arr2 = safeJSON(s.slice(2));
      if (Array.isArray(arr2) && arr2.length >= 1) {
        return { type: "sio", event: String(arr2[0] || ""), payload: arr2.length > 1 ? arr2[1] : null, raw: s };
      }
      return { type: "unknown", raw: s };
    }
    // Binary body \x04<json>
    if (s.charAt(0) === "\x04" && s.length > 1) {
      var j = safeJSON(s.slice(1));
      return { type: "bin", event: null, payload: j, raw: s };
    }
    return { type: "unknown", raw: s.length > 240 ? s.slice(0, 240) + "…" : s };
  }

  /* ============================================================
   * 3. Message router. Maps a (header, payload) pair to a normalized
   *    event name. Falls back to headerless heuristics for the binary
   *    payload (assets list, quotes, candles, balance).
   * ============================================================ */
  function decodeMessage(event, payload) {
    if (typeof event !== "string") return null;
    var ev = mapEventName(event);
    var out = { event: event, normalized: ev, payload: payload };
    switch (ev) {
      case "instruments": out.instruments = parseInstruments(payload); break;
      case "quote":       out.quote = parseQuote(payload); break;
      case "balance":     out.balance = parseBalance(payload); break;
      case "candles":     {
        var c = parseCandles(payload);
        out.asset = c ? c.asset : null;
        out.period = c ? c.period : null;
        out.candles = c ? normalizeCandles(c) : [];
        break;
      }
      case "order_opened": out.order = parseOrderOpened(payload); break;
      case "order_closed": out.order = parseOrderClosed(payload); break;
    }
    return out;
  }

  function normalizeEvent(frame) {
    if (!frame) return null;
    if (frame.type === "sio") return mapEventName(frame.event);
    if (frame.type === "hdr") return mapEventName(frame.event);
    if (frame.type === "bin") {
      // Headerless? Try to infer from payload shape.
      if (!frame.event) {
        var inferred = inferEventFromPayload(frame.payload);
        return { name: inferred, event: null, payload: frame.payload, kind: "bin" };
      }
      return { name: mapEventName(frame.event), event: frame.event, payload: frame.payload, kind: "bin" };
    }
    return null;
  }

  function mapEventName(ev) {
    if (!ev) return "unknown";
    // Direct mappings observed in the wild
    switch (ev) {
      case "s_authorization":      return "authenticated";
      case "instruments/list":      return "instruments";
      case "s_balance":            return "balance";
      case "balance":              return "balance";
      case "successupdateBalance": return "balance";
      case "s_orders/open":        return "order_opened";
      case "successopenOrder":     return "order_opened";
      case "s_orders/close":       return "order_closed";
      case "successcloseOrder":    return "order_closed";
      case "orders/closed/list":   return "orders_closed_list";
      case "quotes/stream":        return "quote";
      case "history/list/v2":      return "candles";
      case "chart_notification/get": return "candles";
      case "loadHistoryPeriod":    return "candles";
      case "authorization/reject": return "auth_error";
      case "error":                return "error";
      default:                     return ev;
    }
  }

  function inferEventFromPayload(p) {
    if (p == null) return "unknown";
    if (Array.isArray(p)) {
      if (!p.length) return "unknown";
      var first = p[0];
      if (Array.isArray(first) && first.length >= 3) {
        if (typeof first[0] === "string" && typeof first[1] === "number" && typeof first[2] === "number") {
          return "quote"; // quotes/stream shape: [symbol, ts, price, ...]
        }
        if (typeof first[0] === "number" && typeof first[1] === "string" && typeof first[2] === "string") {
          return "instruments"; // [id, symbol, name, ...]
        }
      }
      return "unknown";
    }
    if (typeof p === "object") {
      if ("asset" in p && ("history" in p || "candles" in p || "period" in p)) return "candles";
      if ("uid" in p && "balance" in p) return "balance";
      if ("id" in p && ("openPrice" in p || "openTime" in p)) return "order_opened";
      if ("deals" in p || "ticket" in p) return "order_closed";
    }
    return "unknown";
  }

  /* ============================================================
   * 4. Payload parsers. Each one normalizes the broker-specific
   *    payload into the engine-friendly shape used by content.js.
   * ============================================================ */
  function parseInstruments(payload) {
    if (!Array.isArray(payload)) return [];
    var out = [];
    for (var i = 0; i < payload.length; i++) {
      var row = payload[i];
      if (!Array.isArray(row) || row.length < 3) continue;
      var raw_symbol = String(row[1] || "").trim();
      if (!raw_symbol) continue;
      var symbol = raw_symbol.replace("_OTC", "_otc");
      var id = typeof row[0] === "number" ? row[0] : (parseInt(row[0], 10) || 0);
      var name = String(row[2] || symbol);
      var type = row.length > 3 ? String(row[3] || "unknown") : "unknown";
      var payout = row.length > 5 ? (parseInt(row[5], 10) || 0) : 0;
      var isOpen = row.length > 14 ? !!row[14] : true;
      var tfs = [];
      if (row.length > 12 && Array.isArray(row[12])) {
        for (var j = 0; j < row[12].length; j++) {
          var tf = row[12][j];
          if (Array.isArray(tf) && tf.length) tfs.push(parseInt(tf[0], 10));
          else if (typeof tf === "number") tfs.push(tf);
          else if (typeof tf === "string") tfs.push(parseInt(tf, 10));
        }
      }
      if (row.length > 15 && Array.isArray(row[15])) {
        for (var k2 = 0; k2 < row[15].length; k2++) {
          var t = row[15][k2];
          if (t && typeof t === "object" && "time" in t) tfs.push(parseInt(t.time, 10));
        }
      }
      out.push({
        id: id,
        symbol: symbol,
        name: name,
        type: type,
        payout: payout,
        isOpen: isOpen,
        isOtc: /_otc$/i.test(symbol),
        timeframes: tfs.length ? Array.from(new Set(tfs)).sort(function (a, b) { return a - b; }) : [60, 120, 180, 300, 600, 900, 1800, 3600],
      });
    }
    return out;
  }

  function parseCandles(payload) {
    if (!payload || typeof payload !== "object") return null;
    var asset = payload.asset || payload.symbol || null;
    var period = payload.period || payload.timeframe || null;
    if (!asset || !period) {
      // Some servers push {candles:[...]} without metadata. Caller should know.
      if (Array.isArray(payload.history)) {
        var first = payload.history[0];
        if (Array.isArray(first) && first.length >= 5) {
          // Assume ms epoch
          return { asset: asset, period: 60, raw: payload.history };
        }
      }
      return null;
    }
    var rows = payload.history || payload.candles || [];
    return { asset: String(asset), period: parseInt(period, 10) || 60, raw: rows };
  }

  function normalizeCandles(parsed) {
    if (!parsed || !Array.isArray(parsed.raw)) return [];
    var out = [];
    for (var i = 0; i < parsed.raw.length; i++) {
      var row = parsed.raw[i];
      if (!Array.isArray(row) || row.length < 5) continue;
      // Format seen: [ts, open, low, high, close, vol?]
      // Defensive: also accept [ts, open, high, low, close, vol?]
      var ts = parseFloat(row[0]);
      var o = parseFloat(row[1]);
      var a = parseFloat(row[2]);
      var b = parseFloat(row[3]);
      var c = parseFloat(row[4]);
      if (!Number.isFinite(ts) || !Number.isFinite(o) || !Number.isFinite(c)) continue;
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        a = Math.max(o, c); b = Math.min(o, c);
      } else {
        var hi = Math.max(a, b), lo = Math.min(a, b);
        a = hi; b = lo;
      }
      var vol = row.length > 5 && row[5] != null ? parseFloat(row[5]) : 0;
      // ts is either a unix-seconds value (~1.7e9) or a unix-ms value (~1.7e12).
      var tMs = ts > 1e12 ? Math.floor(ts) : Math.floor(ts * 1000);
      out.push({
        time: tMs,
        open: o, high: a, low: b, close: c,
        volume: Number.isFinite(vol) ? vol : 0,
      });
    }
    return out;
  }

  function parseQuote(payload) {
    if (!Array.isArray(payload) || !payload.length) return null;
    var first = payload[0];
    if (!Array.isArray(first) || first.length < 3) return null;
    if (typeof first[0] !== "string" || typeof first[1] !== "number") return null;
    return {
      symbol: String(first[0]),
      time: first[1] > 2e9 ? Math.floor(first[1] * 1000) : Math.floor(first[1]),
      price: parseFloat(first[2]),
      raw: first,
    };
  }

  function parseBalance(payload) {
    if (!payload || typeof payload !== "object") return null;
    var uid = payload.uid || 0;
    var bal = payload.balance || payload.amount || 0;
    return {
      uid: parseInt(uid, 10) || 0,
      balance: parseFloat(bal) || 0,
      currency: payload.currency || "USD",
      isDemo: payload.isDemo != null ? !!payload.isDemo : (payload.is_demo != null ? !!payload.is_demo : null),
      accountType: payload.accountType || payload.account_type || null,
      raw: payload,
    };
  }

  function parseOrderOpened(payload) {
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload === "string") return null; // "OPEN" text ack ignored
    return {
      id: String(payload.id || payload.orderId || ""),
      requestId: payload.requestId != null ? String(payload.requestId) : null,
      asset: String(payload.asset || ""),
      amount: parseFloat(payload.amount) || 0,
      direction: payload.command === 0 || payload.action === "call" ? "CALL"
                : payload.command === 1 || payload.action === "put"  ? "PUT" : null,
      openPrice: parseFloat(payload.openPrice) || 0,
      openTime: payload.openTime || payload.openTimestamp || null,
      closeTime: payload.closeTime || payload.closeTimestamp || null,
      duration: parseInt(payload.duration, 10) || 0,
      status: "OPEN",
    };
  }

  function parseOrderClosed(payload) {
    if (!payload || typeof payload !== "object") return null;
    return {
      id: String(payload.id || ""),
      asset: String(payload.asset || ""),
      amount: parseFloat(payload.amount) || 0,
      profit: parseFloat(payload.profit) || 0,
      win: (parseFloat(payload.profit) || 0) > 0,
      loss: (parseFloat(payload.profit) || 0) < 0,
      openPrice: parseFloat(payload.openPrice) || 0,
      closePrice: parseFloat(payload.closePrice) || 0,
      openTime: payload.openTime || null,
      closeTime: payload.closeTime || null,
      status: "CLOSED",
    };
  }

  /* ============================================================
   * 5. DOM helpers. Find the active asset, the live price label, the
   *    stake input, the expiry select, the CALL/PUT buttons, and the
   *    displayed balance. The selectors are intentionally broad; the
   *    helper tries them in order and returns the first visible hit.
   * ============================================================ */
  function isVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.getClientRects().length === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function visibleText(el) {
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  function parsePrice(text) {
    if (text == null) return null;
    var t = String(text).replace(/\s/g, "");
    var m = t.match(/(\d{1,7}(?:[.,]\d{1,7})?)/);
    if (!m) return null;
    var n = parseFloat(m[1].replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function findAssetHeader() {
    var sels = [
      "[class*='current-symbol']",
      "[class*='asset-select']",
      "[class*='pair-name']",
      "[class*='symbol-name']",
      "[class*='assetName']",
      "[class*='trading-pair']",
      "[class*='active-asset']",
      "[data-test*='symbol']",
      "header [class*='active']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        var t = visibleText(nodes[j]);
        if (t && t.length >= 3 && t.length < 32) return { el: nodes[j], text: t };
      }
    }
    return null;
  }

  function findPriceLabel() {
    var sels = [
      "[class*='current-profit']",
      "[class*='current-price']",
      "[class*='currentPrice']",
      "[class*='chart-price']",
      "[class*='asset-price']",
      "[class*='price-info']",
      "[class*='quotes'] [class*='price']",
      ".value__val",
      "[class*='value__val']",
      "[data-test*='price']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (!isVisible(nodes[j])) continue;
        var p = parsePrice(visibleText(nodes[j]));
        if (p && p > 0.0001 && p < 1e7) return { el: nodes[j], price: p };
      }
    }
    // Fallback: scan small text nodes near stake panel for the first price-like number.
    var panel = findPanel();
    var scope = panel || document;
    var all = scope.querySelectorAll("span, div, strong, b");
    for (var k = 0; k < all.length; k++) {
      if (all[k].children.length > 1) continue;
      var t = visibleText(all[k]);
      if (t.length < 3 || t.length > 18) continue;
      var cls = (all[k].className || "").toString().toLowerCase();
      if (!/price|quote|rate|last|valor|curso|profit/i.test(cls)) continue;
      var p2 = parsePrice(t);
      if (p2 && p2 > 0.0001) return { el: all[k], price: p2 };
    }
    return null;
  }

  function findStakeInput() {
    var sels = [
      "input[class*='amount']",
      "input[class*='stake']",
      "input[class*='sum']",
      "input[aria-label*='amount' i]",
      "input[aria-label*='stake' i]",
      "input[placeholder*='amount' i]",
      "input[type='number']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (isVisible(nodes[j])) return nodes[j];
      }
    }
    return null;
  }

  function findExpirySelect() {
    // The expiry is often a button bar, not a <select>. Return both kinds.
    var sels = [
      "select[class*='expir']",
      "select[class*='time']",
      "[class*='expir'] [class*='option']",
      "[class*='duration'] [class*='option']",
      "button[class*='expir']",
      "button[class*='time']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (isVisible(nodes[j])) return nodes[j];
      }
    }
    return null;
  }

  function findCallButton() { return findDirButton("CALL"); }
  function findPutButton()  { return findDirButton("PUT"); }

  function findDirButton(dir) {
    var sels = [
      "button[class*='call']",
      "button[class*='put']",
      "button[class*='up']",
      "button[class*='down']",
      "[class*='call-btn']",
      "[class*='put-btn']",
      "button[data-type='CALL']",
      "button[data-type='PUT']",
      "button[data-direction='CALL']",
      "button[data-direction='PUT']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (!isVisible(nodes[j])) continue;
        var t = (nodes[j].textContent || "").trim().toUpperCase();
        if (dir === "CALL" && (sels[i].indexOf("call") !== -1 || sels[i].indexOf("up") !== -1 ||
            t === "CALL" || t === "BUY" || t.indexOf("↑") !== -1)) return nodes[j];
        if (dir === "PUT" && (sels[i].indexOf("put") !== -1 || sels[i].indexOf("down") !== -1 ||
            t === "PUT" || t === "SELL" || t.indexOf("↓") !== -1)) return nodes[j];
      }
    }
    // Last-resort scan: any visible button whose label matches the direction.
    var all = document.querySelectorAll("button");
    for (var k = 0; k < all.length; k++) {
      if (!isVisible(all[k])) continue;
      var t2 = (all[k].textContent || "").trim().toUpperCase();
      if (dir === "CALL" && (t2 === "CALL" || t2 === "BUY" || t2.indexOf("↑") !== -1)) return all[k];
      if (dir === "PUT"  && (t2 === "PUT"  || t2 === "SELL" || t2.indexOf("↓") !== -1)) return all[k];
    }
    return null;
  }

  function findBalance() {
    var sels = [
      "[class*='balance']",
      "[class*='current-balance']",
      "[class*='account-balance']",
      "[data-test*='balance']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length; j++) {
        if (!isVisible(nodes[j])) continue;
        var p = parsePrice(visibleText(nodes[j]));
        if (p && p > 0 && p < 1e9) return { el: nodes[j], value: p };
      }
    }
    return null;
  }

  function findPanel() {
    // Heuristic: the trade panel typically sits in a right rail.
    var sels = [
      "[class*='trade-panel']",
      "[class*='tradePanel']",
      "[class*='right-panel']",
      "[class*='sidebar']",
      "[class*='deals']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var n = document.querySelector(sels[i]);
      if (n && isVisible(n)) return n;
    }
    return null;
  }

  /* ============================================================
   * 6. Trade placement. Two modes:
   *   dom  — find the button, set the stake, click. Always works
   *          while the page is in its normal state and the user
   *          is logged in.
   *   ws   — send a Socket.IO `orders/open` frame on the page's own
   *          WebSocket. Requires a captured auth payload, which we
   *          only get by snooping the page's traffic; we never ask
   *          the user for credentials.
   * ============================================================ */
  function setStake(amount) {
    var el = findStakeInput();
    if (!el) return false;
    try {
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, String(amount));
      else el.value = String(amount);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (_) { return false; }
  }

  function placeTradeDom(args) {
    args = args || {};
    var dir = (args.dir || args.direction || "CALL").toUpperCase();
    if (dir !== "CALL" && dir !== "PUT") return { ok: false, mode: "dom", error: "invalid direction" };
    if (typeof args.amount !== "undefined") setStake(args.amount);
    var btn = dir === "CALL" ? findCallButton() : findPutButton();
    if (!btn) return { ok: false, mode: "dom", error: "trade button not visible" };
    try {
      btn.click();
      return { ok: true, mode: "dom", id: null, dir: dir, amount: args.amount, expiry: args.expiry || null };
    } catch (e) {
      return { ok: false, mode: "dom", error: String(e && e.message || e) };
    }
  }

  // The `orders/open` payload the server expects. Mirrors A11ksa/API-Quotex.
  function buildOrderPayload(args) {
    var dir = (args.dir || args.direction || "CALL").toUpperCase();
    var action = dir === "CALL" ? "call" : "put";
    var asset = args.asset || args.symbol || "";
    var amount = parseFloat(args.amount) || 1;
    var expirySec = parseInt(args.expiry || args.expirySec || 60, 10);
    var requestId = args.requestId || String(Date.now());
    // optionType: 0 = turbo (seconds-precision expiry), 1 = binary (whole-minute).
    // Caller can override; otherwise default to binary for any minute+ duration,
    // turbo for any sub-minute duration.
    var optionType = typeof args.optionType === "number" ? args.optionType : (expirySec < 60 ? 0 : 1);
    return {
      asset: asset,
      amount: amount,
      time: expirySec,
      action: action,
      isDemo: args.isDemo ? 1 : 0,
      tournamentId: 0,
      requestId: parseInt(requestId, 10) || requestId,
      optionType: optionType,
    };
  }

  function placeTradeWs(ws, args) {
    args = args || {};
    if (!ws || typeof ws.send !== "function") return { ok: false, mode: "ws", error: "no websocket handle" };
    if (!args.asset) return { ok: false, mode: "ws", error: "asset required" };
    try {
      var payload = buildOrderPayload(args);
      // Send `tick` + `instruments/follow` then `orders/open` — this is the
      // exact sequence the page uses when the user clicks.
      try { ws.send('42["tick"]'); } catch (_) {}
      try { ws.send('42["instruments/follow","' + payload.asset + '"]'); } catch (_) {}
      var msg = '42["orders/open",' + JSON.stringify(payload) + ']';
      ws.send(msg);
      return { ok: true, mode: "ws", id: String(payload.requestId), dir: payload.action, message: msg };
    } catch (e) {
      return { ok: false, mode: "ws", error: String(e && e.message || e) };
    }
  }

  function placeTrade(args, ws) {
    args = args || {};
    if (args.mode === "ws") return placeTradeWs(ws, args);
    return placeTradeDom(args);
  }

  /* ============================================================
   * 7. Page-side WebSocket hijack. Wraps `window.WebSocket` so every
   *    page-owned socket goes through our decoder. The wrapper is
   *    idempotent; we expose a handle with `detach()` to put the
   *    native constructor back.
   * ============================================================ */
  function attachPageSocket(handlers) {
    handlers = handlers || {};
    var Native = window.WebSocket;
    if (typeof Native !== "function") return { ok: false, error: "no native WebSocket" };
    if (Native.__cyberWrapped) return { ok: true, handle: Native.__cyberHandle, already: true };

    var pendingHeader = null; // last 451-["event"] seen; consumed by next \x04 body
    var listeners = {
      status:    handlers.onStatus    || function () {},
      candle:    handlers.onCandle    || function () {},
      tick:      handlers.onTick      || function () {},
      instruments: handlers.onInstruments || function () {},
      balance:   handlers.onBalance   || function () {},
      order:     handlers.onOrder     || function () {},
      frame:     handlers.onFrame     || function () {},
    };

    function feed(label, payload, frame) {
      try { listeners.frame(label, payload, frame); } catch (_) {}
    }

    function dispatch(frame) {
      if (!frame) return;
      // Engine.IO control
      if (frame.type === "eio") {
        if (frame.kind === "open" || frame.kind === "connect") {
          try { listeners.status({ state: "connected", url: (frame.payload && frame.payload.sid) || null }); } catch (_) {}
        } else if (frame.kind === "disconnect") {
          try { listeners.status({ state: "disconnected" }); } catch (_) {}
        }
        return;
      }
      // Headered binary
      if (frame.type === "hdr") {
        pendingHeader = frame.event;
        feed("hdr", frame.payload, frame);
        return;
      }
      // Binary body — use pending header if any
      if (frame.type === "bin") {
        var ev = frame.event || pendingHeader;
        pendingHeader = null;
        if (ev === "instruments/list") {
          var list = parseInstruments(frame.payload);
          try { listeners.instruments(list); } catch (_) {}
          feed("instruments", list, frame);
          return;
        }
        if (ev === "quotes/stream") {
          var q = parseQuote(frame.payload);
          if (q) {
            try { listeners.tick(q); } catch (_) {}
            feed("tick", q, frame);
          }
          return;
        }
        if (ev === "s_balance") {
          var b = parseBalance(frame.payload);
          if (b) {
            try { listeners.balance(b); } catch (_) {}
            feed("balance", b, frame);
          }
          return;
        }
        if (ev === "s_orders/open") {
          var oo = parseOrderOpened(frame.payload);
          if (oo) {
            try { listeners.order({ kind: "opened", data: oo }); } catch (_) {}
            feed("order_opened", oo, frame);
          }
          return;
        }
        if (ev === "s_orders/close" || ev === "orders/closed/list") {
          if (Array.isArray(frame.payload)) {
            for (var i = 0; i < frame.payload.length; i++) {
              var oc = parseOrderClosed(frame.payload[i]);
              if (oc) { try { listeners.order({ kind: "closed", data: oc }); } catch (_) {} }
            }
          } else if (frame.payload && frame.payload.deals) {
            for (var j = 0; j < frame.payload.deals.length; j++) {
              var oc2 = parseOrderClosed(frame.payload.deals[j]);
              if (oc2) { try { listeners.order({ kind: "closed", data: oc2 }); } catch (_) {} }
            }
          } else {
            var oc3 = parseOrderClosed(frame.payload);
            if (oc3) try { listeners.order({ kind: "closed", data: oc3 }); } catch (_) {}
          }
          feed("order_closed", frame.payload, frame);
          return;
        }
        if (ev === "history/list/v2" || ev === "chart_notification/get" || ev === "loadHistoryPeriod") {
          var c = parseCandles(frame.payload);
          if (c) {
            try { listeners.candle({ asset: c.asset, period: c.period, candles: normalizeCandles(c) }); } catch (_) {}
            feed("candles", c, frame);
          }
          return;
        }
        // Headerless inference
        var ev2 = inferEventFromPayload(frame.payload);
        if (ev2 === "quote") {
          var q2 = parseQuote(frame.payload);
          if (q2) try { listeners.tick(q2); } catch (_) {}
        } else if (ev2 === "instruments") {
          var list2 = parseInstruments(frame.payload);
          try { listeners.instruments(list2); } catch (_) {}
        } else if (ev2 === "balance") {
          var b2 = parseBalance(frame.payload);
          if (b2) try { listeners.balance(b2); } catch (_) {}
        } else if (ev2 === "candles") {
          var c2 = parseCandles(frame.payload);
          if (c2) try { listeners.candle({ asset: c2.asset, period: c2.period, candles: normalizeCandles(c2) }); } catch (_) {}
        } else if (ev2 === "order_opened") {
          var oo2 = parseOrderOpened(frame.payload);
          if (oo2) try { listeners.order({ kind: "opened", data: oo2 }); } catch (_) {}
        } else if (ev2 === "order_closed") {
          var oc4 = parseOrderClosed(frame.payload);
          if (oc4) try { listeners.order({ kind: "closed", data: oc4 }); } catch (_) {}
        }
        return;
      }
      // Text Socket.IO event
      if (frame.type === "sio") {
        var ev3 = mapEventName(frame.event);
        if (ev3 === "authenticated") {
          try { listeners.status({ state: "authenticated" }); } catch (_) {}
        } else if (ev3 === "balance") {
          var bb = parseBalance(frame.payload);
          if (bb) try { listeners.balance(bb); } catch (_) {}
        } else if (ev3 === "instruments") {
          var list3 = parseInstruments(frame.payload);
          try { listeners.instruments(list3); } catch (_) {}
        } else if (ev3 === "quote") {
          var q3 = parseQuote(frame.payload);
          if (q3) try { listeners.tick(q3); } catch (_) {}
        } else if (ev3 === "candles") {
          var c3 = parseCandles(frame.payload);
          if (c3) try { listeners.candle({ asset: c3.asset, period: c3.period, candles: normalizeCandles(c3) }); } catch (_) {}
        } else if (ev3 === "order_opened") {
          var oo3 = parseOrderOpened(frame.payload);
          if (oo3) try { listeners.order({ kind: "opened", data: oo3 }); } catch (_) {}
        } else if (ev3 === "order_closed") {
          // Some servers send {"deals":[...]} or {"ticket":{...}} as the payload.
          var ocDeals = null;
          if (frame.payload && Array.isArray(frame.payload.deals)) ocDeals = frame.payload.deals;
          else if (frame.payload && frame.payload.ticket) ocDeals = [frame.payload.ticket];
          else if (Array.isArray(frame.payload)) ocDeals = frame.payload;
          else if (frame.payload && typeof frame.payload === "object") ocDeals = [frame.payload];
          if (ocDeals) {
            for (var oci = 0; oci < ocDeals.length; oci++) {
              var oc5 = parseOrderClosed(ocDeals[oci]);
              if (oc5) try { listeners.order({ kind: "closed", data: oc5 }); } catch (_) {}
            }
          }
        } else if (ev3 === "auth_error") {
          try { listeners.status({ state: "auth_error" }); } catch (_) {}
        } else if (ev3 === "error") {
          try { listeners.status({ state: "error", error: frame.payload }); } catch (_) {}
        }
        feed(ev3, frame.payload, frame);
      }
    }

    function Wrapped(url, protocols) {
      var ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      try { listeners.status({ state: "opening", url: url }); } catch (_) {}
      ws.addEventListener("open", function () {
        try { listeners.status({ state: "open", url: url }); } catch (_) {}
      });
      ws.addEventListener("close", function () {
        try { listeners.status({ state: "closed", url: url }); } catch (_) {}
      });
      ws.addEventListener("message", function (ev) {
        try {
          var frame = null;
          if (typeof ev.data === "string") {
            frame = decodeFrame(ev.data);
          } else if (ev.data && typeof ev.data === "object" && "text" in ev.data) {
            // Some polyfills expose a Blob with .text()
            ev.data.text().then(function (s) { dispatch(decodeFrame(s)); }).catch(function () {});
            return;
          } else {
            frame = decodeFrame(ev.data);
          }
          dispatch(frame);
        } catch (_) {}
      });
      return ws;
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;

    var handle = { native: Native, wrapper: Wrapped, pending: function () { return pendingHeader; } };
    Wrapped.__cyberWrapped = true;
    Wrapped.__cyberHandle = handle;
    window.WebSocket = Wrapped;

    return {
      ok: true,
      handle: handle,
      detach: function detach() {
        if (window.WebSocket === Wrapped) window.WebSocket = Native;
        Wrapped.__cyberWrapped = false;
      },
    };
  }

  /* ============================================================
   * 8. Public API.
   * ============================================================ */
  var KNOWN_EVENTS = [
    "candles", "ticks", "instruments", "balance",
    "orders/open", "orders/close", "order_opened", "order_closed",
    "authenticated", "authorization", "authorization/reject",
    "s_authorization", "s_balance", "s_orders/open", "s_orders/close",
    "successopenOrder", "successcloseOrder", "successupdateBalance",
    "instruments/list", "quotes/stream", "history/list/v2",
    "chart_notification/get", "loadHistoryPeriod",
  ];

  var WSS_GUESSES = [
    "wss://ws2.qxbroker.com/socket.io/?EIO=3&transport=websocket",
    "wss://ws.qxbroker.com/socket.io/?EIO=3&transport=websocket",
    "wss://ws3.qxbroker.com/socket.io/?EIO=3&transport=websocket",
  ];

  root.CYBER_QUOTEX = {
    isQuotexPage: isQuotexPage,
    isQuotexHost: isQuotexHost,
    attachPageSocket: attachPageSocket,
    decodeFrame: decodeFrame,
    decodeMessage: decodeMessage,
    normalizeEvent: normalizeEvent,
    parseInstruments: parseInstruments,
    parseCandles: parseCandles,
    normalizeCandles: normalizeCandles,
    parseQuote: parseQuote,
    parseBalance: parseBalance,
    parseOrderOpened: parseOrderOpened,
    parseOrderClosed: parseOrderClosed,
    findPanel: findPanel,
    findAssetHeader: findAssetHeader,
    findPriceLabel: findPriceLabel,
    findStakeInput: findStakeInput,
    findExpirySelect: findExpirySelect,
    findCallButton: findCallButton,
    findPutButton: findPutButton,
    findBalance: findBalance,
    setStake: setStake,
    placeTrade: placeTrade,
    placeTradeDom: placeTradeDom,
    placeTradeWs: placeTradeWs,
    buildOrderPayload: buildOrderPayload,
    getInstruments: function () {
      // Static catalog (id -> symbol). Live list arrives via attachPageSocket.
      var out = [];
      for (var s in ASSET_IDS) {
        if (Object.prototype.hasOwnProperty.call(ASSET_IDS, s)) {
          out.push({ id: ASSET_IDS[s], symbol: s, isOtc: /_otc$/i.test(s) });
        }
      }
      return out;
    },
    getBalance: function () {
      var b = findBalance();
      return b ? b.value : null;
    },
    KNOWN_EVENTS: KNOWN_EVENTS,
    WSS_GUESSES: WSS_GUESSES,
    ASSET_IDS: ASSET_IDS,
    ID_TO_SYMBOL: ID_TO_SYMBOL,
    KNOWN_TIMEFRAMES: KNOWN_TIMEFRAMES,
  };
})(typeof self !== "undefined" ? self : this);
