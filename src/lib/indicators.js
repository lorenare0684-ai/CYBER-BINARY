/**
 * Pure indicator library — no DOM, no globals except CYBER_TA.
 * Indicators cover: SMA, EMA, RSI, MACD, Stochastic, Bollinger, ATR,
 * VWAP, ADX, Keltner, Parabolic SAR, Supertrend, Hurst, momentum,
 * Williams %R, CCI, MFI, OBV, Donchian, standard-dev based volatility,
 * and a multi-timeframe resampler.
 */
(function (root) {
  "use strict";

  /* -------- core helpers -------- */

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

  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0 || values.length < period) return out;
    for (let i = period - 1; i < values.length; i++) {
      let s = 0;
      let m = 0;
      for (let j = i - period + 1; j <= i; j++) m += values[j];
      m /= period;
      for (let j = i - period + 1; j <= i; j++) {
        const d = values[j] - m;
        s += d * d;
      }
      out[i] = Math.sqrt(s / period);
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
    const sd = stdev(closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] != null && sd[i] != null) {
        upper[i] = mid[i] + mult * sd[i];
        lower[i] = mid[i] - mult * sd[i];
      }
    }
    return { mid, upper, lower, sd };
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

  /* -------- new indicators -------- */

  /** True range + Directional Movement (ADX / +DI / -DI) */
  function adx(highs, lows, closes, period) {
    const len = closes.length;
    const tr = new Array(len).fill(null);
    const plusDM = new Array(len).fill(null);
    const minusDM = new Array(len).fill(null);
    if (len < 2) return { tr, plus: plusDM, minus: minusDM, adx: new Array(len).fill(null) };

    for (let i = 1; i < len; i++) {
      const up = highs[i] - highs[i - 1];
      const dn = lows[i - 1] - lows[i];
      plusDM[i] = up > dn && up > 0 ? up : 0;
      minusDM[i] = dn > up && dn > 0 ? dn : 0;
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      tr[i] = Math.max(hl, hc, lc);
    }
    const trN = ema(tr, period);
    const plusN = ema(plusDM, period);
    const minusN = ema(minusDM, period);

    const plusDI = new Array(len).fill(null);
    const minusDI = new Array(len).fill(null);
    const dx = new Array(len).fill(null);
    for (let i = 0; i < len; i++) {
      if (trN[i] != null && trN[i] > 0) {
        plusDI[i] = (plusN[i] / trN[i]) * 100;
        minusDI[i] = (minusN[i] / trN[i]) * 100;
        const sum = plusDI[i] + minusDI[i];
        dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
      }
    }
    const adxArr = ema(dx, period);
    return { tr: trN, plus: plusDI, minus: minusDI, adx: adxArr };
  }

  /** Keltner channels (EMA + ATR) */
  function keltner(highs, lows, closes, period, mult) {
    const mid = ema(closes, period);
    const a = atr(highs, lows, closes, period);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] != null && a[i] != null) {
        upper[i] = mid[i] + mult * a[i];
        lower[i] = mid[i] - mult * a[i];
      }
    }
    return { mid, upper, lower, atr: a };
  }

  /** Parabolic SAR */
  function psar(highs, lows, opts) {
    const step = (opts && opts.step) || 0.02;
    const max = (opts && opts.max) || 0.2;
    const out = new Array(highs.length).fill(null);
    if (highs.length < 2) return out;
    let bull = highs[0] > highs[1]; // start with assumed trend
    let af = step;
    let ep = bull ? highs[0] : lows[0];
    let sar = bull ? lows[0] : highs[0];
    out[0] = sar;
    for (let i = 1; i < highs.length; i++) {
      sar = sar + af * (ep - sar);
      if (bull) {
        if (lows[i] < sar) {
          bull = false;
          sar = ep;
          ep = lows[i];
          af = step;
        } else {
          if (highs[i] > ep) {
            ep = highs[i];
            af = Math.min(max, af + step);
          }
        }
      } else {
        if (highs[i] > sar) {
          bull = true;
          sar = ep;
          ep = highs[i];
          af = step;
        } else {
          if (lows[i] < ep) {
            ep = lows[i];
            af = Math.min(max, af + step);
          }
        }
      }
      out[i] = sar;
    }
    return out;
  }

  /** Supertrend (ATR-based) */
  function supertrend(highs, lows, closes, period, mult) {
    const a = atr(highs, lows, closes, period);
    const len = closes.length;
    const upper = new Array(len).fill(null);
    const lower = new Array(len).fill(null);
    const st = new Array(len).fill(null);
    const trend = new Array(len).fill(null);
    for (let i = 0; i < len; i++) {
      if (a[i] == null) continue;
      const hl2 = (highs[i] + lows[i]) / 2;
      upper[i] = hl2 + mult * a[i];
      lower[i] = hl2 - mult * a[i];
    }
    for (let i = 1; i < len; i++) {
      if (upper[i] == null) continue;
      if (upper[i] < upper[i - 1] || closes[i - 1] > upper[i - 1]) {
        // keep
      } else {
        upper[i] = upper[i - 1];
      }
      if (lower[i] > lower[i - 1] || closes[i - 1] < lower[i - 1]) {
        // keep
      } else {
        lower[i] = lower[i - 1];
      }
      if (st[i - 1] == null) {
        st[i] = closes[i] > upper[i] ? lower[i] : upper[i];
        trend[i] = closes[i] > upper[i] ? 1 : -1;
      } else if (st[i - 1] === upper[i - 1]) {
        if (closes[i] > upper[i]) {
          st[i] = lower[i];
          trend[i] = 1;
        } else {
          st[i] = upper[i];
          trend[i] = -1;
        }
      } else {
        if (closes[i] < lower[i]) {
          st[i] = upper[i];
          trend[i] = -1;
        } else {
          st[i] = lower[i];
          trend[i] = 1;
        }
      }
    }
    return { upper, lower, st, trend };
  }

  /** VWAP — uses typical price, cumulative. Suitable for intraday resampling. */
  function vwap(highs, lows, closes, volumes) {
    const len = closes.length;
    const out = new Array(len).fill(null);
    let cumPV = 0;
    let cumV = 0;
    for (let i = 0; i < len; i++) {
      const v = volumes && volumes[i] != null ? volumes[i] : 1;
      const tp = (highs[i] + lows[i] + closes[i]) / 3;
      cumPV += tp * v;
      cumV += v;
      out[i] = cumV > 0 ? cumPV / cumV : tp;
    }
    return out;
  }

  /** Hurst exponent over a window — measures trend strength (0.5=random, >0.5=trending) */
  function hurst(closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      const slice = closes.slice(i - period + 1, i + 1);
      const n = slice.length;
      const mean = slice.reduce((a, b) => a + b, 0) / n;
      let cumDev = 0;
      let maxCum = 0;
      let minCum = 0;
      for (let j = 0; j < n; j++) {
        cumDev += slice[j] - mean;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
      }
      const R = maxCum - minCum;
      let s = 0;
      for (let j = 0; j < n; j++) s += (slice[j] - mean) ** 2;
      s = Math.sqrt(s / n);
      out[i] = s > 0 ? Math.log(R / s) / Math.log(n) : 0.5;
    }
    return out;
  }

  /** Momentum — current close vs N bars ago, normalized by stdev. */
  function momentum(closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period; i < closes.length; i++) {
      const base = closes[i - period];
      out[i] = base !== 0 ? ((closes[i] - base) / base) * 100 : 0;
    }
    return out;
  }

  /** Williams %R */
  function williamsR(highs, lows, closes, period) {
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      const range = hh - ll;
      out[i] = range === 0 ? -50 : ((hh - closes[i]) / range) * -100;
    }
    return out;
  }

  /** Commodity Channel Index */
  function cci(highs, lows, closes, period) {
    const tp = closes.map((_, i) => (highs[i] + lows[i] + closes[i]) / 3);
    const smaTP = sma(tp, period);
    const out = new Array(closes.length).fill(null);
    for (let i = period - 1; i < closes.length; i++) {
      let mad = 0;
      for (let j = i - period + 1; j <= i; j++) mad += Math.abs(tp[j] - smaTP[i]);
      mad /= period;
      out[i] = mad === 0 ? 0 : (tp[i] - smaTP[i]) / (0.015 * mad);
    }
    return out;
  }

  /** Money Flow Index */
  function mfi(highs, lows, closes, volumes, period) {
    const out = new Array(closes.length).fill(null);
    if (!volumes) return out;
    for (let i = period; i < closes.length; i++) {
      let pos = 0;
      let neg = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const tp = (highs[j] + lows[j] + closes[j]) / 3;
        const tpPrev = (highs[j - 1] + lows[j - 1] + closes[j - 1]) / 3;
        const flow = tp * volumes[j];
        if (tp > tpPrev) pos += flow;
        else if (tp < tpPrev) neg += flow;
      }
      out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    return out;
  }

  /** On-Balance Volume */
  function obv(closes, volumes) {
    const out = new Array(closes.length).fill(null);
    if (!volumes || volumes.length === 0) return out;
    out[0] = 0;
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] > closes[i - 1]) out[i] = out[i - 1] + volumes[i];
      else if (closes[i] < closes[i - 1]) out[i] = out[i - 1] - volumes[i];
      else out[i] = out[i - 1];
    }
    return out;
  }

  /** Donchian channels (highest high / lowest low over period) */
  function donchian(highs, lows, period) {
    const upper = new Array(highs.length).fill(null);
    const lower = new Array(lows.length).fill(null);
    for (let i = period - 1; i < highs.length; i++) {
      let hh = -Infinity;
      let ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (highs[j] > hh) hh = highs[j];
        if (lows[j] < ll) ll = lows[j];
      }
      upper[i] = hh;
      lower[i] = ll;
    }
    return { upper, lower, mid: upper.map((u, i) => u == null ? null : (u + lower[i]) / 2) };
  }

  /* -------- multi-timeframe resampler -------- */

  /** Resample a 1m candle series into N-minute bars. */
  function resample(candles, minutes) {
    if (minutes <= 1) return candles.slice();
    const bucketMs = minutes * 60000;
    const out = [];
    let cur = null;
    for (const c of candles) {
      const t = Math.floor(c.time / bucketMs) * bucketMs;
      if (!cur || cur.time !== t) {
        if (cur) out.push(cur);
        cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close };
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function lastValid(arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null && !Number.isNaN(arr[i])) return { value: arr[i], index: i };
    }
    return { value: null, index: -1 };
  }

  /** Score-based confidence calibration — softmax of weighted vote scores. */
  function softmaxProbs(callScore, putScore) {
    const k = 2.5; // temperature
    const eC = Math.exp(k * callScore);
    const eP = Math.exp(k * putScore);
    const sum = eC + eP + 1e-9;
    return { call: eC / sum, put: eP / sum };
  }

  root.CYBER_TA = {
    sma,
    ema,
    stdev,
    rsi,
    macd,
    stochastic,
    bollinger,
    atr,
    adx,
    keltner,
    psar,
    supertrend,
    vwap,
    hurst,
    momentum,
    williamsR,
    cci,
    mfi,
    obv,
    donchian,
    resample,
    lastValid,
    softmaxProbs,
  };
})(typeof self !== "undefined" ? self : globalThis);
