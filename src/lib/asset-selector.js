/**
 * CYBER BINARY — Auto-Adapting High-Accuracy Asset System v2.7.4
 *
 * Evaluates, ranks, and filters all catalog assets in real-time based on:
 *   - Historical & live recorded strategy win-rates
 *   - Broker payout percentages
 *   - Expected Value (EV = WinRate * (1 + Payout%) - 1)
 *   - Market regime & volatility quality
 *   - Noise profile (directional efficiency, chop, wick ratio)
 *   - Trend strength (ADX, EMA alignment, directional clarity)
 *   - Multi-strategy sweep (finds best strategy per asset)
 *   - Session awareness (assets in active trading hours score higher)
 *   - Recent performance weighting (newer trades weighted more)
 *
 * Exposes:
 *   CYBER_ASSET_SELECTOR.evaluateAsset(assetOrId, opts)
 *   CYBER_ASSET_SELECTOR.rankAssets(opts)
 *   CYBER_ASSET_SELECTOR.getHighAccuracyAssets(opts)
 *   CYBER_ASSET_SELECTOR.getBestAsset(opts)
 */
(function (root) {
  "use strict";

  const ASSETS = root.CYBER_ASSETS;
  const ENG = root.CYBER_ENGINE;
  const TA = root.CYBER_TA;

  if (!ASSETS) {
    root.CYBER_ASSET_SELECTOR = null;
    return;
  }

  function numberValue(val, fallback) {
    if (val == null || typeof val === "boolean") return fallback;
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  /**
   * v2.7.4: Market session detection. Assets trade better during their
   * natural session — forex pairs during London/NY overlap, crypto 24/7,
   * stocks during exchange hours. Returns a quality multiplier [0.8..1.2].
   */
  function sessionQuality(asset, timestamp) {
    const id = String(asset && asset.id || "").toUpperCase();
    const ts = Number(timestamp) || Date.now();
    const d = new Date(ts);
    const utcHour = d.getUTCHours();

    // Crypto/OTC: 24/7, slight quality dip during low-volume weekend hours
    if (asset && asset.isOtc) return 1.0;
    if (/CRYPTO|BTC|ETH|XRP|SOL|DOGE/.test(id)) {
      const day = d.getUTCDay();
      if (day === 0 || day === 6) return 0.92; // weekend lower volume
      return 1.0;
    }

    // Forex: best during London (07-16 UTC) and NY (12-21 UTC) overlap
    if (asset && asset.kind === "fx") {
      if (utcHour >= 12 && utcHour <= 16) return 1.15; // London/NY overlap
      if (utcHour >= 7 && utcHour <= 21) return 1.05;  // London or NY
      if (utcHour >= 0 && utcHour <= 5) return 0.85;   // Asian quiet hours
      return 0.95;
    }

    // Stocks/indices: best during US market hours (13:30-20:00 UTC)
    if (asset && (asset.kind === "stock" || asset.kind === "index")) {
      if (utcHour >= 13 && utcHour <= 20) return 1.12;
      if (utcHour >= 8 && utcHour <= 13) return 1.02;  // European hours
      return 0.88;
    }

    // Commodities: best during US/European overlap
    if (asset && asset.kind === "commodity") {
      if (utcHour >= 8 && utcHour <= 18) return 1.08;
      return 0.92;
    }

    return 1.0;
  }

  /**
   * v2.7.4: Volatility quality score. Measures whether the asset has
   * "tradeable" volatility — not too low (no movement), not too high
   * (whipsaw). Uses ATR%, Bollinger width, and volatility stability.
   * Returns [0..100] where 50-80 is ideal.
   */
  function volatilityQuality(candles) {
    if (!TA || !Array.isArray(candles) || candles.length < 30) return 50;
    const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
    const highs = candles.map((c) => Number(c.high)).filter(Number.isFinite);
    const lows = candles.map((c) => Number(c.low)).filter(Number.isFinite);
    if (closes.length < 30) return 50;
    const lastClose = closes[closes.length - 1];
    if (!lastClose || lastClose <= 0) return 50;

    // ATR% — ideal range 0.02% to 0.4% per bar
    const atrArr = TA.atr(highs, lows, closes, 14);
    const atrVal = atrArr[atrArr.length - 1];
    const atrPct = Number.isFinite(atrVal) ? (atrVal / lastClose) * 100 : 0;
    let atrScore = 50;
    if (atrPct >= 0.02 && atrPct <= 0.15) atrScore = 90;       // ideal
    else if (atrPct > 0.15 && atrPct <= 0.30) atrScore = 75;   // good
    else if (atrPct > 0.30 && atrPct <= 0.50) atrScore = 55;   // acceptable
    else if (atrPct < 0.02) atrScore = 20;                     // too quiet
    else atrScore = 30;                                        // too volatile

    // Bollinger width — measures expansion/compression
    const bb = TA.bollinger(closes, 20, 2);
    const bbUpper = bb.upper[bb.upper.length - 1];
    const bbLower = bb.lower[bb.lower.length - 1];
    const bbWidth = Number.isFinite(bbUpper) && Number.isFinite(bbLower) && lastClose > 0
      ? ((bbUpper - bbLower) / lastClose) * 100 : 0;
    let bbScore = 50;
    if (bbWidth >= 0.05 && bbWidth <= 0.40) bbScore = 85;
    else if (bbWidth > 0.40 && bbWidth <= 0.80) bbScore = 65;
    else if (bbWidth < 0.05) bbScore = 25; // squeeze — breakout pending
    else bbScore = 40;

    // Volatility stability — std dev of ATR over last 10 bars
    const atrTail = atrArr.slice(-10).filter(Number.isFinite);
    let stabilityScore = 50;
    if (atrTail.length >= 5) {
      const mean = atrTail.reduce((a, b) => a + b, 0) / atrTail.length;
      const variance = atrTail.reduce((a, b) => a + (b - mean) ** 2, 0) / atrTail.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1;
      if (cv < 0.3) stabilityScore = 85;      // very stable
      else if (cv < 0.6) stabilityScore = 65;  // normal
      else stabilityScore = 35;                // erratic
    }

    return Math.round(atrScore * 0.45 + bbScore * 0.30 + stabilityScore * 0.25);
  }

  /**
   * v2.7.4: Trend strength score. Measures directional clarity using ADX,
   * EMA alignment, and price position relative to moving averages.
   * Returns [0..100] where higher = clearer trend.
   */
  function trendStrength(candles) {
    if (!TA || !Array.isArray(candles) || candles.length < 30) return 50;
    const closes = candles.map((c) => Number(c.close)).filter(Number.isFinite);
    const highs = candles.map((c) => Number(c.high)).filter(Number.isFinite);
    const lows = candles.map((c) => Number(c.low)).filter(Number.isFinite);
    if (closes.length < 30) return 50;
    const lastClose = closes[closes.length - 1];
    if (!lastClose || lastClose <= 0) return 50;
    const i = closes.length - 1;

    // ADX — trend strength
    const adxR = TA.adx(highs, lows, closes, 14);
    const adxVal = adxR.adx[i];
    let adxScore = 50;
    if (Number.isFinite(adxVal)) {
      if (adxVal >= 30) adxScore = 90;       // strong trend
      else if (adxVal >= 22) adxScore = 70;  // trending
      else if (adxVal >= 15) adxScore = 50;  // weak trend
      else adxScore = 30;                    // ranging
    }

    // EMA alignment — fast > slow (bullish) or fast < slow (bearish)
    const emaFast = TA.ema(closes, 8);
    const emaSlow = TA.ema(closes, 21);
    const ef = emaFast[i], es = emaSlow[i];
    let alignScore = 50;
    if (Number.isFinite(ef) && Number.isFinite(es)) {
      const spread = Math.abs(ef - es) / lastClose;
      if (spread > 0.002) alignScore = 85;      // wide spread = clear trend
      else if (spread > 0.001) alignScore = 70; // moderate
      else if (spread > 0.0005) alignScore = 55; // narrow
      else alignScore = 30;                      // crossed = no trend
    }

    // Price position relative to EMAs
    let posScore = 50;
    if (Number.isFinite(ef) && Number.isFinite(es)) {
      if (lastClose > ef && ef > es) posScore = 80;      // clean bullish
      else if (lastClose < ef && ef < es) posScore = 80; // clean bearish
      else if (lastClose > es) posScore = 60;            // mixed bullish
      else if (lastClose < es) posScore = 60;            // mixed bearish
      else posScore = 35;                                // choppy
    }

    return Math.round(adxScore * 0.40 + alignScore * 0.35 + posScore * 0.25);
  }

  /**
   * v2.7.4: Noise quality score. Uses the TA noiseProfile to measure
   * directional efficiency and chop. Returns [0..100] where higher = cleaner.
   */
  function noiseQuality(candles) {
    if (!TA || !TA.noiseProfile || !Array.isArray(candles) || candles.length < 20) return 50;
    const noise = TA.noiseProfile(candles, 20);
    if (!noise || !noise.ready) return 50;

    // efficiency: 1 = perfectly directional, 0 = random walk
    const effScore = Math.round(Math.max(0, Math.min(100, noise.efficiency * 120)));
    // flip: 0 = no direction changes, 1 = constant flipping
    const flipScore = Math.round(Math.max(0, Math.min(100, (1 - noise.flip) * 100)));
    // chop: 0 = clean trend, 1 = choppy
    const chopScore = Math.round(Math.max(0, Math.min(100, (1 - noise.chop) * 100)));
    // wick: 0 = full bodies, 1 = all wicks
    const wickScore = Math.round(Math.max(0, Math.min(100, (1 - noise.wick) * 80 + 20)));

    return Math.round(effScore * 0.35 + flipScore * 0.25 + chopScore * 0.25 + wickScore * 0.15);
  }

  /**
   * v2.7.4: Quick multi-strategy sweep. Tests a subset of strategies
   * against the asset's candles to find which one produces the strongest
   * signal. Returns the best strategy ID and its confidence.
   */
  const SWEEP_STRATEGIES = [
    "confluence", "sniper", "turbo_trend", "institutional_flow",
    "breakout", "trend", "scalp", "high_accuracy"
  ];

  function bestStrategyForAsset(candles) {
    if (!ENG || !Array.isArray(candles) || candles.length < 50) {
      return { strategy: "confluence", confidence: 0, direction: "WAIT" };
    }
    let best = { strategy: "confluence", confidence: 0, score: 0, direction: "WAIT" };
    for (const stratId of SWEEP_STRATEGIES) {
      try {
        const sig = ENG.analyze(candles, { strategy: stratId, lean: true });
        if (!sig || !sig.ready) continue;
        const conf = Number(sig.confidence) || 0;
        const score = Number(sig.score) || 0;
        const hasSignal = sig.direction === "CALL" || sig.direction === "PUT";
        // Prefer strategies with active signals and high confidence
        const fitness = conf * 2 + score * 5 + (hasSignal ? 30 : 0);
        if (fitness > (best.confidence * 2 + best.score * 5 + (best.direction !== "WAIT" ? 30 : 0))) {
          best = { strategy: stratId, confidence: conf, score, direction: sig.direction, regime: sig.regime };
        }
      } catch (_) {}
    }
    return best;
  }

  /**
   * v2.7.4: Recent performance weighting. Weights recent trades more
   * heavily than older ones using exponential decay.
   */
  function weightedWinrate(history, assetId) {
    if (!Array.isArray(history) || !history.length) return null;
    const assetTrades = history.filter((h) => h && h.asset === assetId && (h.won === true || h.won === false));
    if (assetTrades.length < 3) return null;
    const now = Date.now();
    let weightedWins = 0, weightedTotal = 0;
    for (const trade of assetTrades) {
      const age = Math.max(0, now - Number(trade.at || trade.entryTime || 0));
      const daysAgo = age / 86400000;
      // Exponential decay: half-life of 3 days
      const weight = Math.exp(-0.231 * daysAgo); // ln(2)/3 ≈ 0.231
      if (trade.won === true) weightedWins += weight;
      weightedTotal += weight;
    }
    if (weightedTotal < 0.5) return null;
    return (weightedWins / weightedTotal) * 100;
  }

  /**
   * Evaluates expected value and accuracy score for a single asset or asset ID string.
   */
  function evaluateAsset(assetOrId, opts) {
    let asset = assetOrId;
    if (typeof assetOrId === "string") {
      asset = ASSETS.get(assetOrId) || ASSETS.ensureRegistered(assetOrId);
    } else if (assetOrId && typeof assetOrId === "object" && assetOrId.id) {
      const full = ASSETS.get(assetOrId.id) || ASSETS.ensureRegistered(assetOrId.id);
      asset = Object.assign({}, full || {}, assetOrId);
    }
    if (!asset || typeof asset !== "object" || !asset.id) return null;
    opts = opts || {};

    const stats = opts.stats || null;
    const candlesMap = opts.candlesByAsset || null;
    const payoutsMap = opts.payoutsByAsset || null;
    const history = opts.history || (stats && stats.history) || null;

    // 1. Payout %
    let payout = 85;
    if (payoutsMap && payoutsMap[asset.id] != null) {
      payout = numberValue(payoutsMap[asset.id], asset.payout || 85);
    } else if (asset.payout != null && asset.payout > 0) {
      payout = Number(asset.payout);
    }
    if (payout <= 1) payout *= 100;
    payout = Math.max(10, Math.min(100, payout));

    // 2. Win rate calculation (blend multiple sources with recency weighting)
    let wins = 0, losses = 0, totalTrades = 0;
    let liveWinrate = null;

    if (stats && stats.byAsset) {
      const aStats = stats.byAsset[asset.id] || stats.byAsset[asset.id.toUpperCase()] || stats.byAsset[asset.id.toLowerCase()];
      if (aStats) {
        wins = numberValue(aStats.w, 0);
        losses = numberValue(aStats.l, 0);
        totalTrades = wins + losses;
        if (totalTrades > 0) liveWinrate = (wins / totalTrades) * 100;
      }
    }

    // v2.7.4: Recent performance weighting (exponential decay)
    const recentWinrate = weightedWinrate(history, asset.id);
    if (recentWinrate !== null && liveWinrate !== null && totalTrades >= 3) {
      // Blend: 60% recent, 40% all-time (recent is more predictive)
      liveWinrate = recentWinrate * 0.6 + liveWinrate * 0.4;
    } else if (recentWinrate !== null) {
      liveWinrate = recentWinrate;
    }

    let matrixWinrate = null;
    let recommendedStrat = "confluence";
    if (opts.matrixBest && opts.matrixBest[asset.id]) {
      const b = opts.matrixBest[asset.id];
      if (b && b.winrate != null) {
        matrixWinrate = Number(b.winrate);
        if (b.strategy) recommendedStrat = b.strategy;
      }
    }

    // Baseline winrate fallback based on asset type
    let baseWinrate = asset.isOtc ? 62 : 60;
    if (asset.kind === "crypto") baseWinrate = 58;
    else if (asset.kind === "fx") baseWinrate = 63;

    // Blend winrates based on sample weight
    let finalWinrate = baseWinrate;
    if (liveWinrate !== null && totalTrades >= 3) {
      const weight = Math.min(0.8, totalTrades / 20);
      finalWinrate = liveWinrate * weight + (matrixWinrate !== null ? matrixWinrate : baseWinrate) * (1 - weight);
    } else if (matrixWinrate !== null) {
      finalWinrate = matrixWinrate;
    }

    finalWinrate = Math.max(10, Math.min(98, finalWinrate));

    // 3. Expected Value
    const winProb = finalWinrate / 100;
    const payoutFactor = 1 + payout / 100;
    const expectedValue = winProb * payoutFactor - 1;

    // 4. v2.7.4: Multi-dimensional market quality analysis
    let regimeQuality = 70;
    let activeSignal = null;
    let hasLiveCandles = false;
    let volQuality = 50;
    let trendStr = 50;
    let noiseQ = 50;
    let bestStratSweep = null;
    let sessionMult = 1.0;

    if (candlesMap && Array.isArray(candlesMap[asset.id]) && candlesMap[asset.id].length >= 40 && ENG) {
      hasLiveCandles = true;
      const candles = candlesMap[asset.id];

      // Run best-strategy sweep instead of just confluence
      bestStratSweep = bestStrategyForAsset(candles);
      if (bestStratSweep.strategy) recommendedStrat = bestStratSweep.strategy;

      // Get signal from best strategy
      const sig = ENG.analyze(candles, { strategy: recommendedStrat, lean: true });
      if (sig && sig.ready) {
        activeSignal = sig;
        if (sig.direction === "CALL" || sig.direction === "PUT") regimeQuality += 15;
        if (sig.regime === "trending" || sig.regime === "strong-trend") regimeQuality += 10;
        else if (sig.regime === "choppy") regimeQuality -= 15;
        else if (sig.regime === "squeeze") regimeQuality -= 5;
      }

      // v2.7.4: Volatility quality
      volQuality = volatilityQuality(candles);
      // v2.7.4: Trend strength
      trendStr = trendStrength(candles);
      // v2.7.4: Noise quality
      noiseQ = noiseQuality(candles);
      // v2.7.4: Session quality
      sessionMult = sessionQuality(asset, Date.now());

      // Combine into market quality score
      regimeQuality = Math.round(
        regimeQuality * 0.25 +
        volQuality * 0.25 +
        trendStr * 0.25 +
        noiseQ * 0.25
      );
      // Apply session multiplier
      regimeQuality = Math.round(regimeQuality * sessionMult);
    }

    // Evidence accounting
    const dataConfidence = Math.max(0, Math.min(1,
      Math.min(1, totalTrades / 20) * 0.5 +
      (matrixWinrate !== null ? 0.20 : 0) +
      (hasLiveCandles ? 0.15 : 0) +
      (bestStratSweep && bestStratSweep.direction !== "WAIT" ? 0.15 : 0)
    ));
    const hasEvidence = totalTrades >= 3 || matrixWinrate !== null || (hasLiveCandles && activeSignal !== null);

    // 5. Accuracy Score (0..100) — v2.7.4: rebalanced weights
    const evScore = Math.max(0, Math.min(100, (expectedValue + 0.2) * 150));
    const payoutScore = payout;
    const marketQualityScore = Math.max(0, Math.min(100, regimeQuality));
    const accuracyScore = Math.min(100, Math.max(0, Math.round(
      finalWinrate * 0.35 +       // historical winrate (35%)
      evScore * 0.20 +             // expected value (20%)
      payoutScore * 0.10 +         // payout (10%)
      marketQualityScore * 0.20 +  // market quality (20%) — was 10%
      noiseQ * 0.15               // noise quality (15%) — new
    )));

    const stratObj = root.CYBER_STRATEGIES ? root.CYBER_STRATEGIES.get(recommendedStrat) : null;
    const recommendedStratLabel = stratObj ? stratObj.label : recommendedStrat;

    return {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      isOtc: asset.isOtc,
      isOpen: asset.isOpen !== false,
      payout,
      winrate: Math.round(finalWinrate * 10) / 10,
      trades: totalTrades,
      wins,
      losses,
      expectedValue: Math.round(expectedValue * 1000) / 1000,
      expectedValuePct: Math.round(expectedValue * 1000) / 10,
      accuracyScore,
      regimeQuality,
      // v2.7.4: new quality metrics
      volatilityQuality: volQuality,
      trendStrength: trendStr,
      noiseQuality: noiseQ,
      sessionQuality: Math.round(sessionMult * 100) / 100,
      bestStrategySweep: bestStratSweep,
      dataConfidence: Math.round(dataConfidence * 100) / 100,
      hasEvidence,
      recommendedStrategy: recommendedStrat,
      recommendedStrategyLabel: recommendedStratLabel,
      recommended: hasEvidence && accuracyScore >= 60 && payout >= 65 && expectedValue > 0,
      currentSignal: activeSignal,
    };
  }

  /**
   * Ranks all catalog assets by Accuracy & Expected Value.
   */
  function rankAssets(opts) {
    opts = opts || {};
    const inputAssets = Array.isArray(opts.assets) ? opts.assets : ASSETS.list();
    const kind = typeof opts.kind === "string" ? opts.kind : "all";
    const minWinrate = numberValue(opts.minWinrate, 0);
    const minPayout = numberValue(opts.minPayout, 0);
    const openOnly = opts.openOnly === true;

    const evaluated = [];
    for (const rawAsset of inputAssets) {
      const a = ASSETS.get(typeof rawAsset === "string" ? rawAsset : rawAsset && rawAsset.id);
      if (!a) continue;
      if (kind !== "all" && typeof ASSETS.matchesKind === "function" && !ASSETS.matchesKind(a, kind)) continue;
      if (openOnly && a.isOpen === false) continue;

      const evalRes = evaluateAsset(a, opts);
      if (!evalRes) continue;
      if (evalRes.winrate < minWinrate || evalRes.payout < minPayout) continue;

      evaluated.push(evalRes);
    }

    evaluated.sort((x, y) => {
      // v2.6.8: evidence tier first
      const tx = x.hasEvidence ? 1 : 0, ty = y.hasEvidence ? 1 : 0;
      if (ty !== tx) return ty - tx;
      if (tx && ty && y.dataConfidence !== x.dataConfidence) return y.dataConfidence - x.dataConfidence;
      // v2.7.4: when evidence is equal, prefer higher market quality
      if (y.regimeQuality !== x.regimeQuality) return y.regimeQuality - x.regimeQuality;
      if (y.accuracyScore !== x.accuracyScore) return y.accuracyScore - x.accuracyScore;
      return y.expectedValue - x.expectedValue;
    });

    for (let i = 0; i < evaluated.length; i++) {
      evaluated[i].rank = i + 1;
    }

    return evaluated;
  }

  /**
   * Returns top high-accuracy assets meeting criteria.
   */
  function getHighAccuracyAssets(opts) {
    opts = opts || {};
    const minAccuracy = numberValue(opts.minAccuracy, 60);
    const ranked = rankAssets(opts);
    return ranked.filter((item) => item.accuracyScore >= minAccuracy && item.recommended);
  }

  /**
   * Returns the single best high-accuracy asset.
   */
  function getBestAsset(opts) {
    opts = opts || {};
    if (opts.includeClosed !== true) opts = Object.assign({}, opts, { openOnly: true });
    const ranked = rankAssets(opts);
    return ranked.length ? ranked[0] : null;
  }

  root.CYBER_ASSET_SELECTOR = {
    evaluateAsset,
    rankAssets,
    getHighAccuracyAssets,
    getBestAsset,
  };
})(typeof self !== "undefined" ? self : globalThis);
