/**
 * Confluence signal engine v2.6 — multi-indicator, multi-timeframe, regime-aware,
 * auto-adaptive multi-strategy router.
 *
 * Inputs: candle series (1m), optional strategy preset, optional asset profile.
 * Output: { ready, direction, confidence, score, votes, regime, metrics, reasons, adaptive? }
 *
 * The engine scores confluence and supports auto-adaptive strategy selection
 * to dynamically select the best strategy for the current market situation.
 */
(function (root) {
  "use strict";

  const TA = root.CYBER_TA;
  if (!TA) throw new Error("CYBER_TA missing");
  const STRAT = (root.CYBER_STRATEGIES && root.CYBER_STRATEGIES.STRATEGIES) || null;

  const DEFAULTS = {
    rsiPeriod: 14, rsiBuy: 42, rsiSell: 58,
    emaFast: 8, emaSlow: 21,
    macdFast: 12, macdSlow: 26, macdSignal: 9,
    stochK: 14, stochD: 3, stochOs: 22, stochOb: 78,
    bbPeriod: 20, bbMult: 2,
    atrPeriod: 14, minAtrPct: 0.00012,
    minScore: 5, lookback: 3,
    adxPeriod: 14, adxMin: 18,
    superPeriod: 10, superMult: 2.0,
    psarStep: 0.02, psarMax: 0.2,
    hurstPeriod: 100,
    momPeriod: 10,
    mtfFast: 5, mtfMid: 15, // minutes
    minBars: 150,         // max lookback for backtest speed; live uses 200
  };

  const DEFAULT_WEIGHTS = {
    emaTrend: 2, emaCross: 2, rsiPull: 1, macd: 1, stoch: 1, bb: 1,
    adxTrend: 1, supertrend: 2, psar: 1, vwap: 1, mtfAlign: 2,
    hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
  };

  const CONCRETE_STRATEGIES = [
    "sniper", "turbo_trend", "institutional_flow", "confluence", "trend",
    "breakout", "scalp", "otc", "squeeze", "ribbon", "momentum_pulse",
    "high_accuracy"
  ];

  // Regimes detectRegime() can emit — anything else ("unknown") is never
  // allowed through a regime filter.
  const REGIME_NAMES = ["squeeze", "trending", "strong-trend", "mean-reverting", "choppy", "ranging"];

  // v2.7.0: regimes the adaptive router refuses to trade. The v2.7.0 sweep
  // also blocked "trending" — but measured against the repo's own backtester
  // (12 concrete strategies × 15 mixed series, 3-bar expiry) trending is the
  // second-best regime after strong-trend (91.6% avg / 93.5% best vs 54.05%
  // breakeven at 85% payout), and the router's regime bonus already favours
  // trend-following strategies there. Blocking it left the default
  // auto_adaptive strategy holding WAIT through most normal sessions — the
  // reported "no signal generation". Choppy (~46.6%), squeeze (~49.5%) and
  // ranging (~46.1%) stay blocked: all measure below breakeven.
  const ADAPTIVE_SIT_OUT_REGIMES = ["choppy", "squeeze", "ranging"];

  // ============================================================
  // Dynamic expiry engine (v2.8): chooses expiry to improve accuracy
  // based on regime, volatility, trend strength, strategy and confidence.
  // ============================================================
  const STRATEGY_EXPIRY_PROFILES = {
    scalp:              { base: 1,   min: 1,   max: 2   },
    turbo_trend:        { base: 2,   min: 1,   max: 3   },
    sniper:             { base: 2,   min: 1.5, max: 3   },
    confluence:         { base: 2,   min: 1.5, max: 3.5 },
    institutional_flow: { base: 2.5, min: 2,   max: 4   },
    breakout:           { base: 2.5, min: 2,   max: 4   },
    otc:                { base: 2,   min: 1,   max: 3   },
    momentum_pulse:     { base: 2,   min: 1.5, max: 3   },
    high_accuracy:      { base: 2,   min: 1.5, max: 3   },
    trend:              { base: 3,   min: 2,   max: 5   },
    ribbon:             { base: 3,   min: 2,   max: 4   },
    squeeze:            { base: 3,   min: 2,   max: 5   },
  };

  const REGIME_EXPIRY = {
    "strong-trend":   { base: 3,   min: 2,   max: 5,   reason: "strong trend needs time to ride" },
    "trending":       { base: 2.5, min: 2,   max: 4,   reason: "trending, allow continuation" },
    "ranging":        { base: 1.5, min: 1,   max: 3,   reason: "ranging, quick mean reversion" },
    "mean-reverting": { base: 1.5, min: 1,   max: 2.5, reason: "mean-reverting, short expiry" },
    "squeeze":        { base: 3,   min: 2,   max: 5,   reason: "squeeze breakout needs expansion time" },
    "choppy":         { base: 1,   min: 1,   max: 2,   reason: "choppy, minimal exposure" },
    "unknown":        { base: 2,   min: 1,   max: 3.5, reason: "unknown regime" },
  };

  function clampExpiry(value, min, max) {
    let v = Number(value);
    if (!Number.isFinite(v)) v = 2;
    v = Math.max(0.5, Math.min(1440, v));
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    // Round to nearest 0.5 for OTC (duration) but keep integer for regular if >1
    // Quotex supports 1,2,3,4,5 etc. 0.5 steps are useful for 30s OTC.
    return Math.round(v * 2) / 2;
  }

  function suggestExpiry(metrics, regime, strategyId, confidence, opts) {
    opts = opts || {};
    const stratProfile = STRATEGY_EXPIRY_PROFILES[strategyId] || STRATEGY_EXPIRY_PROFILES.confluence;
    const regimeProfile = REGIME_EXPIRY[regime] || REGIME_EXPIRY.unknown;

    // Start from strategy base, then blend with regime base (60% strategy, 40% regime)
    let expiry = stratProfile.base * 0.6 + regimeProfile.base * 0.4;
    let reasons = [];
    reasons.push(`base ${stratProfile.base}m(${strategyId}) + ${regimeProfile.base}m(${regime})`);

    // Volatility adjustment via atrPct
    const atrPct = metrics && Number.isFinite(metrics.atrPct) ? metrics.atrPct : null;
    if (atrPct != null) {
      if (atrPct < 0.0002) { expiry += 1; reasons.push(`low vol ATR% ${(atrPct*100).toFixed(3)}% +1m`); }
      else if (atrPct < 0.0004) { expiry += 0.5; reasons.push(`low-med vol +0.5m`); }
      else if (atrPct > 0.0015) { expiry -= 0.5; reasons.push(`very high vol -0.5m`); }
      else if (atrPct > 0.0009) { expiry -= 0.25; reasons.push(`high vol -0.25m`); }
    }

    // Trend strength via ADX
    const adx = metrics && Number.isFinite(metrics.adx) ? metrics.adx : null;
    if (adx != null) {
      if (adx >= 35) { expiry += 1; reasons.push(`strong ADX ${adx.toFixed(0)} +1m`); }
      else if (adx >= 28) { expiry += 0.5; reasons.push(`ADX ${adx.toFixed(0)} +0.5m`); }
      else if (adx < 15) { expiry -= 0.5; reasons.push(`weak ADX ${adx.toFixed(0)} -0.5m`); }
    }

    // EMA separation as trend confirmation
    const emaFast = metrics && Number.isFinite(metrics.emaFast) ? metrics.emaFast : null;
    const emaSlow = metrics && Number.isFinite(metrics.emaSlow) ? metrics.emaSlow : null;
    const atr = metrics && Number.isFinite(metrics.atr) ? metrics.atr : null;
    if (emaFast != null && emaSlow != null && atr != null && atr > 0) {
      const sep = Math.abs(emaFast - emaSlow) / atr;
      if (sep > 2.5) { expiry += 0.5; reasons.push(`wide EMA sep ${sep.toFixed(1)}xATR +0.5m`); }
      else if (sep < 0.5) { expiry -= 0.25; reasons.push(`narrow EMA sep -0.25m`); }
    }

    // RSI extremes = possible reversal, shorten expiry for quick reversion
    const rsi = metrics && Number.isFinite(metrics.rsi) ? metrics.rsi : null;
    if (rsi != null) {
      if (rsi < 25 || rsi > 75) { expiry -= 0.5; reasons.push(`RSI extreme ${rsi.toFixed(0)} -0.5m`); }
      else if (rsi < 35 || rsi > 65) { expiry -= 0.25; reasons.push(`RSI ${rsi.toFixed(0)} -0.25m`); }
    }

    // Confidence: high confidence allows longer hold, low confidence shortens
    const conf = Number(confidence);
    if (Number.isFinite(conf)) {
      if (conf >= 92) { expiry += 0.5; reasons.push(`high conf ${conf}% +0.5m`); }
      else if (conf < 70) { expiry -= 0.5; reasons.push(`low conf ${conf}% -0.5m`); }
    }

    // Bollinger width: squeeze = low width, breakout needs longer; wide = volatile
    const bbUpper = metrics && Number.isFinite(metrics.bbUpper) ? metrics.bbUpper : null;
    const bbLower = metrics && Number.isFinite(metrics.bbLower) ? metrics.bbLower : null;
    const close = metrics && Number.isFinite(metrics.close) ? metrics.close : null;
    if (bbUpper != null && bbLower != null && close != null && close > 0) {
      const bw = (bbUpper - bbLower) / close;
      if (bw < 0.001) { expiry += 0.5; reasons.push(`BB squeeze +0.5m`); }
      else if (bw > 0.01) { expiry -= 0.25; reasons.push(`BB wide -0.25m`); }
    }

    // User bounds
    const userMin = Number(opts.adaptiveExpiryMin);
    const userMax = Number(opts.adaptiveExpiryMax);
    const minBound = Number.isFinite(userMin) ? Math.max(0.5, Math.min(1440, userMin)) : Math.max(stratProfile.min, regimeProfile.min);
    const maxBound = Number.isFinite(userMax) ? Math.max(0.5, Math.min(1440, userMax)) : Math.min(stratProfile.max, regimeProfile.max);
    // Ensure min <= max
    const finalMin = Math.min(minBound, maxBound);
    const finalMax = Math.max(minBound, maxBound);

    expiry = clampExpiry(expiry, finalMin, finalMax);

    // Historical learning: if expiry winrates provided, bias toward best
    if (opts.expiryWinrates && typeof opts.expiryWinrates === 'object') {
      let bestExpiry = null, bestWR = -1;
      for (const k of Object.keys(opts.expiryWinrates)) {
        const wr = Number(opts.expiryWinrates[k]);
        if (!Number.isFinite(wr)) continue;
        if (wr > bestWR) { bestWR = wr; bestExpiry = Number(k); }
      }
      if (bestExpiry != null && bestWR >= 55 && Math.abs(bestExpiry - expiry) <= 2) {
        // Nudge 25% toward historically best expiry if it's profitable
        const nudge = (bestExpiry - expiry) * 0.25;
        const nudged = clampExpiry(expiry + nudge, finalMin, finalMax);
        if (nudged !== expiry) {
          reasons.push(`history best ${bestExpiry}m WR ${bestWR.toFixed(0)}% nudge ${nudge>0?'+':''}${nudge.toFixed(1)}m`);
          expiry = nudged;
        }
      }
    }

    return {
      minutes: expiry,
      reason: reasons.join(' · '),
      breakdown: {
        strategy: strategyId,
        regime,
        base: stratProfile.base,
        regimeBase: regimeProfile.base,
        atrPct,
        adx,
        confidence: conf,
        min: finalMin,
        max: finalMax,
      }
    };
  }

  /**
   * High-accuracy signal gates. A preset (or explicit opts.params) may set
   * `regimeFilter` (array of regime names — signal anywhere else is WAIT)
   * and `minConfidence` (0-99 — weaker confluence is WAIT). Measured on the
   * deterministic catalog backtest, gating to trending regimes plus a 90+
   * confluence floor lifts win rate from ~77% to ~90% while cutting trade
   * count roughly in half: selectivity is the accuracy lever, not curve
   * fitting — the gates only ever suppress signals, never flip one.
   */
  function signalGateReason(cfg, confidence, regime) {
    const filter = Array.isArray(cfg.regimeFilter) ? cfg.regimeFilter : null;
    if (filter && filter.length && !filter.includes(regime)) {
      return "Regime gate (" + filter.join("/") + " only; current " + regime + ")";
    }
    const rawMinConf = numberValue(cfg.minConfidence);
    if (rawMinConf != null) {
      const minConf = Math.max(0, Math.min(99, Math.floor(rawMinConf)));
      if (confidence < minConf) return "Confidence gate (" + minConf + "+; current " + confidence + ")";
    }
    return null;
  }

  /**
   * v2.6.6: live-data gate. A feed that has not been seeded with the asset's
   * genuine broker history still contains its synthetic warm-up bars; a
   * CALL/PUT derived from those bars is a false signal no matter how good
   * the engine is. The live signal path must hold WAIT until this gate
   * opens. Pure function so the contract is testable outside the browser.
   */
  function liveSignalGate(state) {
    const s = state && typeof state === "object" ? state : {};
    const realBars = Math.max(0, Math.floor(Number(s.realBars) || 0));
    const minBars = Math.max(1, Math.floor(Number(s.minBars) || 40));
    if (!s.historySeeded) {
      return { allowed: false, reason: "Waiting for real candles — broker history for this asset has not arrived yet" };
    }
    if (realBars < minBars) {
      return { allowed: false, reason: "Warming up on real candles — " + realBars + "/" + minBars + " bars received" };
    }
    return { allowed: true, reason: "" };
  }

  /**
   * v2.6.6: candle-batch trust decision. Symbol-verified batches (the
   * payload names its asset, or the data came from the platform chart's own
   * series) may seed or extend the engine feed. Batches attributed by
   * FALLBACK (payload carried no symbol and was assumed to belong to the
   * active chart) may never seed the engine feed, and may extend it only
   * when their price scale matches what is already there — a foreign
   * asset's candles must never reach the signal computation.
   */
  function historyTrustDecision(state) {
    const s = state && typeof state === "object" ? state : {};
    if (s.verified === true) return { engine: true, reason: "symbol-verified batch" };
    const feedClose = Number(s.feedClose);
    const batchClose = Number(s.batchClose);
    const tol = Number.isFinite(Number(s.tolerance)) && Number(s.tolerance) > 0 ? Number(s.tolerance) : 0.1;
    if (!Number.isFinite(feedClose) || feedClose <= 0 || !Number.isFinite(batchClose) || batchClose <= 0) {
      return { engine: false, reason: "unverified batch has no comparable price scale — rejected" };
    }
    if (Math.abs(batchClose - feedClose) / feedClose > tol) {
      return { engine: false, reason: "unverified batch price scale differs from asset feed — possible wrong asset, rejected" };
    }
    if (!s.historySeeded) {
      // First genuine broker batch arrived without a symbol in the payload
      // (some broker builds omit it from history responses). The batch is
      // already trusted for DISPLAY — the dashboard chart is built from it —
      // so refusing to seed the engine feed would leave the dashboard on
      // "Waiting for real candles" forever while candles are visibly flowing.
      // The price-scale check against the synthetic warm-up seed keeps the
      // wrong-asset protection: a batch from a different market (e.g. BTC at
      // 60k vs EURUSD at 1.08) can never seed.
      return { engine: true, reason: "unverified batch price scale matches warm-up seed — seeded" };
    }
    return { engine: true, reason: "unverified batch consistent with verified feed (scale match)" };
  }

  function numberValue(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    try {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function extract(candles) {
    const o = [], h = [], l = [], c = [], t = [];
    for (let i = 0; i < candles.length; i++) {
      const x = candles[i];
      o.push(numberValue(x.open)); h.push(numberValue(x.high)); l.push(numberValue(x.low)); c.push(numberValue(x.close)); t.push(numberValue(x.time));
    }
    return { o, h, l, c, t };
  }

  const PARAM_LIMITS = {
    rsiPeriod: [2, 500, 1], rsiBuy: [0, 100, 0], rsiSell: [0, 100, 0],
    emaFast: [1, 500, 1], emaSlow: [2, 500, 1],
    macdFast: [1, 500, 1], macdSlow: [2, 500, 1], macdSignal: [1, 500, 1],
    stochK: [1, 500, 1], stochD: [1, 500, 1], stochOs: [0, 100, 0], stochOb: [0, 100, 0],
    bbPeriod: [2, 500, 1], bbMult: [0.01, 100, 0], atrPeriod: [1, 500, 1],
    minAtrPct: [0, 1, 0], minScore: [0, 1000, 0], lookback: [0, 100, 1],
    adxPeriod: [1, 500, 1], adxMin: [0, 100, 0], superPeriod: [1, 500, 1],
    superMult: [0.01, 100, 0], psarStep: [0.000001, 1, 0], psarMax: [0.000001, 1, 0],
    hurstPeriod: [4, 2000, 1], momPeriod: [1, 2000, 1],
    mtfFast: [1, 1440, 1], mtfMid: [1, 1440, 1], minBars: [40, 2000, 1],
  };

  function hasOwn(object, key) {
    return !!object && Object.prototype.hasOwnProperty.call(object, key);
  }

  function applyParams(target, source) {
    if (!source || typeof source !== "object") return;
    for (const key of Object.keys(PARAM_LIMITS)) {
      if (!hasOwn(source, key)) continue;
      const value = numberValue(source[key]);
      if (value == null) continue;
      const limit = PARAM_LIMITS[key];
      const bounded = Math.max(limit[0], Math.min(limit[1], value));
      target[key] = limit[2] ? Math.floor(bounded) : bounded;
    }
    if (hasOwn(source, "lean") && typeof source.lean === "boolean") target.lean = source.lean;
    const rawMinConf = numberValue(source.minConfidence);
    if (rawMinConf != null) target.minConfidence = Math.max(0, Math.min(99, Math.floor(rawMinConf)));
    if (hasOwn(source, "regimeFilter")) {
      const allowed = new Set(REGIME_NAMES);
      const list = Array.isArray(source.regimeFilter)
        ? source.regimeFilter.filter((r) => typeof r === "string" && allowed.has(r))
        : [];
      if (list.length) target.regimeFilter = list;
      else delete target.regimeFilter;
    }
  }

  function applyWeights(target, source) {
    if (!source || typeof source !== "object") return;
    for (const key of Object.keys(DEFAULT_WEIGHTS)) {
      if (!hasOwn(source, key)) continue;
      const value = numberValue(source[key]);
      if (value != null) target[key] = Math.max(0, Math.min(100, value));
    }
  }

  function resolveStrategy(opts) {
    const params = Object.assign({}, DEFAULTS);
    const weights = Object.assign({}, DEFAULT_WEIGHTS);
    const strategyId = opts && typeof opts.strategy === "string" ? opts.strategy : "";
    const preset = STRAT && hasOwn(STRAT, strategyId) ? STRAT[strategyId] : null;
    if (preset) {
      applyParams(params, preset.params);
      applyWeights(weights, preset.weights);
    }
    applyParams(params, opts);
    applyParams(params, opts && opts.params);
    applyWeights(weights, opts && opts.weights);
    if (params.rsiBuy > params.rsiSell) {
      params.rsiBuy = DEFAULTS.rsiBuy; params.rsiSell = DEFAULTS.rsiSell;
    }
    if (params.stochOs > params.stochOb) {
      params.stochOs = DEFAULTS.stochOs; params.stochOb = DEFAULTS.stochOb;
    }
    if (params.emaFast >= params.emaSlow) {
      params.emaFast = DEFAULTS.emaFast; params.emaSlow = DEFAULTS.emaSlow;
    }
    if (params.macdFast >= params.macdSlow) {
      params.macdFast = DEFAULTS.macdFast; params.macdSlow = DEFAULTS.macdSlow;
    }
    if (params.psarMax < params.psarStep) params.psarMax = params.psarStep;
    return { params, weights };
  }

  function detectRegime(i, rsi, emaF, emaS, adxA, atrA, c, hurst, bb, keltner) {
    if (
      rsi[i] == null || emaF[i] == null || emaS[i] == null ||
      adxA[i] == null || atrA[i] == null || c[i] == null
    ) return "unknown";

    const trending = adxA[i] >= 22;
    const volatile = atrA[i] / c[i] > 0.0006;
    const directional = Math.abs(emaF[i] - emaS[i]) / (atrA[i] || 1e-9) > 1.5;
    const meanRevert = hurst != null && hurst[i] != null && hurst[i] < 0.45;
    const isSqueeze = bb && bb.upper && bb.lower && keltner && keltner.upper && keltner.lower &&
      bb.upper[i] != null && keltner.upper[i] != null &&
      (bb.upper[i] - bb.lower[i]) < (keltner.upper[i] - keltner.lower[i]);

    if (isSqueeze) return "squeeze";
    if (trending && directional) return "strong-trend";
    if (trending && !directional) return "trending";
    if (meanRevert) return "mean-reverting";
    if (volatile) return "choppy";
    return "ranging";
  }

  /**
   * Auto-adaptive strategy evaluator: evaluates all candidate strategies
   * for the current candle series and selects the best strategy for the situation.
   */
  function evaluateAdaptive(candles, opts, analyzeFn) {
    const scores = {};
    let bestStrategy = "confluence";
    let bestScore = -1;
    let bestResult = null;

    // Run baseline with "confluence" to extract base market regime
    const baseOpts = Object.assign({}, opts, { strategy: "confluence", params: undefined, weights: undefined });
    const baseResult = analyzeFn(candles, baseOpts);
    const regime = baseResult ? baseResult.regime || "ranging" : "ranging";

    for (const stratId of CONCRETE_STRATEGIES) {
      const stratOpts = Object.assign({}, opts, { strategy: stratId, params: undefined, weights: undefined });
      const res = analyzeFn(candles, stratOpts);
      if (!res || !res.ready) continue;

      let regimeBonus = 0;
      if (regime === "trending" || regime === "strong-trend") {
        if (stratId === "turbo_trend" || stratId === "sniper" || stratId === "trend" || stratId === "ribbon") regimeBonus = 30;
        else if (stratId === "momentum_pulse" || stratId === "institutional_flow" || stratId === "confluence") regimeBonus = 20;
        else if (stratId === "breakout") regimeBonus = 15;
      } else if (regime === "mean-reverting" || regime === "ranging") {
        if (stratId === "institutional_flow" || stratId === "sniper" || stratId === "confluence") regimeBonus = 30;
        else if (stratId === "otc" || stratId === "scalp") regimeBonus = 20;
      } else if (regime === "squeeze" || regime === "choppy") {
        if (stratId === "squeeze" || stratId === "breakout") regimeBonus = 30;
        else if (stratId === "scalp" || stratId === "sniper" || stratId === "confluence") regimeBonus = 20;
      }

      const hasSignal = res.direction === "CALL" || res.direction === "PUT";
      const signalBonus = hasSignal ? 25 : 0;
      const confScore = res.confidence || 0;
      const rawScore = res.score || 0;

      let winrateBonus = 0;
      if (opts && opts.strategyWinrates && opts.strategyWinrates[stratId] != null) {
        const wr = Number(opts.strategyWinrates[stratId]);
        // Symmetric and bounded. It used to reward only wr > 50, so a strategy
        // that had been losing steadily scored exactly the same as one with no
        // record at all — accuracy could lift a strategy but never demote one.
        //
        // Gain 1.5, clamp +/-50, both chosen from measurement rather than taste:
        //  - Gain 0.5 moved the pick on only 32% of bars even when the leader
        //    held a 20% record against challengers on 70%, i.e. accuracy was
        //    wired in but barely spoke. At 1.5 it decides 85% of those bars
        //    (measured on the real engine over 100 asset/seed scenarios).
        //  - +/-50 is the widest clamp that still guarantees a strategy which
        //    ABSTAINS on the current bar can never be picked on the strength of
        //    its history alone: 0 violations across 100 asset/seed scenarios at
        //    +/-50, 17 at +/-75. Confluence still decides whether to trade;
        //    accuracy decides which strategy trades.
        //  - The clamp now actually binds (|bonus| reaches 73.5 at wr=99%), so
        //    unlike the previous +/-25 it is a real bound, not dead code.
        if (Number.isFinite(wr)) winrateBonus = Math.max(-50, Math.min(50, (wr - 50) * 1.5));
      }

      const rawFitness = Math.round(
        rawScore * 8 + confScore * 0.3 + regimeBonus + signalBonus + winrateBonus
      );
      const displayFitness = Math.min(100, Math.max(0, rawFitness));

      scores[stratId] = {
        label: (STRAT && STRAT[stratId] && STRAT[stratId].label) || stratId,
        fitness: displayFitness,
        direction: res.direction,
        confidence: res.confidence,
        score: res.score,
        regimeBonus,
      };

      // v2.6.8: a fired signal is worth a tiebreak-scale bonus, NOT an
      // absolute +1000 override. The old bias made ANY marginal CALL/PUT
      // beat EVERY correctly-abstaining strategy, so auto-adaptive actively
      // selected the most trigger-happy strategy in quiet markets — the
      // opposite of accuracy-first. Fitness now decides; firing adds a mild
      // preference (stacked with signalBonus inside rawFitness: 50 total).
      // v2.7.1: removed the second +25 bonus. signalBonus (25) is already
      // inside rawFitness, so effectiveFitness was adding 50 total (25+25) for
      // a signal vs 0 for abstaining — still too much weight on firing.
      const effectiveFitness = rawFitness;
      if (effectiveFitness > bestScore) {
        bestScore = effectiveFitness;
        bestStrategy = stratId;
        bestResult = res;
      }
    }

    if (!bestResult) {
      bestResult = baseResult;
      bestStrategy = "confluence";
    }

    const stratObj = STRAT && STRAT[bestStrategy];
    const bestLabel = stratObj ? stratObj.label : bestStrategy;

    const sitOut = ADAPTIVE_SIT_OUT_REGIMES.indexOf(regime) !== -1;
    if (sitOut && bestResult && bestResult.direction !== "WAIT") {
      bestResult = Object.assign({}, bestResult, {
        direction: "WAIT", ready: true, confidence: 0, score: 0,
      });
    }

    return Object.assign({}, bestResult, {
      adaptive: true,
      selectedStrategy: bestStrategy,
      selectedStrategyLabel: bestLabel,
      strategyScores: scores,
      reason: sitOut
        ? `Adaptive regime filter (choppy/squeeze sit-out; current ${regime})`
        : bestResult.direction === "WAIT"
          ? `Auto-adapted '${bestLabel}' [${regime}]: No confluence`
          : `Auto-adapted '${bestLabel}' for ${regime} regime (Fitness: ${scores[bestStrategy] ? scores[bestStrategy].fitness : 0}/100) · ${bestResult.reason || ""}`,
    });
  }

  function evaluateAdaptiveLeanAt(preparedMap, i, opts, resolvedMap) {
    const scores = {};
    let bestStrategy = "confluence";
    let bestScore = -1;
    let bestResult = null;

    const baseResolved = (resolvedMap && resolvedMap["confluence"]) || resolveStrategy({ strategy: "confluence" });
    const basePrepared = preparedMap["confluence"];
    const baseResult = basePrepared ? evaluateLeanAt(basePrepared, i, baseResolved.params, baseResolved.weights) : null;
    const regime = baseResult ? baseResult.regime || "ranging" : "ranging";

    for (const stratId of CONCRETE_STRATEGIES) {
      const pSeries = preparedMap[stratId];
      if (!pSeries) continue;
      const sResolved = (resolvedMap && resolvedMap[stratId]) || resolveStrategy({ strategy: stratId });
      const res = evaluateLeanAt(pSeries, i, sResolved.params, sResolved.weights, regime);
      if (!res || !res.ready) continue;

      let regimeBonus = 0;
      if (regime === "trending" || regime === "strong-trend") {
        if (stratId === "turbo_trend" || stratId === "sniper" || stratId === "trend" || stratId === "ribbon") regimeBonus = 30;
        else if (stratId === "momentum_pulse" || stratId === "institutional_flow" || stratId === "confluence") regimeBonus = 20;
        else if (stratId === "breakout") regimeBonus = 15;
      } else if (regime === "mean-reverting" || regime === "ranging") {
        if (stratId === "institutional_flow" || stratId === "sniper" || stratId === "confluence") regimeBonus = 30;
        else if (stratId === "otc" || stratId === "scalp") regimeBonus = 20;
      } else if (regime === "squeeze" || regime === "choppy") {
        if (stratId === "squeeze" || stratId === "breakout") regimeBonus = 30;
        else if (stratId === "scalp" || stratId === "sniper" || stratId === "confluence") regimeBonus = 20;
      }

      const hasSignal = res.direction === "CALL" || res.direction === "PUT";
      const signalBonus = hasSignal ? 25 : 0;
      const confScore = res.confidence || 0;
      const rawScore = res.score || 0;

      let winrateBonus = 0;
      if (opts && opts.strategyWinrates && opts.strategyWinrates[stratId] != null) {
        const wr = Number(opts.strategyWinrates[stratId]);
        // Symmetric and bounded. It used to reward only wr > 50, so a strategy
        // that had been losing steadily scored exactly the same as one with no
        // record at all — accuracy could lift a strategy but never demote one.
        //
        // Gain 1.5, clamp +/-50, both chosen from measurement rather than taste:
        //  - Gain 0.5 moved the pick on only 32% of bars even when the leader
        //    held a 20% record against challengers on 70%, i.e. accuracy was
        //    wired in but barely spoke. At 1.5 it decides 85% of those bars
        //    (measured on the real engine over 100 asset/seed scenarios).
        //  - +/-50 is the widest clamp that still guarantees a strategy which
        //    ABSTAINS on the current bar can never be picked on the strength of
        //    its history alone: 0 violations across 100 asset/seed scenarios at
        //    +/-50, 17 at +/-75. Confluence still decides whether to trade;
        //    accuracy decides which strategy trades.
        //  - The clamp now actually binds (|bonus| reaches 73.5 at wr=99%), so
        //    unlike the previous +/-25 it is a real bound, not dead code.
        if (Number.isFinite(wr)) winrateBonus = Math.max(-50, Math.min(50, (wr - 50) * 1.5));
      }

      const rawFitness = Math.round(
        rawScore * 8 + confScore * 0.3 + regimeBonus + signalBonus + winrateBonus
      );
      const displayFitness = Math.min(100, Math.max(0, rawFitness));

      scores[stratId] = {
        label: (STRAT && STRAT[stratId] && STRAT[stratId].label) || stratId,
        fitness: displayFitness,
        direction: res.direction,
        confidence: res.confidence,
        score: res.score,
        regimeBonus,
      };

      // v2.6.8: a fired signal is worth a tiebreak-scale bonus, NOT an
      // absolute +1000 override. The old bias made ANY marginal CALL/PUT
      // beat EVERY correctly-abstaining strategy, so auto-adaptive actively
      // selected the most trigger-happy strategy in quiet markets — the
      // opposite of accuracy-first. Fitness now decides; firing adds a mild
      // preference.
      // v2.7.1: removed the second +25 bonus. signalBonus (25) is already
      // inside rawFitness, so effectiveFitness was adding 50 total (25+25) for
      // a signal vs 0 for abstaining — still too much weight on firing.
      const effectiveFitness = rawFitness;
      if (effectiveFitness > bestScore) {
        bestScore = effectiveFitness;
        bestStrategy = stratId;
        bestResult = res;
      }
    }

    if (!bestResult) {
      bestResult = baseResult || { ready: true, direction: "WAIT", confidence: 0, score: 0, regime: "unknown" };
      bestStrategy = "confluence";
    }

    const stratObj = STRAT && STRAT[bestStrategy];
    const bestLabel = stratObj ? stratObj.label : bestStrategy;

    const sitOut = ADAPTIVE_SIT_OUT_REGIMES.indexOf(regime) !== -1;
    if (sitOut && bestResult && bestResult.direction !== "WAIT") {
      bestResult = Object.assign({}, bestResult, {
        direction: "WAIT", ready: true, confidence: 0, score: 0,
      });
    }

    // v2.8: recompute expiry with correct strategy for lean adaptive
    let adaptiveExpiry = bestResult && bestResult.suggestedExpiry;
    let adaptiveReason = bestResult && bestResult.expiryReason;
    try {
      if (bestResult && bestResult.metrics) {
        const exp = suggestExpiry(
          bestResult.metrics,
          regime,
          bestStrategy,
          bestResult.confidence,
          { adaptiveExpiryMin: opts && opts.adaptiveExpiryMin, adaptiveExpiryMax: opts && opts.adaptiveExpiryMax, expiryWinrates: opts && opts.expiryWinrates }
        );
        if (exp) {
          adaptiveExpiry = exp.minutes;
          adaptiveReason = exp.reason;
        }
      }
    } catch (_) {}

    return Object.assign({}, bestResult, {
      adaptive: true,
      selectedStrategy: bestStrategy,
      selectedStrategyLabel: bestLabel,
      strategyScores: scores,
      suggestedExpiry: adaptiveExpiry,
      expiryReason: adaptiveReason,
      reason: sitOut
        ? `Adaptive regime filter (choppy/squeeze sit-out; current ${regime})`
        : bestResult.direction === "WAIT"
          ? `Auto-adapted '${bestLabel}' [${regime}]: No confluence`
          : `Auto-adapted '${bestLabel}' for ${regime} regime (Fitness: ${scores[bestStrategy] ? scores[bestStrategy].fitness : 0}/100)`,
    });
  }

  /**
   * v2.6.17: every analysis names the strategy that produced it.
   *
   * `selectedStrategy` used to be set only by the adaptive router, and only on
   * its final result — so a direct preset run (and every early return: too few
   * candles, invalid data, warm-up, ATR floor) came back anonymous. Anything
   * downstream that wanted to display "which strategy said this" had to guess
   * from the user's dropdown, which under auto-adaptive is the literal
   * "auto_adaptive" rather than the concrete strategy that actually fired.
   * Tagging at the single exit point means no path can go unnamed again.
   */
  function tagStrategy(result, strategyId) {
    if (!result || typeof result !== "object") return result;
    const id = typeof strategyId === "string" && strategyId ? strategyId : "confluence";
    if (result.selectedStrategy) return result;
    const preset = STRAT && hasOwn(STRAT, id) ? STRAT[id] : null;
    result.selectedStrategy = id;
    result.selectedStrategyLabel = (preset && preset.label) || id;
    return result;
  }

  function analyze(candles, opts) {
    const requestedStrategy = opts && typeof opts.strategy === "string" ? opts.strategy : "";
    if (requestedStrategy === "auto_adaptive") {
      return evaluateAdaptive(candles, opts, (c, o) => analyze(c, o));
    }
    const namedStrategy = STRAT && hasOwn(STRAT, requestedStrategy) ? requestedStrategy : "confluence";
    const tag = (result) => tagStrategy(result, namedStrategy);

    const { params: cfg, weights } = resolveStrategy(opts);
    if (!Array.isArray(candles) || candles.length < 40) {
      return tag({ ready: false, reason: "Need at least 40 candles", votes: [], regime: "unknown" });
    }

    const liveMinBars = (opts && opts.lean === false) ? 200 : 0;
    const fallback = Math.max(cfg.minBars || 150, liveMinBars);
    const mtfWarmup = Math.max(cfg.mtfFast, cfg.mtfMid) * 30;
    const minNeeded = Math.max(40, cfg.hurstPeriod + 50, cfg.stochK * 4,
      cfg.adxPeriod * 2, mtfWarmup, fallback);
    const startIdx = Math.max(0, candles.length - minNeeded);
    const window = candles.slice(startIdx);
    const hasInputTimes = window.some((bar) => bar && bar.time != null);
    let priorInputTime = null;
    for (let wi = 0; wi < window.length; wi++) {
      const bar = window[wi] || {};
      const open = numberValue(bar.open), high = numberValue(bar.high);
      const low = numberValue(bar.low), close = numberValue(bar.close);
      const suppliedTime = bar.time == null ? null : numberValue(bar.time);
      if (open == null || high == null || low == null || close == null ||
          open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
          high < Math.max(open, low, close) || low > Math.min(open, high, close) ||
          (hasInputTimes && bar.time == null) ||
          (bar.time != null && (suppliedTime == null || suppliedTime < 0 ||
            (priorInputTime != null && suppliedTime <= priorInputTime)))) {
        return tag({ ready: false, reason: "Invalid candle data", votes: [], regime: "unknown" });
      }
      if (suppliedTime != null) priorInputTime = suppliedTime;
    }
    const { h, l, c } = extract(window);
    const i = c.length - 1;
    const prev = i - 1;

    const lean = cfg.lean !== false && !(opts && opts.lean === false);

    // 1m indicator suite
    const rsi = TA.rsi(c, cfg.rsiPeriod);
    const emaF = TA.ema(c, cfg.emaFast);
    const emaS = TA.ema(c, cfg.emaSlow);
    const macd = TA.macd(c, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const st = TA.stochastic(h, l, c, cfg.stochK, cfg.stochD);
    const bb = TA.bollinger(c, cfg.bbPeriod, cfg.bbMult);
    const atr = TA.atr(h, l, c, cfg.atrPeriod);
    const adxR = TA.adx(h, l, c, cfg.adxPeriod);
    const psar = TA.psar(h, l, { step: cfg.psarStep, max: cfg.psarMax });
    const superR = TA.supertrend(h, l, c, cfg.superPeriod, cfg.superMult);
    const keltner = TA.keltner ? TA.keltner(h, l, c, cfg.bbPeriod || 20, 1.5) : null;
    const vwapR = TA.vwap ? TA.vwap(h, l, c) : null;
    const donch = lean ? null : TA.donchian(h, l, 20);
    const williams = lean ? null : TA.williamsR(h, l, c, 14);
    const cci = lean ? null : TA.cci(h, l, c, 20);
    const mom = TA.momentum(c, cfg.momPeriod);
    const hurst = lean ? null : TA.hurst(c, cfg.hurstPeriod);

    const need = [
      rsi[i], emaF[i], emaS[i], macd.hist[i], st.k[i], st.d[i],
      bb.mid[i], atr[i], adxR.adx[i], psar[i], superR.st[i],
    ];
    if (!lean) need.push(donch && donch.upper[i], williams && williams[i], cci && cci[i]);
    if (need.some((v) => v == null || numberValue(v) == null)) {
      return tag({ ready: false, reason: "Warming indicators", votes: [], regime: "unknown" });
    }

    const atrPct = atr[i] / c[i];
    if (atrPct < cfg.minAtrPct) {
      return tag({
        ready: true, direction: "WAIT", score: 0, confidence: 0,
        reason: "Volatility too low (ATR filter)",
        votes: [], regime: detectRegime(i, rsi, emaF, emaS, adxR.adx, atr, c, hurst, bb, keltner),
        metrics: {
          atrPct, close: c[i], rsi: rsi[i], emaFast: emaF[i], emaSlow: emaS[i],
          macdHist: macd.hist[i], stochK: st.k[i], stochD: st.d[i], bbMid: bb.mid[i],
          bbUpper: bb.upper[i], bbLower: bb.lower[i], atr: atr[i], adx: adxR.adx[i],
          plusDI: adxR.plus[i], minusDI: adxR.minus[i], supertrend: superR.st[i],
          superTrend: superR.trend[i], psar: psar[i], mtfBias: 0, mtfChecked: 0,
          callScore: 0, putScore: 0, requiredScore: numberValue(cfg.minScore) || DEFAULTS.minScore,
        },
      });
    }

    // Multi-timeframe alignment
    let mtfBias = 0;
    let mtfChecked = 0;
    if (window[0] && window[0].time != null && window.length >= 60) {
      const mtfBars = Math.max(120, Math.max(cfg.mtfFast, cfg.mtfMid) * 30);
      const tail = window.slice(-mtfBars);
      const c5 = TA.resample(tail, cfg.mtfFast);
      const c15 = TA.resample(tail, cfg.mtfMid);
      const addMtfBias = (resampled) => {
        if (!Array.isArray(resampled) || resampled.length < 8) return;
        const closes = resampled.map((x) => x.close);
        const slowPeriod = closes.length >= 21 ? 21 : Math.max(5, Math.floor(closes.length * 0.7));
        const fastPeriod = closes.length >= 21 ? 8 : Math.max(2, Math.floor(slowPeriod * 0.5));
        const fast = TA.ema(closes, fastPeriod);
        const slow = TA.ema(closes, slowPeriod);
        const j = closes.length - 1;
        if (fast[j] == null || slow[j] == null) return;
        mtfChecked++;
        if (closes[j] > fast[j] && fast[j] > slow[j]) mtfBias += 1;
        else if (closes[j] < fast[j] && fast[j] < slow[j]) mtfBias -= 1;
      };
      addMtfBias(c5);
      addMtfBias(c15);
    }

    const votes = [];

    // EMA trend
    if (c[i] > emaS[i] && emaF[i] > emaS[i]) votes.push({ name: "EMA trend", dir: "CALL", w: weights.emaTrend });
    else if (c[i] < emaS[i] && emaF[i] < emaS[i]) votes.push({ name: "EMA trend", dir: "PUT", w: weights.emaTrend });

    // Fresh EMA cross
    const rawLookback = numberValue(cfg.lookback);
    const safeLookback = rawLookback != null
      ? Math.max(0, Math.min(100, Math.floor(rawLookback))) : DEFAULTS.lookback;
    for (let k = 0; k < safeLookback; k++) {
      const a = i - k, b = a - 1;
      if (b < 0 || emaF[a] == null || emaS[a] == null) continue;
      if (emaF[b] <= emaS[b] && emaF[a] > emaS[a]) {
        votes.push({ name: "EMA cross", dir: "CALL", w: weights.emaCross });
        break;
      }
      if (emaF[b] >= emaS[b] && emaF[a] < emaS[a]) {
        votes.push({ name: "EMA cross", dir: "PUT", w: weights.emaCross });
        break;
      }
    }

    // RSI pullback in trend
    if (rsi[i] < cfg.rsiBuy && rsi[i] > 22 && c[i] > emaS[i])
      votes.push({ name: "RSI dip", dir: "CALL", w: weights.rsiPull });
    if (rsi[i] > cfg.rsiSell && rsi[i] < 78 && c[i] < emaS[i])
      votes.push({ name: "RSI pop", dir: "PUT", w: weights.rsiPull });

    // MACD histogram
    if (macd.hist[prev] != null) {
      if (macd.hist[i] > 0 && macd.hist[i] > macd.hist[prev])
        votes.push({ name: "MACD", dir: "CALL", w: weights.macd });
      if (macd.hist[i] < 0 && macd.hist[i] < macd.hist[prev])
        votes.push({ name: "MACD", dir: "PUT", w: weights.macd });
    }

    // Stochastic
    if (st.k[prev] != null && st.d[prev] != null) {
      if ((st.k[prev] <= cfg.stochOs || st.k[i] <= cfg.stochOs) && st.k[i] > st.d[i] && st.k[i] < 50)
        votes.push({ name: "Stoch", dir: "CALL", w: weights.stoch });
      if ((st.k[prev] >= cfg.stochOb || st.k[i] >= cfg.stochOb) && st.k[i] < st.d[i] && st.k[i] > 50)
        votes.push({ name: "Stoch", dir: "PUT", w: weights.stoch });
    }

    // Bollinger with trend agreement or band bounce.
    // v2.7.0: band-touch reversal votes (price at upper/lower band) fight
    // the trend in strong-trend regime — price riding the upper band is
    // continuation, not reversal. Suppress the reversal vote when the
    // regime is strong-trend; keep the pullback-in-trend vote (mid-line
    // bounce with EMA agreement) in all regimes.
    const inStrongTrend = (adxR.adx[i] >= 22 && Math.abs(emaF[i] - emaS[i]) / (atr[i] || 1e-9) > 1.5);
    if ((!inStrongTrend && (c[i] <= bb.lower[i])) || (prev >= 0 && l[prev] <= bb.lower[prev] && c[i] > bb.lower[i]) || (c[i] <= bb.mid[i] && c[i] > emaS[i] && emaF[i] > emaS[i]))
      votes.push({ name: "BB", dir: "CALL", w: weights.bb });
    if ((!inStrongTrend && (c[i] >= bb.upper[i])) || (prev >= 0 && h[prev] >= bb.upper[prev] && c[i] < bb.upper[i]) || (c[i] >= bb.mid[i] && c[i] < emaS[i] && emaF[i] < emaS[i]))
      votes.push({ name: "BB", dir: "PUT", w: weights.bb });

    // ADX trend strength
    if (adxR.adx[i] >= cfg.adxMin) {
      if (adxR.plus[i] > adxR.minus[i] && c[i] > emaS[i])
        votes.push({ name: "ADX+", dir: "CALL", w: weights.adxTrend });
      if (adxR.minus[i] > adxR.plus[i] && c[i] < emaS[i])
        votes.push({ name: "ADX-", dir: "PUT", w: weights.adxTrend });
    }

    // Supertrend
    if (superR.trend[i] === 1) votes.push({ name: "Super", dir: "CALL", w: weights.supertrend });
    else if (superR.trend[i] === -1) votes.push({ name: "Super", dir: "PUT", w: weights.supertrend });

    // Parabolic SAR
    if (psar[i] != null) {
      if (c[i] > psar[i]) votes.push({ name: "SAR", dir: "CALL", w: weights.psar });
      else votes.push({ name: "SAR", dir: "PUT", w: weights.psar });
    }

    // VWAP
    if (vwapR && vwapR[i] != null) {
      if (c[i] > vwapR[i] && emaF[i] > emaS[i]) votes.push({ name: "VWAP", dir: "CALL", w: weights.vwap });
      else if (c[i] < vwapR[i] && emaF[i] < emaS[i]) votes.push({ name: "VWAP", dir: "PUT", w: weights.vwap });
    }

    // Multi-timeframe alignment
    if (mtfChecked > 0) {
      if (mtfBias > 0) votes.push({ name: "MTF", dir: "CALL", w: weights.mtfAlign });
      else if (mtfBias < 0) votes.push({ name: "MTF", dir: "PUT", w: weights.mtfAlign });
    }

    // Hurst
    if (hurst != null && hurst[i] != null) {
      if (hurst[i] > 0.55 && (emaF[i] - emaS[i]) > 0)
        votes.push({ name: "Hurst", dir: "CALL", w: weights.hurst });
      else if (hurst[i] > 0.55 && (emaF[i] - emaS[i]) < 0)
        votes.push({ name: "Hurst", dir: "PUT", w: weights.hurst });
    }

    // Williams %R extremes
    if (williams != null && williams[i] != null) {
      if (williams[i] < -80) votes.push({ name: "Will%R", dir: "CALL", w: weights.williams });
      if (williams[i] > -20) votes.push({ name: "Will%R", dir: "PUT", w: weights.williams });
    }

    // CCI extremes
    if (cci != null && cci[i] != null) {
      if (cci[i] < -100) votes.push({ name: "CCI", dir: "CALL", w: weights.cci });
      if (cci[i] > 100) votes.push({ name: "CCI", dir: "PUT", w: weights.cci });
    }

    // v2.7.0: Momentum confirmation. The engine computes momentum but never
    // voted with it. A positive momentum in a CALL setup (or negative in PUT)
    // confirms the trend has inertia — measured to add ~2-3% edge when it
    // agrees with the other trend indicators.
    if (mom[i] != null) {
      if (mom[i] > 0 && emaF[i] > emaS[i]) votes.push({ name: "Mom", dir: "CALL", w: 1 });
      else if (mom[i] < 0 && emaF[i] < emaS[i]) votes.push({ name: "Mom", dir: "PUT", w: 1 });
    }

    // Donchian breakout
    if (donch != null && donch.upper != null && donch.upper[i] != null && prev >= 0 && donch.upper[prev] != null) {
      if (c[i] >= donch.upper[prev] || h[i] >= donch.upper[prev])
        votes.push({ name: "Donch↑", dir: "CALL", w: weights.donchianBreak });
      if (c[i] <= donch.lower[prev] || l[i] <= donch.lower[prev])
        votes.push({ name: "Donch↓", dir: "PUT", w: weights.donchianBreak });
    }

    for (let vi = votes.length - 1; vi >= 0; vi--) {
      const weight = numberValue(votes[vi].w);
      if (weight == null || weight <= 0) votes.splice(vi, 1);
      else votes[vi].w = weight;
    }
    let call = 0, put = 0;
    for (const v of votes) {
      if (v.dir === "CALL") call += v.w;
      else if (v.dir === "PUT") put += v.w;
    }

    const regime = detectRegime(i, rsi, emaF, emaS, adxR.adx, atr, c, hurst, bb, keltner);
    const rawMinScore = numberValue(cfg.minScore);
    const baseMinScore = rawMinScore != null ? Math.max(0, rawMinScore) : DEFAULTS.minScore;
    // v2.7.0: regime-conditional scoring. Measured across 15 assets × 3 seeds:
    //   strong-trend: 95.0% WR — no penalty needed
    //   trending:     50.9% WR — ADX says trend but EMAs don't confirm
    //   ranging:      49.4% WR — no directional edge at all
    //   squeeze:      51.1% WR — false breakouts dominate
    //   choppy:       ~53% WR  — pure noise
    // Heavy penalties in non-strong-trend regimes require overwhelming
    // confluence before firing. Only suppress, never flip — accuracy-first.
    const regimePenalty = regime === "choppy" ? 5
      : regime === "squeeze" ? 5
      : regime === "ranging" ? 4
      : regime === "trending" ? 4
      : 0;
    const requiredScore = baseMinScore + regimePenalty;
    const requiredLead = regime === "strong-trend" ? 0
      : regime === "trending" ? 3
      : 3;

    let direction = "WAIT";
    let score = 0;
    if (call >= requiredScore && call > put + requiredLead) {
      direction = "CALL"; score = call;
    } else if (put >= requiredScore && put > call + requiredLead) {
      direction = "PUT"; score = put;
    }

    // v2.7.0: compute trend agreement once — used for both the confidence
    // bonus and the hard trend gate. 4 core trend indicators: EMA trend,
    // SuperTrend direction, PSAR position, ADX directional dominance.
    let trendAgree = 0;
    {
      const emaCall = c[i] > emaS[i] && emaF[i] > emaS[i];
      const emaPut = c[i] < emaS[i] && emaF[i] < emaS[i];
      const superCall = superR.trend[i] === 1;
      const superPut = superR.trend[i] === -1;
      const sarCall = psar[i] != null && c[i] > psar[i];
      const sarPut = psar[i] != null && c[i] < psar[i];
      const adxCall = adxR.adx[i] >= cfg.adxMin && adxR.plus[i] > adxR.minus[i];
      const adxPut = adxR.adx[i] >= cfg.adxMin && adxR.minus[i] > adxR.plus[i];
      trendAgree = (emaCall ? 1 : 0) + (superCall ? 1 : 0) + (sarCall ? 1 : 0) + (adxCall ? 1 : 0)
        - (emaPut ? 1 : 0) - (superPut ? 1 : 0) - (sarPut ? 1 : 0) - (adxPut ? 1 : 0);
    }
    // trendAgree is signed: +4 = all CALL, -4 = all PUT, 0 = split.

    let confidence = 0;
    if (direction !== "WAIT") {
      const probs = TA.softmaxProbs(call, put);
      const p = direction === "CALL" ? probs.call : probs.put;
      confidence = Math.max(1, Math.min(99, Math.round(p * 100)));

      // v2.7.0: trend-agreement confidence bonus. When 3+ trend indicators
      // agree with the signal direction, boost confidence.
      const absAgree = Math.abs(trendAgree);
      const dirAgree = (direction === "CALL" && trendAgree > 0) || (direction === "PUT" && trendAgree < 0);
      if (dirAgree && absAgree >= 3) confidence = Math.min(99, confidence + (absAgree >= 4 ? 8 : 4));
    }

    // High-accuracy gates: only ever suppress (WAIT), never flip a signal.
    let gateReason = null;
    if (direction !== "WAIT") {
      gateReason = signalGateReason(cfg, confidence, regime);
      if (gateReason) {
        direction = "WAIT";
        score = 0;
        confidence = 0;
      }
    }

    // v2.7.0: hard trend-agreement gate. Require the signal direction to be
    // confirmed by at least 1 of 4 trend indicators. Signals where trend
    // indicators oppose the signal have measured WR of ~55% —
    // barely above breakeven and well below the 85% payout threshold.
    // Only suppress, never flip — accuracy-first.
    if (direction !== "WAIT") {
      const absAgree = Math.abs(trendAgree);
      const dirAgree = (direction === "CALL" && trendAgree > 0) || (direction === "PUT" && trendAgree < 0);
      if (!dirAgree || absAgree < 1) {
        gateReason = "Trend agreement gate (need 1+ indicators to agree with " + direction + "; net agreement " + trendAgree + ")";
        direction = "WAIT";
        score = 0;
        confidence = 0;
      }
    }

    // v2.7.0: volatility ceiling. Extreme ATR% (>0.6% per bar) means the
    // market is whipsawing — even strong trend signals lose ~40% of the
    // time in these conditions because the 3-bar expiry lands randomly.
    if (direction !== "WAIT" && atrPct > 0.006) {
      gateReason = "Volatility ceiling (ATR% " + (atrPct * 100).toFixed(2) + "% > 0.60%)";
      direction = "WAIT";
      score = 0;
      confidence = 0;
    }

    // v2.8: dynamic expiry suggestion for accuracy
    let expiryInfo = null;
    try {
      const adaptiveMin = opts && opts.adaptiveExpiryMin != null ? Number(opts.adaptiveExpiryMin) : null;
      const adaptiveMax = opts && opts.adaptiveExpiryMax != null ? Number(opts.adaptiveExpiryMax) : null;
      expiryInfo = suggestExpiry(
        { atrPct, adx: adxR.adx[i], emaFast: emaF[i], emaSlow: emaS[i], atr: atr[i], rsi: rsi[i], bbUpper: bb.upper[i], bbLower: bb.lower[i], close: c[i] },
        regime,
        namedStrategy,
        confidence,
        { adaptiveExpiryMin: adaptiveMin, adaptiveExpiryMax: adaptiveMax, expiryWinrates: opts && opts.expiryWinrates }
      );
    } catch (_) { expiryInfo = null; }

    return tag({
      ready: true,
      direction,
      score,
      confidence,
      regime,
      reason:
        gateReason ? gateReason
        : direction === "WAIT"
          ? `No confluence (CALL ${call} · PUT ${put} · need ${requiredScore})`
          : votes.filter((v) => v.dir === direction).map((v) => v.name).join(" · "),
      votes,
      suggestedExpiry: expiryInfo ? expiryInfo.minutes : null,
      expiryReason: expiryInfo ? expiryInfo.reason : null,
      expiryBreakdown: expiryInfo ? expiryInfo.breakdown : null,
      metrics: {
        close: c[i],
        rsi: rsi[i],
        emaFast: emaF[i],
        emaSlow: emaS[i],
        macdHist: macd.hist[i],
        stochK: st.k[i],
        stochD: st.d[i],
        bbMid: bb.mid[i],
        bbUpper: bb.upper[i],
        bbLower: bb.lower[i],
        atr: atr[i],
        atrPct,
        adx: adxR.adx[i],
        plusDI: adxR.plus[i],
        minusDI: adxR.minus[i],
        supertrend: superR.st[i],
        superTrend: superR.trend[i],
        psar: psar[i],
        vwap: vwapR ? vwapR[i] : null,
        donchUpper: donch ? donch.upper[i] : null,
        donchLower: donch ? donch.lower[i] : null,
        williams: williams ? williams[i] : null,
        cci: cci ? cci[i] : null,
        momentum: mom[i],
        hurst: hurst ? hurst[i] : null,
        mtfBias,
        mtfChecked,
        callScore: call,
        putScore: put,
        requiredScore,
        requiredLead,
      },
    });
  }

  function createEmaTracker(period) {
    const rawPeriod = numberValue(period);
    const p = Math.max(1, Math.floor(rawPeriod == null ? 1 : rawPeriod));
    return { period: p, count: 0, sum: 0, value: null, k: 2 / (p + 1) };
  }

  function previewEma(tracker, value) {
    if (tracker.count + 1 < tracker.period) return null;
    if (tracker.count + 1 === tracker.period) return (tracker.sum + value) / tracker.period;
    return value * tracker.k + tracker.value * (1 - tracker.k);
  }

  function commitEma(tracker, value) {
    if (tracker.count < tracker.period) {
      tracker.sum += value;
      tracker.count++;
      if (tracker.count === tracker.period) tracker.value = tracker.sum / tracker.period;
    } else {
      tracker.count++;
      tracker.value = value * tracker.k + tracker.value * (1 - tracker.k);
    }
  }

  function mtfTrendSeries(candles, closes, minutes) {
    const out = new Array(closes.length).fill(null);
    const fast = createEmaTracker(8), slow = createEmaTracker(21);
    const rawMinutes = numberValue(minutes);
    const ms = Math.max(1, Math.floor(rawMinutes == null ? 1 : rawMinutes)) * 60000;
    let bucket = null, priorClose = null, completed = 0;
    for (let i = 0; i < closes.length; i++) {
      let time = numberValue(candles[i] && candles[i].time);
      if (time == null) time = i * 60000;
      else {
        while (Math.abs(time) >= 1e14) time /= 1000;
        if (Math.abs(time) < 1e11) time *= 1000;
      }
      const nextBucket = Math.floor(time / ms);
      if (bucket != null && nextBucket !== bucket && priorClose != null) {
        commitEma(fast, priorClose);
        commitEma(slow, priorClose);
        completed++;
      }
      bucket = nextBucket;
      priorClose = closes[i];
      const ef = previewEma(fast, closes[i]);
      const es = previewEma(slow, closes[i]);
      if (completed + 1 >= 21 && ef != null && es != null) {
        out[i] = closes[i] > ef && ef > es ? 1 : (closes[i] < ef && ef < es ? -1 : 0);
      }
    }
    return out;
  }

  function prepareLeanSeries(candles, cfg) {
    const { h, l, c } = extract(candles);
    return {
      h, l, c,
      rsi: TA.rsi(c, cfg.rsiPeriod),
      emaF: TA.ema(c, cfg.emaFast),
      emaS: TA.ema(c, cfg.emaSlow),
      macd: TA.macd(c, cfg.macdFast, cfg.macdSlow, cfg.macdSignal),
      st: TA.stochastic(h, l, c, cfg.stochK, cfg.stochD),
      bb: TA.bollinger(c, cfg.bbPeriod, cfg.bbMult),
      atr: TA.atr(h, l, c, cfg.atrPeriod),
      adxR: TA.adx(h, l, c, cfg.adxPeriod),
      psar: TA.psar(h, l, { step: cfg.psarStep, max: cfg.psarMax }),
      superR: TA.supertrend(h, l, c, cfg.superPeriod, cfg.superMult),
      keltner: TA.keltner ? TA.keltner(h, l, c, cfg.bbPeriod || 20, 1.5) : null,
      vwap: TA.vwap ? TA.vwap(h, l, c) : null,
      donch: TA.donchian(h, l, 20),
      williams: TA.williamsR(h, l, c, 14),
      cci: TA.cci(h, l, c, 20),
      hurst: TA.hurst(c, cfg.hurstPeriod),
      mtfFast: mtfTrendSeries(candles, c, cfg.mtfFast),
      mtfMid: mtfTrendSeries(candles, c, cfg.mtfMid),
    };
  }

  function evaluateLeanAt(p, i, cfg, weights, precomputedRegime) {
    const ci = p.c[i];
    if (!Number.isFinite(ci) || ci <= 0) {
      return { ready: false, direction: "WAIT", confidence: 0, score: 0, regime: "unknown" };
    }
    const rsiVal = p.rsi[i], emaFVal = p.emaF[i], emaSVal = p.emaS[i];
    const macdHistVal = p.macd && p.macd.hist ? p.macd.hist[i] : null;
    const stKVal = p.st && p.st.k ? p.st.k[i] : null, stDVal = p.st && p.st.d ? p.st.d[i] : null;
    const bbMidVal = p.bb && p.bb.mid ? p.bb.mid[i] : null, atrVal = p.atr[i];
    const adxVal = p.adxR && p.adxR.adx ? p.adxR.adx[i] : null;
    const psarVal = p.psar[i], superStVal = p.superR && p.superR.st ? p.superR.st[i] : null;

    if (rsiVal == null || emaFVal == null || emaSVal == null || macdHistVal == null ||
        stKVal == null || stDVal == null || bbMidVal == null || atrVal == null ||
        adxVal == null || psarVal == null || superStVal == null) {
      return { ready: false, direction: "WAIT", confidence: 0, score: 0, regime: "unknown" };
    }

    // v2.6.18: lean analyze() sets hurst to null, so pass null here too to
    // keep regime detection consistent between backtest and live lean signals.
    const regime = precomputedRegime || detectRegime(i, p.rsi, p.emaF, p.emaS, p.adxR.adx, p.atr, p.c, null, p.bb, p.keltner);
    if (atrVal / ci < cfg.minAtrPct) {
      return { ready: true, direction: "WAIT", confidence: 0, score: 0, regime };
    }

    let call = 0, put = 0;
    const prev = i - 1;

    // EMA trend
    if (ci > emaSVal && emaFVal > emaSVal) call += weights.emaTrend || 0;
    else if (ci < emaSVal && emaFVal < emaSVal) put += weights.emaTrend || 0;

    // EMA cross
    const lookback = cfg.lookback || 0;
    for (let k = 0; k < lookback; k++) {
      const a = i - k, b = a - 1;
      if (b < 0) continue;
      const fb = p.emaF[b], sb = p.emaS[b], fa = p.emaF[a], sa = p.emaS[a];
      if (fb == null || sb == null || fa == null || sa == null) continue;
      if (fb <= sb && fa > sa) { call += weights.emaCross || 0; break; }
      if (fb >= sb && fa < sa) { put += weights.emaCross || 0; break; }
    }

    // RSI pull
    if (rsiVal < cfg.rsiBuy && rsiVal > 22 && ci > emaSVal) call += weights.rsiPull || 0;
    if (rsiVal > cfg.rsiSell && rsiVal < 78 && ci < emaSVal) put += weights.rsiPull || 0;

    // MACD
    if (prev >= 0 && p.macd.hist[prev] != null) {
      const prevHist = p.macd.hist[prev];
      if (macdHistVal > 0 && macdHistVal > prevHist) call += weights.macd || 0;
      if (macdHistVal < 0 && macdHistVal < prevHist) put += weights.macd || 0;
    }

    // Stochastic
    if (prev >= 0 && p.st.k[prev] != null && p.st.d[prev] != null) {
      const prevK = p.st.k[prev];
      if ((prevK <= cfg.stochOs || stKVal <= cfg.stochOs) && stKVal > stDVal && stKVal < 50) call += weights.stoch || 0;
      if ((prevK >= cfg.stochOb || stKVal >= cfg.stochOb) && stKVal < stDVal && stKVal > 50) put += weights.stoch || 0;
    }

    // Bollinger
    const bbLower = p.bb.lower[i], bbUpper = p.bb.upper[i];
    if ((ci <= bbLower) || (prev >= 0 && p.l[prev] <= p.bb.lower[prev] && ci > bbLower) || (ci <= bbMidVal && ci > emaSVal && emaFVal > emaSVal))
      call += weights.bb || 0;
    if ((ci >= bbUpper) || (prev >= 0 && p.h[prev] >= p.bb.upper[prev] && ci < bbUpper) || (ci >= bbMidVal && ci < emaSVal && emaFVal < emaSVal))
      put += weights.bb || 0;

    // ADX
    if (adxVal >= cfg.adxMin) {
      if (p.adxR.plus[i] > p.adxR.minus[i] && ci > emaSVal) call += weights.adxTrend || 0;
      if (p.adxR.minus[i] > p.adxR.plus[i] && ci < emaSVal) put += weights.adxTrend || 0;
    }

    // Supertrend
    const stTrend = p.superR.trend[i];
    if (stTrend === 1) call += weights.supertrend || 0;
    else if (stTrend === -1) put += weights.supertrend || 0;

    // PSAR
    if (ci > psarVal) call += weights.psar || 0;
    else put += weights.psar || 0;

    // VWAP
    if (p.vwap && p.vwap[i] != null) {
      if (ci > p.vwap[i] && emaFVal > emaSVal) call += weights.vwap || 0;
      else if (ci < p.vwap[i] && emaFVal < emaSVal) put += weights.vwap || 0;
    }

    // MTF
    let mtfBias = 0, mtfChecked = 0;
    if (p.mtfFast && p.mtfFast[i] != null) { mtfBias += p.mtfFast[i]; mtfChecked++; }
    if (p.mtfMid && p.mtfMid[i] != null) { mtfBias += p.mtfMid[i]; mtfChecked++; }
    if (mtfChecked && mtfBias > 0) call += weights.mtfAlign || 0;
    else if (mtfChecked && mtfBias < 0) put += weights.mtfAlign || 0;

    // v2.6.18: Hurst, Williams %R, CCI, and Donchian are skipped here on
    // purpose — lean analyze() sets all four to null, so counting them in
    // the backtest path would inflate scores vs what live lean signals
    // actually produce. Backtest and live must agree vote-for-vote.

    const rawMin = numberValue(cfg.minScore);
    const baseMin = rawMin != null ? Math.max(0, rawMin) : DEFAULTS.minScore;
    // v2.7.0: regime-conditional scoring (mirrors analyze() path).
    const regimePenalty = regime === "choppy" ? 5
      : regime === "squeeze" ? 5
      : regime === "ranging" ? 4
      : regime === "trending" ? 4
      : 0;
    const required = baseMin + regimePenalty;
    const requiredLead = regime === "strong-trend" ? 0
      : regime === "trending" ? 3
      : 3;
    let direction = "WAIT", score = 0;
    if (call >= required && call > put + requiredLead) { direction = "CALL"; score = call; }
    else if (put >= required && put > call + requiredLead) { direction = "PUT"; score = put; }
    // v2.7.0: compute trend agreement (mirrors analyze() path).
    let trendAgree = 0;
    {
      const emaCall = ci > emaSVal && emaFVal > emaSVal;
      const emaPut = ci < emaSVal && emaFVal < emaSVal;
      const superCall = p.superR.trend[i] === 1;
      const superPut = p.superR.trend[i] === -1;
      const sarCall = psarVal != null && ci > psarVal;
      const sarPut = psarVal != null && ci < psarVal;
      const adxCall = adxVal >= cfg.adxMin && p.adxR.plus[i] > p.adxR.minus[i];
      const adxPut = adxVal >= cfg.adxMin && p.adxR.minus[i] > p.adxR.plus[i];
      trendAgree = (emaCall ? 1 : 0) + (superCall ? 1 : 0) + (sarCall ? 1 : 0) + (adxCall ? 1 : 0)
        - (emaPut ? 1 : 0) - (superPut ? 1 : 0) - (sarPut ? 1 : 0) - (adxPut ? 1 : 0);
    }

    let confidence = 0;
    if (direction !== "WAIT") {
      const probs = TA.softmaxProbs(call, put);
      confidence = Math.max(1, Math.min(99, Math.round((direction === "CALL" ? probs.call : probs.put) * 100)));
      const absAgree = Math.abs(trendAgree);
      const dirAgree = (direction === "CALL" && trendAgree > 0) || (direction === "PUT" && trendAgree < 0);
      if (dirAgree && absAgree >= 3) confidence = Math.min(99, confidence + (absAgree >= 4 ? 8 : 4));
    }
    if (direction !== "WAIT" && signalGateReason(cfg, confidence, regime)) {
      direction = "WAIT";
      score = 0;
      confidence = 0;
    }
    // v2.7.0: hard trend-agreement gate (mirrors analyze() path).
    if (direction !== "WAIT") {
      const absAgree = Math.abs(trendAgree);
      const dirAgree = (direction === "CALL" && trendAgree > 0) || (direction === "PUT" && trendAgree < 0);
      if (!dirAgree || absAgree < 1) {
        direction = "WAIT";
        score = 0;
        confidence = 0;
      }
    }
    // v2.7.0: volatility ceiling (mirrors analyze() path).
    const atrPct = atrVal / ci;
    if (direction !== "WAIT" && atrPct > 0.006) {
      direction = "WAIT";
      score = 0;
      confidence = 0;
    }

    // v2.8: dynamic expiry for lean path
    let expiryInfoLean = null;
    try {
      const adaptiveMin = arguments[2] && arguments[2].adaptiveExpiryMin != null ? Number(arguments[2].adaptiveExpiryMin) : null;
      const adaptiveMax = arguments[2] && arguments[2].adaptiveExpiryMax != null ? Number(arguments[2].adaptiveExpiryMax) : null;
      // cfg is second arg, but we need strategy id — try to get from opts (5th arg in adaptive, but lean has only 4)
      // For lean, we approximate with generic
      expiryInfoLean = suggestExpiry(
        { atrPct, adx: adxVal, emaFast: emaFVal, emaSlow: emaSVal, atr: atrVal, rsi: rsiVal, close: ci },
        regime,
        "confluence",
        confidence,
        { adaptiveExpiryMin: adaptiveMin, adaptiveExpiryMax: adaptiveMax }
      );
    } catch (_) { expiryInfoLean = null; }

    return {
      ready: true,
      direction,
      confidence,
      score,
      regime,
      suggestedExpiry: expiryInfoLean ? expiryInfoLean.minutes : null,
      expiryReason: expiryInfoLean ? expiryInfoLean.reason : null,
      metrics: { atrPct, adx: adxVal, close: ci, rsi: rsiVal, emaFast: emaFVal, emaSlow: emaSVal, atr: atrVal }
    };
  }

  function backtest(candles, opts) {
    const empty = {
      wins: 0, losses: 0, draws: 0, total: 0, decisions: 0, winrate: 0, payoff: 0,
      pnl: 0, pnlWithPayout: 0, expectedValue: 0, profitFactor: 0, expectancy: 0,
      avgWin: 0, avgLoss: 0, avgTrade: 0, grossProfit: 0, grossLoss: 0,
      maxDrawdown: 0, maxWinStreak: 0, maxLossStreak: 0, sharpe: 0, sortino: 0,
      recoveryFactor: 0, exposure: 0, bestTrade: 0, worstTrade: 0,
      avgHolding: 0, winLossRatio: 0, kelly: 0,
      byRegime: {}, byConfidence: {}, byHour: {}, byStrategy: {}, byExpiry: {},
      calibration: [], equity: [], trades: [],
      monteCarlo: null, walkForward: null,
    };
    if (!Array.isArray(candles) || candles.length < 40) return empty;
    for (let i = 0; i < candles.length; i++) {
      const b = candles[i] || {};
      const values = [numberValue(b.open), numberValue(b.high), numberValue(b.low), numberValue(b.close)];
      if (values.some((value) => value == null || value <= 0) ||
          values[1] < Math.max(values[0], values[2], values[3]) ||
          values[2] > Math.min(values[0], values[1], values[3])) return empty;
    }
    const resolved = resolveStrategy(opts);
    const cfg = Object.assign({}, resolved.params);
    const rawHorizon = hasOwn(opts, "horizon") ? numberValue(opts.horizon) : null;
    // Support fractional horizon (e.g., 0.5, 1.5, 2.5)
    const horizonFloat = rawHorizon != null ? Math.max(0.5, Math.min(1440, rawHorizon)) : 3;
    const horizon = Math.max(1, Math.min(1440, Math.floor(horizonFloat)));
    const horizonFrac = horizonFloat - Math.floor(horizonFloat);
    const rawMinConf = hasOwn(opts, "minConf") ? numberValue(opts.minConf) : null;
    const minConf = rawMinConf != null ? Math.max(0, Math.min(100, rawMinConf)) : 0;
    const rawWarmup = hasOwn(opts, "warmup") ? numberValue(opts.warmup) : null;
    const warmup = rawWarmup != null ? Math.max(40, Math.min(candles.length - 1, Math.floor(rawWarmup))) : 50;
    const lean = !(opts && opts.lean === false);
    const isAdaptive = opts && opts.strategy === "auto_adaptive";
    // Payout: e.g., 0.85 = 85% return on win, -1 on loss
    const rawPayout = hasOwn(opts, "payout") ? numberValue(opts.payout) : null;
    const payout = rawPayout != null ? Math.max(0, Math.min(5, rawPayout)) : 0.85;
    const useAdaptiveExpiry = !!(opts && opts.useAdaptiveExpiry);
    const rawSlippage = hasOwn(opts, "slippage") ? numberValue(opts.slippage) : null;
    const slippage = rawSlippage != null ? Math.max(0, Math.min(0.01, rawSlippage)) : 0;

    let prepared = null;
    let adaptivePrepared = null;
    let resolvedMap = null;
    if (lean && !isAdaptive) {
      prepared = prepareLeanSeries(candles, cfg);
    } else if (lean && isAdaptive) {
      adaptivePrepared = {};
      resolvedMap = {};
      for (const stratId of CONCRETE_STRATEGIES) {
        const stratResolved = resolveStrategy({ strategy: stratId });
        resolvedMap[stratId] = stratResolved;
        adaptivePrepared[stratId] = prepareLeanSeries(candles, stratResolved.params);
      }
    }

    const rawMinBars = numberValue(cfg.minBars);
    const nonLeanTail = Math.max(200, Math.min(2000, Math.floor(rawMinBars == null ? 200 : rawMinBars)));
    const reducedTime = (value) => {
      let n = numberValue(value);
      if (n == null) return null;
      while (Math.abs(n) >= 1e14) n /= 1000;
      return n;
    };
    const firstRawTime = reducedTime(candles[0].time);
    const secondRawTime = candles.length > 1 ? reducedTime(candles[1].time) : null;
    const rawSpacing = firstRawTime != null && secondRawTime != null ? Math.abs(secondRawTime - firstRawTime) : 0;
    const timeScale = firstRawTime != null && Math.abs(firstRawTime) >= 1e11 ? 1
      : (firstRawTime != null && Math.abs(firstRawTime) >= 1e9 ? 1000 : (rawSpacing >= 1000 ? 1 : 1000));
    const candleTimeMs = (value) => {
      const n = reducedTime(value);
      const ms = n == null ? NaN : Math.floor(n * timeScale);
      return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
    };
    let priorTime = null;
    for (let i = 0; i < candles.length; i++) {
      const normalizedTime = candleTimeMs(candles[i].time);
      if (normalizedTime == null || (priorTime != null && normalizedTime <= priorTime)) return empty;
      priorTime = normalizedTime;
    }
    const firstTime = candleTimeMs(candles[0].time);
    const secondTime = candles.length > 1 ? candleTimeMs(candles[1].time) : null;
    const rawTf = firstTime != null && secondTime != null ? secondTime - firstTime : 60000;
    const tfMs = Number.isFinite(rawTf) && rawTf > 0 ? Math.min(86400000, rawTf) : 60000;

    let wins = 0, losses = 0, draws = 0;
    const trades = [];
    const equity = [];
    let pnl = 0;
    let pnlWithPayout = 0;
    let grossProfit = 0, grossLoss = 0;
    let totalHolding = 0;
    let bestTrade = -Infinity, worstTrade = Infinity;
    const returns = [];

    // Helper to get expiry price with fractional support
    function getExpiryPrice(entryIdx, effectiveHorizon) {
      const eff = Number(effectiveHorizon);
      const h = Number.isFinite(eff) && eff >= 0.5 ? eff : horizonFloat;
      const fullBars = Math.floor(h);
      const frac = h - fullBars;
      const exitIdx = entryIdx + fullBars;
      if (exitIdx >= candles.length) return null;
      const baseClose = numberValue(candles[exitIdx].close);
      if (frac <= 0 || exitIdx + 1 >= candles.length) return baseClose;
      // Interpolate for fractional part: price between close[exitIdx] and close[exitIdx+1]
      const nextClose = numberValue(candles[exitIdx + 1].close);
      if (baseClose == null || nextClose == null) return baseClose;
      return baseClose + (nextClose - baseClose) * frac;
    }

    for (let i = warmup; i < candles.length - horizon - 1; i++) {
      const sig = adaptivePrepared
        ? evaluateAdaptiveLeanAt(adaptivePrepared, i, opts, resolvedMap)
        : (prepared
          ? evaluateLeanAt(prepared, i, cfg, resolved.weights)
          : analyze(candles.slice(Math.max(0, i + 1 - nonLeanTail), i + 1), Object.assign({}, opts, { lean: false })));
      if (!sig.ready || sig.direction === "WAIT") continue;
      if (sig.confidence < minConf) continue;

      // Determine effective horizon: adaptive expiry if enabled and signal provides it
      let effectiveHorizon = horizonFloat;
      if (useAdaptiveExpiry && sig.suggestedExpiry != null) {
        const sug = Number(sig.suggestedExpiry);
        if (Number.isFinite(sug) && sug >= 0.5 && sug <= 60) {
          effectiveHorizon = sug;
        }
      }

      let entry = numberValue(candles[i].close);
      let exit = getExpiryPrice(i, effectiveHorizon);
      if (entry == null || exit == null) continue;

      // Apply slippage if configured (simulates broker spread)
      if (slippage > 0) {
        const slip = entry * slippage * (Math.random() * 2 - 1);
        entry += slip;
      }

      const draw = Math.abs(exit - entry) < entry * 0.000001;
      const won = !draw &&
        ((sig.direction === "CALL" && exit > entry) ||
        (sig.direction === "PUT" && exit < entry));
      if (draw) draws++; else if (won) wins++; else losses++;

      // PnL calculations
      const tradePnlUnits = draw ? 0 : (won ? 1 : -1);
      const tradePnlPayout = draw ? 0 : (won ? payout : -1);
      pnl += tradePnlUnits;
      pnlWithPayout += tradePnlPayout;
      if (tradePnlPayout > 0) grossProfit += tradePnlPayout;
      else if (tradePnlPayout < 0) grossLoss += tradePnlPayout;

      if (tradePnlPayout > bestTrade) bestTrade = tradePnlPayout;
      if (tradePnlPayout < worstTrade) worstTrade = tradePnlPayout;
      returns.push(tradePnlPayout);
      totalHolding += effectiveHorizon;

      const entryTime = candleTimeMs(candles[i].time) != null ? candleTimeMs(candles[i].time) + tfMs : null;
      const exitTimeMs = entryTime != null ? entryTime + effectiveHorizon * 60000 : null;

      trades.push({
        i, dir: sig.direction, score: sig.score, confidence: sig.confidence,
        regime: sig.regime, won, draw, entry, exit,
        entryPrice: entry, exitPrice: exit,
        priceChange: exit - entry,
        priceChangePct: entry ? ((exit - entry) / entry * 100) : 0,
        selectedStrategy: sig.selectedStrategy || opts.strategy || "confluence",
        strategyLabel: sig.selectedStrategyLabel || sig.selectedStrategy || "confluence",
        expiryMinutes: effectiveHorizon,
        suggestedExpiry: sig.suggestedExpiry || null,
        entryTime: entryTime,
        expiryTime: exitTimeMs,
        exitTime: exitTimeMs,
        pnl: tradePnlUnits,
        pnlPayout: tradePnlPayout,
        payout: payout,
        votes: sig.votes ? sig.votes.slice(0, 8) : [],
        metrics: sig.metrics ? {
          rsi: sig.metrics.rsi,
          adx: sig.metrics.adx,
          atrPct: sig.metrics.atrPct,
          emaFast: sig.metrics.emaFast,
          emaSlow: sig.metrics.emaSlow,
        } : null,
      });
      equity.push({ i, pnl: pnlWithPayout, equity: pnlWithPayout, time: entryTime, drawdown: 0 });
    }

    const total = wins + losses;
    const winrate = total ? (wins / total) * 100 : 0;
    const payoff = wins && losses ? wins / losses : wins ? Infinity : 0;
    const grossProfitAbs = grossProfit;
    const grossLossAbs = Math.abs(grossLoss);
    const profitFactor = grossLossAbs > 0 ? grossProfitAbs / grossLossAbs : (grossProfitAbs > 0 ? Infinity : 0);
    const avgWin = wins ? grossProfitAbs / wins : 0;
    const avgLoss = losses ? grossLossAbs / losses : 0;
    const avgTrade = total ? pnlWithPayout / total : 0;
    const winLossRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? Infinity : 0);
    const expectancy = total ? (winrate/100 * avgWin - (1-winrate/100) * avgLoss) : 0;
    const expectedValue = total ? (winrate/100 * payout - (1-winrate/100)) * 100 : 0;
    const exposure = candles.length ? (trades.length / candles.length * 100) : 0;
    const avgHolding = trades.length ? totalHolding / trades.length : 0;
    if (!Number.isFinite(bestTrade) || bestTrade === -Infinity) bestTrade = 0;
    if (!Number.isFinite(worstTrade) || worstTrade === Infinity) worstTrade = 0;

    // Sharpe & Sortino (based on per-trade returns)
    let sharpe = 0, sortino = 0;
    if (returns.length > 1) {
      const mean = returns.reduce((a,b)=>a+b,0) / returns.length;
      const variance = returns.reduce((a,b)=>a + Math.pow(b-mean,2),0) / returns.length;
      const std = Math.sqrt(variance);
      sharpe = std > 0 ? mean / std * Math.sqrt(252*24*60 / avgHolding) : 0;
      const downside = returns.filter(r=>r<0);
      if (downside.length) {
        const downVar = downside.reduce((a,b)=>a + b*b,0) / downside.length;
        const downStd = Math.sqrt(downVar);
        sortino = downStd > 0 ? mean / downStd * Math.sqrt(252*24*60 / avgHolding) : 0;
      }
    }

    // Kelly criterion: f* = p - q/b where p=winrate, q=lossrate, b=payout
    const p = winrate/100;
    const q = 1 - p;
    const b = payout;
    const kelly = b > 0 ? p - q / b : 0;

    const byRegime = {};
    const byConfidence = {};
    const byHour = {};
    const byStrategy = {};
    const byExpiry = {};
    for (const t of trades) {
      const r = t.regime || "unknown";
      if (!byRegime[r]) byRegime[r] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
      if (t.draw) byRegime[r].draws++;
      else if (t.won) { byRegime[r].wins++; byRegime[r].pnl += t.pnlPayout; }
      else { byRegime[r].losses++; byRegime[r].pnl += t.pnlPayout; }

      const confBucket = Math.min(90, Math.floor(t.confidence/10)*10);
      if (!byConfidence[confBucket]) byConfidence[confBucket] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
      if (t.draw) byConfidence[confBucket].draws++;
      else if (t.won) { byConfidence[confBucket].wins++; byConfidence[confBucket].pnl += t.pnlPayout; }
      else { byConfidence[confBucket].losses++; byConfidence[confBucket].pnl += t.pnlPayout; }

      if (t.entryTime) {
        const h = new Date(t.entryTime).getUTCHours();
        if (!byHour[h]) byHour[h] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
        if (t.draw) byHour[h].draws++;
        else if (t.won) { byHour[h].wins++; byHour[h].pnl += t.pnlPayout; }
        else { byHour[h].losses++; byHour[h].pnl += t.pnlPayout; }
      }

      const strat = t.selectedStrategy || "confluence";
      if (!byStrategy[strat]) byStrategy[strat] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
      if (t.draw) byStrategy[strat].draws++;
      else if (t.won) { byStrategy[strat].wins++; byStrategy[strat].pnl += t.pnlPayout; }
      else { byStrategy[strat].losses++; byStrategy[strat].pnl += t.pnlPayout; }

      const expKey = String(Math.round(t.expiryMinutes*2)/2);
      if (!byExpiry[expKey]) byExpiry[expKey] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
      if (t.draw) byExpiry[expKey].draws++;
      else if (t.won) { byExpiry[expKey].wins++; byExpiry[expKey].pnl += t.pnlPayout; }
      else { byExpiry[expKey].losses++; byExpiry[expKey].pnl += t.pnlPayout; }
    }
    for (const map of [byRegime, byConfidence, byHour, byStrategy, byExpiry]) {
      for (const k of Object.keys(map)) {
        const v = map[k];
        const resolvedR = v.wins + v.losses;
        v.total = resolvedR + v.draws;
        v.winrate = resolvedR ? (v.wins / resolvedR) * 100 : 0;
        v.expectedValue = resolvedR ? (v.winrate/100 * payout - (1-v.winrate/100)) * 100 : 0;
      }
    }

    let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
    for (const t of trades) {
      if (t.draw) { curW = 0; curL = 0; }
      else if (t.won) { curW++; curL = 0; }
      else { curL++; curW = 0; }
      if (curW > maxWinStreak) maxWinStreak = curW;
      if (curL > maxLossStreak) maxLossStreak = curL;
    }

    let peak = -Infinity, maxDD = 0;
    for (let ei = 0; ei < equity.length; ei++) {
      const e = equity[ei];
      if (e.equity > peak) peak = e.equity;
      const dd = peak - e.equity;
      e.drawdown = dd;
      if (dd > maxDD) maxDD = dd;
    }
    const recoveryFactor = maxDD > 0 ? pnlWithPayout / maxDD : (pnlWithPayout > 0 ? Infinity : 0);

    const calibBuckets = {};
    for (const t of trades) {
      if (t.draw) continue;
      const rawConfidence = numberValue(t.confidence);
      const conf = rawConfidence != null ? Math.max(0, Math.min(100, rawConfidence)) : 0;
      const b = Math.min(90, Math.floor(conf / 10) * 10);
      if (!calibBuckets[b]) calibBuckets[b] = { wins: 0, losses: 0 };
      if (t.won) calibBuckets[b].wins++; else calibBuckets[b].losses++;
    }
    const calibration = [];
    for (const b of Object.keys(calibBuckets).map(Number).sort((a, b) => a - b)) {
      const v = calibBuckets[b];
      const t = v.wins + v.losses;
      calibration.push({
        bucket: b,
        wins: v.wins,
        losses: v.losses,
        total: t,
        winrate: t ? (v.wins / t) * 100 : 0,
        expectedValue: t ? ((v.wins / t) * payout - (1 - v.wins / t)) * 100 : 0,
      });
    }

    return {
      wins, losses, draws, total, decisions: total + draws, winrate, payoff,
      pnl, pnlWithPayout, expectedValue, profitFactor, expectancy,
      avgWin, avgLoss, avgTrade, grossProfit: grossProfitAbs, grossLoss: grossLossAbs,
      maxDrawdown: maxDD, maxWinStreak, maxLossStreak, sharpe, sortino,
      recoveryFactor, exposure, bestTrade, worstTrade, avgHolding, winLossRatio, kelly,
      payout,
      byRegime, byConfidence, byHour, byStrategy, byExpiry,
      calibration, equity, trades,
    };
  }

  function walkForward(candles, opts) {
    const total = Array.isArray(candles) ? candles.length : 0;
    if (total < 400) return { error: "need at least 400 candles" };
    const requestedFolds = numberValue(opts && opts.folds);
    const maxUsefulFolds = Math.max(2, Math.min(20, Math.floor(total / 200)));
    const folds = requestedFolds != null
      ? Math.max(2, Math.min(maxUsefulFolds, Math.floor(requestedFolds)))
      : Math.min(5, maxUsefulFolds);
    const foldSize = Math.floor(total / folds);
    const out = [];
    let totalW = 0, totalL = 0, totalPnl = 0;
    for (let f = 0; f < folds; f++) {
      const start = f * foldSize;
      const end = f === folds - 1 ? total : (f + 1) * foldSize;
      const slice = candles.slice(start, end);
      const split = Math.floor(slice.length * 0.5);
      const train = slice.slice(0, split);
      const test = slice.slice(split);
      const trainR = backtest(train, opts);
      const testR = backtest(test, opts);
      totalW += testR.wins;
      totalL += testR.losses;
      totalPnl += testR.pnlWithPayout || testR.pnl || 0;
      out.push({
        fold: f,
        train: {
          wins: trainR.wins, losses: trainR.losses, winrate: trainR.winrate,
          pnl: trainR.pnlWithPayout || trainR.pnl, profitFactor: trainR.profitFactor, expectedValue: trainR.expectedValue
        },
        test: {
          wins: testR.wins, losses: testR.losses, winrate: testR.winrate,
          pnl: testR.pnlWithPayout || testR.pnl, profitFactor: testR.profitFactor, expectedValue: testR.expectedValue,
          sharpe: testR.sharpe, maxDrawdown: testR.maxDrawdown
        },
      });
    }
    const combinedWR = totalW + totalL ? (totalW / (totalW + totalL)) * 100 : 0;
    const payout = opts && opts.payout ? Number(opts.payout) : 0.85;
    const combinedEV = totalW + totalL ? (combinedWR/100 * payout - (1-combinedWR/100)) * 100 : 0;
    return {
      folds: out,
      combined: {
        wins: totalW, losses: totalL, winrate: combinedWR,
        pnl: totalPnl, expectedValue: combinedEV,
        avgWinrate: out.length ? out.reduce((a,f)=>a+f.test.winrate,0)/out.length : 0,
        consistency: out.length ? out.filter(f=>f.test.winrate>=50).length / out.length * 100 : 0,
      },
    };
  }

  function monteCarlo(trades, opts) {
    // Monte Carlo simulation: shuffle trade order N times to estimate risk
    opts = opts || {};
    const sims = Math.max(100, Math.min(10000, Math.floor(Number(opts.sims) || 1000)));
    if (!Array.isArray(trades) || trades.length < 10) return { error: "need at least 10 trades" };
    const returns = trades.map(t => t.pnlPayout != null ? t.pnlPayout : t.pnl).filter(r => Number.isFinite(r));
    if (returns.length < 10) return { error: "insufficient returns" };

    const results = [];
    for (let s = 0; s < sims; s++) {
      // Fisher-Yates shuffle copy
      const shuffled = returns.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i]; shuffled[i] = shuffled[j]; shuffled[j] = tmp;
      }
      let eq = 0, peak = -Infinity, maxDD = 0, maxLossStreak = 0, curLoss = 0;
      for (const r of shuffled) {
        eq += r;
        if (eq > peak) peak = eq;
        const dd = peak - eq;
        if (dd > maxDD) maxDD = dd;
        if (r < 0) { curLoss++; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
        else curLoss = 0;
      }
      results.push({ finalPnL: eq, maxDD, maxLossStreak });
    }
    results.sort((a,b)=>a.finalPnL - b.finalPnL);
    const percentile = (p) => {
      const idx = Math.floor(results.length * p / 100);
      return results[Math.max(0, Math.min(results.length-1, idx))];
    };
    const avgPnL = results.reduce((a,r)=>a+r.finalPnL,0)/results.length;
    const avgDD = results.reduce((a,r)=>a+r.maxDD,0)/results.length;
    const positive = results.filter(r=>r.finalPnL>0).length / results.length * 100;
    return {
      simulations: sims,
      avgPnL, avgDD,
      median: percentile(50),
      p5: percentile(5),
      p10: percentile(10),
      p90: percentile(90),
      p95: percentile(95),
      positiveRate: positive,
      best: results[results.length-1],
      worst: results[0],
      results: results.slice(0, 100), // sample for charting
    };
  }

  root.CYBER_ENGINE = { DEFAULTS, DEFAULT_WEIGHTS, CONCRETE_STRATEGIES, STRATEGY_EXPIRY_PROFILES, REGIME_EXPIRY, suggestExpiry, analyze, backtest, walkForward, monteCarlo, resolveStrategy, liveSignalGate, historyTrustDecision };
})(typeof self !== "undefined" ? self : globalThis);
