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
  function registerQuotexAsset(q) {
    if (!q || !q.symbol) return null;
    const sym = String(q.symbol).toUpperCase();
    if (!ALIAS[sym]) {
      // Synthesize a minimal asset entry for any detected symbol so the
      // engine has *something* to anchor on. Synthetic seed parameters come
      // from the kind/otc hints when available.
      const kind = q.isOtc ? "otc" : (q.type || "fx");
      const basePrice = q.basePrice || (kind === "otc" ? 100 : kind === "crypto" ? 50000 : 1.08);
      const vol = kind === "otc" ? annToMin(25) : kind === "crypto" ? annToMin(60) : annToMin(8);
      const decimals = basePrice > 100 ? 2 : basePrice > 1 ? 5 : 5;
      ASSETS.push({
        id: sym,
        name: q.name || sym,
        kind: kind,
        basePrice: basePrice,
        pipSize: basePrice > 100 ? 0.1 : 0.0001,
        decimals: decimals,
        vol: vol,
        drift: 0,
        jumpRate: 0.003,
        session: kind === "otc" ? "OTC 24/7" : (kind === "crypto" ? "24/7" : "London/NY"),
        aliases: [sym, q.name || sym].concat(q.aliases || []),
        brokerId: q.id || 0,
        payout: q.payout || 0,
        isOpen: q.isOpen !== false,
        timeframes: q.timeframes || [60, 120, 180, 300, 600, 900, 1800, 3600],
      });
      ALIAS[sym] = sym;
      for (const al of (q.aliases || [])) ALIAS[String(al).toUpperCase()] = sym;
      RUNTIME_ALIASES[sym] = sym;
    }
    return get(sym);
  }

  function get(id) {
    if (!id) return null;
    const k = String(id).toUpperCase();
    return ASSETS.find((a) => a.id === ALIAS[k]) || null;
  }

  function detect(text) {
    if (!text) return null;
    const t = String(text).toUpperCase();
    // First try direct match (longest first)
    const keys = Object.keys(ALIAS).sort((a, b) => b.length - a.length);
    for (const k of keys) {
      if (t.includes(k)) return get(k);
    }
    return null;
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

  root.CYBER_ASSETS = { list, get, detect, byKind, ALIAS, registerQuotexAsset, runtimeAliases };
})(typeof self !== "undefined" ? self : globalThis);
