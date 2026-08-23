/**
 * Confluence signal engine v2.5 — multi-indicator, multi-timeframe, regime-aware,
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
    minScore: 4, lookback: 3,
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
    "confluence", "trend", "meanrev", "breakout", "scalp", "otc",
    "squeeze", "ribbon", "reversal", "momentum_pulse", "choppy_range"
  ];

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
    if (trending && directional) return "trending";
    if (trending && !directional) return "strong-trend";
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
        if (stratId === "trend" || stratId === "ribbon") regimeBonus = 30;
        else if (stratId === "momentum_pulse" || stratId === "confluence") regimeBonus = 20;
        else if (stratId === "breakout") regimeBonus = 15;
      } else if (regime === "mean-reverting" || regime === "ranging") {
        if (stratId === "meanrev" || stratId === "choppy_range") regimeBonus = 30;
        else if (stratId === "reversal" || stratId === "confluence") regimeBonus = 20;
        else if (stratId === "otc") regimeBonus = 15;
      } else if (regime === "squeeze" || regime === "choppy") {
        if (stratId === "squeeze" || stratId === "breakout") regimeBonus = 30;
        else if (stratId === "scalp" || stratId === "confluence") regimeBonus = 20;
      }

      const hasSignal = res.direction === "CALL" || res.direction === "PUT";
      const signalBonus = hasSignal ? 25 : 0;
      const confScore = res.confidence || 0;
      const rawScore = res.score || 0;

      let winrateBonus = 0;
      if (opts && opts.strategyWinrates && opts.strategyWinrates[stratId]) {
        const wr = Number(opts.strategyWinrates[stratId]);
        if (Number.isFinite(wr) && wr > 50) winrateBonus = (wr - 50) * 0.5;
      }

      const fitness = Math.min(100, Math.round(
        rawScore * 8 + confScore * 0.3 + regimeBonus + signalBonus + winrateBonus
      ));

      scores[stratId] = {
        label: (STRAT && STRAT[stratId] && STRAT[stratId].label) || stratId,
        fitness,
        direction: res.direction,
        confidence: res.confidence,
        score: res.score,
        regimeBonus,
      };

      const effectiveFitness = hasSignal ? fitness + 100 : fitness;
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

    return Object.assign({}, bestResult, {
      adaptive: true,
      selectedStrategy: bestStrategy,
      selectedStrategyLabel: bestLabel,
      strategyScores: scores,
      reason: bestResult.direction === "WAIT"
        ? `Auto-adapted '${bestLabel}' [${regime}]: No confluence`
        : `⚡ Auto-adapted '${bestLabel}' for ${regime} regime (Fitness: ${scores[bestStrategy] ? scores[bestStrategy].fitness : 0}/100) · ${bestResult.reason || ""}`,
    });
  }

  function evaluateAdaptiveLeanAt(preparedMap, i, opts) {
    const scores = {};
    let bestStrategy = "confluence";
    let bestScore = -1;
    let bestResult = null;

    const { params: baseParams, weights: baseWeights } = resolveStrategy({ strategy: "confluence" });
    const basePrepared = preparedMap["confluence"];
    const baseResult = basePrepared ? evaluateLeanAt(basePrepared, i, baseParams, baseWeights) : null;
    const regime = baseResult ? baseResult.regime || "ranging" : "ranging";

    for (const stratId of CONCRETE_STRATEGIES) {
      const pSeries = preparedMap[stratId];
      if (!pSeries) continue;
      const { params: sParams, weights: sWeights } = resolveStrategy({ strategy: stratId });
      const res = evaluateLeanAt(pSeries, i, sParams, sWeights);
      if (!res || !res.ready) continue;

      let regimeBonus = 0;
      if (regime === "trending" || regime === "strong-trend") {
        if (stratId === "trend" || stratId === "ribbon") regimeBonus = 30;
        else if (stratId === "momentum_pulse" || stratId === "confluence") regimeBonus = 20;
        else if (stratId === "breakout") regimeBonus = 15;
      } else if (regime === "mean-reverting" || regime === "ranging") {
        if (stratId === "meanrev" || stratId === "choppy_range") regimeBonus = 30;
        else if (stratId === "reversal" || stratId === "confluence") regimeBonus = 20;
        else if (stratId === "otc") regimeBonus = 15;
      } else if (regime === "squeeze" || regime === "choppy") {
        if (stratId === "squeeze" || stratId === "breakout") regimeBonus = 30;
        else if (stratId === "scalp" || stratId === "confluence") regimeBonus = 20;
      }

      const hasSignal = res.direction === "CALL" || res.direction === "PUT";
      const signalBonus = hasSignal ? 25 : 0;
      const confScore = res.confidence || 0;
      const rawScore = res.score || 0;

      let winrateBonus = 0;
      if (opts && opts.strategyWinrates && opts.strategyWinrates[stratId]) {
        const wr = Number(opts.strategyWinrates[stratId]);
        if (Number.isFinite(wr) && wr > 50) winrateBonus = (wr - 50) * 0.5;
      }

      const fitness = Math.min(100, Math.round(
        rawScore * 8 + confScore * 0.3 + regimeBonus + signalBonus + winrateBonus
      ));

      scores[stratId] = {
        label: (STRAT && STRAT[stratId] && STRAT[stratId].label) || stratId,
        fitness,
        direction: res.direction,
        confidence: res.confidence,
        score: res.score,
        regimeBonus,
      };

      const effectiveFitness = hasSignal ? fitness + 100 : fitness;
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

    return Object.assign({}, bestResult, {
      adaptive: true,
      selectedStrategy: bestStrategy,
      selectedStrategyLabel: bestLabel,
      strategyScores: scores,
      reason: bestResult.direction === "WAIT"
        ? `Auto-adapted '${bestLabel}' [${regime}]: No confluence`
        : `⚡ Auto-adapted '${bestLabel}' for ${regime} regime (Fitness: ${scores[bestStrategy] ? scores[bestStrategy].fitness : 0}/100)`,
    });
  }

  function analyze(candles, opts) {
    const requestedStrategy = opts && typeof opts.strategy === "string" ? opts.strategy : "";
    if (requestedStrategy === "auto_adaptive") {
      return evaluateAdaptive(candles, opts, (c, o) => analyze(c, o));
    }

    const { params: cfg, weights } = resolveStrategy(opts);
    if (!Array.isArray(candles) || candles.length < 40) {
      return { ready: false, reason: "Need at least 40 candles", votes: [], regime: "unknown" };
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
        return { ready: false, reason: "Invalid candle data", votes: [], regime: "unknown" };
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
      return { ready: false, reason: "Warming indicators", votes: [], regime: "unknown" };
    }

    const atrPct = atr[i] / c[i];
    if (atrPct < cfg.minAtrPct) {
      return {
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
      };
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
      if (st.k[prev] < cfg.stochOs && st.k[i] > st.d[i] && st.k[i] < 50)
        votes.push({ name: "Stoch", dir: "CALL", w: weights.stoch });
      if (st.k[prev] > cfg.stochOb && st.k[i] < st.d[i] && st.k[i] > 50)
        votes.push({ name: "Stoch", dir: "PUT", w: weights.stoch });
    }

    // Bollinger with trend agreement or band bounce
    if ((c[i] <= bb.lower[i]) || (prev >= 0 && l[prev] <= bb.lower[prev] && c[i] > bb.lower[i]) || (c[i] <= bb.mid[i] && c[i] > emaS[i] && emaF[i] > emaS[i]))
      votes.push({ name: "BB", dir: "CALL", w: weights.bb });
    if ((c[i] >= bb.upper[i]) || (prev >= 0 && h[prev] >= bb.upper[prev] && c[i] < bb.upper[i]) || (c[i] >= bb.mid[i] && c[i] < emaS[i] && emaF[i] < emaS[i]))
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
    const requiredScore = baseMinScore + (regime === "choppy" ? 2 : 0);
    const requiredLead = regime === "trending" ? 0 : 1;

    let direction = "WAIT";
    let score = 0;
    if (call >= requiredScore && call > put + requiredLead) {
      direction = "CALL"; score = call;
    } else if (put >= requiredScore && put > call + requiredLead) {
      direction = "PUT"; score = put;
    }

    let confidence = 0;
    if (direction !== "WAIT") {
      const probs = TA.softmaxProbs(call, put);
      const p = direction === "CALL" ? probs.call : probs.put;
      confidence = Math.max(1, Math.min(99, Math.round(p * 100)));
    }

    return {
      ready: true,
      direction,
      score,
      confidence,
      regime,
      reason:
        direction === "WAIT"
          ? `No confluence (CALL ${call} · PUT ${put} · need ${requiredScore})`
          : votes.filter((v) => v.dir === direction).map((v) => v.name).join(" · "),
      votes,
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
    };
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
      if (completed + 1 >= 30 && ef != null && es != null) {
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

  function evaluateLeanAt(p, i, cfg, weights) {
    const prev = i - 1;
    const need = [p.rsi[i], p.emaF[i], p.emaS[i], p.macd.hist[i], p.st.k[i], p.st.d[i],
      p.bb.mid[i], p.atr[i], p.adxR.adx[i], p.psar[i], p.superR.st[i]];
    if (need.some((v) => v == null || numberValue(v) == null) || !Number.isFinite(p.c[i]) || p.c[i] <= 0) {
      return { ready: false, direction: "WAIT", confidence: 0, score: 0, regime: "unknown" };
    }
    const regime = detectRegime(i, p.rsi, p.emaF, p.emaS, p.adxR.adx, p.atr, p.c, p.hurst, p.bb, p.keltner);
    if (p.atr[i] / p.c[i] < cfg.minAtrPct) {
      return { ready: true, direction: "WAIT", confidence: 0, score: 0, regime };
    }
    const votes = [];
    if (p.c[i] > p.emaS[i] && p.emaF[i] > p.emaS[i]) votes.push({ dir: "CALL", w: weights.emaTrend });
    else if (p.c[i] < p.emaS[i] && p.emaF[i] < p.emaS[i]) votes.push({ dir: "PUT", w: weights.emaTrend });
    const rawLookback = numberValue(cfg.lookback);
    const lookback = Math.max(0, Math.min(100, Math.floor(rawLookback == null ? 0 : rawLookback)));
    for (let k = 0; k < lookback; k++) {
      const a = i - k, b = a - 1;
      if (b < 0 || p.emaF[a] == null || p.emaS[a] == null) continue;
      if (p.emaF[b] <= p.emaS[b] && p.emaF[a] > p.emaS[a]) { votes.push({ dir: "CALL", w: weights.emaCross }); break; }
      if (p.emaF[b] >= p.emaS[b] && p.emaF[a] < p.emaS[a]) { votes.push({ dir: "PUT", w: weights.emaCross }); break; }
    }
    if (p.rsi[i] < cfg.rsiBuy && p.rsi[i] > 22 && p.c[i] > p.emaS[i]) votes.push({ dir: "CALL", w: weights.rsiPull });
    if (p.rsi[i] > cfg.rsiSell && p.rsi[i] < 78 && p.c[i] < p.emaS[i]) votes.push({ dir: "PUT", w: weights.rsiPull });
    if (prev >= 0 && p.macd.hist[prev] != null) {
      if (p.macd.hist[i] > 0 && p.macd.hist[i] > p.macd.hist[prev]) votes.push({ dir: "CALL", w: weights.macd });
      if (p.macd.hist[i] < 0 && p.macd.hist[i] < p.macd.hist[prev]) votes.push({ dir: "PUT", w: weights.macd });
    }
    if (prev >= 0 && p.st.k[prev] != null && p.st.d[prev] != null) {
      if (p.st.k[prev] < cfg.stochOs && p.st.k[i] > p.st.d[i] && p.st.k[i] < 50) votes.push({ dir: "CALL", w: weights.stoch });
      if (p.st.k[prev] > cfg.stochOb && p.st.k[i] < p.st.d[i] && p.st.k[i] > 50) votes.push({ dir: "PUT", w: weights.stoch });
    }
    if ((p.c[i] <= p.bb.lower[i]) || (prev >= 0 && p.l[prev] <= p.bb.lower[prev] && p.c[i] > p.bb.lower[i]) || (p.c[i] <= p.bb.mid[i] && p.c[i] > p.emaS[i] && p.emaF[i] > p.emaS[i]))
      votes.push({ dir: "CALL", w: weights.bb });
    if ((p.c[i] >= p.bb.upper[i]) || (prev >= 0 && p.h[prev] >= p.bb.upper[prev] && p.c[i] < p.bb.upper[i]) || (p.c[i] >= p.bb.mid[i] && p.c[i] < p.emaS[i] && p.emaF[i] < p.emaS[i]))
      votes.push({ dir: "PUT", w: weights.bb });
    if (p.adxR.adx[i] >= cfg.adxMin) {
      if (p.adxR.plus[i] > p.adxR.minus[i] && p.c[i] > p.emaS[i]) votes.push({ dir: "CALL", w: weights.adxTrend });
      if (p.adxR.minus[i] > p.adxR.plus[i] && p.c[i] < p.emaS[i]) votes.push({ dir: "PUT", w: weights.adxTrend });
    }
    if (p.superR.trend[i] === 1) votes.push({ dir: "CALL", w: weights.supertrend });
    else if (p.superR.trend[i] === -1) votes.push({ dir: "PUT", w: weights.supertrend });
    if (p.c[i] > p.psar[i]) votes.push({ dir: "CALL", w: weights.psar });
    else votes.push({ dir: "PUT", w: weights.psar });
    if (p.vwap && p.vwap[i] != null) {
      if (p.c[i] > p.vwap[i] && p.emaF[i] > p.emaS[i]) votes.push({ dir: "CALL", w: weights.vwap });
      else if (p.c[i] < p.vwap[i] && p.emaF[i] < p.emaS[i]) votes.push({ dir: "PUT", w: weights.vwap });
    }
    let mtfBias = 0, mtfChecked = 0;
    if (p.mtfFast[i] != null) { mtfBias += p.mtfFast[i]; mtfChecked++; }
    if (p.mtfMid[i] != null) { mtfBias += p.mtfMid[i]; mtfChecked++; }
    if (mtfChecked && mtfBias > 0) votes.push({ dir: "CALL", w: weights.mtfAlign });
    else if (mtfChecked && mtfBias < 0) votes.push({ dir: "PUT", w: weights.mtfAlign });
    if (p.hurst && p.hurst[i] != null && p.hurst[i] > 0.55) {
      if ((p.emaF[i] - p.emaS[i]) > 0) votes.push({ dir: "CALL", w: weights.hurst });
      else if ((p.emaF[i] - p.emaS[i]) < 0) votes.push({ dir: "PUT", w: weights.hurst });
    }
    if (p.williams && p.williams[i] != null) {
      if (p.williams[i] < -80) votes.push({ dir: "CALL", w: weights.williams });
      if (p.williams[i] > -20) votes.push({ dir: "PUT", w: weights.williams });
    }
    if (p.cci && p.cci[i] != null) {
      if (p.cci[i] < -100) votes.push({ dir: "CALL", w: weights.cci });
      if (p.cci[i] > 100) votes.push({ dir: "PUT", w: weights.cci });
    }
    if (p.donch && p.donch.upper != null && p.donch.upper[i] != null && prev >= 0 && p.donch.upper[prev] != null) {
      if (p.c[i] >= p.donch.upper[prev] || p.h[i] >= p.donch.upper[prev]) votes.push({ dir: "CALL", w: weights.donchianBreak });
      if (p.c[i] <= p.donch.lower[prev] || p.l[i] <= p.donch.lower[prev]) votes.push({ dir: "PUT", w: weights.donchianBreak });
    }
    let call = 0, put = 0;
    for (const vote of votes) {
      const weight = numberValue(vote.w);
      if (weight == null || weight <= 0) continue;
      if (vote.dir === "CALL") call += weight; else put += weight;
    }
    const rawMin = numberValue(cfg.minScore);
    const baseMin = rawMin != null ? Math.max(0, rawMin) : DEFAULTS.minScore;
    const required = baseMin + (regime === "choppy" ? 2 : 0);
    const requiredLead = regime === "trending" ? 0 : 1;
    let direction = "WAIT", score = 0;
    if (call >= required && call > put + requiredLead) { direction = "CALL"; score = call; }
    else if (put >= required && put > call + requiredLead) { direction = "PUT"; score = put; }
    let confidence = 0;
    if (direction !== "WAIT") {
      const probs = TA.softmaxProbs(call, put);
      confidence = Math.max(1, Math.min(99, Math.round((direction === "CALL" ? probs.call : probs.put) * 100)));
    }
    return { ready: true, direction, confidence, score, regime };
  }

  function backtest(candles, opts) {
    const empty = {
      wins: 0, losses: 0, draws: 0, total: 0, decisions: 0, winrate: 0, payoff: 0,
      pnl: 0, maxDrawdown: 0, maxWinStreak: 0, maxLossStreak: 0,
      byRegime: {}, calibration: [], equity: [], trades: [],
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
    const horizon = rawHorizon != null ? Math.max(1, Math.min(1440, Math.floor(rawHorizon))) : 3;
    const rawMinConf = hasOwn(opts, "minConf") ? numberValue(opts.minConf) : null;
    const minConf = rawMinConf != null ? Math.max(0, Math.min(100, rawMinConf)) : 0;
    const rawWarmup = hasOwn(opts, "warmup") ? numberValue(opts.warmup) : null;
    const warmup = rawWarmup != null ? Math.max(40, Math.min(candles.length - 1, Math.floor(rawWarmup))) : 50;
    const lean = !(opts && opts.lean === false);
    const isAdaptive = opts && opts.strategy === "auto_adaptive";

    let prepared = null;
    let adaptivePrepared = null;
    if (lean && !isAdaptive) {
      prepared = prepareLeanSeries(candles, cfg);
    } else if (lean && isAdaptive) {
      adaptivePrepared = {};
      for (const stratId of CONCRETE_STRATEGIES) {
        const { params: sParams } = resolveStrategy({ strategy: stratId });
        adaptivePrepared[stratId] = prepareLeanSeries(candles, sParams);
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

    for (let i = warmup; i < candles.length - horizon; i++) {
      const sig = adaptivePrepared
        ? evaluateAdaptiveLeanAt(adaptivePrepared, i, opts)
        : (prepared
          ? evaluateLeanAt(prepared, i, cfg, resolved.weights)
          : analyze(candles.slice(Math.max(0, i + 1 - nonLeanTail), i + 1), Object.assign({}, opts, { lean: false })));
      if (!sig.ready || sig.direction === "WAIT") continue;
      if (sig.confidence < minConf) continue;

      const entry = numberValue(candles[i].close);
      const exit = numberValue(candles[i + horizon].close);
      const draw = exit === entry;
      const won = !draw &&
        ((sig.direction === "CALL" && exit > entry) ||
        (sig.direction === "PUT" && exit < entry));
      if (draw) draws++; else if (won) wins++; else losses++;
      const tradePnl = draw ? 0 : (won ? 1 : -1);
      pnl += tradePnl;
      trades.push({
        i, dir: sig.direction, score: sig.score, confidence: sig.confidence,
        regime: sig.regime, won, draw, entry, exit,
        selectedStrategy: sig.selectedStrategy || opts.strategy || "confluence",
        entryTime: candleTimeMs(candles[i].time) != null ? candleTimeMs(candles[i].time) + tfMs : null,
        expiryTime: candleTimeMs(candles[i + horizon].time) != null ? candleTimeMs(candles[i + horizon].time) + tfMs : null,
        exitTime: candleTimeMs(candles[i + horizon].time) != null ? candleTimeMs(candles[i + horizon].time) + tfMs : null,
        pnl: tradePnl,
      });
      equity.push({ i, pnl, equity: pnl });
    }

    const total = wins + losses;
    const winrate = total ? (wins / total) * 100 : 0;
    const payoff = wins && losses ? wins / losses : wins ? Infinity : 0;

    const byRegime = {};
    for (const t of trades) {
      const r = t.regime || "unknown";
      if (!byRegime[r]) byRegime[r] = { wins: 0, losses: 0, draws: 0 };
      if (t.draw) byRegime[r].draws++;
      else if (t.won) byRegime[r].wins++;
      else byRegime[r].losses++;
    }
    for (const r of Object.keys(byRegime)) {
      const resolved = byRegime[r].wins + byRegime[r].losses;
      byRegime[r].total = resolved + byRegime[r].draws;
      byRegime[r].winrate = resolved ? (byRegime[r].wins / resolved) * 100 : 0;
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
    for (const e of equity) {
      if (e.equity > peak) peak = e.equity;
      const dd = peak - e.equity;
      if (dd > maxDD) maxDD = dd;
    }

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
      });
    }

    return {
      wins, losses, draws, total, decisions: total + draws, winrate, payoff,
      pnl, maxDrawdown: maxDD, maxWinStreak, maxLossStreak,
      byRegime, calibration, equity, trades,
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
    for (let f = 0; f < folds; f++) {
      const start = f * foldSize;
      const end = f === folds - 1 ? total : (f + 1) * foldSize;
      const slice = candles.slice(start, end);
      const split = Math.floor(slice.length * 0.5);
      const train = slice.slice(0, split);
      const test = slice.slice(split);
      const trainR = backtest(train, opts);
      const testR = backtest(test, opts);
      out.push({
        fold: f,
        train: { wins: trainR.wins, losses: trainR.losses, winrate: trainR.winrate },
        test: { wins: testR.wins, losses: testR.losses, winrate: testR.winrate },
      });
    }
    let totalW = 0, totalL = 0;
    for (const f of out) { totalW += f.test.wins; totalL += f.test.losses; }
    return {
      folds: out,
      combined: { wins: totalW, losses: totalL, winrate: totalW + totalL ? (totalW / (totalW + totalL)) * 100 : 0 },
    };
  }

  root.CYBER_ENGINE = { DEFAULTS, DEFAULT_WEIGHTS, CONCRETE_STRATEGIES, analyze, backtest, walkForward, resolveStrategy };
})(typeof self !== "undefined" ? self : globalThis);
