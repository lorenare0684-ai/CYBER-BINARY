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
    // Binary event header: 45N-["event",{...}] — N = binary attachments.
    //   The common 1-attachment form is 451-[...] followed by a binary body.
    //   Variant seen on some builds: 51- (Engine.IO prefix already stripped).
    if ((s.charAt(0) === "4" && s.charAt(1) === "5") ||
        (s.charAt(0) === "5" && s.charAt(1) === "1")) {
      var k = s.charAt(0) === "4" ? 2 : 0;
      var digits = "";
      while (k < s.length && s.charCodeAt(k) >= 48 && s.charCodeAt(k) <= 57) { digits += s.charAt(k); k++; }
      if (digits && s.charAt(k) === "-" && s.charAt(k + 1) === "[") {
        var hdrArr = safeJSON(s.slice(k + 1));
        if (Array.isArray(hdrArr) && hdrArr.length >= 1) {
          var hdr = { type: "hdr", event: String(hdrArr[0] || ""), payload: hdrArr[1] || null, raw: s };
          hdr.attachments = parseInt(digits, 10) || 1;
          return hdr;
        }
        return { type: "unknown", raw: s };
      }
    }
    // Binary ACK header: 46N-[...] (Socket.IO binary ack) and 43N-[...]
    if ((s.charAt(0) === "4" && s.charAt(1) === "6") ||
        (s.charAt(0) === "4" && s.charAt(1) === "3")) {
      var k2 = 2;
      var digits2 = "";
      while (k2 < s.length && s.charCodeAt(k2) >= 48 && s.charCodeAt(k2) <= 57) { digits2 += s.charAt(k2); k2++; }
      if (digits2 && s.charAt(k2) === "-" && s.charAt(k2 + 1) === "[") {
        var ackArr = safeJSON(s.slice(k2 + 1));
        if (Array.isArray(ackArr) && ackArr.length >= 1) {
          var ahdr = { type: "hdr", event: String(ackArr[0] || ""), payload: ackArr[1] || null, raw: s, ack: true };
          ahdr.attachments = parseInt(digits2, 10) || 1;
          return ahdr;
        }
        return { type: "unknown", raw: s };
      }
    }
    // 42["event", payload] — Socket.IO event
    if (s.indexOf("42") === 0) {
      var arr2 = safeJSON(s.slice(2));
      if (Array.isArray(arr2) && arr2.length >= 1) {
        return { type: "sio", event: String(arr2[0] || ""), payload: arr2.length > 1 ? arr2[1] : null, raw: s };
      }
      return { type: "unknown", raw: s };
    }
    // 43["event", payload] — Socket.IO acknowledgement packet. Quotex-style
    // servers answer `history/list/v2`, `tick`, `instruments/list` and
    // `quotes/stream` with ACK packets, so treat them exactly like events.
    if (s.indexOf("43") === 0) {
      var ack2 = safeJSON(s.slice(2));
      if (Array.isArray(ack2) && ack2.length >= 1) {
        return { type: "sio", ack: true, event: String(ack2[0] || ""), payload: ack2.length > 1 ? ack2[1] : null, raw: s };
      }
      return { type: "unknown", raw: s };
    }
    // Binary body: byte 0x04 followed by JSON
    if (s.charCodeAt(0) === 4 && s.length > 1) {
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
        if (typeof first[0] === "string" && (typeof first[1] === "number" || typeof first[1] === "string") && typeof first[2] === "number") {
          return "quote"; // quotes/stream shape: [symbol, ts, price, ...]
        }
        if (typeof first[0] === "number" && typeof first[1] === "string" && typeof first[2] === "string") {
          return "instruments"; // [id, symbol, name, ...]
        }
        // Candle rows: [ts, open, low, high, close, ...] or [ts, open, high, low, close, ...]
        if (typeof first[0] === "number" && typeof first[1] === "number" && typeof first[2] === "number" &&
            typeof first[3] === "number" && typeof first[4] === "number" && first.length >= 5) {
          if (first[0] > 1e9) return "candles"; // timestamps far in the past → history batch
        }
      }
      return "unknown";
    }
    if (typeof p === "object") {
      if (("asset" in p || "symbol" in p) && ("history" in p || "candles" in p || "period" in p)) return "candles";
      if (("instrument" in p && Array.isArray(p.instrument)) || ("instruments" in p && Array.isArray(p.instruments))) return "instruments";
      if (("asset" in p || "symbol" in p) && ("price" in p || "value" in p)) return "quote";
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
  function normalizeSymbolName(s) {
    return String(s || "").trim().toUpperCase().replace(/_OTC/g, "_otc");
  }

  function parseInstruments(payload) {
    if (!payload) return [];
    // Some server builds wrap the list: {instrument:[...]} / {instruments:[...]}
    var list = payload;
    if (!Array.isArray(list)) {
      if (Array.isArray(payload.instrument)) list = payload.instrument;
      else if (Array.isArray(payload.instruments)) list = payload.instruments;
      else if (Array.isArray(payload.data)) list = payload.data;
      else if (Array.isArray(payload.result)) list = payload.result;
      else {
        // Keyed by symbol: { EURUSD: {...}, ... } — take the first list value.
        for (var key in payload) {
          if (Object.prototype.hasOwnProperty.call(payload, key) && Array.isArray(payload[key])) {
            list = payload[key];
            break;
          }
        }
      }
    }
    if (!Array.isArray(list)) return [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      if (!Array.isArray(row) || row.length < 3) continue;
      // Canonical broker row: [id, symbol, name, type, ..., payout(5), ..., tfs(12), ..., open(14)]
      // Some clients send [symbol, name, id, ...] — detect + reorder.
      var sf = typeof row[0] === "string" &&
        (typeof row[2] === "number" || /^\d+$/.test(String(row[2]))); // symbol-first row
      var id = 0;
      if (typeof row[0] === "number" || /^\d+$/.test(String(row[0]))) id = parseInt(row[0], 10) || 0;
      if (!id && sf) id = parseInt(row[2], 10) || 0;
      var raw_symbol = String(sf ? row[0] : row[1] || "").trim();
      if (!raw_symbol) continue;
      var symbol = normalizeSymbolName(raw_symbol);
      var name = String(sf ? (row[1] || symbol) : (row[2] || symbol));
      var type = String(row[3] || "unknown");
      var payout = parseInt(sf ? row[6] : row[5], 10) || 0;
      var isOpen = true;
      var openIdx = row.length > (sf ? 15 : 14) ? (sf ? 15 : 14) : 14;
      if (row.length > openIdx) isOpen = !!row[openIdx];
      var tfs = [];
      // Timeframes can sit at 12/13 (timeframe list) or 15/16 (objects).
      for (var tIdx = 12; tIdx <= 16 && tIdx < row.length; tIdx++) {
        if (!Array.isArray(row[tIdx])) continue;
        for (var j = 0; j < row[tIdx].length; j++) {
          var tf = row[tIdx][j];
          if (Array.isArray(tf) && tf.length) tfs.push(parseInt(tf[0], 10));
          else if (typeof tf === "number") tfs.push(tf);
          else if (typeof tf === "string") tfs.push(parseInt(tf, 10));
          else if (tf && typeof tf === "object" && "time" in tf) tfs.push(parseInt(tf.time, 10));
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
    var asset = payload.asset || payload.symbol || payload.pair || null;
    var period = payload.period || payload.timeframe || null;
    var rows = payload.history || payload.candles || payload.data || null;
    if (!asset || period == null) {
      // Some servers push {history:[...]} without metadata (headerless flow).
      // Caller should know the requested asset/period; assume 60s here.
      if (Array.isArray(rows) && rows.length) {
        var first = rows[0];
        if (Array.isArray(first) && first.length >= 5) {
          return { asset: asset, period: 60, raw: rows };
        }
      }
      return null;
    }
    if (typeof period === "object" && period != null) {
      period = period.time != null ? period.time : (period.value != null ? period.value : 60);
    }
    period = parseInt(period, 10) || 60;
    if (!Array.isArray(rows)) rows = [];
    return { asset: String(asset), period: period, raw: rows };
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

  function toMs(ts) {
    if (ts == null) return null;
    var n = typeof ts === "number" ? ts : parseFloat(ts);
    if (!Number.isFinite(n)) {
      var d = Date.parse(String(ts));
      return Number.isFinite(d) ? d : null;
    }
    if (n > 1e12) return Math.floor(n);            // already ms
    if (n > 1e9) return Math.floor(n * 1000);      // unix seconds
    return Math.floor(n);                          // unknown small value
  }

  function parseQuote(payload) {
    if (!payload) return null;
    var symbol = null, ts = null, price = null;
    if (Array.isArray(payload)) {
      if (!payload.length) return null;
      var first = Array.isArray(payload[0]) ? payload[0] : payload;
      // [symbol, ts, price, ...]
      if (typeof first[0] === "string") {
        symbol = String(first[0]);
        ts = first[1];
        price = parseFloat(first[2]);
      }
      // [ts, symbol, price]
      if (price == null && typeof first[1] === "string") {
        ts = first[0];
        symbol = String(first[1]);
        price = parseFloat(first[2]);
      }
      if (price == null && typeof first[1] === "number") {
        ts = first[1];
        price = parseFloat(first[2]);
      }
    } else if (typeof payload === "object") {
      symbol = payload.symbol || payload.asset || payload.pair || null;
      ts = payload.time != null ? payload.time : (payload.ts != null ? payload.ts : null);
      price = payload.price != null ? parseFloat(payload.price)
            : payload.value != null ? parseFloat(payload.value)
            : payload.close != null ? parseFloat(payload.close) : null;
    }
    if (!symbol || price == null || !Number.isFinite(price)) return null;
    return {
      symbol: String(symbol),
      time: toMs(ts),
      price: price,
      raw: payload,
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
   * 7. Packet router + page-side WebSocket hijack.
   *
   * `createRouter(handlers)` decodes raw Engine.IO/Socket.IO frames and
   * routes them to typed callbacks. It owns the binary-attachment state
   * (451-/43N- headers) and is deliberately independent of the WebSocket
   * wrapper so the page-hook can install a WebSocket wrapper *synchronously*
   * at document_start, queue frames, and only later feed them into a router
   * once the adapter module has loaded. That guarantees no frame is lost
   * during the extension's own startup.
   *
   * `attachPageSocket(handlers)` is the convenience wrapper: installs
   * `window.WebSocket` (idempotent) wired to a router, tracks the live
   * socket in `handle.lastWs` and exposes `detach()`.
   * ============================================================ */
  function createRouter(handlers) {
    handlers = handlers || {};
    var pendingHeader = null; // last 451-/43N-["event"] seen
    var pendingCount = 0;     // binary attachments still expected
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

    function emitCandles(payload) {
      var c = parseCandles(payload);
      if (c) {
        try { listeners.candle({ asset: c.asset, period: c.period, candles: normalizeCandles(c) }); } catch (_) {}
        feed("candles", c, payload && payload.raw ? payload : null);
      }
    }

    function emitInstruments(payload) {
      var list = parseInstruments(payload);
      try { listeners.instruments(list); } catch (_) {}
      feed("instruments", list, null);
    }

    function emitTick(payload) {
      var q = parseQuote(payload);
      if (q) {
        try { listeners.tick(q); } catch (_) {}
        feed("tick", q, null);
      }
    }

    function emitBalance(payload) {
      var b = parseBalance(payload);
      if (b) {
        try { listeners.balance(b); } catch (_) {}
        feed("balance", b, null);
      }
    }

    function emitOrderOpen(payload) {
      var oo = parseOrderOpened(payload);
      if (oo) {
        try { listeners.order({ kind: "opened", data: oo }); } catch (_) {}
        feed("order_opened", oo, null);
      }
    }

    function emitOrderClosed(payload) {
      var ocDeals = null;
      if (payload && Array.isArray(payload.deals)) ocDeals = payload.deals;
      else if (payload && payload.ticket) ocDeals = [payload.ticket];
      else if (Array.isArray(payload)) ocDeals = payload;
      else if (payload && typeof payload === "object") ocDeals = [payload];
      if (ocDeals) {
        for (var oci = 0; oci < ocDeals.length; oci++) {
          var oc5 = parseOrderClosed(ocDeals[oci]);
          if (oc5) { try { listeners.order({ kind: "closed", data: oc5 }); } catch (_) {} }
        }
      }
      feed("order_closed", payload, null);
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
        pendingCount = frame.attachments || 1;
        feed("hdr", frame.payload, frame);
        return;
      }
      // Binary body — use pending header if any
      if (frame.type === "bin") {
        var ev = frame.event || pendingHeader;
        if (pendingCount > 0) pendingCount -= 1;
        if (pendingCount <= 0) pendingHeader = null;
        if (ev === "instruments/list" || ev === "instruments/update" || ev === "assets/list") {
          emitInstruments(frame.payload);
          return;
        }
        if (ev === "quotes/stream") {
          emitTick(frame.payload);
          return;
        }
        if (ev === "s_balance" || ev === "balance" || ev === "successupdateBalance") {
          emitBalance(frame.payload);
          return;
        }
        if (ev === "s_orders/open" || ev === "successopenOrder") {
          emitOrderOpen(frame.payload);
          return;
        }
        if (ev === "s_orders/close" || ev === "successcloseOrder" || ev === "orders/closed/list") {
          emitOrderClosed(frame.payload);
          return;
        }
        if (ev === "history/list/v2" || ev === "chart_notification/get" || ev === "loadHistoryPeriod") {
          emitCandles(frame.payload);
          return;
        }
        // Headerless inference
        var ev2 = inferEventFromPayload(frame.payload);
        if (ev2 === "quote") emitTick(frame.payload);
        else if (ev2 === "instruments") emitInstruments(frame.payload);
        else if (ev2 === "balance") emitBalance(frame.payload);
        else if (ev2 === "candles") emitCandles(frame.payload);
        else if (ev2 === "order_opened") emitOrderOpen(frame.payload);
        else if (ev2 === "order_closed") emitOrderClosed(frame.payload);
        return;
      }
      // Text Socket.IO event / ACK packet
      if (frame.type === "sio") {
        var ev3 = mapEventName(frame.event);
        if (ev3 === "authenticated") {
          try { listeners.status({ state: "authenticated" }); } catch (_) {}
        } else if (ev3 === "s_authorization") {
          try { listeners.status({ state: "authenticated" }); } catch (_) {}
        } else if (ev3 === "balance") {
          emitBalance(frame.payload);
        } else if (ev3 === "instruments") {
          emitInstruments(frame.payload);
        } else if (ev3 === "quote") {
          emitTick(frame.payload);
        } else if (ev3 === "candles") {
          emitCandles(frame.payload);
        } else if (ev3 === "order_opened") {
          emitOrderOpen(frame.payload);
        } else if (ev3 === "order_closed") {
          emitOrderClosed(frame.payload);
        } else if (ev3 === "auth_error" || ev3 === "authorization/reject") {
          try { listeners.status({ state: "auth_error", error: frame.payload }); } catch (_) {}
        } else if (ev3 === "error") {
          try { listeners.status({ state: "error", error: frame.payload }); } catch (_) {}
        }
        feed(ev3, frame.payload, frame);
      }
    }

    function rawToFrame(data, cb) {
      if (typeof data === "string") {
        cb(decodeFrame(data));
        return;
      }
      if (data && typeof data === "object" && typeof data.text === "function") {
        // Blob / polyfill
        data.text().then(function (s) { cb(decodeFrame(s)); }).catch(function () {});
        return;
      }
      cb(decodeFrame(data));
    }

    function feedRaw(raw) {
      try { rawToFrame(raw, dispatch); } catch (_) {}
    }

    return {
      dispatch: dispatch,
      feedRaw: feedRaw,
      pending: function () { return pendingHeader; },
      pendingCount: function () { return pendingCount; },
      listeners: listeners,
    };
  }

  function attachPageSocket(handlers) {
    handlers = handlers || {};
    var Native = window.WebSocket;
    if (typeof Native !== "function") return { ok: false, error: "no native WebSocket" };
    if (Native.__cyberWrapped) return { ok: true, handle: Native.__cyberHandle, already: true };

    var router = createRouter(handlers);

    function Wrapped(url, protocols) {
      var ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      try { router.listeners.status({ state: "opening", url: url }); } catch (_) {}
      if (handle) handle.lastWs = ws;
      ws.addEventListener("open", function () {
        try { router.listeners.status({ state: "open", url: url }); } catch (_) {}
      });
      ws.addEventListener("close", function () {
        try { router.listeners.status({ state: "closed", url: url }); } catch (_) {}
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

    var handle = { native: Native, wrapper: Wrapped, router: router, lastWs: null, pending: function () { return router.pending(); } };
    Wrapped.__cyberWrapped = true;
    Wrapped.__cyberHandle = handle;
    window.WebSocket = Wrapped;

    return {
      ok: true,
      handle: handle,
      router: router,
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
    createRouter: createRouter,
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
    toMs: toMs,
    normalizeSymbol: normalizeSymbolName,
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
    /**
     * Ask the broker for real-time ticks + history on the *page's own*
     * socket. Mirrors the exact sequence the Quotex web client sends when a
     * chart opens, so nothing extra is needed to receive `quotes/stream` and
     * `history/list/v2` frames from the server. Safe to call repeatedly.
     */
    subscribeHistory: function (ws, asset, period) {
      if (!ws || typeof ws.send !== "function") return { ok: false, error: "no websocket handle" };
      var sym = (asset || "").replace(/_OTC/g, "_otc");
      if (!sym) return { ok: false, error: "asset required" };
      period = parseInt(period, 10) || 60;
      try {
        ws.send('42["tick"]');
        ws.send('42["instruments/follow","' + sym + '"]');
        ws.send('42["instruments/update",{"asset":"' + sym + '","period":' + period + '}]');
        ws.send('42["chart_notification/get",{"asset":"' + sym + '","version":"1.0.0"}]');
        return { ok: true, asset: sym, period: period };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
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
