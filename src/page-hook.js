/**
 * CYBER BINARY — GENERATED FILE. DO NOT EDIT BY HAND.
 *
 * Built by `node tools/build-hook.js` from:
 *   - src/lib/quotex.js        (protocol decoder / adapter)
 *   - tools/page-hook.shell.js (MAIN-world WebSocket hook shell)
 *
 * Rebuild after any change to either source file.
 * Generated: 2026-08-23T07:18:45.700Z
 */
/* ====================================================================
 * Inlined CYBER_QUOTEX adapter (src/lib/quotex.js).
 * Exposes window.CYBER_QUOTEX in the page's MAIN world.
 * ==================================================================== */
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
 *   - Knows the full Quotex asset catalog (~170 symbols: every base FX pair
 *     + its `_otc` twin, exotic FX OTC, crypto OTC, commodities, indices,
 *     stocks OTC), with the broker-internal numeric IDs where confirmed;
 *     live `instruments/list` payloads merge real ids at runtime.
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
 * Live execution adapter. No SSID is ever read from the page, stored, or
 * transmitted by the extension. Real orders use the page's own already-
 * authenticated socket (or the strictly verified DOM controls) and require
 * explicit arming in the isolated extension controller.
 *
 * Pure functions, no module-level state except the catalog.
 */
(function (root) {
  "use strict";

  /* ============================================================
   * 1. Asset catalog (v2.3: FULL Quotex platform list).
   *
   * Numeric IDs are the broker-internal ids confirmed by the official
   * open-source clients (A11ksa/API-Quotex, ericpedra/quotexapi, quotexpy).
   * Symbols with no confirmed id live in EXTRA_SYMBOLS and get their real id
   * from the platform's `instruments/list` payload at runtime (rememberIds).
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
    "USDCHF_otc": 92, "USDJPY": 63, "USDJPY_otc": 93, "USDMXN_otc": 343,
    "XAGUSD": 65, "XAGUSD_otc": 167, "XAUUSD": 2, "XAUUSD_otc": 169,
    "XRPUSD_otc": 364, "AVAUSD_otc": 379, "AXSUSD_otc": 380,
  };

  // Symbols the platform lists but whose broker id isn't confirmed by the
  // open-source clients yet. They still appear in getInstruments()/detection;
  // the live `instruments/list` payload fills in their real ids (rememberIds).
  var EXTRA_SYMBOLS = [
    // FX: newer real-market pairs + OTC twins
    "GBPNZD", "GBPNZD_otc", "NZDCAD", "NZDCAD_otc", "NZDCHF", "NZDCHF_otc",
    // Exotic FX (OTC)
    "ARSUSD_otc", "DZDUSD_otc", "INRUSD_otc", "USDBDT_otc", "USDCOP_otc",
    "USDPKR_otc", "USDTRY_otc", "USDZAR_otc", "EURTRY_otc", "EURPLN_otc",
    "EURHUF_otc", "USDRUB_otc", "USDSEK_otc", "USDNOK_otc", "EURNOK_otc",
    "EURSEK_otc",
    // Crypto (OTC)
    "SOLUSD_otc", "LTCUSD_otc", "TRXUSD_otc", "SHIBUSD_otc", "MATICUSD_otc",
    "DOTUSD_otc", "LINKUSD_otc", "XLMUSD_otc", "DOGEUSD_otc", "DASHUSD_otc",
    "ETCUSD_otc", "NEARUSD_otc", "SUIUSD_otc", "TIAUSD_otc",
    // Commodities (OTC)
    "XNGUSD_otc", "XPTUSD_otc", "XPDUSD_otc", "COPPER_otc",
    // Stocks (OTC)
    "AAPL_otc", "AMZN_otc", "CSCO_otc", "DIS_otc", "GOOGL_otc", "JPM_otc",
    "KO_otc", "NFLX_otc", "NVDA_otc", "PG_otc", "TSLA_otc", "V_otc", "WMT_otc",
    "XOM_otc", "HD_otc", "PEP_otc", "META_otc", "AMD_otc", "IBM_otc",
    "NKE_otc", "SBUX_otc", "CVX_otc", "WFC_otc", "BAC_otc", "C_otc", "GS_otc",
    "MS_otc", "T_otc", "VZ_otc", "COST_otc", "ABBV_otc", "LLY_otc", "UNH_otc",
    "MA_otc",
  ];

  var KNOWN_TIMEFRAMES = {
    30: "30s", 60: "1m", 120: "2m", 180: "3m", 300: "5m", 600: "10m",
    900: "15m", 1800: "30m", 2700: "45m", 3600: "1h", 7200: "2h",
    10800: "3h", 14400: "4h",
  };

  // Build reverse index: numeric id -> symbol
  var ID_TO_SYMBOL = Object.create(null);
  var runtimeSymbolCount = 0;
  var MAX_RUNTIME_SYMBOLS = 1000;
  for (var k in ASSET_IDS) {
    if (Object.prototype.hasOwnProperty.call(ASSET_IDS, k)) {
      ID_TO_SYMBOL[ASSET_IDS[k]] = k;
    }
  }

  /**
   * Merge broker-internal ids learned from the live `instruments/list`
   * payload into the static catalog. Any id seen at runtime wins over our
   * best-effort static guess, and any brand-new symbol gets an id mapping so
   * numeric tick rows (`[id, ts, price]`) resolve to a symbol.
   */
  function rememberIds(list) {
    if (!Array.isArray(list)) return 0;
    var added = 0;
    for (var i = 0; i < list.length && i < 5000; i++) {
      var it = list[i];
      if (!it || typeof it !== "object" || !it.symbol) continue;
      var sym = normalizeSymbolName(it.symbol);
      var id = positiveId(it.id);
      if (!sym) continue;
      var known = Object.prototype.hasOwnProperty.call(ASSET_IDS, sym);
      if (!known && runtimeSymbolCount >= MAX_RUNTIME_SYMBOLS) continue;
      if (!known) runtimeSymbolCount++;
      if (id) {
        if (!known || ASSET_IDS[sym] !== id) {
          var oldId = positiveId(ASSET_IDS[sym]);
          if (oldId && ID_TO_SYMBOL[oldId] === sym) delete ID_TO_SYMBOL[oldId];
          ASSET_IDS[sym] = id;
          ID_TO_SYMBOL[id] = sym;
          added++;
        }
      } else if (!known) {
        // Known symbol, id not (yet) present in the row — keep it listed.
        ASSET_IDS[sym] = 0;
        added++;
      }
    }
    return added;
  }

  function isQuotexHost(host) {
    if (!host) return false;
    return /(^|\.)(qxbroker|quotex)\.(?:com|io)$/i.test(host);
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
  function bytesToStr(u8) {
    // Broker JSON is UTF-8. fromCharCode corrupts non-ASCII instrument names;
    // prefer TextDecoder and retain a chunked legacy fallback.
    if (typeof TextDecoder !== "undefined") {
      try { return new TextDecoder("utf-8").decode(u8); } catch (_) {}
    }
    var out = "";
    var CHUNK = 0x8000;
    for (var i = 0; i < u8.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
  }

  function asString(raw) {
    if (typeof raw === "string") return raw;
    if (raw == null) return "";
    if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) {
      try { return bytesToStr(new Uint8Array(raw)); } catch (_) { return ""; }
    }
    if (typeof Uint8Array !== "undefined" && raw instanceof Uint8Array) {
      try { return bytesToStr(raw); } catch (_) { return ""; }
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

  function socketArrayPacket(s, offset) {
    var i = offset;
    var namespace = null;
    if (s.charAt(i) === "/") {
      var comma = s.indexOf(",", i);
      if (comma < 0) return null;
      namespace = s.slice(i, comma);
      i = comma + 1;
    }
    var idText = "";
    while (i < s.length && /\d/.test(s.charAt(i))) { idText += s.charAt(i); i++; }
    if (s.charAt(i) !== "[") return null;
    var arr = safeJSON(s.slice(i));
    return Array.isArray(arr) ? { array: arr, namespace: namespace, id: idText ? Number(idText) : null } : null;
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
    if (/^40(?:$|\/|\{)/.test(s)) {
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
      var packet2 = socketArrayPacket(s, 2);
      var arr2 = packet2 && packet2.array;
      if (Array.isArray(arr2) && arr2.length >= 1) {
        return { type: "sio", event: String(arr2[0] || ""), payload: arr2.length > 1 ? arr2[1] : null,
          namespace: packet2.namespace, id: packet2.id, raw: s };
      }
      return { type: "unknown", raw: s.length > 240 ? s.slice(0, 240) + "…" : s };
    }
    // 43<ackId>["event", payload] — Socket.IO acknowledgement packet.
    if (s.indexOf("43") === 0) {
      var ackPacket = socketArrayPacket(s, 2);
      var ack2 = ackPacket && ackPacket.array;
      if (Array.isArray(ack2) && ack2.length >= 1) {
        return { type: "sio", ack: true, event: String(ack2[0] || ""), payload: ack2.length > 1 ? ack2[1] : null,
          namespace: ackPacket.namespace, id: ackPacket.id, raw: s };
      }
      return { type: "unknown", raw: s.length > 240 ? s.slice(0, 240) + "…" : s };
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
      case "instruments":
        out.instruments = parseInstruments(payload);
        try { rememberIds(out.instruments); } catch (_) {}
        break;
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
      // Older platform builds stream quotes under "tick" / "stream_update"
      // (payload identical to quotes/stream: [[symbol, ts, price], ...]).
      case "tick":                 return "quote";
      case "stream_update":        return "quote";
      case "quotes":               return "quote";
      case "history/list/v2":      return "candles";
      case "chart_notification/get": return "candles";
      case "loadHistoryPeriod":    return "candles";
      case "authorization/reject": return "auth_error";
      case "error":                return "error";
      default:                     return ev;
    }
  }

  function inferEventFromPayload(p, depth) {
    if (p == null) return "unknown";
    depth = Number.isInteger(depth) ? depth : 0;
    if (depth < 8 && !Array.isArray(p) && typeof p === "object") {
      // ACK/binary variants frequently add one transport envelope. Inspect it
      // before shape detection so {data:[[symbol,time,price]]} is not dropped.
      var wrapped = p.tick != null ? p.tick
        : (p.quotes != null ? p.quotes : (p.data != null ? p.data : p.result));
      if (wrapped != null && wrapped !== p) {
        var wrappedEvent = inferEventFromPayload(wrapped, depth + 1);
        if (wrappedEvent !== "unknown") return wrappedEvent;
      }
    }
    if (Array.isArray(p)) {
      if (!p.length) return "unknown";
      var first = p[0];
      if (Array.isArray(first) && first.length >= 3) {
        if (typeof first[0] === "string" && !/^\d+$/.test(first[0].trim()) && normalizeSymbolName(first[0]) &&
            numberValue(first[1]) != null && numberValue(first[2]) != null) {
          return "quote"; // quotes/stream shape: [symbol, ts, price, ...]
        }
        if (typeof first[0] === "number" && typeof first[1] === "string" && typeof first[2] === "string") {
          return "instruments"; // [id, symbol, name, ...]
        }
        var n0 = numberValue(first[0]), n1 = numberValue(first[1]), n2 = numberValue(first[2]);
        if (first.length === 3 && n0 != null && n1 != null && n2 != null &&
            (ID_TO_SYMBOL[n0] || n1 > 1e9)) {
          return "quote"; // [assetId, timestamp, price]
        }
        // Quotex candle rows: [ts, open, close, high, low, ...]
        if (first.length >= 5 && n0 != null && n1 != null && n2 != null &&
            numberValue(first[3]) != null && numberValue(first[4]) != null) {
          if (n0 > 1e9) return "candles"; // timestamps far in the past → history batch
        }
      }
      return "unknown";
    }
    if (typeof p === "object") {
      if (("asset" in p || "symbol" in p) && ("history" in p || "candles" in p || "period" in p)) return "candles";
      if (("instrument" in p && Array.isArray(p.instrument)) ||
          ("instruments" in p && p.instruments && (Array.isArray(p.instruments) || typeof p.instruments === "object"))) return "instruments";
      if (Array.isArray(p.tick) || Array.isArray(p.quotes)) return "quote";
      if (("asset" in p || "symbol" in p) && ("price" in p || "value" in p)) return "quote";
      if ("uid" in p && "balance" in p) return "balance";
      if ("deals" in p || "ticket" in p || "closePrice" in p || "closeTime" in p || "profit" in p || "netProfit" in p) return "order_closed";
      if (("id" in p || "requestId" in p) && ("openPrice" in p || "openTime" in p)) return "order_opened";
    }
    return "unknown";
  }

  /* ============================================================
   * 4. Payload parsers. Each one normalizes the broker-specific
   *    payload into the engine-friendly shape used by content.js.
   * ============================================================ */
  function normalizeSymbolName(s) {
    if (typeof s !== "string" && typeof s !== "number") return "";
    var symbol = String(s).trim().toUpperCase().replace(/_OTC/g, "_otc");
    if (!symbol || symbol.length > 64 || !/^[A-Z0-9][A-Z0-9._-]*$/i.test(symbol)) return "";
    return symbol;
  }

  function numberValue(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    try {
      var n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function positiveId(value) {
    var n = numberValue(value);
    return n != null && Number.isSafeInteger(n) && n > 0 && n <= 1000000000 ? n : 0;
  }

  function cleanTimeframes(raw) {
    if (!Array.isArray(raw)) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < raw.length && out.length < 64; i++) {
      var item = raw[i];
      var value = item && typeof item === "object"
        ? (item.time != null ? item.time : (item.value != null ? item.value : (Array.isArray(item) ? item[0] : null)))
        : item;
      var n = numberValue(value);
      if (n == null || n <= 0 || n > 86400) continue;
      n = Math.floor(n);
      if (seen[n]) continue;
      seen[n] = true;
      out.push(n);
    }
    return out.sort(function (a, b) { return a - b; });
  }

  function brokerBool(value, fallback) {
    if (value == null) return fallback;
    if (value === false || value === 0) return false;
    var s = String(value).trim().toLowerCase();
    if (s === "false" || s === "0" || s === "closed" || s === "no") return false;
    if (s === "true" || s === "1" || s === "open" || s === "yes") return true;
    return !!value;
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
        // Keyed by symbol: { EURUSD: {...}, ... } or by category arrays.
        // Flatten every category; selecting only the first array silently
        // dropped crypto/stocks whenever forex appeared first.
        var objectRows = [];
        var categoryRows = [];
        var inspectedKeys = 0;
        for (var key in payload) {
          if (!Object.prototype.hasOwnProperty.call(payload, key) || inspectedKeys++ >= 5000) continue;
          if (Array.isArray(payload[key])) {
            for (var ci = 0; ci < payload[key].length && categoryRows.length < 5000; ci++) categoryRows.push(payload[key][ci]);
          } else if (payload[key] && typeof payload[key] === "object") {
            objectRows.push(Object.assign({}, payload[key], { symbol: payload[key].symbol || key }));
          }
        }
        if (categoryRows.length || objectRows.length) list = categoryRows.concat(objectRows);
      }
    }
    if (!Array.isArray(list)) return [];
    var out = [];
    var seenSymbols = Object.create(null);
    for (var i = 0; i < list.length && i < 5000 && out.length < 2000; i++) {
      var row = list[i];
      if (row && !Array.isArray(row) && typeof row === "object") {
        var objSymbol = normalizeSymbolName(row.symbol || row.asset || row.code || "");
        if (!objSymbol) continue;
        if (seenSymbols[objSymbol]) continue;
        seenSymbols[objSymbol] = true;
        var rawTfs = row.timeframes || row.periods || row.times || [];
        var objTfs = cleanTimeframes(rawTfs);
        var objPayout = numberValue(row.payout);
        out.push({
          id: positiveId(row.id != null ? row.id : row.assetId),
          symbol: objSymbol,
          name: String(row.name || row.title || objSymbol).slice(0, 128),
          type: String(row.type || row.kind || "unknown").slice(0, 32),
          payout: objPayout != null ? Math.max(0, Math.min(100, objPayout)) : 0,
          isOpen: brokerBool(row.isOpen != null ? row.isOpen : row.open, true),
          isOtc: /_otc$/i.test(objSymbol),
          timeframes: objTfs.length ? objTfs : [60, 120, 180, 300, 600, 900, 1800, 3600],
        });
        continue;
      }
      if (!Array.isArray(row) || row.length < 3) continue;
      // Canonical broker row: [id, symbol, name, type, ..., payout(5), ..., tfs(12), ..., open(14)]
      // Some clients send [symbol, name, id, ...] — detect + reorder.
      var sf = typeof row[0] === "string" &&
        (typeof row[2] === "number" || /^\d+$/.test(String(row[2]))); // symbol-first row
      var id = 0;
      if (typeof row[0] === "number" || /^\d+$/.test(String(row[0]))) id = positiveId(row[0]);
      if (!id && sf) id = positiveId(row[2]);
      var raw_symbol = String(sf ? row[0] : row[1] || "").trim();
      if (!raw_symbol) continue;
      var symbol = normalizeSymbolName(raw_symbol);
      if (!symbol || seenSymbols[symbol]) continue;
      seenSymbols[symbol] = true;
      var name = String(sf ? (row[1] || symbol) : (row[2] || symbol)).slice(0, 128);
      var type = String(row[3] || "unknown").slice(0, 32);
      var rawPayout = numberValue(sf ? row[6] : row[5]);
      var payout = rawPayout != null ? Math.max(0, Math.min(100, rawPayout)) : 0;
      var isOpen = true;
      var openIdx = row.length > (sf ? 15 : 14) ? (sf ? 15 : 14) : 14;
      if (row.length > openIdx) isOpen = brokerBool(row[openIdx], true);
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
      tfs = cleanTimeframes(tfs);
      out.push({
        id: id,
        symbol: symbol,
        name: name,
        type: type,
        payout: payout,
        isOpen: isOpen,
        isOtc: /_otc$/i.test(symbol),
        timeframes: tfs.length ? tfs : [60, 120, 180, 300, 600, 900, 1800, 3600],
      });
    }
    return out;
  }

  function parseCandles(payload) {
    if (!payload || typeof payload !== "object") return null;
    var body = payload.data && !Array.isArray(payload.data) && typeof payload.data === "object"
      ? payload.data
      : (payload.result && !Array.isArray(payload.result) && typeof payload.result === "object" ? payload.result : payload);
    var asset = body.asset || body.symbol || body.pair || payload.asset || payload.symbol || payload.pair || null;
    if (asset != null && /^\d+$/.test(String(asset)) && ID_TO_SYMBOL[Number(asset)]) asset = ID_TO_SYMBOL[Number(asset)];
    var period = body.period != null ? body.period : (body.timeframe != null ? body.timeframe : (payload.period || payload.timeframe || null));
    var rows = body.history || body.candles || (Array.isArray(body.data) ? body.data : null) ||
      (Array.isArray(body.result) ? body.result : null) || (Array.isArray(payload.data) ? payload.data : null) ||
      (Array.isArray(payload.result) ? payload.result : null) || null;
    if (!asset || period == null) {
      // Some servers push {history:[...]} without metadata (headerless flow).
      // Caller should know the requested asset/period; assume 60s here.
      if (Array.isArray(rows) && rows.length) {
        var first = rows[0];
        if (asset && Array.isArray(first) && first.length >= 5) {
          var inferredAsset = normalizeSymbolName(asset);
          return inferredAsset ? { asset: inferredAsset, period: 60, raw: rows } : null;
        }
      }
      return null;
    }
    if (typeof period === "object" && period != null) {
      period = period.time != null ? period.time : (period.value != null ? period.value : 60);
    }
    period = numberValue(period);
    period = period != null && period > 0 ? Math.min(86400, Math.floor(period)) : 60;
    if (!Array.isArray(rows)) rows = [];
    asset = normalizeSymbolName(asset);
    if (!asset) return null;
    return { asset: asset, period: period, raw: rows };
  }

  function normalizeCandles(parsed) {
    if (!parsed || !Array.isArray(parsed.raw)) return [];
    var byTime = Object.create(null);
    var start = Math.max(0, parsed.raw.length - 5000);
    for (var i = start; i < parsed.raw.length; i++) {
      var row = parsed.raw[i];
      if (row && !Array.isArray(row) && typeof row === "object") {
        row = [
          row.time != null ? row.time : (row.ts != null ? row.ts : row.timestamp),
          row.open, row.close, row.high, row.low,
          row.volume != null ? row.volume : row.vol,
        ];
      }
      if (!Array.isArray(row) || row.length < 5) continue;
      // Quotex history rows are [ts, open, close, high, low, vol?]. The old
      // decoder treated index 4 (low) as close, which made historical candle
      // bodies and every close-based indicator disagree with the broker chart.
      // Derive the wick envelope from all four prices to tolerate occasional
      // high/low inversions while preserving the canonical close at index 2.
      var ts = numberValue(row[0]);
      var o = numberValue(row[1]);
      var c = numberValue(row[2]);
      var reportedHigh = numberValue(row[3]);
      var reportedLow = numberValue(row[4]);
      if (ts == null || o == null || c == null ||
          o <= 0 || c <= 0 || o > 1e100 || c > 1e100) continue;
      var hi = Math.max(o, c);
      var lo = Math.min(o, c);
      if (reportedHigh != null && reportedHigh > 0 && reportedHigh <= 1e100) {
        hi = Math.max(hi, reportedHigh); lo = Math.min(lo, reportedHigh);
      }
      if (reportedLow != null && reportedLow > 0 && reportedLow <= 1e100) {
        hi = Math.max(hi, reportedLow); lo = Math.min(lo, reportedLow);
      }
      var rawVol = row.length > 5 && row[5] != null ? numberValue(row[5]) : 0;
      var vol = rawVol == null ? 0 : rawVol;
      // Accept unix seconds, milliseconds, microseconds, or nanoseconds consistently.
      var tMs = toMs(ts);
      if (!Number.isFinite(tMs) || tMs < 0) continue;
      byTime[tMs] = {
        time: tMs,
        open: o, high: hi, low: lo, close: c,
        volume: Number.isFinite(vol) && vol >= 0 ? Math.min(vol, 1e100) : 0,
      };
    }
    var times = Object.keys(byTime).map(Number).sort(function (x, y) { return x - y; });
    var out = [];
    for (var j = 0; j < times.length; j++) out.push(byTime[times[j]]);
    return out;
  }

  function toMs(ts) {
    if (ts == null) return null;
    var n = numberValue(ts);
    if (n == null) {
      try {
        var d = Date.parse(String(ts));
        return Number.isFinite(d) && Math.abs(d) <= 8640000000000000 ? d : null;
      } catch (_) { return null; }
    }
    // Repeated division handles both microsecond and nanosecond unix stamps.
    while (Math.abs(n) >= 1e14) n /= 1000;
    if (Math.abs(n) >= 1e11) n = Math.floor(n);       // unix milliseconds
    else if (Math.abs(n) >= 1e9) n = Math.floor(n * 1000); // unix seconds
    else n = Math.floor(n);                           // relative/test value
    return Number.isSafeInteger(n) && Math.abs(n) <= 8640000000000000 ? n : null;
  }

  function parseQuote(payload, depth) {
    if (!payload) return null;
    depth = Number.isInteger(depth) ? depth : 0;
    // Object wrappers seen on broker builds. Unwrap objects as well as arrays;
    // transports may emit {data:{symbol,time,price}} rather than a bare row.
    if (!Array.isArray(payload) && typeof payload === "object") {
      var wrapped = payload.tick != null ? payload.tick
        : (payload.quotes != null ? payload.quotes
        : (payload.quote != null ? payload.quote
        : (payload.data != null ? payload.data : payload.result)));
      if (wrapped != null && wrapped !== payload) {
        if (depth >= 8) return null;
        return parseQuote(wrapped, depth + 1);
      }
    }
    var symbol = null, ts = null, price = null;
    if (Array.isArray(payload)) {
      if (!payload.length) return null;
      var first = Array.isArray(payload[0]) ? payload[0] : payload;
      // [symbol, ts, price, ...]
      if (typeof first[0] === "string" && !/^\d+$/.test(first[0].trim())) {
        symbol = String(first[0]);
        ts = first[1];
        price = numberValue(first[2]);
      }
      // [ts, symbol, price]
      if (price == null && typeof first[1] === "string") {
        ts = first[0];
        symbol = String(first[1]);
        price = numberValue(first[2]);
      }
      // [assetId, ts, price] — resolve the numeric broker id to a symbol.
      // Some broker regions serialize every tuple field as a string.
      var numericId = numberValue(first[0]);
      var numericTs = numberValue(first[1]);
      if (price == null && numericId != null && numericTs != null && first.length >= 3) {
        var byId = ID_TO_SYMBOL[numericId];
        if (byId) {
          symbol = byId;
          ts = numericTs;
          price = numberValue(first[2]);
        }
      }
      // [ts, price] — two-element rows on some streams. Headerless quotes
      // cannot identify an asset here and are therefore rejected below.
      if (price == null && numericTs != null && first.length === 2) {
        ts = first[0];
        price = numericTs;
      }
    } else if (typeof payload === "object") {
      symbol = payload.symbol || payload.asset || payload.pair || null;
      ts = payload.time != null ? payload.time : (payload.ts != null ? payload.ts : null);
      price = payload.price != null ? numberValue(payload.price)
            : payload.value != null ? numberValue(payload.value)
            : payload.close != null ? numberValue(payload.close) : null;
    }
    var symbolId = numberValue(symbol);
    if (symbolId != null && /^\d+$/.test(String(symbol).trim()) && ID_TO_SYMBOL[symbolId]) {
      symbol = ID_TO_SYMBOL[symbolId];
    }
    symbol = normalizeSymbolName(symbol);
    if (!symbol || price == null || !Number.isFinite(price) || price <= 0 || price > 1e100) return null;
    return {
      symbol: symbol,
      time: toMs(ts),
      price: price,
    };
  }

  function parseQuotes(payload, depth) {
    if (!payload) return [];
    depth = Number.isInteger(depth) ? depth : 0;
    if (!Array.isArray(payload) && typeof payload === "object") {
      var wrapped = payload.tick != null ? payload.tick
        : (payload.quotes != null ? payload.quotes
        : (payload.quote != null ? payload.quote
        : (payload.data != null ? payload.data : payload.result)));
      if (wrapped != null && wrapped !== payload) {
        if (depth >= 8) return [];
        return parseQuotes(wrapped, depth + 1);
      }
    }
    var out = [];
    if (Array.isArray(payload) && payload.length &&
        (Array.isArray(payload[0]) || (payload[0] && typeof payload[0] === "object"))) {
      var quoteStart = Math.max(0, payload.length - 5000);
      for (var i = quoteStart; i < payload.length; i++) {
        var nested = parseQuote(payload[i]);
        if (nested) out.push(nested);
      }
      return out;
    }
    var one = parseQuote(payload);
    if (one) out.push(one);
    return out;
  }

  function parseBalance(payload, depth) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    depth = Number.isInteger(depth) ? depth : 0;
    var wrapped = payload.data != null ? payload.data
      : (payload.result != null ? payload.result
      : (payload.account != null ? payload.account
      : (payload.balance && typeof payload.balance === "object" ? payload.balance : null)));
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped) && wrapped !== payload) {
      return depth >= 8 ? null : parseBalance(wrapped, depth + 1);
    }
    var uid = positiveId(payload.uid);
    var bal = numberValue(payload.balance != null ? payload.balance : (payload.amount != null ? payload.amount : 0));
    return {
      uid: uid,
      balance: bal != null && bal >= 0 && bal <= 1e100 ? bal : 0,
      currency: String(payload.currency || "USD").slice(0, 16),
      isDemo: payload.isDemo != null ? brokerBool(payload.isDemo, null) : (payload.is_demo != null ? brokerBool(payload.is_demo, null) : null),
      accountType: payload.accountType || payload.account_type
        ? String(payload.accountType || payload.account_type).slice(0, 32) : null,
    };
  }

  function orderBody(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
    var nested = payload.order || payload.deal || payload.ticket || payload.data ||
      (payload.result && typeof payload.result === "object" ? payload.result : null);
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return payload;
    // Placement ACKs often keep correlation on the envelope and order fields
    // under data/result. Preserve the ID or automation times out despite a
    // broker-confirmed order.
    if (nested.requestId == null && payload.requestId != null) {
      var correlated = {};
      for (var key in nested) {
        if (Object.prototype.hasOwnProperty.call(nested, key) && key !== "__proto__") correlated[key] = nested[key];
      }
      correlated.requestId = payload.requestId;
      return correlated;
    }
    return nested;
  }

  function orderDirection(payload) {
    var command = numberValue(payload.command);
    var action = String(payload.action != null ? payload.action : (payload.direction != null ? payload.direction : "")).toLowerCase();
    if (command === 0 || action === "call" || action === "buy" || action === "up") return "CALL";
    if (command === 1 || action === "put" || action === "sell" || action === "down") return "PUT";
    return null;
  }

  function positiveNumber(value) {
    var n = numberValue(value);
    return n != null && n > 0 && n <= 1e100 ? n : 0;
  }

  function parseOrderOpened(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    payload = orderBody(payload);
    var openTime = toMs(payload.openTime != null ? payload.openTime : payload.openTimestamp);
    var closeTime = toMs(payload.closeTime != null ? payload.closeTime : payload.closeTimestamp);
    var rawDuration = numberValue(payload.duration);
    var duration = Number.isFinite(rawDuration) && rawDuration > 0 ? Math.min(86400, Math.floor(rawDuration)) : 0;
    if (!closeTime && openTime != null && duration) closeTime = openTime + duration * 1000;
    var rawId = payload.id != null ? payload.id : payload.orderId;
    if (rawId == null && payload.requestId == null && !payload.asset && !payload.symbol) return null;
    return {
      id: rawId != null ? String(rawId).slice(0, 128) : "",
      requestId: payload.requestId != null ? String(payload.requestId).slice(0, 128) : null,
      asset: normalizeSymbolName(payload.asset || payload.symbol || ""),
      amount: positiveNumber(payload.amount),
      direction: orderDirection(payload),
      openPrice: positiveNumber(payload.openPrice),
      openTime: openTime,
      closeTime: closeTime,
      expiryTime: closeTime,
      duration: duration,
      status: "OPEN",
    };
  }

  function parseOrderClosed(payload) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    payload = orderBody(payload);
    var profit = numberValue(payload.profit);
    if (profit != null && Math.abs(profit) > 1e100) profit = null;
    var amount = positiveNumber(payload.amount);
    var resultText = String(payload.result || payload.status || payload.outcome || "").trim().toLowerCase();
    var explicitWin = payload.win === true || /^(win|won|success)$/.test(resultText);
    var explicitLoss = payload.loss === true || /^(loss|lost|lose|failed)$/.test(resultText);
    var explicitDraw = payload.draw === true || /^(draw|tie|equal|refund|refunded|cancelled|canceled)$/.test(resultText);
    var explicitNet = numberValue(payload.netProfit != null ? payload.netProfit : payload.net_profit);
    if (explicitNet != null && Math.abs(explicitNet) > 1e100) explicitNet = null;
    // Quotex commonly reports gross return in `profit` (zero on loss). Expose
    // a net value for risk caps while retaining the broker field unchanged.
    // Missing outcome fields stay UNKNOWN; treating missing profit as zero
    // fabricated a full-stake loss and froze the asset.
    var netProfit = null;
    if (explicitNet != null) netProfit = explicitNet;
    else if (explicitDraw || (amount > 0 && profit != null && profit === amount)) netProfit = 0;
    else if (explicitLoss) netProfit = profit != null && profit < 0 ? profit : (amount > 0 ? -amount : null);
    else if (explicitWin && profit != null) netProfit = amount > 0 && profit >= amount ? profit - amount : profit;
    else if (profit != null && profit < 0) netProfit = profit;
    else if (amount > 0 && profit === 0) netProfit = -amount;
    else if (amount > 0 && profit != null && profit > amount) netProfit = profit - amount;
    else if (profit != null) netProfit = profit;
    var draw = explicitDraw || (!explicitWin && !explicitLoss && netProfit === 0);
    var win = !draw && (explicitWin || (!explicitLoss && netProfit != null && netProfit > 0));
    var loss = !draw && (explicitLoss || (!explicitWin && netProfit != null && netProfit < 0));
    var openTime = toMs(payload.openTime != null ? payload.openTime : payload.openTimestamp);
    var closeTime = toMs(payload.closeTime != null ? payload.closeTime : payload.closeTimestamp);
    var rawDuration = numberValue(payload.duration);
    var duration = Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.min(86400, Math.floor(rawDuration))
      : (openTime != null && closeTime != null ? Math.max(0, Math.min(86400, Math.round((closeTime - openTime) / 1000))) : 0);
    var rawId = payload.id != null ? payload.id : payload.orderId;
    if (rawId == null && payload.requestId == null && !payload.asset && !payload.symbol) return null;
    return {
      id: rawId != null ? String(rawId).slice(0, 128) : "",
      requestId: payload.requestId != null ? String(payload.requestId).slice(0, 128) : null,
      asset: normalizeSymbolName(payload.asset || payload.symbol || ""),
      amount: amount,
      direction: orderDirection(payload),
      profit: profit,
      netProfit: netProfit,
      win: win,
      loss: loss,
      draw: draw,
      openPrice: positiveNumber(payload.openPrice),
      closePrice: positiveNumber(payload.closePrice),
      openTime: openTime,
      closeTime: closeTime,
      expiryTime: closeTime,
      duration: duration,
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
    var source = String(text);
    var m = source.match(/\d[\d\s.,]*/);
    if (!m) return null;
    var raw = m[0].replace(/\s/g, "");
    var comma = raw.lastIndexOf(",");
    var dot = raw.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      // The final separator is decimal; earlier separators are grouping.
      var decimalAt = Math.max(comma, dot);
      raw = raw.slice(0, decimalAt).replace(/[.,]/g, "") + "." + raw.slice(decimalAt + 1).replace(/[.,]/g, "");
    } else if (comma >= 0) {
      // Comma is decimal unless it is an obvious 3-digit thousands group.
      var commaDigits = raw.length - comma - 1;
      var commas = (raw.match(/,/g) || []).length;
      var obviousGrouping = commas > 1 || (commaDigits === 3 && /[$€£₹]/.test(source));
      raw = obviousGrouping ? raw.replace(/,/g, "") : raw.replace(/,/g, ".");
    } else if ((raw.match(/\./g) || []).length > 1) {
      var lastDot = raw.lastIndexOf(".");
      raw = raw.slice(0, lastDot).replace(/\./g, "") + "." + raw.slice(lastDot + 1);
    }
    var n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function findAssetHeader() {
    var sels = [
      "[aria-current='true'] [class*='asset']",
      "[aria-selected='true'] [class*='asset']",
      "[class*='active'][class*='asset']",
      "[class*='selected'][class*='asset']",
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
    var best = null;
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length && j < 100; j++) {
        var el = nodes[j];
        if (!isVisible(el)) continue;
        var t = visibleText(el);
        if (!t || t.length < 3 || t.length >= 48) continue;
        // Asset drawers and "open chart" controls may contain every symbol.
        // Only short leaf-like labels are eligible for the main header.
        if (el.children && el.children.length > 3) continue;
        var meta = String(el.className || "") + " " +
          String(el.getAttribute && (el.getAttribute("aria-current") || el.getAttribute("aria-selected") || ""));
        var score = 0;
        if (/active|current|selected|chosen|true/i.test(meta)) score += 20;
        if (/symbol|pair|asset.?name|trading.?pair/i.test(meta)) score += 8;
        try {
          var r = el.getBoundingClientRect();
          if (r.top >= 0 && r.top < Math.max(220, window.innerHeight * 0.35)) score += 4;
          if (r.width >= 40 && r.width <= 320) score += 2;
        } catch (_) {}
        score -= t.length / 100;
        if (!best || score > best.score) best = { el: el, text: t, score: score };
      }
    }
    return best ? { el: best.el, text: best.text } : null;
  }

  function findPriceLabel() {
    var sels = [
      // Deliberately exclude `current-profit`: that is an order P&L label,
      // not the chart quote, and feeding it produced invalid candles.
      "[class*='current-price']",
      "[class*='currentPrice']",
      "[class*='chart-price']",
      "[class*='asset-price']",
      "[class*='price-info']",
      "[class*='quotes'] [class*='price']",
      "[data-test*='price']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length && j < 100; j++) {
        if (!isVisible(nodes[j])) continue;
        var p = parsePrice(visibleText(nodes[j]));
        if (p && p > 0.0001 && p <= 1e12) return { el: nodes[j], price: p };
      }
    }
    // Fallback: scan only visible leaf nodes whose own class explicitly says
    // price/quote/rate. Do not scope this to the stake panel, where amount and
    // payout values can look exactly like prices.
    var all = document.querySelectorAll("span, div, strong, b");
    for (var k = 0; k < all.length && k < 800; k++) {
      if (all[k].children.length > 1 || !isVisible(all[k])) continue;
      var t = visibleText(all[k]);
      if (t.length < 3 || t.length > 18) continue;
      var cls = (all[k].className || "").toString().toLowerCase();
      if (!/price|quote|rate|last|valor|curso/i.test(cls)) continue;
      var p2 = parsePrice(t);
      if (p2 && p2 > 0.0001 && p2 <= 1e12) return { el: all[k], price: p2 };
    }
    return null;
  }

  function findStakeInput() {
    var cands = stakeCandidates();
    return cands.length ? cands[0].el : null;
  }

  function findExpirySelect() {
    // Keep this deliberately narrow. A generic `button[class*='time']`
    // matched chart/history icons on some builds and auto-clicked them.
    var sels = [
      "select[class*='expir']",
      "select[name*='expir']",
      "select[data-testid*='expir' i]",
      "input[class*='expir']",
      "input[name*='expir']",
      "input[class*='duration']",
      "[class*='expiration'] [role='combobox']",
      "[class*='expiry'] [role='combobox']",
      "[class*='duration'] [role='combobox']",
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length && j < 100; j++) {
        if (isVisible(nodes[j])) return nodes[j];
      }
    }
    return null;
  }

  function parseExpirySeconds(text, nowMs) {
    var raw = String(text == null ? "" : text).trim().toLowerCase();
    if (!raw) return null;
    var h = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:h|hr|hour)/i);
    var m = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:m|min|minute)/i);
    var s = raw.match(/(\d+(?:[.,]\d+)?)\s*(?:s|sec|second)/i);
    if (h || m || s) {
      var seconds = Math.round((h ? parseFloat(h[1].replace(",", ".")) * 3600 : 0) +
        (m ? parseFloat(m[1].replace(",", ".")) * 60 : 0) +
        (s ? parseFloat(s[1].replace(",", ".")) : 0));
      return Number.isFinite(seconds) && seconds > 0 && seconds <= 86400 ? seconds : null;
    }
    var parts = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (parts) {
      var a = +parts[1], b = +parts[2];
      if (b >= 60) return null;
      if (parts[3] != null) {
        var c = +parts[3];
        if (c >= 60) return null;
        var durationSeconds = a * 3600 + b * 60 + c;
        return durationSeconds > 0 && durationSeconds <= 86400 ? durationSeconds : null;
      }
      // Quotex commonly displays an absolute HH:MM expiry clock. Convert it
      // to a future duration; values <= 4h are treated as MM:SS instead.
      if (a <= 4) return a || b ? a * 60 + b : null;
      if (a > 23) return null;
      var base = numberValue(nowMs);
      var now = new Date(base != null ? base : Date.now());
      var target = new Date(now.getTime());
      target.setHours(a, b, 0, 0);
      if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1);
      return Math.round((target.getTime() - now.getTime()) / 1000);
    }
    if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
      var numericSeconds = Math.round(parseFloat(raw.replace(",", ".")) * 60);
      return Number.isFinite(numericSeconds) && numericSeconds > 0 && numericSeconds <= 86400 ? numericSeconds : null;
    }
    return null;
  }

  function setExpiry(expirySec) {
    var requested = numberValue(expirySec);
    if (requested == null || requested < 30 || requested > 86400) return { ok: false, error: "invalid expiry" };
    var wanted = Math.round(requested);
    var el = findExpirySelect();
    if (!el) return { ok: false, error: "expiry control not found" };
    try {
      if (String(el.tagName || "").toUpperCase() === "SELECT" && el.options) {
        var best = null;
        for (var i = 0; i < el.options.length; i++) {
          var opt = el.options[i];
          var sec = parseExpirySeconds((opt.textContent || "") + " " + (opt.value || ""));
          if (sec == null) continue;
          var diff = Math.abs(sec - wanted);
          if (!best || diff < best.diff) best = { option: opt, sec: sec, diff: diff };
        }
        if (!best || best.diff > Math.max(5, wanted * 0.1)) return { ok: false, error: "configured expiry unavailable" };
        var selectProto = window.HTMLSelectElement && window.HTMLSelectElement.prototype;
        var descriptor = selectProto ? Object.getOwnPropertyDescriptor(selectProto, "value") : null;
        if (descriptor && descriptor.set) descriptor.set.call(el, best.option.value);
        else el.value = best.option.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (String(el.value) !== String(best.option.value)) return { ok: false, error: "expiry selection was rejected" };
        return { ok: true, expiry: best.sec };
      }
      if (String(el.tagName || "").toUpperCase() === "INPUT") {
        var secondsInput = /sec/i.test(String(el.className || "") + " " + String(el.name || ""));
        var unit = secondsInput ? wanted : wanted / 60;
        var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
        if (setter && setter.set) setter.set.call(el, String(unit));
        else el.value = String(unit);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        var actualUnit = Number(String(el.value).replace(",", "."));
        var actualSeconds = actualUnit * (secondsInput ? 1 : 60);
        if (!Number.isFinite(actualSeconds) || Math.abs(actualSeconds - wanted) > 1) {
          return { ok: false, error: "expiry input was rejected" };
        }
        return { ok: true, expiry: Math.round(actualSeconds) };
      }
      var current = parseExpirySeconds(visibleText(el));
      if (current != null && Math.abs(current - wanted) <= Math.max(5, wanted * 0.1)) {
        return { ok: true, expiry: current, unchanged: true };
      }
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
    return { ok: false, error: "expiry control is not safely editable" };
  }

  function findCallButton() { return findDirButton("CALL"); }
  function findPutButton()  { return findDirButton("PUT"); }

  // Direction words must be complete tokens. The previous `/up/` test also
  // matched innocent classes such as "group", "popup" and "setup", which is
  // how the extension ended up clicking Quotex's open-chart icon.
  var CALL_HINTS = /(?:^|[\s_\-:/])(call|buy|up|rise|higher|bull|subir|comprar)(?:$|[\s_\-:/])|[↑⇑▲➚↗]/i;
  var PUT_HINTS = /(?:^|[\s_\-:/])(put|sell|down|fall|lower|bear|bajar|vender)(?:$|[\s_\-:/])|[↓⇓▼➘↘]/i;

  function elementDirHints(el) {
    var attrs = "";
    try {
      attrs = (el.getAttribute("aria-label") || "") + " " +
        (el.getAttribute("data-type") || "") + " " +
        (el.getAttribute("data-direction") || "") + " " +
        (el.getAttribute("data-testid") || "");
    } catch (_) {}
    var child = "";
    try {
      var nodes = el.querySelectorAll ? el.querySelectorAll("svg, path, use, span, i") : [];
      for (var i = 0; i < nodes.length && i < 8; i++) {
        child += " " + (nodes[i].textContent || "") + " " + (nodes[i].className || "") + " " +
          (nodes[i].getAttribute && ((nodes[i].getAttribute("aria-label") || "") + " " +
          (nodes[i].getAttribute("d") || "") + " " + (nodes[i].getAttribute("href") || "")));
      }
    } catch (_) {}
    var text = " " + (el.textContent || "") + " " + attrs + " " + (el.className || "") + child + " ";
    var call = CALL_HINTS.test(text);
    var put = PUT_HINTS.test(text);
    return { call: call, put: put, explicit: call !== put };
  }

  function colorVoteFromStyle(style) {
    if (!style) return null;
    var raw = String(style.backgroundColor || "") + " " + String(style.backgroundImage || "") + " " +
      String(style.borderColor || "") + " " + String(style.color || "");
    var matches = raw.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g);
    if (!matches) return null;
    var green = 0, red = 0;
    for (var i = 0; i < matches.length; i++) {
      var m = matches[i].match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) continue;
      var r = +m[1], g = +m[2], b = +m[3];
      if (g > r + 25 && g > b + 25) green++;
      if (r > g + 25 && r > b + 25) red++;
    }
    if (green && !red) return true;
    if (red && !green) return false;
    return null;
  }

  function elementIsGreen(el) {
    try {
      var direct = colorVoteFromStyle(getComputedStyle(el));
      if (direct !== null) return direct;
      var kids = el.querySelectorAll ? el.querySelectorAll("span, div, svg, i") : [];
      for (var i = 0; i < kids.length && i < 8; i++) {
        var vote = colorVoteFromStyle(getComputedStyle(kids[i]));
        if (vote !== null) return vote;
      }
      return null;
    } catch (_) { return null; }
  }

  function findDirButton(dir) {
    var panel = findPanel();
    var scope = panel || document;
    // Query direction selectors independently. One unsupported selector or a
    // brittle DOM shim must not discard every other valid action button, and
    // de-duplication keeps the bounded scan deterministic.
    var selectors = [
      "button", "[role='button']", "[data-type]", "[data-direction]",
      "[aria-label*='up' i]", "[aria-label*='down' i]", "[aria-label*='call' i]", "[aria-label*='put' i]",
      "[class*='call' i]", "[class*='put' i]", "[class*='up' i]", "[class*='down' i]",
      "[class*='higher' i]", "[class*='lower' i]", "[class*='buy' i]", "[class*='sell' i]",
    ];
    var all = [];
    for (var si = 0; si < selectors.length && all.length < 500; si++) {
      var selected = [];
      try { selected = scope.querySelectorAll(selectors[si]); } catch (_) { selected = []; }
      for (var sj = 0; sj < selected.length && all.length < 500; sj++) {
        if (all.indexOf(selected[sj]) === -1) all.push(selected[sj]);
      }
    }
    var explicit = [];
    var greens = [];
    var reds = [];

    function eligible(el, hinted) {
      if (!el || !isVisible(el)) return false;
      if (el.closest && el.closest("#cyber-binary-hud")) return false;
      if (el.disabled || (el.getAttribute && el.getAttribute("aria-disabled") === "true")) return false;
      var blob = ((el.textContent || "") + " " + (el.className || "") + " " +
        (el.getAttribute && (el.getAttribute("aria-label") || ""))).toLowerCase();
      if (/open.?chart|add.?chart|chart.?icon|new.?chart|settings|deposit|withdraw|profile|menu|timeframe/.test(blob)) return false;
      try {
        var r = el.getBoundingClientRect();
        // Icon controls are normally square and < 60px. Direction buttons
        // are broad action controls; explicit CALL/PUT labels get a little
        // more leeway for compact/mobile layouts.
        if (r.height < 28 || r.width < (hinted ? 56 : 80)) return false;
        if (!hinted && r.width < r.height * 1.45) return false;
      } catch (_) {}
      return true;
    }

    for (var i = 0; i < all.length && i < 500; i++) {
      var el = all[i];
      var hints = elementDirHints(el);
      if (hints.explicit && eligible(el, true)) {
        explicit.push({ el: el, dir: hints.call ? "CALL" : "PUT" });
        continue;
      }
      if (!eligible(el, false)) continue;
      var color = elementIsGreen(el);
      if (color === true) greens.push(el);
      else if (color === false) reds.push(el);
    }

    // Explicit token/attribute matches are safest. If several charts are
    // visible, prefer the pair in the detected trade panel, then the largest
    // action control (never the first arbitrary button in DOM order).
    var bestExplicitPair = null;
    for (var ej = 0; ej < explicit.length; ej++) {
      if (explicit[ej].dir !== "CALL") continue;
      for (var ek = 0; ek < explicit.length; ek++) {
        if (explicit[ek].dir !== "PUT") continue;
        try {
          var cr = explicit[ej].el.getBoundingClientRect();
          var pr = explicit[ek].el.getBoundingClientRect();
          var comparable = Math.abs(cr.width - pr.width) <= Math.max(30, cr.width * 0.35) &&
            Math.abs(cr.height - pr.height) <= Math.max(18, cr.height * 0.4);
          var close = Math.abs(cr.left - pr.left) < Math.max(cr.width, pr.width) * 2.5 &&
            Math.abs(cr.top - pr.top) < 320;
          var sameParent = explicit[ej].el.parentElement && explicit[ej].el.parentElement === explicit[ek].el.parentElement;
          if (!comparable || !close || (!sameParent && !panel)) continue;
          var pairScore = cr.width * cr.height + pr.width * pr.height + (sameParent ? 10000 : 0);
          if (!bestExplicitPair || pairScore > bestExplicitPair.score) {
            bestExplicitPair = { call: explicit[ej].el, put: explicit[ek].el, score: pairScore };
          }
        } catch (_) {}
      }
    }
    if (bestExplicitPair) return dir === "CALL" ? bestExplicitPair.call : bestExplicitPair.put;

    // Hashed builds can omit labels. Accept color only when a credible
    // green/red action PAIR exists: similar dimensions, nearby, and either a
    // common parent or both within the canonical trade panel.
    var bestPair = null;
    for (var g = 0; g < greens.length; g++) {
      for (var r = 0; r < reds.length; r++) {
        try {
          var gr = greens[g].getBoundingClientRect();
          var rr = reds[r].getBoundingClientRect();
          var similar = Math.abs(gr.width - rr.width) <= Math.max(24, gr.width * 0.25) &&
            Math.abs(gr.height - rr.height) <= Math.max(14, gr.height * 0.3);
          var near = Math.abs(gr.left - rr.left) < Math.max(gr.width, rr.width) * 1.5 &&
            Math.abs(gr.top - rr.top) < 260;
          var paired = greens[g].parentElement && greens[g].parentElement === reds[r].parentElement;
          if (!similar || !near || (!paired && !panel)) continue;
          var score = gr.width * gr.height + rr.width * rr.height + (paired ? 10000 : 0);
          if (!bestPair || score > bestPair.score) bestPair = { call: greens[g], put: reds[r], score: score };
        } catch (_) {}
      }
    }
    if (bestPair) return dir === "CALL" ? bestPair.call : bestPair.put;

    // No positional fallback. Clicking nothing is much safer than clicking a
    // chart/menu icon or the wrong direction.
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
      for (var j = 0; j < nodes.length && j < 100; j++) {
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
      if (!n || !isVisible(n)) continue;
      var tag = String(n.tagName || "").toUpperCase();
      if (tag === "BUTTON" || tag === "INPUT" || tag === "A") continue;
      try {
        var r = n.getBoundingClientRect();
        if (r.width < 140 || r.height < 120) continue;
      } catch (_) {}
      return n;
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
  function stakeCandidates() {
    var sels = [
      "input[class*='amount']", "input[class*='stake']", "input[class*='sum']", "input[class*='invest']",
      "input[aria-label*='amount' i]", "input[aria-label*='stake' i]", "input[aria-label*='invest' i]",
      "input[placeholder*='amount' i]", "input[placeholder*='stake' i]", "input[placeholder*='invest' i]",
      "input[name='amount']", "input[name='sum']", "input[name='stake']", "input[name='investment']",
      "input[data-testid*='amount' i]", "input[data-testid*='stake' i]", "input[data-testid*='invest' i]",
      "[class*='stake'] input", "[class*='amount'] input", "[class*='invest'] input", "[class*='investment'] input",
      "[data-testid*='stake' i] input", "[data-testid*='amount' i] input", "[data-testid*='invest' i] input",
      "[data-test*='stake' i] input", "[data-test*='amount' i] input", "[data-test*='invest' i] input",
    ];
    var out = [];
    var seen = [];
    var panel = null;
    try { panel = findPanel(); } catch (_) {}
    var btn = null;
    try { btn = findCallButton() || findPutButton(); } catch (_) {}
    for (var i = 0; i < sels.length; i++) {
      var nodes = document.querySelectorAll(sels[i]);
      for (var j = 0; j < nodes.length && j < 100; j++) {
        var el = nodes[j];
        if (!isVisible(el)) continue;
        if (seen.indexOf(el) !== -1) continue;
        seen.push(el);
        var type = (el.type || "").toLowerCase();
        if (type === "hidden" || type === "checkbox" || type === "radio" || type === "submit" || type === "button") continue;
        var score = 2; // every selector above contains an amount/stake/invest token
        var tag = (el.className || "") + " " + (el.placeholder || "") + " " + (el.getAttribute && (el.getAttribute("aria-label") || ""));
        if (/amount|stake|sum|invest/i.test(tag)) score += 4;
        if (el.inputMode === "decimal" || el.inputMode === "numeric") score += 1;
        if (panel && panel.contains && panel.contains(el)) score += 2;
        else if (panel && panel.querySelectorAll) {
          // is el inside panel?
          var p = el.parentElement;
          while (p) { if (p === panel) { score += 2; break; } p = p.parentElement; }
        }
        if (btn) {
          try {
            var r1 = el.getBoundingClientRect(), r2 = btn.getBoundingClientRect();
            var dist = Math.abs(r1.top - r2.top) + Math.abs(r1.left - r2.left);
            if (dist < 400) score += 1;
          } catch (_) {}
        }
        out.push({ el: el, score: score });
      }
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  function setStake(amount) {
    var wanted = numberValue(amount);
    if (wanted == null || wanted <= 0 || wanted > 1000000) return false;
    var cands = stakeCandidates();
    if (!cands.length || cands[0].score < 2) return false;
    var el = cands[0].el;
    var min = Number(el.min), max = Number(el.max);
    if (el.min !== "" && Number.isFinite(min) && wanted < min) return false;
    if (el.max !== "" && Number.isFinite(max) && wanted > max) return false;
    try {
      try { if (typeof el.focus === "function") el.focus(); } catch (_) {}
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(el, String(wanted));
      else el.value = String(wanted);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      // Quotex may render a currency prefix/suffix or localized decimal after
      // React processes the input. Validate the numeric content, not the raw
      // decorated string.
      var cleaned = String(el.value == null ? "" : el.value)
        .replace(/[^0-9,.-]/g, "").replace(",", ".");
      var actual = Number(cleaned);
      return Number.isFinite(actual) && Math.abs(actual - wanted) <= Math.max(1e-9, Math.abs(wanted) * 1e-9);
    } catch (_) { return false; }
  }

  function placeTradeDom(args) {
    args = args || {};
    var dir = String(args.dir || args.direction || "").toUpperCase();
    if (dir !== "CALL" && dir !== "PUT") return { ok: false, mode: "dom", error: "invalid direction" };
    var amount = numberValue(args.amount);
    if (amount == null || amount <= 0 || amount > 1000000) {
      return { ok: false, mode: "dom", error: "a valid amount is required" };
    }
    if (!setStake(amount)) {
      return { ok: false, mode: "dom", error: "stake input not found or rejected" };
    }
    if (args.expiry == null && args.expirySec == null) {
      return { ok: false, mode: "dom", error: "a verified expiry is required" };
    }
    var expiryResult = setExpiry(args.expiry != null ? args.expiry : args.expirySec);
    if (!expiryResult.ok) {
      return { ok: false, mode: "dom", error: expiryResult.error || "expiry not set" };
    }
    var btn = dir === "CALL" ? findCallButton() : findPutButton();
    if (!btn) return { ok: false, mode: "dom", error: "verified trade button not visible" };
    try {
      btn.click();
      return {
        ok: true, confirmed: false, mode: "dom", id: null, dir: dir,
        amount: amount, expiry: expiryResult.expiry,
      };
    } catch (e) {
      return { ok: false, mode: "dom", error: String(e && e.message || e) };
    }
  }

  function qxExpirationEpoch(nowMs, expirySec) {
    var baseNow = numberValue(nowMs);
    if (baseNow == null || baseNow <= 0) baseNow = Date.now();
    var requested = numberValue(expirySec);
    if (requested == null || requested <= 0) requested = 60;
    requested = Math.min(86400, requested);
    var minutes = Math.max(1, Math.ceil(requested / 60));
    // Quotex's regular-market binary contract expects an ABSOLUTE unix
    // expiry, rounded to the minute. Epoch arithmetic avoids local-time DST
    // jumps that Date#setMinutes can introduce.
    var nowSec = Math.floor(baseNow / 1000);
    var extra = nowSec % 60 >= 30 ? 1 : 0;
    return (Math.floor(nowSec / 60) + minutes + extra) * 60;
  }

  // The `orders/open` payload the server expects. OTC contracts use a duration
  // in seconds with optionType=100. Regular-market contracts use an absolute
  // unix expiry with optionType=1. The old implementation sent duration+type1
  // for every asset, so the server rejected otherwise valid trades.
  function buildOrderPayload(args) {
    args = args || {};
    var dir = String(args.dir || args.direction || "").toUpperCase();
    if (dir !== "CALL" && dir !== "PUT") throw new Error("invalid direction");
    var action = dir === "CALL" ? "call" : "put";
    var asset = normalizeSymbolName(args.asset || args.symbol || "");
    if (!asset) throw new Error("asset required");
    var parsedAmount = numberValue(args.amount);
    if (parsedAmount == null || parsedAmount <= 0 || parsedAmount > 1000000) throw new Error("invalid amount");
    var amount = parsedAmount;
    var parsedExpiry = numberValue(args.expirySec != null ? args.expirySec : args.expiry);
    if (parsedExpiry == null || parsedExpiry < 30 || parsedExpiry > 86400) throw new Error("invalid expiry");
    var expirySec = Math.round(parsedExpiry);
    var requestId = args.requestId != null ? args.requestId : String(Date.now());
    if (!(args.isDemo === true || args.isDemo === false || args.isDemo === 1 || args.isDemo === 0)) {
      throw new Error("account mode must be known");
    }
    var otc = /_otc$/i.test(asset);
    var optionType = otc ? 100 : 1;
    var requestedType = args.optionType != null ? numberValue(args.optionType) : optionType;
    if (requestedType !== optionType) throw new Error("option type does not match asset market");
    var expectedEpoch = optionType === 1 ? qxExpirationEpoch(args.nowMs != null ? args.nowMs : Date.now(), expirySec) : null;
    var suppliedEpoch = args.expiryEpoch != null ? numberValue(args.expiryEpoch) : null;
    if (args.expiryEpoch != null && suppliedEpoch == null) throw new Error("invalid absolute expiry");
    if (optionType === 1 && suppliedEpoch != null &&
        Math.abs(Math.floor(suppliedEpoch) - expectedEpoch) > 60) {
      throw new Error("invalid absolute expiry");
    }
    var timeField = optionType === 1 && suppliedEpoch != null ? Math.floor(suppliedEpoch)
      : (optionType === 1 ? expectedEpoch : expirySec);
    var requestNumber = numberValue(requestId);
    if (requestNumber == null || !Number.isSafeInteger(requestNumber) || requestNumber <= 0) requestNumber = Date.now();
    return {
      asset: asset,
      amount: amount,
      time: timeField,
      action: action,
      isDemo: brokerBool(args.isDemo, false) ? 1 : 0,
      tournamentId: 0,
      requestId: requestNumber,
      optionType: optionType,
    };
  }

  function placeTradeWs(ws, args) {
    args = args || {};
    if (!ws || typeof ws.send !== "function") return { ok: false, mode: "ws", error: "no websocket handle" };
    if (ws.readyState != null && numberValue(ws.readyState) !== 1) return { ok: false, mode: "ws", error: "websocket is not open" };
    if (!args.asset) return { ok: false, mode: "ws", error: "asset required" };
    var wsDir = String(args.dir || args.direction || "").toUpperCase();
    if (wsDir !== "CALL" && wsDir !== "PUT") return { ok: false, mode: "ws", error: "invalid direction" };
    var wsAmount = args.amount == null ? null : numberValue(args.amount);
    if (args.amount != null && (wsAmount == null || wsAmount <= 0)) {
      return { ok: false, mode: "ws", error: "amount must be positive" };
    }
    try {
      var payload = buildOrderPayload(args);
      // Send `tick` + `instruments/follow` then `orders/open` — this is the
      // exact sequence the page uses when the user clicks.
      try { ws.send('42["tick"]'); } catch (_) {}
      try { ws.send('42["instruments/follow","' + payload.asset + '"]'); } catch (_) {}
      var msg = '42["orders/open",' + JSON.stringify(payload) + ']';
      ws.send(msg);
      return {
        ok: true,
        confirmed: false,
        sent: true,
        mode: "ws",
        id: String(payload.requestId),
        requestId: String(payload.requestId),
        dir: payload.action === "put" ? "PUT" : "CALL",
        asset: payload.asset,
        amount: payload.amount,
        expiry: parseInt(args.expirySec != null ? args.expirySec : args.expiry, 10) || 60,
        expiryTime: payload.optionType === 1 ? payload.time * 1000 : Date.now() + payload.time * 1000,
        optionType: payload.optionType,
        message: msg,
      };
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
      asset:     handlers.onAsset     || function () {},
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
      // Learn broker ids from the live payload (numeric tick rows and
      // orders reference assets by id, so this is what makes detection work
      // even on builds whose quotes/stream uses numeric ids).
      try { rememberIds(list); } catch (_) {}
      try { listeners.instruments(list); } catch (_) {}
      feed("instruments", list, null);
    }

    function emitAsset(symbol) {
      if (!symbol) return;
      try { listeners.asset(String(symbol)); } catch (_) {}
      feed("asset", String(symbol), null);
    }

    function emitTick(payload) {
      // quotes/stream commonly batches many subscribed instruments. The old
      // router emitted only row zero, starving the actual main chart whenever
      // another subscription happened to appear first.
      var quotes = parseQuotes(payload);
      for (var qi = 0; qi < quotes.length; qi++) {
        try { listeners.tick(quotes[qi]); } catch (_) {}
        feed("tick", quotes[qi], null);
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
      var rows = Array.isArray(payload) ? payload
        : (payload && Array.isArray(payload.orders) ? payload.orders
          : (payload && Array.isArray(payload.deals) ? payload.deals : [payload]));
      for (var oi = 0; oi < rows.length && oi < 100; oi++) {
        var oo = parseOrderOpened(rows[oi]);
        if (!oo) continue;
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
        for (var oci = 0; oci < ocDeals.length && oci < 100; oci++) {
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

    var rawQueue = null;
    function feedRaw(raw) {
      var asyncRaw = raw && typeof raw === "object" && typeof raw.text === "function";
      if (!rawQueue && !asyncRaw) {
        try { dispatch(decodeFrame(raw)); } catch (_) {}
        return;
      }
      var prior = rawQueue || Promise.resolve();
      var task = prior.then(function () {
        if (asyncRaw) return raw.text().then(function (s) { dispatch(decodeFrame(s)); });
        dispatch(decodeFrame(raw));
        return null;
      });
      var settled = task.catch(function () {});
      rawQueue = settled;
      settled.then(function () { if (rawQueue === settled) rawQueue = null; });
    }

    return {
      dispatch: dispatch,
      feedRaw: feedRaw,
      pending: function () { return pendingHeader; },
      pendingCount: function () { return pendingCount; },
      listeners: listeners,
    };
  }

  /**
   * Sniff OUTGOING Socket.IO frames. The web client tells the server which
   * asset it is charting (`instruments/follow`, `instruments/update`,
   * `history/list/v2`, `chart_notification/get`, `orders/open` …), so these
   * frames are the single most reliable source for the ACTIVE asset — far
   * better than guessing from hashed DOM class names. Returns the symbol or
   * null. Pure, safe to call for every send().
   */
  function sniffOutgoing(data) {
    var s = typeof data === "string" ? data : "";
    if (!s) return null;
    var idx = s.indexOf('["');
    if (idx < 0) return null;
    // Only Socket.IO payload frames (42… / 43… / 451-… / 46…).
    var prefix = s.charAt(0);
    if (!(prefix === "4" || prefix === "5")) return null;
    if (s.indexOf("42") !== 0 && s.indexOf("43") !== 0 && s.indexOf("451-") !== 0 && s.indexOf("46") !== 0) return null;
    var arr = safeJSON(s.slice(s.indexOf("[")));
    if (!Array.isArray(arr) || arr.length < 1) return null;
    var ev = String(arr[0] || "");
    var body = arr.length > 1 ? arr[1] : null;
    // Only events that carry an asset/symbol reference.
    if (!/^(instruments\/follow|instruments\/update|history\/list\/v2|chart_notification\/get|loadHistoryPeriod|quotes\/stream|orders\/open|instruments\/update_list|tick)$/.test(ev)) return null;
    var asset = null;
    var period = null;
    if (body && typeof body === "object") {
      asset = body.asset || body.symbol || body.pair || null;
      var rawPeriod = numberValue(body.period != null ? body.period : body.timeframe);
      period = rawPeriod != null && rawPeriod > 0 && rawPeriod <= 86400 ? Math.floor(rawPeriod) : null;
    } else if (typeof body === "string" && body) {
      asset = body;
    }
    if (asset != null && /^\d+$/.test(String(asset)) && ID_TO_SYMBOL[Number(asset)]) asset = ID_TO_SYMBOL[Number(asset)];
    asset = normalizeSymbolName(asset);
    if (!asset) return null;
    // `instruments/update` is the platform's main-chart selection message;
    // `orders/open` confirms that selection. Follow/history messages can be
    // emitted for every mini/background chart and must never steal "main".
    var main = ev === "instruments/update" || ev === "orders/open";
    var candidate = ev === "instruments/follow";
    return {
      event: ev,
      symbol: asset,
      period: period,
      main: main,
      candidate: candidate,
    };
  }

  function attachPageSocket(handlers) {
    handlers = handlers || {};
    var Native = window.WebSocket;
    if (typeof Native !== "function") return { ok: false, error: "no native WebSocket" };
    if (Native.__cyberWrapped) return { ok: true, handle: Native.__cyberHandle, already: true };

    var fallbackRouter = createRouter(handlers);

    function brokerSocketUrl(url) {
      try {
        var parsed = new URL(String(url || ""), location.href);
        return (parsed.protocol === "ws:" || parsed.protocol === "wss:") &&
          isQuotexHost(parsed.hostname) && /\/socket\.io(?:\/|$)/i.test(parsed.pathname);
      } catch (_) { return false; }
    }

    function Wrapped(url, protocols) {
      var ws = protocols !== undefined ? new Native(url, protocols) : new Native(url);
      var socketRouter = createRouter(handlers);
      var brokerSocket = brokerSocketUrl(url);
      if (brokerSocket) {
        try { socketRouter.listeners.status({ state: "opening", url: url }); } catch (_) {}
        if (handle) { handle.lastWs = ws; handle.router = socketRouter; }
      }
      // Outgoing-frame sniffing can promote a relative/previously unknown
      // socket, but unrelated analytics sockets never become the trade handle.
      var nativeSend = ws.send.bind(ws);
      ws.send = function (data) {
        try {
          var s = typeof data === "string" ? data
            : (typeof ArrayBuffer !== "undefined" && data instanceof ArrayBuffer ? asString(data) : null);
          var hit = s ? sniffOutgoing(s) : null;
          if (hit && hit.symbol) {
            brokerSocket = true;
            if (handle) { handle.lastWs = ws; handle.router = socketRouter; }
            try { socketRouter.listeners.asset(hit.symbol, hit); } catch (_) {}
            feedOut(socketRouter, hit);
          }
        } catch (_) {}
        return nativeSend(data);
      };
      ws.addEventListener("open", function () {
        if (brokerSocket) try { socketRouter.listeners.status({ state: "open", url: url }); } catch (_) {}
      });
      ws.addEventListener("close", function () {
        var wasCurrent = handle && handle.lastWs === ws;
        if (wasCurrent) handle.lastWs = null;
        if (brokerSocket && wasCurrent) try { socketRouter.listeners.status({ state: "closed", url: url }); } catch (_) {}
      });
      ws.addEventListener("message", function (ev) {
        if (brokerSocket) try { socketRouter.feedRaw(ev.data); } catch (_) {}
      });
      return ws;
    }
    function feedOut(router, hit) {
      try {
        if (router.listeners && typeof router.listeners.frame === "function") {
          router.listeners.frame("outgoing", hit, null);
        }
      } catch (_) {}
    }
    Wrapped.prototype = Native.prototype;
    Wrapped.CONNECTING = Native.CONNECTING;
    Wrapped.OPEN = Native.OPEN;
    Wrapped.CLOSING = Native.CLOSING;
    Wrapped.CLOSED = Native.CLOSED;
    try { Object.setPrototypeOf(Wrapped, Native); } catch (_) {}

    var handle = {
      native: Native, wrapper: Wrapped, router: fallbackRouter, lastWs: null,
      pending: function () { return handle.router ? handle.router.pending() : null; },
    };
    Wrapped.__cyberWrapped = true;
    Wrapped.__cyberHandle = handle;
    window.WebSocket = Wrapped;

    return {
      ok: true,
      handle: handle,
      router: fallbackRouter,
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
    parseQuotes: parseQuotes,
    parseBalance: parseBalance,
    parseOrderOpened: parseOrderOpened,
    parseOrderClosed: parseOrderClosed,
    toMs: toMs,
    normalizeSymbol: normalizeSymbolName,
    findPanel: findPanel,
    findAssetHeader: findAssetHeader,
    findPriceLabel: findPriceLabel,
    parsePrice: parsePrice,
    findStakeInput: findStakeInput,
    stakeCandidates: stakeCandidates,
    findExpirySelect: findExpirySelect,
    parseExpirySeconds: parseExpirySeconds,
    setExpiry: setExpiry,
    findCallButton: findCallButton,
    findPutButton: findPutButton,
    findBalance: findBalance,
    setStake: setStake,
    placeTrade: placeTrade,
    placeTradeDom: placeTradeDom,
    placeTradeWs: placeTradeWs,
    buildOrderPayload: buildOrderPayload,
    qxExpirationEpoch: qxExpirationEpoch,
    /**
     * Ask the broker for real-time ticks + history on the *page's own*
     * socket. Mirrors the exact sequence the Quotex web client sends when a
     * chart opens, so nothing extra is needed to receive `quotes/stream` and
     * `history/list/v2` frames from the server. Safe to call repeatedly.
     */
    subscribeHistory: function (ws, asset, period, limit) {
      if (!ws || typeof ws.send !== "function") return { ok: false, error: "no websocket handle" };
      if (ws.readyState != null && numberValue(ws.readyState) !== 1) return { ok: false, error: "websocket is not open" };
      var sym = normalizeSymbolName(asset || "");
      if (!sym) return { ok: false, error: "asset required" };
      period = numberValue(period);
      period = period != null && period > 0 ? Math.min(86400, Math.floor(period)) : 60;
      limit = numberValue(limit);
      limit = limit != null ? Math.max(60, Math.min(5000, Math.floor(limit))) : 5000;
      try {
        ws.send('42["tick"]');
        ws.send('42["instruments/follow","' + sym + '"]');
        ws.send('42["instruments/update",{"asset":"' + sym + '","period":' + period + '}]');
        // chart_notification/get does not return OHLC history on every Quotex
        // build. Request the actual history endpoint explicitly; otherwise the
        // cache receives ticks only and can take hours to become backtestable.
        ws.send('42["history/list/v2",{"asset":"' + sym + '","period":' + period + ',"offset":0,"limit":' + limit + '}]');
        ws.send('42["chart_notification/get",{"asset":"' + sym + '","version":"1.0.0"}]');
        return { ok: true, asset: sym, period: period, limit: limit };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    },
    getInstruments: function () {
      // Static catalog (id -> symbol) + symbols without confirmed ids yet.
      // Live list arrives via attachPageSocket and merges real ids.
      var out = [];
      for (var s in ASSET_IDS) {
        if (Object.prototype.hasOwnProperty.call(ASSET_IDS, s)) {
          out.push({ id: ASSET_IDS[s], symbol: s, isOtc: /_otc$/i.test(s) });
        }
      }
      for (var e = 0; e < EXTRA_SYMBOLS.length; e++) {
        var es = EXTRA_SYMBOLS[e];
        if (!Object.prototype.hasOwnProperty.call(ASSET_IDS, es)) {
          out.push({ id: 0, symbol: es, isOtc: /_otc$/i.test(es) });
        }
      }
      return out;
    },
    getBalance: function () {
      var b = findBalance();
      return b ? b.value : null;
    },
    rememberIds: rememberIds,
    sniffOutgoing: sniffOutgoing,
    KNOWN_EVENTS: KNOWN_EVENTS,
    WSS_GUESSES: WSS_GUESSES,
    ASSET_IDS: ASSET_IDS,
    EXTRA_SYMBOLS: EXTRA_SYMBOLS,
    ID_TO_SYMBOL: ID_TO_SYMBOL,
    KNOWN_TIMEFRAMES: KNOWN_TIMEFRAMES,
  };
})(typeof self !== "undefined" ? self : this);


/* ====================================================================
 * MAIN-world WebSocket hook shell (tools/page-hook.shell.js).
 * Exposes window.CYBER_QUOTEX in the page's MAIN world.
 * ==================================================================== */
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
      live.candles[key] = Array.isArray(msg.candles) ? msg.candles.slice(-5000) : [];
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
