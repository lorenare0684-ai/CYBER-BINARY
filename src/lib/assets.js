/**
 * Asset catalog — used for automatic detection, synthetic history generation,
 * pip sizing for backtests, and per-asset accuracy breakdowns.
 *
 * v2.3: the catalog now mirrors the FULL Quotex platform list (every base FX
 * pair + its `_otc` twin, exotic FX OTC pairs, crypto OTC, commodities,
 * indices and stocks OTC). Broker-internal numeric IDs are included where
 * confirmed by the official clients (A11ksa/API-Quotex, ericpedra/quotexapi,
 * quotexpy); symbols with `brokerId: null` are filled in at runtime from the
 * platform's `instruments/list` payload (see registerQuotexAsset).
 *
 * Each asset has:
 *   id        : canonical key (e.g. "EURUSD" or "EURUSD_otc")
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
 *   brokerId  : Quotex broker-internal numeric id (null until known)
 */
(function (root) {
  "use strict";

  // Annual vol → 1m scale ≈ annVol / sqrt(252*24*60) ~ /602
  function annToMin(annPct) {
    return annPct / 100 / 602;
  }

  /* ============================================================
   * Compact source data (symbol, display name, broker id | null)
   * ============================================================ */

  // FX base pairs (29) — real market, closed on weekends.
  // broker ids confirmed by official Quotex clients.
  var FX_PAIRS = [
    ["EURUSD", "EUR/USD", 1],   ["GBPUSD", "GBP/USD", 56],  ["USDJPY", "USD/JPY", 63],
    ["AUDUSD", "AUD/USD", 40],  ["USDCAD", "USD/CAD", 61],  ["USDCHF", "USD/CHF", 62],
    ["EURJPY", "EUR/JPY", 48],  ["EURGBP", "EUR/GBP", 47],  ["EURCHF", "EUR/CHF", 46],
    ["AUDJPY", "AUD/JPY", 38],  ["GBPJPY", "GBP/JPY", 54],  ["EURAUD", "EUR/AUD", 44],
    ["EURCAD", "EUR/CAD", 45],  ["GBPCHF", "GBP/CHF", 53],  ["CADJPY", "CAD/JPY", 42],
    ["NZDUSD", "NZD/USD", 60],  ["EURNZD", "EUR/NZD", 49],  ["AUDCAD", "AUD/CAD", 36],
    ["AUDCHF", "AUD/CHF", 37],  ["AUDNZD", "AUD/NZD", 39],  ["GBPAUD", "GBP/AUD", 51],
    ["GBPCAD", "GBP/CAD", 52],  ["GBPNZD", "GBP/NZD", null],["CHFJPY", "CHF/JPY", 43],
    ["EURSGD", "EUR/SGD", 123], ["CADCHF", "CAD/CHF", 41],  ["NZDJPY", "NZD/JPY", 58],
    ["NZDCAD", "NZD/CAD", null],["NZDCHF", "NZD/CHF", null],
  ];

  // FX `_otc` twin broker ids (base symbol → otc id), confirmed by clients.
  var FX_OTC_IDS = {
    "EURUSD": 66, "GBPUSD": 86, "USDJPY": 93, "AUDUSD": 71, "USDCAD": 91,
    "USDCHF": 92, "EURJPY": 79, "EURGBP": 78, "EURCHF": 77, "AUDJPY": 69,
    "GBPJPY": 84, "EURAUD": 75, "EURCAD": 76, "GBPCHF": 83, "CADJPY": 73,
    "NZDUSD": 90, "EURNZD": 80, "AUDCAD": 67, "AUDCHF": 68, "AUDNZD": 70,
    "GBPAUD": 81, "GBPCAD": 82, "CHFJPY": 74, "EURSGD": 303, "CADCHF": 72,
    "NZDJPY": 89,
  };

  // Exotic FX — Quotex lists these as OTC-only 24/7 synthetic pairs.
  var FX_EXOTIC_OTC = [
    ["ARSUSD_otc",  "ARS/USD", null],  ["BRLUSD_otc",  "BRL/USD", 332],
    ["DZDUSD_otc",  "DZD/USD", null],  ["INRUSD_otc",  "INR/USD", null],
    ["USDBDT_otc",  "USD/BDT", null],  ["USDCOP_otc",  "USD/COP", null],
    ["USDMXN_otc",  "USD/MXN", 343],   ["USDPKR_otc",  "USD/PKR", null],
    ["USDTRY_otc",  "USD/TRY", null],  ["USDZAR_otc",  "USD/ZAR", null],
    ["EURTRY_otc",  "EUR/TRY", null],  ["EURPLN_otc",  "EUR/PLN", null],
    ["EURHUF_otc",  "EUR/HUF", null],  ["USDRUB_otc",  "USD/RUB", null],
    ["USDSEK_otc",  "USD/SEK", null],  ["USDNOK_otc",  "USD/NOK", null],
    ["EURNOK_otc",  "EUR/NOK", null],  ["EURSEK_otc",  "EUR/SEK", null],
  ];

  // Crypto — OTC-only on Quotex (24/7 synthetic). IDs from the official
  // clients; newer coins get filled from instruments/list at runtime.
  var CRYPTO_OTC = [
    ["ADAUSD_otc",  "Cardano (ADA)", 376],    ["APTUSD_otc",  "Aptos (APT)", 377],
    ["ARBUSD_otc",  "Arbitrum (ARB)", 378],   ["ATOUSD_otc",  "Cosmos (ATOM)", 368],
    ["AVAUSD_otc",  "Avalanche (AVAX)", 379], ["AXSUSD_otc",  "Axie Infinity (AXS)", 380],
    ["BCHUSD_otc",  "Bitcoin Cash (BCH)", 363],["BNBUSD_otc",  "BNB", 362],
    ["BONUSD_otc",  "Bonk (BONK)", 358],      ["BTCUSD_otc",  "Bitcoin (BTC)", 352],
    ["DOGUSD_otc",  "Dogecoin (DOGE)", 353],  ["ETHUSD_otc",  "Ethereum (ETH)", 360],
    ["FLOUSD_otc",  "Floki (FLOKI)", 356],    ["XRPUSD_otc",  "XRP", 364],
    ["SOLUSD_otc",  "Solana (SOL)", null],    ["LTCUSD_otc",  "Litecoin (LTC)", null],
    ["TRXUSD_otc",  "TRON (TRX)", null],      ["SHIBUSD_otc", "Shiba Inu (SHIB)", null],
    ["MATICUSD_otc","Polygon (MATIC)", null], ["DOTUSD_otc",  "Polkadot (DOT)", null],
    ["LINKUSD_otc", "Chainlink (LINK)", null],["XLMUSD_otc",  "Stellar (XLM)", null],
    ["DOGEUSD_otc", "Dogecoin (DOGE)", null], ["DASHUSD_otc", "Dash (DASH)", null],
    ["ETCUSD_otc",  "Ethereum Classic (ETC)", null], ["NEARUSD_otc","NEAR Protocol", null],
    ["SUIUSD_otc",  "Sui (SUI)", null],       ["TIAUSD_otc",  "Celestia (TIA)", null],
  ];

  // Commodities — XAU/XAG trade both real and OTC; the rest OTC-only.
  var COMMODITIES = [
    ["XAUUSD",     "XAU/USD (Gold)", 2,   true],
    ["XAGUSD",     "XAG/USD (Silver)", 65, true],
    ["UKBrent_otc","UK Brent Oil", 164,   false],
    ["USCrude_otc","WTI Crude Oil (USOIL)", 165, false],
    ["XNGUSD_otc", "Natural Gas", null,   false],
    ["XPTUSD_otc", "Platinum", null,      false],
    ["XPDUSD_otc", "Palladium", null,     false],
    ["COPPER_otc", "Copper", null,        false],
  ];

  // Indices — real market only on Quotex.
  var INDICES = [
    ["SPXUSD",  "S&P 500", 323],   ["NDXUSD",  "Nasdaq 100", 322],
    ["DJIUSD",  "Dow Jones 30", 317],["GEREUR", "GER 40 (DAX)", 316],
    ["FTSGBP",  "UK 100", 319],    ["F40EUR",  "FRA 40 (CAC)", 318],
    ["STXEUR",  "EU 50", 325],     ["IBXEUR",  "ESP 35 (IBEX)", 321],
    ["IT4EUR",  "ITA 40", 326],    ["JPXJPY",  "JPN 225 (Nikkei)", 327],
    ["HSIHKD",  "HKG 50 (Hang Seng)", 320],["CHIA50", "CHN 50 (FTSE China)", 328],
    ["AXJAUD",  "AUS 200", 315],
  ];

  // Stocks — OTC-only on Quotex.
  var STOCKS = [
    ["AAPL_otc",  "Apple", null],   ["AMZN_otc", "Amazon", null],
    ["AXP_otc",   "American Express", 291],["BA_otc", "Boeing", 292],
    ["CSCO_otc",  "Cisco", null],   ["DIS_otc",  "Disney", null],
    ["FB_otc",    "Meta (Facebook)", 187],["GOOGL_otc","Alphabet (Google)", null],
    ["INTC_otc",  "Intel", 190],    ["JNJ_otc",  "Johnson & Johnson", 296],
    ["JPM_otc",   "JPMorgan Chase", null],["KO_otc",  "Coca-Cola", null],
    ["MCD_otc",   "McDonald's", 175],["MSFT_otc", "Microsoft", 176],
    ["NFLX_otc",  "Netflix", null], ["NVDA_otc", "NVIDIA", null],
    ["PFE_otc",   "Pfizer", 297],   ["PG_otc",   "Procter & Gamble", null],
    ["TSLA_otc",  "Tesla", null],   ["V_otc",    "Visa", null],
    ["WMT_otc",   "Walmart", null], ["XOM_otc",  "Exxon Mobil", null],
    ["HD_otc",    "Home Depot", null],["PEP_otc", "PepsiCo", null],
    ["META_otc",  "Meta Platforms", null],["AMD_otc", "AMD", null],
    ["IBM_otc",   "IBM", null],     ["NKE_otc",  "Nike", null],
    ["SBUX_otc",  "Starbucks", null],["CVX_otc", "Chevron", null],
    ["WFC_otc",   "Wells Fargo", null],["BAC_otc", "Bank of America", null],
    ["C_otc",     "Citigroup", null],["GS_otc",  "Goldman Sachs", null],
    ["MS_otc",    "Morgan Stanley", null],["T_otc", "AT&T", null],
    ["VZ_otc",    "Verizon", null],  ["COST_otc", "Costco", null],
    ["ABBV_otc",  "AbbVie", null],   ["LLY_otc",  "Eli Lilly", null],
    ["UNH_otc",   "UnitedHealth", null],["MA_otc", "Mastercard", null],
  ];

  /* ============================================================
   * Synthetic-profile helpers (used by the engine seed + backtests)
   * ============================================================ */

  var FX_PRICES = {
    EURUSD: 1.0854, GBPUSD: 1.2715, USDJPY: 156.42, AUDUSD: 0.6584,
    USDCAD: 1.3642, USDCHF: 0.8831, EURJPY: 169.7,  EURGBP: 0.8531,
    EURCHF: 0.9584, AUDJPY: 102.9,  GBPJPY: 198.8,  EURAUD: 1.6482,
    EURCAD: 1.4802, GBPCHF: 1.1224, CADJPY: 114.7,  NZDUSD: 0.6054,
    EURNZD: 1.7921, AUDCAD: 0.8982, AUDCHF: 0.5813, AUDNZD: 1.0874,
    GBPAUD: 1.9312, GBPCAD: 1.7343, GBPNZD: 2.1001, CHFJPY: 177.1,
    EURSGD: 1.4582, CADCHF: 0.6474, NZDJPY: 94.6,   NZDCAD: 0.8259,
    NZDCHF: 0.5344,
  };

  var STOCK_PRICES = {
    AAPL: 230, AMZN: 185, AXP: 260, BA: 180, CSCO: 50, DIS: 95,
    FB: 500, GOOGL: 175, INTC: 32, JNJ: 150, JPM: 200, KO: 63,
    MCD: 260, MSFT: 430, NFLX: 640, NVDA: 120, PFE: 28, PG: 165,
    TSLA: 250, V: 275, WMT: 68, XOM: 115, HD: 340, PEP: 172,
    META: 500, AMD: 160, IBM: 190, NKE: 80, SBUX: 95, CVX: 155,
    WFC: 60, BAC: 38, C: 62, GS: 470, MS: 100, T: 19, VZ: 42,
    COST: 850, ABBV: 180, LLY: 800, UNH: 500, MA: 460,
  };

  var CRYPTO_PRICES = {
    BTC: 62000, ETH: 3300, SOL: 150, ADA: 0.45, APT: 8, ARB: 1.1,
    ATO: 9, AVA: 35, AXS: 7, BCH: 380, BNB: 580, BON: 0.00002,
    DOG: 0.13, FLO: 0.00015, XRP: 0.52, LTC: 72, TRX: 0.12, SHIB: 0.00002,
    MATIC: 0.6, DOT: 6.2, LINK: 14, XLM: 0.1, DASH: 26, ETC: 22,
    NEAR: 5.5, SUI: 1.1, TIA: 6,
  };

  var INDEX_PRICES = {
    SPXUSD: 5400, NDXUSD: 19000, DJIUSD: 39000, GEREUR: 18500,
    FTSGBP: 8100, F40EUR: 7600, STXEUR: 4900, IBXEUR: 11300,
    IT4EUR: 34000, JPXJPY: 39500, HSIHKD: 17200, CHIA50: 13000,
    AXJAUD: 7900,
  };

  var COMMODITY_PRICES = {
    XAUUSD: 2350, XAGUSD: 28.4, UKBrent: 84, USCrude: 78.5,
    XNG: 2.8, XPT: 980, XPD: 940, COPPER: 4.2,
  };

  var FX_CUR = /^(USD|JPY|EUR|GBP|CHF|AUD|NZD|CAD|SGD|MXN|TRY|ZAR|PLN|HUF|RUB|SEK|NOK|BDT|COP|PKR|INR|ARS|DZD|BRL)$/;
  var COMMODITY_SYMS = /^(XAU|XAG|XPT|XPD|XNG|USOIL|UKBRENT|BRENT|OIL|WTI|COPPER|NATGAS)$/i;
  var INDEX_SYMS = /^(SPXUSD|NDXUSD|DJIUSD|GEREUR|FTSGBP|F40EUR|STXEUR|IBXEUR|IT4EUR|JPXJPY|HSIHKD|CHIA50|AXJAUD|US500|NAS100|US30|UK100|GER40|DE30|FRA40|CAC40|EU50|ESP35|ITA40|JPN225|HKG50|CHN50|AUS200)$/i;
  var CRYPTO_SYMS = /^(BTC|ETH|SOL|ADA|APT|ARB|ATO|ATOM|AVA|AVAX|AXS|BCH|BNB|BON|BONK|DOG|DOGE|FLO|FLOKI|XRP|LTC|TRX|SHIB|MATIC|DOT|LINK|XLM|DASH|ETC|NEAR|SUI|TIA)$/i;
  var STOCK_SYMS = /^(AAPL|AMZN|AXP|BA|CSCO|DIS|FB|META|GOOGL|GOOG|INTC|JNJ|JPM|KO|MCD|MSFT|NFLX|NVDA|PFE|PG|TSLA|V|WMT|XOM|HD|PEP|AMD|IBM|NKE|SBUX|CVX|WFC|BAC|C|GS|MS|T|VZ|COST|ABBV|LLY|UNH|MA|QCOM|ORCL|CRM|ADBE)$/i;

  function symbolToKind(sym) {
    // Core classification used both for static entries and runtime inference.
    var s = String(sym || "").toUpperCase().replace(/_OTC$/, "");
    // FX: 6-letter convention (EURUSD, GBPUSD...) and exotic combos.
    if (s.length >= 5 && FX_CUR.test(s.slice(-3)) && FX_CUR.test(s.slice(0, s.length - 3))) {
      return "fx";
    }
    if (COMMODITY_SYMS.test(s)) return "commodity";
    if (INDEX_SYMS.test(s)) return "index";
    if (CRYPTO_SYMS.test(s.replace(/USD$|USDT$|USDC$/i, ""))) return "crypto";
    if (STOCK_SYMS.test(s)) return "stock";
    return null;
  }

  function inferKind(sym) {
    if (!sym) return "fx";
    var k = symbolToKind(sym);
    if (k) return k;
    if (/_otc$/i.test(sym)) return "otc"; // unknown synthetic → generic OTC
    return "fx";
  }

  function profileFor(sym, kind) {
    kind = kind || inferKind(sym);
    var s = String(sym || "").replace(/_otc$/i, "");
    var S = s.toUpperCase();
    var S2 = S.replace(/USD$|USDT$|USDC$/i, "");
    if (kind === "crypto") {
      var base = /^([A-Z]+)/.exec(S2) ? RegExp.$1 : S2;
      var p = CRYPTO_PRICES[base] || CRYPTO_PRICES[S2] || 1;
      return { basePrice: p, pipSize: 0.00001, decimals: 5, vol: annToMin(75), jumpRate: 0.012, session: "24/7" };
    }
    if (kind === "commodity") {
      var key = S.replace(/_otc$/i, "");
      var cp = COMMODITY_PRICES[key] || COMMODITY_PRICES[S.replace(/USD$/, "")] || 100;
      return { basePrice: cp, pipSize: 0.01, decimals: 2, vol: annToMin(25), jumpRate: 0.007, session: "London/NY" };
    }
    if (kind === "index") {
      var ip = INDEX_PRICES[S] || INDEX_PRICES[S.replace(/USD|EUR|JPY|HKD|AUD|GBP$/, "")] || 5400;
      return { basePrice: ip, pipSize: 0.1, decimals: 2, vol: annToMin(16), jumpRate: 0.004, session: "NY" };
    }
    if (kind === "stock") {
      var sp = STOCK_PRICES[S.replace(/_otc$/i, "")] || 100;
      return { basePrice: sp, pipSize: 0.01, decimals: 2, vol: annToMin(28), jumpRate: 0.008, session: "NYSE" };
    }
    if (kind === "otc") {
      return { basePrice: 100, pipSize: 0.001, decimals: 3, vol: annToMin(25), jumpRate: 0.012, session: "OTC 24/7" };
    }
    var fp = FX_PRICES[S] || FX_PRICES[S2] || 1.08;
    return { basePrice: fp, pipSize: 0.0001, decimals: 5, vol: annToMin(8), jumpRate: 0.003, session: "London/NY" };
  }

  /* ============================================================
   * Catalog builder
   * ============================================================ */

  function fxAliases(sym, name, isOtc) {
    var out = [sym];
    var base = sym.replace(/_otc$/i, "");
    if (isOtc) {
      // OTC aliases must ALWAYS carry an OTC marker so plain "EUR/USD" text
      // can never resolve to the OTC twin (see detect()).
      out.push(name + " OTC", name + " (OTC)", name + "-OTC", name + " (OT)");
    } else {
      out.push(name, base);
    }
    return out;
  }

  function buildEntries() {
    var out = [];
    var i, row;

    // FX base + OTC twins
    for (i = 0; i < FX_PAIRS.length; i++) {
      row = FX_PAIRS[i];
      var sym = row[0], name = row[1], id = row[2];
      out.push({
        id: sym, name: name, kind: "fx",
        basePrice: profileFor(sym, "fx").basePrice,
        pipSize: 0.0001, decimals: 5,
        vol: annToMin(8), drift: 0, jumpRate: 0.003,
        session: "London/NY",
        brokerId: id,
        aliases: fxAliases(sym, name, false),
      });
      var otcId = FX_OTC_IDS[sym] != null ? FX_OTC_IDS[sym] : null;
      out.push({
        id: sym + "_otc", name: name + " OTC", kind: "fx",
        basePrice: profileFor(sym, "fx").basePrice,
        pipSize: 0.0001, decimals: 5,
        vol: annToMin(11), drift: 0, jumpRate: 0.008,
        session: "OTC 24/7",
        brokerId: otcId,
        aliases: fxAliases(sym + "_otc", name, true),
      });
    }

    // Exotic FX (OTC)
    for (i = 0; i < FX_EXOTIC_OTC.length; i++) {
      row = FX_EXOTIC_OTC[i];
      out.push({
        id: row[0], name: row[1] + " OTC", kind: "fx",
        basePrice: profileFor(row[0], "fx").basePrice,
        pipSize: 0.0001, decimals: 5,
        vol: annToMin(14), drift: 0, jumpRate: 0.01,
        session: "OTC 24/7",
        brokerId: row[2],
        aliases: [row[0], row[1] + " OTC", row[1] + " (OTC)", row[1] + "-OTC", row[1] + " (OT)"],
      });
    }

    // Crypto (OTC)
    for (i = 0; i < CRYPTO_OTC.length; i++) {
      row = CRYPTO_OTC[i];
      var coin = (row[1] || row[0]).replace(/ \(.*\)$/, "");
      var symC = row[0].replace(/_otc$/i, "");
      var pC = profileFor(row[0], "crypto");
      out.push({
        id: row[0], name: coin + " (OTC)", kind: "crypto",
        basePrice: pC.basePrice, pipSize: pC.pipSize, decimals: pC.decimals,
        vol: pC.vol, drift: 0.0001, jumpRate: pC.jumpRate,
        session: "OTC 24/7",
        brokerId: row[2],
        aliases: [row[0], row[0].toUpperCase().replace(/_OTC$/, "_otc"), symC + " OTC", symC + "/USD", symC + " (OTC)", coin, coin + " OTC", coin + " (OTC)"],
      });
    }

    // Commodities
    for (i = 0; i < COMMODITIES.length; i++) {
      row = COMMODITIES[i];
      var symM = row[0], nameM = row[1], idM = row[2], hasBase = row[3];
      var pM = profileFor(symM, "commodity");
      if (hasBase) {
        out.push({
          id: symM, name: nameM, kind: "commodity",
          basePrice: pM.basePrice, pipSize: pM.pipSize, decimals: pM.decimals,
          vol: pM.vol, drift: 0, jumpRate: pM.jumpRate,
          session: "London/NY", brokerId: idM,
          aliases: [symM, symM.replace(/USD$/, "/USD"), nameM, nameM.replace(/ \(.*\)$/, ""),
                    (symM === "XAUUSD" ? "GOLD" : symM === "XAGUSD" ? "SILVER" : "")].filter(Boolean),
        });
        var otcCommodityId = symM === "XAUUSD" ? 169 : symM === "XAGUSD" ? 167 : (idM ? idM + 100 : null);
        out.push({
          id: symM + "_otc", name: nameM + " OTC", kind: "commodity",
          basePrice: pM.basePrice, pipSize: pM.pipSize, decimals: pM.decimals,
          vol: pM.vol, drift: 0, jumpRate: pM.jumpRate * 1.6,
          session: "OTC 24/7",
          brokerId: otcCommodityId,
          aliases: [symM + "_otc", symM + " OTC", nameM + " OTC", nameM + " (OTC)", nameM + "-OTC",
                    (symM === "XAUUSD" ? "GOLD OTC" : symM === "XAGUSD" ? "SILVER OTC" : "")].filter(Boolean),
        });
      } else {
        out.push({
          id: symM, name: nameM + " (OTC)", kind: "commodity",
          basePrice: pM.basePrice, pipSize: pM.pipSize, decimals: pM.decimals,
          vol: pM.vol, drift: 0, jumpRate: pM.jumpRate,
          session: "OTC 24/7", brokerId: idM,
          aliases: [symM, symM + " OTC", symM + " (OTC)", nameM, nameM + " OTC", nameM + " (OTC)"],
        });
      }
    }

    // Indices
    for (i = 0; i < INDICES.length; i++) {
      row = INDICES[i];
      var pI = profileFor(row[0], "index");
      out.push({
        id: row[0], name: row[1], kind: "index",
        basePrice: pI.basePrice, pipSize: pI.pipSize, decimals: pI.decimals,
        vol: pI.vol, drift: 0, jumpRate: pI.jumpRate,
        session: "NY", brokerId: row[2],
        aliases: [row[0], row[0].replace(/USD$/, ""), row[0].replace(/EUR$/, ""), row[0].replace(/JPY$/, ""), row[0].replace(/HKD$/, ""), row[0].replace(/AUD$/, ""), row[0].replace(/GBP$/, ""), row[1]],
      });
    }

    // Stocks (OTC)
    for (i = 0; i < STOCKS.length; i++) {
      row = STOCKS[i];
      var ticker = row[0].replace(/_otc$/i, "");
      var pS = profileFor(row[0], "stock");
      out.push({
        id: row[0], name: row[1] + " (OTC)", kind: "stock",
        basePrice: pS.basePrice, pipSize: pS.pipSize, decimals: pS.decimals,
        vol: pS.vol, drift: 0, jumpRate: pS.jumpRate,
        session: "NYSE", brokerId: row[2],
        aliases: [row[0], ticker, ticker + " OTC", ticker + " (OTC)", row[1], row[1] + " (OTC)", row[1] + " OTC"],
      });
    }

    // Base crypto entries (engine seed / demo; Quotex trades crypto OTC-only,
    // so the broker twin `BTCUSD_otc` is the live-market entry above).
    var BASE_CRYPTO = [
      ["BTCUSD", "BTC/USD", 62000], ["ETHUSD", "ETH/USD", 3300], ["SOLUSD", "SOL/USD", 150],
    ];
    for (i = 0; i < BASE_CRYPTO.length; i++) {
      row = BASE_CRYPTO[i];
      var pB = profileFor(row[0], "crypto");
      out.push({
        id: row[0], name: row[1], kind: "crypto",
        basePrice: row[2], pipSize: pB.pipSize, decimals: pB.decimals,
        vol: pB.vol, drift: 0.0001, jumpRate: pB.jumpRate,
        session: "24/7", brokerId: null,
        aliases: [row[0], row[1], row[0].replace(/USD$/, "") + "/USD"],
      });
    }

    // Legacy synthetic demo pairs (engine demo / backtest sanity).
    out.push({
      id: "OTC1", name: "OTC Synthetic #1", kind: "otc",
      basePrice: 100, pipSize: 0.001, decimals: 3,
      vol: annToMin(20), drift: 0, jumpRate: 0.01,
      session: "OTC 24/7", brokerId: null,
      aliases: ["OTC1", "OTC-1", "OTC_SYNTH_1"],
    });
    out.push({
      id: "OTC2", name: "OTC Synthetic #2", kind: "otc",
      basePrice: 50, pipSize: 0.001, decimals: 3,
      vol: annToMin(25), drift: 0, jumpRate: 0.012,
      session: "OTC 24/7", brokerId: null,
      aliases: ["OTC2", "OTC-2", "OTC_SYNTH_2"],
    });

    return out;
  }

  var ASSETS = buildEntries();

  // Build alias index for fast lookup.
  var ALIAS = Object.create(null);
  for (var a = 0; a < ASSETS.length; a++) {
    var it = ASSETS[a];
    ALIAS[it.id.toUpperCase()] = it.id;
    ALIAS[it.name.toUpperCase()] = it.id;
    for (var ai = 0; ai < it.aliases.length; ai++) {
      var al = String(it.aliases[ai] || "").toUpperCase();
      if (al) ALIAS[al] = it.id;
    }
  }
  // Pull in live-detected Quotex assets registered by the adapter at runtime.
  // (See CYBER_QUOTEX in src/lib/quotex.js — the page hook calls
  //  CYBER_ASSETS.registerQuotexAsset(...) when the broker instruments/list
  //  payload arrives. We expose the same API here for symmetry.)
  var RUNTIME_ALIASES = Object.create(null);

  function normalizeSymbol(s) {
    if (!s) return "";
    // Broker convention (A11ksa/Quotex): base uppercase, OTC suffix lowercase,
    // e.g. EURUSD_otc. ALIAS keys stay uppercase for case-insensitive lookup.
    return String(s).trim().toUpperCase().replace(/_OTC/g, "_otc");
  }

  function inferKindOld(sym) {
    // Legacy shorthand kept for API compatibility (see inferKind above).
    return inferKind(sym);
  }

  /** Human-readable aliases for `EURUSD_otc` → "EUR/USD OTC", "(OTC)", "-OTC". */
  function humanAliases(sym) {
    var out = [sym];
    var base = sym.replace(/_otc$/i, "");
    if (/_otc$/i.test(sym)) {
      var slash = base.length === 6
        ? base.slice(0, 3) + "/" + base.slice(3)
        : base.replace(/(USD|JPY|CAD|CHF|GBP|AUD|NZD)$/, "/$1");
      out.push(slash + " OTC", slash + " (OTC)", slash + "-OTC", slash + " (OT)", slash + " OTC " + sym);
    } else if (/^[A-Z]{6}$/.test(base) && /(USD|JPY|CAD|CHF|GBP|AUD|NZD)$/.test(base)) {
      out.push(base.slice(0, 3) + "/" + base.slice(3));
    }
    return out;
  }

  function registerQuotexAsset(q) {
    if (!q || !q.symbol) return null;
    var sym = normalizeSymbol(q.symbol);
    if (!sym) return null;
    var existing = ALIAS[sym.toUpperCase()] ? get(sym) : null;
    if (!existing) {
      // Synthesize a minimal asset entry for any detected symbol so the
      // engine has *something* to anchor on. Synthetic seed parameters come
      // from the kind/otc hints when available.
      var type = String(q.type || "").toLowerCase();
      var kind = type === "currency" || type === "forex" || type === "fx" ? "fx"
        : type === "crypto" || type === "cryptocurrency" ? "crypto"
        : type === "commodity" ? "commodity"
        : type === "stock" || type === "stocks" ? "stock"
        : type === "index" || type === "indices" ? "index"
        : (q.isOtc ? (inferKind(sym) === "otc" ? "otc" : inferKind(sym)) : inferKind(sym));
      var prof = profileFor(sym, kind);
      var humans = humanAliases(sym);
      // Prefer a human-friendly display name (EUR/USD OTC) over the raw symbol.
      var name = q.name || humans.find(function (h) { return / OTC|\(OTC\)/.test(h) && h !== sym; }) || humans[1] || sym;
      var aliases = [];
      aliases.push(sym);
      if (name) aliases.push(String(name));
      for (var al = 0; al < humans.length; al++) aliases.push(humans[al]);
      for (var qa = 0; qa < (q.aliases || []).length; qa++) aliases.push(String(q.aliases[qa]));
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
      for (var ra = 0; ra < aliases.length; ra++) {
        var k = String(aliases[ra]).replace(/_OTC/g, "_otc").toUpperCase();
        if (k) ALIAS[k] = sym;
      }
      RUNTIME_ALIASES[sym] = sym;
    } else {
      // Update metadata (payout / open state / timeframes / id) on re-list.
      var a = get(sym);
      if (a) {
        if (q.payout) a.payout = q.payout;
        if (q.isOpen != null) a.isOpen = q.isOpen !== false;
        if (q.id) a.brokerId = q.id;
        if (q.name && q.name !== a.name && a.id === sym) {
          // keep display name in sync with the broker's own label once known
          a.name = String(q.name);
          var extra = String(q.name).toUpperCase();
          if (extra && !ALIAS[extra]) ALIAS[extra] = sym;
        }
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
    var raw = String(symbolOrText).trim();
    var sym = normalizeSymbol(raw.replace(/\s+/g, ""));
    var exactId = ALIAS[sym.toUpperCase()];
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
    var k = String(id).toUpperCase();
    var canonical = ALIAS[k];
    if (!canonical) return null;
    return ASSETS.find(function (a) { return a.id === canonical; }) || null;
  }

  function detect(text) {
    if (!text) return null;
    var t = String(text).toUpperCase();
    // Exact normalized-symbol match first (e.g. "EURUSD_otc") so a broker
    // suffix can never be shadowed by a substring alias ("EURUSD").
    var exact = normalizeSymbol(/\s+/g.test(text) ? String(text).replace(/\s+/g, "") : text);
    var exactKey = exact.toUpperCase();
    if (ALIAS[exactKey]) return get(ALIAS[exactKey]);
    var wantOtc = /(OTC|\(OT\)|_OTC)/.test(t);
    // Longest alias first. OTC-aware: when the text mentions OTC, prefer an
    // OTC asset and never let "EUR/USD" swallow "EUR/USD OTC"; when the text
    // has no OTC marker, skip OTC-only aliases so "EURUSD" never resolves to
    // "EURUSD-OTC".
    var keys = Object.keys(ALIAS).sort(function (a, b) { return b.length - a.length; });
    var fallback = null;
    for (var ki = 0; ki < keys.length; ki++) {
      var k = keys[ki];
      if (!t.includes(k)) continue;
      var keyOtc = /(OTC|\(OT\)|_OTC)/.test(k);
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
    return ASSETS.filter(function (a) { return a.kind === kind; });
  }

  function runtimeAliases() {
    return Object.assign({}, RUNTIME_ALIASES);
  }

  root.CYBER_ASSETS = { list: list, get: get, detect: detect, byKind: byKind, ALIAS: ALIAS, registerQuotexAsset: registerQuotexAsset, ensureRegistered: ensureRegistered, runtimeAliases: runtimeAliases, normalizeSymbol: normalizeSymbol, inferKind: inferKind, humanAliases: humanAliases };
})(typeof self !== "undefined" ? self : globalThis);
