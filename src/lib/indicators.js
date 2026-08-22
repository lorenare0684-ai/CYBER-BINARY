/**
 * Pure indicator library — no DOM, no globals except CYBER_TA.
 */
(function (root) {
  "use strict";

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0 || values.length < period) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0 || values.length < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) prev += values[i];
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsi(closes, period) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d;
      else loss -= d;
    }
    gain /= period;
    loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function macd(closes, fast, slow, signal) {
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) =>
      ef[i] == null || es[i] == null ? null : ef[i] - es[i]
    );
    const compact = [];
    const map = [];
    for (let i = 0; i < line.length; i++) {
      if (line[i] != null) {
        map.push(i);
        compact.push(line[i]);
      }
    }
    const sigCompact = ema(compact, signal);
    const sig = new Array(closes.length).fill(null);
    const hist = new Array(closes.length).fill(null);
    for (let j = 0; j < compact.length; j++) {
      const i = map[j];
      sig[i] = sigCompact[j];
      if (sig[i] != null) hist[i] = line[i] - sig[i];
    }
    return { line, signal: sig, hist };
  }

  function stochastic(highs, lows, closes, kPeriod, dPeriod) {
    const k = new Array(closes.length).fill(null);
    for (let i = kPeriod - 1; i < closes.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      const range = hh - ll;
      k[i] = range === 0 ? 50 : ((closes[i] - ll) / range) * 100;
    }
    const d = sma(
      k.map((v) => (v == null ? 0 : v)),
      dPeriod
    );
    for (let i = 0; i < d.length; i++) {
      if (k[i] == null) d[i] = null;
    }
    return { k, d };
  }

  function bollinger(closes, period, mult) {
    const mid = sma(closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let v = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = closes[j] - mid[i];
        v += d * d;
      }
      const sd = Math.sqrt(v / period);
      upper[i] = mid[i] + mult * sd;
      lower[i] = mid[i] - mult * sd;
    }
    return { mid, upper, lower };
  }

  function atr(highs, lows, closes, period) {
    const tr = new Array(closes.length).fill(null);
    tr[0] = highs[0] - lows[0];
    for (let i = 1; i < closes.length; i++) {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr[i] = Math.max(hl, hc, lc);
    }
    return ema(tr, period);
  }

  function lastValid(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null && !Number.isNaN(arr[i])) return { value: arr[i], index: i };
    }
    return { value: null, index: -1 };
  }

  root.CYBER_TA = {
    sma,
    ema,
    rsi,
    macd,
    stochastic,
    bollinger,
    atr,
    lastValid,
  };
})(typeof self !== "undefined" ? self : globalThis);
