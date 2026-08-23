/**
 * Strategy presets — bundles of engine parameters + vote weights for different
 * market regimes. The engine reads `cfg.weights` and the strategy is just a
 * named preset.
 */
(function (root) {
  "use strict";

  const STRATEGIES = {
    "confluence": {
      label: "Balanced Confluence",
      blurb: "Multi-indicator agreement, rejects most bars. Default.",
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
        adxTrend: 1, supertrend: 2, psar: 1, vwap: 1, mtfAlign: 2,
        hurst: 1, williams: 1, cci: 1, donchianBreak: 2,
      },
    },
    "trend": {
      label: "Trend Follower",
      blurb: "EMA + ADX + Supertrend heavy. Best in directional markets.",
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
    "meanrev": {
      label: "Mean Reversion",
      blurb: "Bollinger + Williams + CCI extremes. Best in quiet, ranging markets.",
      params: {
        rsiPeriod: 14, rsiBuy: 30, rsiSell: 70,
        emaFast: 9, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 18, stochOb: 82,
        bbPeriod: 20, bbMult: 1.8,
        atrPeriod: 14, minAtrPct: 0.00008,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 1, emaCross: 0, rsiPull: 2, macd: 1, stoch: 2, bb: 3,
        adxTrend: 1, supertrend: 1, psar: 0, vwap: 1, mtfAlign: 0,
        hurst: 1, williams: 2, cci: 2, donchianBreak: 0,
      },
    },
    "breakout": {
      label: "Breakout",
      blurb: "Donchian + ADX rising + volatility expansion. Best after squeeze.",
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
        emaTrend: 1, emaCross: 1, rsiPull: 0, macd: 1, stoch: 0, bb: 2,
        adxTrend: 3, supertrend: 2, psar: 0, vwap: 1, mtfAlign: 2,
        hurst: 1, williams: 0, cci: 0, donchianBreak: 3,
      },
    },
    "scalp": {
      label: "1m Scalp",
      blurb: "Tighter filters, faster reaction. More trades, lower accuracy.",
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
        emaTrend: 1, emaCross: 2, rsiPull: 1, macd: 1, stoch: 1, bb: 1,
        adxTrend: 1, supertrend: 1, psar: 1, vwap: 0, mtfAlign: 1,
        hurst: 0, williams: 1, cci: 1, donchianBreak: 1,
      },
    },
    "otc": {
      label: "OTC 24/7",
      blurb: "For OTC synthetic pairs — more permissive on low volatility.",
      params: {
        rsiPeriod: 14, rsiBuy: 40, rsiSell: 60,
        emaFast: 8, emaSlow: 21,
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        stochK: 14, stochD: 3, stochOs: 22, stochOb: 78,
        bbPeriod: 20, bbMult: 2,
        atrPeriod: 14, minAtrPct: 0.00005,
        minScore: 3, lookback: 3,
      },
      weights: {
        emaTrend: 2, emaCross: 2, rsiPull: 1, macd: 1, stoch: 1, bb: 1,
        adxTrend: 1, supertrend: 1, psar: 1, vwap: 0, mtfAlign: 1,
        hurst: 0, williams: 1, cci: 1, donchianBreak: 1,
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
