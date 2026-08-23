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

  function numeric(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return NaN;
    try { return Number(value); } catch (_) { return NaN; }
  }

  function sma(values, period) {
    const len = Array.isArray(values) ? values.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period <= 0 || len < period) return out;
    // Accumulate period-scaled terms so a valid mean of several very large
    // finite values does not overflow an intermediate running sum.
    let meanSum = 0;
    for (let i = 0; i < len; i++) {
      const n = numeric(values[i]);
      if (!Number.isFinite(n)) return out;
      meanSum += n / period;
      if (i >= period) meanSum -= numeric(values[i - period]) / period;
      if (!Number.isFinite(meanSum)) return new Array(len).fill(null);
      if (i >= period - 1) out[i] = meanSum;
    }
    return out;
  }

  function ema(values, period) {
    const len = Array.isArray(values) ? values.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period <= 0 || len < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) {
      const n = numeric(values[i]);
      if (!Number.isFinite(n)) return out;
      prev += n / period;
      if (!Number.isFinite(prev)) return out;
    }
    out[period - 1] = prev;
    for (let i = period; i < len; i++) {
      const n = numeric(values[i]);
      if (!Number.isFinite(n)) break;
      const next = n * k + prev * (1 - k);
      if (!Number.isFinite(next)) break;
      prev = next;
      out[i] = prev;
    }
    return out;
  }

  /** Wilder's moving average (RMA/SMMA), used by ATR and ADX. */
  function rma(values, period) {
    const len = Array.isArray(values) ? values.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period <= 0 || len < period) return out;
    let prev = 0;
    for (let i = 0; i < period; i++) {
      const n = numeric(values[i]);
      if (!Number.isFinite(n)) return out;
      prev += n / period;
      if (!Number.isFinite(prev)) return out;
    }
    out[period - 1] = prev;
    const oldWeight = (period - 1) / period;
    for (let i = period; i < len; i++) {
      const n = numeric(values[i]);
      if (!Number.isFinite(n)) break;
      const next = prev * oldWeight + n / period;
      if (!Number.isFinite(next)) break;
      prev = next;
      out[i] = prev;
    }
    return out;
  }

  function stdev(values, period) {
    const len = Array.isArray(values) ? values.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period <= 0 || len < period) return out;
    const nums = new Array(len);
    for (let i = 0; i < len; i++) {
      const n = numeric(values[i]);
      if (!Number.isFinite(n)) return out;
      nums[i] = n;
    }
    for (let i = period - 1; i < len; i++) {
      let scale = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const absVal = Math.abs(nums[j]);
        if (absVal > scale) scale = absVal;
      }
      if (scale === 0) { out[i] = 0; continue; }
      let scaledMean = 0;
      for (let j = i - period + 1; j <= i; j++) scaledMean += (nums[j] / scale) / period;
      let scaledSquares = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = nums[j] / scale - scaledMean;
        scaledSquares += (d * d) / period;
      }
      const result = Math.sqrt(scaledSquares) * scale;
      out[i] = Number.isFinite(result) ? result : null;
    }
    return out;
  }

  function rsi(closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period <= 0 || len <= period) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= period; i++) {
      const cur = numeric(closes[i]), prior = numeric(closes[i - 1]);
      if (!Number.isFinite(cur) || !Number.isFinite(prior)) return out;
      const d = cur - prior;
      if (!Number.isFinite(d)) return out;
      if (d >= 0) gain += d / period;
      else loss += (-d) / period;
      if (!Number.isFinite(gain) || !Number.isFinite(loss)) return out;
    }
    out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    for (let i = period + 1; i < len; i++) {
      const cur = numeric(closes[i]), prior = numeric(closes[i - 1]);
      if (!Number.isFinite(cur) || !Number.isFinite(prior)) break;
      const d = cur - prior;
      if (!Number.isFinite(d)) break;
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      const oldWeight = (period - 1) / period;
      gain = gain * oldWeight + g / period;
      loss = loss * oldWeight + l / period;
      if (!Number.isFinite(gain) || !Number.isFinite(loss)) break;
      out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  function macd(closes, fast, slow, signal) {
    closes = Array.isArray(closes) ? closes : [];
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

  /**
   * v2.6.5: clamp a bar's high/low into the valid range instead of voiding
   * the whole indicator. One glitched live update (h < l or close outside
   * the range) used to blank every oscillator on the chart; now the bar is
   * repaired to the closest valid OHLC and the series keeps flowing.
   * Non-finite values still void the result (genuinely unusable input).
   */
  function clampHighLow(h, l, o, c) {
    return { high: Math.max(h, l, o, c), low: Math.min(h, l, o, c) };
  }

  function stochastic(highs, lows, closes, kPeriod, dPeriod) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const k = new Array(len).fill(null);
    kPeriod = Math.floor(numeric(kPeriod));
    dPeriod = Math.floor(numeric(dPeriod));
    if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== len || lows.length !== len ||
        !Number.isFinite(kPeriod) || !Number.isFinite(dPeriod) || kPeriod <= 0 || dPeriod <= 0) {
      return { k, d: new Array(len).fill(null) };
    }
    const hNums = new Array(len), lNums = new Array(len), cNums = new Array(len);
    for (let i = 0; i < len; i++) {
      const h = numeric(highs[i]), l = numeric(lows[i]), c = numeric(closes[i]);
      if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
        return { k, d: new Array(len).fill(null) };
      }
      const clamped = clampHighLow(h, l, c, c);
      hNums[i] = clamped.high; lNums[i] = clamped.low; cNums[i] = c;
    }
    for (let i = kPeriod - 1; i < len; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - kPeriod + 1; j <= i; j++) {
        if (hNums[j] > hh) hh = hNums[j];
        if (lNums[j] < ll) ll = lNums[j];
      }
      const range = hh - ll;
      k[i] = range === 0 ? 50 : ((cNums[i] - ll) / range) * 100;
    }
    const d = new Array(len).fill(null);
    const compact = [];
    const indices = [];
    for (let i = 0; i < k.length; i++) {
      if (k[i] != null) { compact.push(k[i]); indices.push(i); }
    }
    const dCompact = sma(compact, dPeriod);
    for (let i = 0; i < dCompact.length; i++) {
      if (dCompact[i] != null) d[indices[i]] = dCompact[i];
    }
    return { k, d };
  }

  function bollinger(closes, period, mult) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const mid = sma(closes, period);
    const sd = stdev(closes, period);
    const upper = new Array(len).fill(null);
    const lower = new Array(len).fill(null);
    mult = numeric(mult);
    if (!Number.isFinite(mult) || mult < 0) return { mid, upper, lower, sd };
    for (let i = 0; i < len; i++) {
      if (mid[i] != null && sd[i] != null) {
        const up = mid[i] + mult * sd[i];
        const down = mid[i] - mult * sd[i];
        if (Number.isFinite(up) && Number.isFinite(down)) {
          upper[i] = up;
          lower[i] = down;
        }
      }
    }
    return { mid, upper, lower, sd };
  }

  function atr(highs, lows, closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    if (!Array.isArray(highs) || !Array.isArray(lows) || !len || highs.length !== len || lows.length !== len) return [];
    const tr = new Array(len).fill(null);
    const firstHigh = numeric(highs[0]), firstLow = numeric(lows[0]), firstClose = numeric(closes[0]);
    if (!Number.isFinite(firstHigh) || !Number.isFinite(firstLow) || !Number.isFinite(firstClose)) return tr;
    const firstClamped = clampHighLow(firstHigh, firstLow, firstClose, firstClose);
    tr[0] = firstClamped.high - firstClamped.low;
    for (let i = 1; i < len; i++) {
      const high = numeric(highs[i]), low = numeric(lows[i]);
      const currentClose = numeric(closes[i]), previousClose = numeric(closes[i - 1]);
      if (!Number.isFinite(high) || !Number.isFinite(low) ||
          !Number.isFinite(currentClose) || !Number.isFinite(previousClose)) return new Array(len).fill(null);
      const clamped = clampHighLow(high, low, currentClose, currentClose);
      const hl = clamped.high - clamped.low;
      const hc = Math.abs(clamped.high - previousClose);
      const lc = Math.abs(clamped.low - previousClose);
      tr[i] = Math.max(hl, hc, lc);
    }
    return rma(tr, period);
  }

  function adx(highs, lows, closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const tr = new Array(len).fill(null);
    const plusDM = new Array(len).fill(null);
    const minusDM = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== len || lows.length !== len ||
        !Number.isFinite(period) || period <= 0 || len < 2) {
      return { tr, plus: plusDM, minus: minusDM, adx: new Array(len).fill(null) };
    }
    const firstHigh = numeric(highs[0]), firstLow = numeric(lows[0]), firstClose = numeric(closes[0]);
    if (!Number.isFinite(firstHigh) || !Number.isFinite(firstLow) || !Number.isFinite(firstClose)) {
      return { tr, plus: plusDM, minus: minusDM, adx: new Array(len).fill(null) };
    }
    const firstClamped = clampHighLow(firstHigh, firstLow, firstClose, firstClose);
    tr[0] = firstClamped.high - firstClamped.low;
    plusDM[0] = 0;
    minusDM[0] = 0;

    for (let i = 1; i < len; i++) {
      const high = numeric(highs[i]), priorHigh = numeric(highs[i - 1]);
      const low = numeric(lows[i]), priorLow = numeric(lows[i - 1]);
      const close = numeric(closes[i]), priorClose = numeric(closes[i - 1]);
      if (![high, priorHigh, low, priorLow, close, priorClose].every(Number.isFinite)) {
        return { tr, plus: plusDM, minus: minusDM, adx: new Array(len).fill(null) };
      }
      const clamped = clampHighLow(high, low, close, close);
      const clampedPrev = clampHighLow(priorHigh, priorLow, priorClose, priorClose);
      const up = clamped.high - clampedPrev.high;
      const dn = clampedPrev.low - clamped.low;
      plusDM[i] = up > dn && up > 0 ? up : 0;
      minusDM[i] = dn > up && dn > 0 ? dn : 0;
      const hl = clamped.high - clamped.low;
      const hc = Math.abs(clamped.high - priorClose);
      const lc = Math.abs(clamped.low - priorClose);
      tr[i] = Math.max(hl, hc, lc);
    }
    const trN = rma(tr, period);
    const plusN = rma(plusDM, period);
    const minusN = rma(minusDM, period);

    const plusDI = new Array(len).fill(null);
    const minusDI = new Array(len).fill(null);
    const dx = new Array(len).fill(null);
    for (let i = 0; i < len; i++) {
      if (trN[i] == null || plusN[i] == null || minusN[i] == null) continue;
      if (trN[i] === 0) {
        plusDI[i] = 0;
        minusDI[i] = 0;
        dx[i] = 0;
      } else if (trN[i] > 0) {
        plusDI[i] = (plusN[i] / trN[i]) * 100;
        minusDI[i] = (minusN[i] / trN[i]) * 100;
        const sum = plusDI[i] + minusDI[i];
        dx[i] = sum === 0 ? 0 : (Math.abs(plusDI[i] - minusDI[i]) / sum) * 100;
      }
    }
    const adxArr = new Array(len).fill(null);
    const compactDx = [];
    const dxIndices = [];
    for (let i = 0; i < len; i++) {
      if (dx[i] != null && Number.isFinite(dx[i])) { compactDx.push(dx[i]); dxIndices.push(i); }
    }
    const smoothDx = rma(compactDx, period);
    for (let i = 0; i < smoothDx.length; i++) {
      if (smoothDx[i] != null) adxArr[dxIndices[i]] = smoothDx[i];
    }
    return { tr: trN, plus: plusDI, minus: minusDI, adx: adxArr };
  }

  function keltner(highs, lows, closes, period, mult) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const mid = ema(closes, period);
    const a = atr(highs, lows, closes, period);
    const upper = new Array(len).fill(null);
    const lower = new Array(len).fill(null);
    mult = numeric(mult);
    if (!Number.isFinite(mult) || mult < 0) return { mid, upper, lower, atr: a };
    for (let i = 0; i < len; i++) {
      if (mid[i] != null && a[i] != null) {
        const up = mid[i] + mult * a[i];
        const down = mid[i] - mult * a[i];
        if (Number.isFinite(up) && Number.isFinite(down)) {
          upper[i] = up;
          lower[i] = down;
        }
      }
    }
    return { mid, upper, lower, atr: a };
  }

  function psar(highs, lows, opts) {
    const requestedStep = numeric(opts && opts.step);
    const requestedMax = numeric(opts && opts.max);
    const step = Number.isFinite(requestedStep) && requestedStep > 0 ? Math.min(1, requestedStep) : 0.02;
    const max = Number.isFinite(requestedMax) && requestedMax >= step
      ? Math.min(1, requestedMax) : Math.max(0.2, step);
    const len = Array.isArray(highs) ? highs.length : 0;
    const out = new Array(len).fill(null);
    if (!Array.isArray(lows) || lows.length !== len || len < 2) return out;
    const hNums = new Array(len), lNums = new Array(len);
    for (let i = 0; i < len; i++) {
      const high = numeric(highs[i]), low = numeric(lows[i]);
      if (!Number.isFinite(high) || !Number.isFinite(low)) return out;
      const clamped = clampHighLow(high, low, high, low);
      hNums[i] = clamped.high; lNums[i] = clamped.low;
    }
    let bull = (hNums[1] + lNums[1]) >= (hNums[0] + lNums[0]);
    let af = step;
    let ep = bull ? Math.max(hNums[0], hNums[1]) : Math.min(lNums[0], lNums[1]);
    let sar = bull ? Math.min(lNums[0], lNums[1]) : Math.max(hNums[0], hNums[1]);
    out[0] = sar;
    for (let i = 1; i < len; i++) {
      sar = sar + af * (ep - sar);
      if (bull) sar = Math.min(sar, lNums[i - 1], i > 1 ? lNums[i - 2] : lNums[i - 1]);
      else sar = Math.max(sar, hNums[i - 1], i > 1 ? hNums[i - 2] : hNums[i - 1]);
      if (bull) {
        if (lNums[i] < sar) {
          bull = false;
          sar = ep;
          ep = lNums[i];
          af = step;
        } else {
          if (hNums[i] > ep) {
            ep = hNums[i];
            af = Math.min(max, af + step);
          }
        }
      } else {
        if (hNums[i] > sar) {
          bull = true;
          sar = ep;
          ep = hNums[i];
          af = step;
        } else {
          if (lNums[i] < ep) {
            ep = lNums[i];
            af = Math.min(max, af + step);
          }
        }
      }
      out[i] = sar;
    }
    return out;
  }

  function supertrend(highs, lows, closes, period, mult) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const a = atr(highs, lows, closes, period);
    const upper = new Array(len).fill(null);
    const lower = new Array(len).fill(null);
    const st = new Array(len).fill(null);
    const trend = new Array(len).fill(null);
    mult = numeric(mult);
    if (!Number.isFinite(mult) || mult <= 0 || !Array.isArray(highs) || !Array.isArray(lows) ||
        highs.length !== len || lows.length !== len) return { upper, lower, st, trend };
    const hNums = new Array(len), lNums = new Array(len), cNums = new Array(len);
    for (let i = 0; i < len; i++) {
      const high = numeric(highs[i]), low = numeric(lows[i]), close = numeric(closes[i]);
      if (![high, low, close].every(Number.isFinite)) {
        return { upper, lower, st, trend };
      }
      const clamped = clampHighLow(high, low, close, close);
      hNums[i] = clamped.high; lNums[i] = clamped.low; cNums[i] = close;
      if (a[i] == null) continue;
      const hl2 = (high + low) / 2;
      upper[i] = hl2 + mult * a[i];
      lower[i] = hl2 - mult * a[i];
    }
    for (let i = 1; i < len; i++) {
      if (upper[i] == null) continue;
      if (upper[i - 1] == null) {
        trend[i] = cNums[i] >= cNums[i - 1] ? 1 : -1;
        st[i] = trend[i] === 1 ? lower[i] : upper[i];
        continue;
      }
      if (upper[i] < upper[i - 1] || cNums[i - 1] > upper[i - 1]) {
      } else {
        upper[i] = upper[i - 1];
      }
      if (lower[i] > lower[i - 1] || cNums[i - 1] < lower[i - 1]) {
      } else {
        lower[i] = lower[i - 1];
      }
      if (st[i - 1] == null) {
        st[i] = cNums[i] > upper[i] ? lower[i] : upper[i];
        trend[i] = cNums[i] > upper[i] ? 1 : -1;
      } else if (st[i - 1] === upper[i - 1]) {
        if (cNums[i] > upper[i]) {
          st[i] = lower[i];
          trend[i] = 1;
        } else {
          st[i] = upper[i];
          trend[i] = -1;
        }
      } else {
        if (cNums[i] < lower[i]) {
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

  function vwap(highs, lows, closes, volumes) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== len || lows.length !== len) return out;
    let cumPV = 0;
    let cumV = 0;
    for (let i = 0; i < len; i++) {
      const high = numeric(highs[i]), low = numeric(lows[i]), close = numeric(closes[i]);
      if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) continue;
      const rawVolume = volumes && volumes[i] != null ? numeric(volumes[i]) : 1;
      const v = Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : 0;
      const clamped = clampHighLow(high, low, close, close);
      const tp = (clamped.high + clamped.low + close) / 3;
      const nextPV = cumPV + tp * v;
      const nextV = cumV + v;
      if (!Number.isFinite(nextPV) || !Number.isFinite(nextV)) continue;
      cumPV = nextPV;
      cumV = nextV;
      out[i] = cumV > 0 ? cumPV / cumV : tp;
    }
    return out;
  }

  function hurst(closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period < 2 || len < period) return out;
    const nums = new Array(len);
    for (let i = 0; i < len; i++) {
      const n = numeric(closes[i]);
      if (!Number.isFinite(n)) return out;
      nums[i] = n;
    }
    const logN = Math.log(period);
    for (let i = period - 1; i < len; i++) {
      const start = i - period + 1;
      let sum = 0;
      for (let j = start; j <= i; j++) sum += nums[j];
      const mean = sum / period;
      let cumDev = 0, maxCum = 0, minCum = 0, sumSq = 0;
      for (let j = start; j <= i; j++) {
        const diff = nums[j] - mean;
        cumDev += diff;
        if (cumDev > maxCum) maxCum = cumDev;
        if (cumDev < minCum) minCum = cumDev;
        sumSq += diff * diff;
      }
      const R = maxCum - minCum;
      const s = Math.sqrt(sumSq / period);
      out[i] = s > 0 ? Math.log(R / s) / logN : 0.5;
    }
    return out;
  }

  function momentum(closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Number.isFinite(period) || period <= 0) return out;
    for (let i = period; i < len; i++) {
      const base = numeric(closes[i - period]), current = numeric(closes[i]);
      if (!Number.isFinite(base) || !Number.isFinite(current)) continue;
      out[i] = base !== 0 ? ((current - base) / base) * 100 : 0;
    }
    return out;
  }

  function williamsR(highs, lows, closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== len || lows.length !== len ||
        !Number.isFinite(period) || period <= 0) return out;
    const hNums = new Array(len), lNums = new Array(len), cNums = new Array(len);
    for (let i = 0; i < len; i++) {
      const h = numeric(highs[i]), l = numeric(lows[i]), c = numeric(closes[i]);
      if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) {
        return out;
      }
      const clamped = clampHighLow(h, l, c, c);
      hNums[i] = clamped.high; lNums[i] = clamped.low; cNums[i] = c;
    }
    for (let i = period - 1; i < len; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (hNums[j] > hh) hh = hNums[j];
        if (lNums[j] < ll) ll = lNums[j];
      }
      const range = hh - ll;
      out[i] = range === 0 ? -50 : ((hh - cNums[i]) / range) * -100;
    }
    return out;
  }

  function cci(highs, lows, closes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Array.isArray(highs) || !Array.isArray(lows) || highs.length !== len || lows.length !== len ||
        !Number.isFinite(period) || period <= 0) return out;
    const tp = new Array(len);
    for (let i = 0; i < len; i++) {
      const high = numeric(highs[i]), low = numeric(lows[i]), close = numeric(closes[i]);
      if (![high, low, close].every(Number.isFinite)) return out;
      const clamped = clampHighLow(high, low, close, close);
      tp[i] = (clamped.high + clamped.low + close) / 3;
    }
    const smaTP = sma(tp, period);
    for (let i = period - 1; i < len; i++) {
      if (smaTP[i] == null || !Number.isFinite(tp[i])) continue;
      let mad = 0;
      for (let j = i - period + 1; j <= i; j++) mad += Math.abs(tp[j] - smaTP[i]);
      mad /= period;
      if (!Number.isFinite(mad)) continue;
      out[i] = mad === 0 ? 0 : (tp[i] - smaTP[i]) / (0.015 * mad);
    }
    return out;
  }

  function mfi(highs, lows, closes, volumes, period) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Array.isArray(highs) || !Array.isArray(lows) || !Array.isArray(volumes) ||
        highs.length !== len || lows.length !== len || volumes.length < len ||
        !Number.isFinite(period) || period <= 0) return out;
    for (let i = period; i < len; i++) {
      let pos = 0, neg = 0, valid = true;
      for (let j = i - period + 1; j <= i; j++) {
        const values = [highs[j], lows[j], closes[j], highs[j - 1], lows[j - 1], closes[j - 1], volumes[j]].map(numeric);
        if (!values.every(Number.isFinite) || values[6] < 0) {
          valid = false; break;
        }
        const clamped = clampHighLow(values[0], values[1], values[2], values[2]);
        const clampedPrev = clampHighLow(values[3], values[4], values[5], values[5]);
        const tp = (clamped.high + clamped.low + values[2]) / 3;
        const tpPrev = (clampedPrev.high + clampedPrev.low + values[5]) / 3;
        const flow = tp * values[6];
        if (tp > tpPrev) pos += flow;
        else if (tp < tpPrev) neg += flow;
      }
      if (!valid) continue;
      out[i] = neg === 0 ? (pos === 0 ? 50 : 100) : 100 - 100 / (1 + pos / neg);
    }
    return out;
  }

  function obv(closes, volumes) {
    const len = Array.isArray(closes) ? closes.length : 0;
    const out = new Array(len).fill(null);
    if (!Array.isArray(volumes) || volumes.length < len || !len) return out;
    const initialClose = numeric(closes[0]);
    const initialVolume = numeric(volumes[0]);
    if (!Number.isFinite(initialClose) || !Number.isFinite(initialVolume) || initialVolume < 0) return out;
    out[0] = 0;
    for (let i = 1; i < len; i++) {
      const close = numeric(closes[i]), prior = numeric(closes[i - 1]), volume = numeric(volumes[i]);
      if (!Number.isFinite(close) || !Number.isFinite(prior) || !Number.isFinite(volume) || volume < 0) break;
      const next = close > prior ? out[i - 1] + volume
        : (close < prior ? out[i - 1] - volume : out[i - 1]);
      if (!Number.isFinite(next)) break;
      out[i] = next;
    }
    return out;
  }

  function donchian(highs, lows, period) {
    const len = Array.isArray(highs) ? highs.length : 0;
    const upper = new Array(len).fill(null);
    const lower = new Array(len).fill(null);
    period = Math.floor(numeric(period));
    if (!Array.isArray(lows) || lows.length !== len || !Number.isFinite(period) || period <= 0) {
      return { upper, lower, mid: upper.slice() };
    }
    const hNums = new Array(len), lNums = new Array(len);
    for (let i = 0; i < len; i++) {
      const h = numeric(highs[i]), l = numeric(lows[i]);
      if (!Number.isFinite(h) || !Number.isFinite(l)) {
        return { upper, lower, mid: upper.slice() };
      }
      const clamped = clampHighLow(h, l, h, l);
      hNums[i] = clamped.high; lNums[i] = clamped.low;
    }
    for (let i = period - 1; i < len; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        if (hNums[j] > hh) hh = hNums[j];
        if (lNums[j] < ll) ll = lNums[j];
      }
      upper[i] = hh;
      lower[i] = ll;
    }
    const mid = new Array(len).fill(null);
    for (let i = period - 1; i < len; i++) {
      mid[i] = (upper[i] + lower[i]) / 2;
    }
    return { upper, lower, mid };
  }

  function resample(candles, minutes) {
    if (!Array.isArray(candles)) return [];
    minutes = Math.floor(numeric(minutes));
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) return [];
    let clean = [];
    let ordered = true;
    let lastTime = -Infinity;
    const reducedTime = (value) => {
      let n = numeric(value);
      if (!Number.isFinite(n)) return null;
      while (Math.abs(n) >= 1e14) n /= 1000;
      return n;
    };
    const rawTimes = [];
    for (const candle of candles) {
      const raw = candle && typeof candle === "object" ? reducedTime(candle.time) : null;
      if (raw != null) rawTimes.push(raw);
      if (rawTimes.length === 2) break;
    }
    const rawSpacing = rawTimes.length > 1 ? Math.abs(rawTimes[1] - rawTimes[0]) : 0;
    const timeScale = rawTimes.length && Math.abs(rawTimes[0]) >= 1e11 ? 1
      : (rawTimes.length && Math.abs(rawTimes[0]) >= 1e9 ? 1000 : (rawSpacing >= 1000 ? 1 : 1000));
    for (const c of candles) {
      if (!c || typeof c !== "object") continue;
      const rawTime = reducedTime(c.time);
      const time = rawTime == null ? NaN : Math.floor(rawTime * timeScale);
      const open = numeric(c.open), close = numeric(c.close);
      const rawHigh = numeric(c.high), rawLow = numeric(c.low);
      if (![time, open, close, rawHigh, rawLow].every(Number.isFinite) || !Number.isSafeInteger(time) ||
          time < 0 || open <= 0 || close <= 0 || rawHigh <= 0 || rawLow <= 0) continue;
      const high = Math.max(rawHigh, rawLow, open, close);
      const low = Math.min(rawHigh, rawLow, open, close);
      const rawVolume = numeric(c.volume);
      if (time <= lastTime) ordered = false;
      lastTime = time;
      clean.push({
        time, open, high, low, close,
        volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? rawVolume : 0,
      });
    }
    if (!ordered) {
      const byTime = new Map();
      for (const c of clean) byTime.set(c.time, c);
      clean = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    }
    if (minutes === 1) return clean;
    const bucketMs = minutes * 60000;
    const out = [];
    let cur = null;
    for (const c of clean) {
      const t = Math.floor(c.time / bucketMs) * bucketMs;
      if (!cur || cur.time !== t) {
        if (cur) out.push(cur);
        cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      } else {
        cur.high = Math.max(cur.high, c.high);
        cur.low = Math.min(cur.low, c.low);
        cur.close = c.close;
        cur.volume = Math.min(Number.MAX_VALUE, cur.volume + c.volume);
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  function lastValid(arr) {
    if (!Array.isArray(arr)) return { value: null, index: -1 };
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i] != null && Number.isFinite(numeric(arr[i]))) return { value: numeric(arr[i]), index: i };
    }
    return { value: null, index: -1 };
  }

  function softmaxProbs(callScore, putScore) {
    const k = 0.4;
    const c = numeric(callScore);
    const p = numeric(putScore);
    if (!Number.isFinite(c) || !Number.isFinite(p)) return { call: 0.5, put: 0.5 };
    const cLogit = k * Math.max(-1000000, Math.min(1000000, c));
    const pLogit = k * Math.max(-1000000, Math.min(1000000, p));
    const maxLogit = Math.max(cLogit, pLogit);
    const eC = Math.exp(cLogit - maxLogit);
    const eP = Math.exp(pLogit - maxLogit);
    const sum = eC + eP;
    return sum > 0 && Number.isFinite(sum)
      ? { call: eC / sum, put: eP / sum }
      : { call: 0.5, put: 0.5 };
  }

  root.CYBER_TA = {
    sma,
    ema,
    rma,
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
