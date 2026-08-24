/**
 * Strategy presets — bundles of engine parameters + vote weights for high-accuracy
 * winrate performance across market regimes.
 */
(function (root) {
  "use strict";

  const STRATEGIES = {
    "auto_adaptive": {
      label: "Auto-Adaptive (Elite Strategy Router)",
      blurb: "Dynamically evaluates market regime, volatility, and high-accuracy strategy matrix to auto-select the highest winrate setup for the current bar.",
      params: {
        rsiPeriod: 14, rsiBuy: 42, rsiSell: 58,
        emaFast: 8, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 22, stochOb: 78,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00010,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 1, macd: 1, stoch: 1, bb: 1,
        adxTrend: 2, supertrend: 2, psar: 1, vwap: 1, mtfAlign: 2,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
    "high_accuracy": {
      label: "High-Accuracy 80+ (Trending Regime Only)",
      blurb: "Ultra-selective engine: fires only in trending regimes with 90+ confluence. Tuned for 5-8 minute expiries (set expiry accordingly). Far fewer signals, far higher hit rate.",
      params: {
        rsiPeriod: 7, rsiBuy: 40, rsiSell: 60,
        emaFast: 5, emaSlow: 11,
        macdFast: 6, macdSlow: 13, macdSignal: 5,
        stochK: 7, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 14, bbMult: 1.6,
        atrPeriod: 10, minAtrPct: 0.00015,
        minScore: 3, lookback: 2,
        minConfidence: 90,
        // v2.6.18: "strong-trend" was mislabeled "trending" before the regime
        // classifier fix, so the old filter only matched the strongest trends.
        // Include both now so the gate still passes for the trend conditions
        // this strategy was tuned for (ADX ≥ 22, any directionality).
        regimeFilter: ["trending", "strong-trend"],
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 1, macd: 2, stoch: 1, bb: 1,
        adxTrend: 2, supertrend: 2, psar: 2, vwap: 1, mtfAlign: 2,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
    "sniper": {
      label: "Sniper 90+ Confluence",
      blurb: "Ultra-high conviction multi-timeframe alignment with strict Supertrend, ADX filter, and Parabolic SAR confirmation.",
      params: {
        rsiPeriod: 14, rsiBuy: 45, rsiSell: 55,
        emaFast: 6, emaSlow: 18,
        macdFast: 8, macdSlow: 21, macdSignal: 5,
        stochK: 14, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00015,
        minScore: 4, lookback: 3,
      },
      weights: {
        emaTrend: 3, emaCross: 2, rsiPull: 0, macd: 2, stoch: 0, bb: 0,
        adxTrend: 3, supertrend: 4, psar: 3, vwap: 2, mtfAlign: 4,
        hurst: 2, williams: 0, cci: 1, donchianBreak: 3,
      },
    },
    "turbo_trend": {
      label: "Turbo Trend Flow",
      blurb: "Fast EMA ribbon acceleration coupled with Supertrend and higher-timeframe momentum continuation.",
      params: {
        rsiPeriod: 12, rsiBuy: 46, rsiSell: 54,
        emaFast: 5, emaSlow: 13,
        macdFast: 8, macdSlow: 17, macdSignal: 9,
        stochK: 10, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 20, bbMult: 2.2,
        atrPeriod: 14, minAtrPct: 0.00018,
        minScore: 3, lookback: 4,
      },
      weights: {
        emaTrend: 4, emaCross: 3, rsiPull: 0, macd: 2, stoch: 0, bb: 0,
        adxTrend: 4, supertrend: 4, psar: 3, vwap: 2, mtfAlign: 4,
        hurst: 2, williams: 0, cci: 0, donchianBreak: 3,
      },
    },
    "institutional_flow": {
      label: "Institutional VWAP Flow",
      blurb: "Volume-weighted institutional anchor levels aligned with Hurst fractal trend persistence.",
      params: {
        rsiPeriod: 14, rsiBuy: 45, rsiSell: 55,
        emaFast: 8, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00012,
        minScore: 4, lookback: 3,
      },
      weights: {
        emaTrend: 3, emaCross: 2, rsiPull: 1, macd: 2, stoch: 0, bb: 1,
        adxTrend: 3, supertrend: 3, psar: 2, vwap: 4, mtfAlign: 4,
        hurst: 3, williams: 0, cci: 1, donchianBreak: 2,
      },
    },
    "confluence": {
      label: "Balanced Confluence",
      blurb: "Multi-indicator agreement across trend, momentum, and volume. Default.",
      params: {
        rsiPeriod: 14, rsiBuy: 42, rsiSell: 58,
        emaFast: 8, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 22, stochOb: 78,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00012,
        minScore: 4, lookback: 3,
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 1, macd: 1, stoch: 1, bb: 1,
        adxTrend: 2, supertrend: 3, psar: 2, vwap: 2, mtfAlign: 3,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
    "trend": {
      label: "Trend Master",
      blurb: "EMA + ADX + Supertrend heavy. Best in directional trending markets.",
      params: {
        rsiPeriod: 14, rsiBuy: 45, rsiSell: 55,
        emaFast: 5, emaSlow: 13,
        macdFast: 8, macdSlow: 21, macdSignal: 5,
        stochK: 10, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 20, bbMult: 2.2,
        atrPeriod: 14, minAtrPct: 0.00018,
        minScore: 3, lookback: 4,
      },
      weights: {
        emaTrend: 3, emaCross: 3, rsiPull: 0, macd: 1, stoch: 0, bb: 0,
        adxTrend: 3, supertrend: 3, psar: 2, vwap: 2, mtfAlign: 3,
        hurst: 1, williams: 0, cci: 1, donchianBreak: 2,
      },
    },
    "breakout": {
      label: "Breakout Velocity",
      blurb: "Donchian channel breakout with ADX surge and volatility expansion.",
      params: {
        rsiPeriod: 14, rsiBuy: 50, rsiSell: 50,
        emaFast: 5, emaSlow: 13,
        macdFast: 8, macdSlow: 17, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 30, stochOb: 70,
        bbPeriod: 20, bbMult: 1.5,
        atrPeriod: 14, minAtrPct: 0.0002,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 0, macd: 2, stoch: 0, bb: 2,
        adxTrend: 4, supertrend: 3, psar: 1, vwap: 2, mtfAlign: 3,
        hurst: 2, williams: 0, cci: 0, donchianBreak: 4,
      },
    },
    "scalp": {
      label: "1m Ultra Scalp",
      blurb: "Fast EMA + MACD pulse for rapid high-frequency entries.",
      params: {
        rsiPeriod: 7, rsiBuy: 40, rsiSell: 60,
        emaFast: 5, emaSlow: 11,
        macdFast: 6, macdSlow: 13, macdSignal: 5,
        stochK: 7, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 14, bbMult: 1.6,
        atrPeriod: 10, minAtrPct: 0.00015,
        minScore: 3, lookback: 2,
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 1, macd: 2, stoch: 1, bb: 1,
        adxTrend: 2, supertrend: 2, psar: 2, vwap: 1, mtfAlign: 2,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
    "otc": {
      label: "OTC Pro Matrix",
      blurb: "Tailored for Quotex OTC synthetic pairs with adaptive volatility filtering.",
      params: {
        rsiPeriod: 14, rsiBuy: 40, rsiSell: 60,
        emaFast: 8, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 22, stochOb: 78,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00008,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 3, emaCross: 2, rsiPull: 1, macd: 2, stoch: 1, bb: 1,
        adxTrend: 2, supertrend: 3, psar: 2, vwap: 1, mtfAlign: 2,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
    "squeeze": {
      label: "Volatility Squeeze Expansion",
      blurb: "Bollinger compression inside Keltner Channels followed by explosive directional expansion.",
      params: {
        rsiPeriod: 14, rsiBuy: 48, rsiSell: 52,
        emaFast: 6, emaSlow: 18,
        macdFast: 8, macdSlow: 21, macdSignal: 5,
        stochK: 14, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 20, bbMult: 1.8,
        atrPeriod: 14, minAtrPct: 0.00010,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 0, macd: 3, stoch: 1, bb: 3,
        adxTrend: 3, supertrend: 3, psar: 2, vwap: 2, mtfAlign: 3,
        hurst: 2, williams: 1, cci: 1, donchianBreak: 3,
      },
    },
    "ribbon": {
      label: "EMA Ribbon Matrix",
      blurb: "Multiple EMA stack alignment (Fast / Medium / Slow) + ADX trend confirmation.",
      params: {
        rsiPeriod: 14, rsiBuy: 45, rsiSell: 55,
        emaFast: 5, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 25, stochOb: 75,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00015,
        minScore: 3, lookback: 4,
      },
      weights: {
        emaTrend: 4, emaCross: 3, rsiPull: 1, macd: 2, stoch: 0, bb: 0,
        adxTrend: 3, supertrend: 3, psar: 2, vwap: 2, mtfAlign: 3,
        hurst: 1, williams: 0, cci: 0, donchianBreak: 2,
      },
    },
    "momentum_pulse": {
      label: "Momentum Pulse",
      blurb: "Captures rapid price momentum thrusts using MACD histogram acceleration and Parabolic SAR.",
      params: {
        rsiPeriod: 10, rsiBuy: 50, rsiSell: 50,
        emaFast: 5, emaSlow: 15,
        macdFast: 6, macdSlow: 19, macdSignal: 5,
        stochK: 10, stochD: 3, stochOs: 20, stochOb: 80,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00015,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 3, emaCross: 2, rsiPull: 1, macd: 4, stoch: 1, bb: 1,
        adxTrend: 2, supertrend: 3, psar: 3, vwap: 2, mtfAlign: 3,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
  };

  function own(id) {
    return typeof id === "string" && Object.prototype.hasOwnProperty.call(STRATEGIES, id)
      ? STRATEGIES[id] : null;
  }

  function copy(id, strategy) {
    return strategy ? {
      id,
      label: strategy.label,
      blurb: strategy.blurb,
      params: Object.assign({}, strategy.params),
      weights: Object.assign({}, strategy.weights),
    } : null;
  }

  function list() {
    return Object.keys(STRATEGIES).map((id) => copy(id, STRATEGIES[id]));
  }

  function get(id) {
    return copy(id, own(id));
  }

  function defaults() {
    return get("confluence");
  }

  // Engine internals need the preset table, but neither callers nor accidental
  // mutations should be able to alter trading behavior for the rest of the
  // session. Public get/list calls still return independent mutable copies.
  for (const id of Object.keys(STRATEGIES)) {
    Object.freeze(STRATEGIES[id].params);
    Object.freeze(STRATEGIES[id].weights);
    Object.freeze(STRATEGIES[id]);
  }
  Object.freeze(STRATEGIES);

  root.CYBER_STRATEGIES = Object.freeze({ list, get, defaults, STRATEGIES });
})(typeof self !== "undefined" ? self : globalThis);
