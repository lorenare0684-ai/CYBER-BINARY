/**
 * CYBER BINARY — Auto-Adapting High-Accuracy Asset System v2.6
 *
 * Evaluates, ranks, and filters all catalog assets in real-time based on:
 *   - Historical & live recorded strategy win-rates
 *   - Broker payout percentages
 *   - Expected Value (EV = WinRate * (1 + Payout%) - 1)
 *   - Market regime & volatility quality
 *   - Active confluence signals
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

    // 1. Payout %
    let payout = 85;
    if (payoutsMap && payoutsMap[asset.id] != null) {
      payout = numberValue(payoutsMap[asset.id], asset.payout || 85);
    } else if (asset.payout != null && asset.payout > 0) {
      payout = Number(asset.payout);
    }
    if (payout <= 1) payout *= 100; // normalize 0.85 -> 85
    payout = Math.max(10, Math.min(100, payout));

    // 2. Win rate calculation (blend live stats + backtest stats + baseline)
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

    let matrixWinrate = null;
    let recommendedStrat = "confluence";
    if (opts.matrixBest && opts.matrixBest[asset.id]) {
      const b = opts.matrixBest[asset.id];
      if (b && b.winrate != null) {
        matrixWinrate = Number(b.winrate);
        if (b.strategy) recommendedStrat = b.strategy;
      }
    }

    // Baseline winrate fallback based on asset volatility & session
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

    // 3. Expected Value (EV) = (WinRate% * (1 + Payout%)) - 100%
    const winProb = finalWinrate / 100;
    const payoutFactor = 1 + payout / 100;
    const expectedValue = winProb * payoutFactor - 1;

    // 4. Market / Volatility Quality
    let regimeQuality = 70;
    let activeSignal = null;

    if (candlesMap && Array.isArray(candlesMap[asset.id]) && candlesMap[asset.id].length >= 40 && ENG) {
      const candles = candlesMap[asset.id];
      const sig = ENG.analyze(candles, { strategy: "auto_adaptive", lean: false });
      if (sig && sig.ready) {
        activeSignal = sig;
        if (sig.direction === "CALL" || sig.direction === "PUT") regimeQuality += 15;
        if (sig.regime === "trending" || sig.regime === "strong-trend") regimeQuality += 10;
        else if (sig.regime === "choppy") regimeQuality -= 15;
      }
    }

    // 5. Accuracy Score (0..100)
    const evScore = Math.max(0, Math.min(100, (expectedValue + 0.2) * 150));
    const payoutScore = payout;
    const accuracyScore = Math.min(100, Math.max(0, Math.round(
      finalWinrate * 0.45 + evScore * 0.30 + payoutScore * 0.15 + regimeQuality * 0.10
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
      recommendedStrategy: recommendedStrat,
      recommendedStrategyLabel: recommendedStratLabel,
      recommended: accuracyScore >= 60 && payout >= 65 && expectedValue > 0,
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
