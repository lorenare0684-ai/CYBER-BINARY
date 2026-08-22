/**
 * Asset catalog — used for automatic detection, synthetic history generation,
 * pip sizing for backtests, and per-asset accuracy breakdowns.
 *
 * Each asset has:
 *   id        : canonical key (e.g. "EURUSD")
 *   name      : display name
 *   kind      : "fx" | "crypto" | "commodity" | "otc" | "stock" | "index"
 *   basePrice : starting price for synthetic walk
 *   pipSize   : smallest meaningful move
 *   decimals  : display precision
 *   vol       : per-minute volatility profile (annualized → 1m scale)
 *   drift     : per-minute mean drift
 *   jumpRate  : probability of a volatility spike (news/flash)
 *   session   : trading session hints (e.g. "24/7" for crypto, "London" for FX)
 *   aliases   : other names seen on broker UIs that should map to this asset
 */
(function (root) {
  "use strict";

  // Annual vol → 1m scale ≈ annVol / sqrt(252*24*60) ~ /602
  function annToMin(annPct) {
    return annPct / 100 / 602;
  }

  const ASSETS = [
    {
      id: "EURUSD", name: "EUR/USD", kind: "fx", basePrice: 1.0854, pipSize: 0.0001,
      decimals: 5, vol: annToMin(7), drift: 0, jumpRate: 0.002,
      session: "London/NY", aliases: ["EURUSD", "EUR/USD", "EURUSD-OTC"],
    },
    {
      id: "GBPUSD", name: "GBP/USD", kind: "fx", basePrice: 1.2715, pipSize: 0.0001,
      decimals: 5, vol: annToMin(9), drift: 0, jumpRate: 0.003,
      session: "London", aliases: ["GBPUSD", "GBP/USD", "GBPUSD-OTC"],
    },
    {
      id: "USDJPY", name: "USD/JPY", kind: "fx", basePrice: 156.42, pipSize: 0.01,
      decimals: 3, vol: annToMin(8), drift: 0, jumpRate: 0.003,
      session: "Tokyo/NY", aliases: ["USDJPY", "USD/JPY", "USDJPY-OTC"],
    },
    {
      id: "AUDUSD", name: "AUD/USD", kind: "fx", basePrice: 0.6584, pipSize: 0.0001,
      decimals: 5, vol: annToMin(10), drift: 0, jumpRate: 0.003,
      session: "Sydney", aliases: ["AUDUSD", "AUD/USD", "AUDUSD-OTC"],
    },
    {
      id: "USDCAD", name: "USD/CAD", kind: "fx", basePrice: 1.3642, pipSize: 0.0001,
      decimals: 5, vol: annToMin(7), drift: 0, jumpRate: 0.002,
      session: "NY", aliases: ["USDCAD", "USD/CAD", "USDCAD-OTC"],
    },
    {
      id: "EURJPY", name: "EUR/JPY", kind: "fx", basePrice: 169.7, pipSize: 0.01,
      decimals: 3, vol: annToMin(10), drift: 0, jumpRate: 0.003,
      session: "London/Tokyo", aliases: ["EURJPY", "EUR/JPY", "EURJPY-OTC"],
    },
    {
      id: "BTCUSD", name: "BTC/USD", kind: "crypto", basePrice: 62000, pipSize: 1,
      decimals: 2, vol: annToMin(60), drift: 0.0001, jumpRate: 0.01,
      session: "24/7", aliases: ["BTCUSD", "BTC/USD", "BITCOIN"],
    },
    {
      id: "ETHUSD", name: "ETH/USD", kind: "crypto", basePrice: 3300, pipSize: 0.1,
      decimals: 2, vol: annToMin(75), drift: 0.0001, jumpRate: 0.012,
      session: "24/7", aliases: ["ETHUSD", "ETH/USD", "ETHEREUM"],
    },
    {
      id: "SOLUSD", name: "SOL/USD", kind: "crypto", basePrice: 150, pipSize: 0.01,
      decimals: 2, vol: annToMin(110), drift: 0, jumpRate: 0.018,
      session: "24/7", aliases: ["SOLUSD", "SOL/USD", "SOLANA"],
    },
    {
      id: "XAUUSD", name: "XAU/USD (Gold)", kind: "commodity", basePrice: 2350, pipSize: 0.1,
      decimals: 2, vol: annToMin(15), drift: 0, jumpRate: 0.004,
      session: "London/NY", aliases: ["XAUUSD", "XAU/USD", "GOLD"],
    },
    {
      id: "XAGUSD", name: "XAG/USD (Silver)", kind: "commodity", basePrice: 28.4, pipSize: 0.01,
      decimals: 3, vol: annToMin(25), drift: 0, jumpRate: 0.006,
      session: "London/NY", aliases: ["XAGUSD", "XAG/USD", "SILVER"],
    },
    {
      id: "OILUSD", name: "WTI Oil", kind: "commodity", basePrice: 78.5, pipSize: 0.01,
      decimals: 2, vol: annToMin(35), drift: 0, jumpRate: 0.008,
      session: "NY", aliases: ["OILUSD", "WTI", "USOIL", "CRUDE"],
    },
    {
      id: "US500", name: "S&P 500", kind: "index", basePrice: 5400, pipSize: 0.1,
      decimals: 2, vol: annToMin(15), drift: 0, jumpRate: 0.004,
      session: "NY", aliases: ["US500", "SPX", "SP500", "S&P500"],
    },
    {
      id: "NAS100", name: "Nasdaq 100", kind: "index", basePrice: 19000, pipSize: 0.1,
      decimals: 2, vol: annToMin(20), drift: 0, jumpRate: 0.005,
      session: "NY", aliases: ["NAS100", "NDX", "NASDAQ"],
    },
    {
      id: "OTC1", name: "OTC Synthetic #1", kind: "otc", basePrice: 100, pipSize: 0.001,
      decimals: 3, vol: annToMin(20), drift: 0, jumpRate: 0.01,
      session: "OTC 24/7", aliases: ["OTC-1", "OTC_SYNTH_1"],
    },
    {
      id: "OTC2", name: "OTC Synthetic #2", kind: "otc", basePrice: 50, pipSize: 0.001,
      decimals: 3, vol: annToMin(25), drift: 0, jumpRate: 0.012,
      session: "OTC 24/7", aliases: ["OTC-2", "OTC_SYNTH_2"],
    },
  ];

  // Build alias index for fast lookup.
  const ALIAS = Object.create(null);
  for (const a of ASSETS) {
    ALIAS[a.id.toUpperCase()] = a.id;
    ALIAS[a.name.toUpperCase()] = a.id;
    for (const al of a.aliases) ALIAS[al.toUpperCase()] = a.id;
  }
  // Pull in live-detected Quotex assets registered by the adapter at runtime.
  // (See CYBER_QUOTEX in src/lib/quotex.js — the page hook calls
  //  CYBER_ASSETS.registerQuotexAsset(...) when the broker instruments/list
  //  payload arrives. We expose the same API here for symmetry.)
  const RUNTIME_ALIASES = Object.create(null);
  const CRYPTO_CODES = /^(BTC|ETH|SOL|DOGE|DOG|BNB|BCH|XRP|ARB|APT|AVAX|AXS|FLO|BON|LTC|LINK|DOT|ADA|MATIC|SHIB|TRX|UNI|NEAR|ATOM|FIL|ICP|SAND|MANA)$/i;
  const INDEX_CODES = /^(US500|NAS100|NDX|SPX|SP500|DJI|DJIA|F40|GEREUR|IBX|IT4|JPX|HSI|CHIA|STX|UK100|DE30|US30)$/i;
  const COMMODITY_CODES = /^(XAU|XAG|OIL|WTI|USOIL|UKBrent|BRENT|NATGAS|COPPER)$/i;

  function normalizeSymbol(s) {
    if (!s) return "";
    // Broker convention (A11ksa/Quotex): base uppercase, OTC suffix lowercase,
    // e.g. EURUSD_otc. ALIAS keys stay uppercase for case-insensitive lookup.
    return String(s).trim().toUpperCase().replace(/_OTC/g, "_otc");
  }

  function inferKind(sym) {
    if (!sym) return "fx";
    if (/_otc$/i.test(sym)) return "otc";
    if (CRYPTO_CODES.test(sym.replace(/USD|USDT|USDC$/i, ""))) return "crypto";
    if (INDEX_CODES.test(sym)) return "index";
    if (COMMODITY_CODES.test(sym)) return "commodity";
    return "fx";
  }

  function profileFor(sym, kind) {
    kind = kind || inferKind(sym);
    if (kind === "crypto") {
      return { basePrice: /BTC/.test(sym) ? 62000 : /ETH/.test(sym) ? 3300 : 150, pipSize: 0.01, decimals: 2, vol: annToMin(60), jumpRate: 0.01, session: "24/7" };
    }
    if (kind === "commodity") {
      return { basePrice: /XAU/.test(sym) ? 2350 : /XAG/.test(sym) ? 28.4 : 78.5, pipSize: 0.01, decimals: 2, vol: annToMin(20), jumpRate: 0.006, session: "London/NY" };
    }
    if (kind === "index") {
      return { basePrice: 5400, pipSize: 0.1, decimals: 2, vol: annToMin(15), jumpRate: 0.004, session: "NY" };
    }
    if (kind === "otc") {
      return { basePrice: 100, pipSize: 0.001, decimals: 3, vol: annToMin(25), jumpRate: 0.01, session: "OTC 24/7" };
    }
    return { basePrice: 1.08, pipSize: 0.0001, decimals: 5, vol: annToMin(8), jumpRate: 0.003, session: "London/NY" };
  }

  /** Human-readable aliases for `EURUSD_otc` → "EUR/USD OTC", "(OTC)", "-OTC". */
  function humanAliases(sym) {
    const out = [sym];
    const base = sym.replace(/_otc$/i, "");
    if (/_otc$/i.test(sym)) {
      const slash = base.length === 6
        ? base.slice(0, 3) + "/" + base.slice(3)
        : base.replace(/(USD|JPY|CAD|CHF|GBP|AUD|NZD)$/, "/$1");
      out.push(slash + " OTC", slash + " (OTC)", slash + "-OTC", slash + " (OT)", slash + " OTC " + sym);
    } else if (/^[A-Z]{6}$/.test(sym) && /(USD|JPY|CAD|CHF|GBP|AUD|NZD)$/.test(sym)) {
      out.push(sym.slice(0, 3) + "/" + sym.slice(3));
    }
    return out;
  }

  function registerQuotexAsset(q) {
    if (!q || !q.symbol) return null;
    const sym = normalizeSymbol(q.symbol);
    if (!sym) return null;
    if (!ALIAS[sym.toUpperCase()]) {
      // Synthesize a minimal asset entry for any detected symbol so the
      // engine has *something* to anchor on. Synthetic seed parameters come
      // from the kind/otc hints when available.
      const kind = q.isOtc ? "otc" : (inferKind(sym));
      const prof = profileFor(sym, kind);
      const humans = humanAliases(sym);
      // Prefer a human-friendly display name (EUR/USD OTC) over the raw symbol.
      const name = q.name || humans.find((h) => / OTC|\(OTC\)/.test(h) && h !== sym) || humans[1] || sym;
      const aliases = [];
      aliases.push(sym);
      if (name) aliases.push(String(name));
      for (const al of humans) aliases.push(al);
      for (const al of (q.aliases || [])) aliases.push(String(al));
      ASSETS.push({
        id: sym,
        name: name,
        kind: kind,
        basePrice: q.basePrice || prof.basePrice,
        pipSize: prof.pipSize,
        decimals: prof.decimals,
        vol: prof.vol,
        drift: 0,
        jumpRate: prof.jumpRate,
        session: prof.session,
        aliases: aliases,
        brokerId: q.id || 0,
        payout: q.payout || 0,
        isOpen: q.isOpen !== false,
        timeframes: q.timeframes || [60, 120, 180, 300, 600, 900, 1800, 3600],
      });
      for (const al of aliases) {
        const a = String(al).replace(/_OTC/g, "_otc").toUpperCase();
        if (a) ALIAS[a] = sym;
      }
      RUNTIME_ALIASES[sym] = sym;
    } else {
      // Update metadata (payout / open state / timeframes) on re-list.
      const a = get(sym);
      if (a) {
        if (q.payout) a.payout = q.payout;
        if (q.isOpen != null) a.isOpen = q.isOpen !== false;
        if (q.id) a.brokerId = q.id;
        if (Array.isArray(q.timeframes) && q.timeframes.length) a.timeframes = q.timeframes.slice();
      }
    }
    return get(sym);
  }

  /**
   * Guarantee a catalog entry exists for a symbol seen anywhere (DOM, URL,
   * WebSocket). Registers a sensible synthetic profile on the fly so the
   * engine/detection always has an anchor, even before the broker's
   * instruments/list payload arrives.
   */
  function ensureRegistered(symbolOrText) {
    if (!symbolOrText) return null;
    const raw = String(symbolOrText).trim();
    const sym = normalizeSymbol(raw.replace(/\s+/g, ""));
    const exactId = ALIAS[sym.toUpperCase()];
    if (exactId) return get(exactId);
    // Looks like a broker symbol? (letters/digits/underscore, 3-20 — broker
    // wire symbols never carry a slash; "EUR/USD" is a human display name).
    // Synthesize it as its own entry — never let "EURUSD_otc" collapse into
    // the base "EURUSD" alias, and keep "EURUSD" intact for plain inputs.
    if (/^[A-Za-z0-9_]{3,20}$/.test(sym)) {
      return registerQuotexAsset({ symbol: sym, isOtc: /_otc$/i.test(sym), type: null });
    }
    return detect(raw);
  }

  function get(id) {
    if (!id) return null;
    const k = String(id).toUpperCase();
    const canonical = ALIAS[k];
    if (!canonical) return null;
    return ASSETS.find((a) => a.id === canonical) || null;
  }

  function detect(text) {
    if (!text) return null;
    const t = String(text).toUpperCase();
    // Exact normalized-symbol match first (e.g. "EURUSD_otc") so a broker
    // suffix can never be shadowed by a substring alias ("EURUSD").
    const exact = normalizeSymbol(/\s+/g.test(text) ? String(text).replace(/\s+/g, "") : text);
    const exactKey = exact.toUpperCase();
    if (ALIAS[exactKey]) return get(ALIAS[exactKey]);
    const wantOtc = /(OTC|\(OT\)|_OTC)/.test(t);
    // Longest alias first. OTC-aware: when the text mentions OTC, prefer an
    // OTC asset and never let "EUR/USD" swallow "EUR/USD OTC"; when the text
    // has no OTC marker, skip OTC-only aliases so "EURUSD" never resolves to
    // "EURUSD-OTC".
    const keys = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
    let fallback = null;
    for (const k of keys) {
      if (!t.includes(k)) continue;
      const keyOtc = /(OTC|\(OT\)|_OTC)/.test(k);
      if (wantOtc) {
        if (keyOtc) return get(k);
        if (!fallback) fallback = get(k);
        continue;
      }
      if (keyOtc) continue;
      return get(k);
    }
    // Human text like "EUR/USD OTC" that reaches here means the OTC variant
    // is not yet registered: derive + register `EURUSD_otc` from the base
    // asset so DOM detection and the broker symbol stay consistent.
    if (wantOtc && fallback && /^[A-Za-z0-9]{3,20}$/.test(fallback.id) && !/_otc$/i.test(fallback.id)) {
      return registerQuotexAsset({ symbol: fallback.id + "_otc", isOtc: true, type: null });
    }
    return fallback;
  }

  function list() {
    return ASSETS.slice();
  }

  function byKind(kind) {
    return ASSETS.filter((a) => a.kind === kind);
  }

  function runtimeAliases() {
    return Object.assign({}, RUNTIME_ALIASES);
  }

  root.CYBER_ASSETS = { list, get, detect, byKind, ALIAS, registerQuotexAsset, ensureRegistered, runtimeAliases, normalizeSymbol, inferKind };
})(typeof self !== "undefined" ? self : globalThis);
