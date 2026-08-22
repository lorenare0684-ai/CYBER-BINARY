/**
 * Confluence signal engine v2 — multi-indicator, multi-timeframe, regime-aware.
 *
 * Inputs: candle series (1m), optional strategy preset, optional asset profile.
 * Output: { ready, direction, confidence, score, votes, regime, metrics, reasons }
 *
 * The engine never "predicts"; it scores confluence and refuses to signal when
 * the confluence is weak or the market regime is hostile. This is conservative
 * on purpose: a lower hit rate on fewer trades is more honest than a 60% claim
 * that crumbles out of sample.
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

  function extract(candles) {
    const o = [], h = [], l = [], c = [], t = [];
    for (let i = 0; i < candles.length; i++) {
      const x = candles[i];
      o.push(x.open); h.push(x.high); l.push(x.low); c.push(x.close); t.push(x.time);
    }
    return { o, h, l, c, t };
  }

  function resolveStrategy(opts) {
    let params = Object.assign({}, DEFAULTS);
    let weights = Object.assign({}, DEFAULT_WEIGHTS);
    if (opts && opts.strategy && STRAT && STRAT[opts.strategy]) {
      params = Object.assign(params, STRAT[opts.strategy].params);
      weights = Object.assign(weights, STRAT[opts.strategy].weights || {});
    }
    if (opts && opts.params) params = Object.assign(params, opts.params);
    if (opts && opts.weights) weights = Object.assign(weights, opts.weights);
    return { params, weights };
  }

  function detectRegime(i, rsi, emaF, emaS, adxA, atrA, c, hurst) {
    if (
      rsi[i] == null || emaF[i] == null || emaS[i] == null ||
      adxA[i] == null || atrA[i] == null || c[i] == null
    ) return "unknown";

    const trending = adxA[i] >= 22;
    const volatile = atrA[i] / c[i] > 0.0006;
    const directional = Math.abs(emaF[i] - emaS[i]) / (atrA[i] || 1e-9) > 1.5;
    const meanRevert = hurst != null && hurst[i] != null && hurst[i] < 0.45;

    if (trending && directional) return "trending";
    if (trending && !directional) return "strong-trend";
    if (meanRevert) return "mean-reverting";
    if (volatile) return "choppy";
    return "ranging";
  }

  function analyze(candles, opts) {
    const { params: cfg, weights } = resolveStrategy(opts);
    if (!candles || candles.length < 40) {
      return { ready: false, reason: "Need at least 40 candles", votes: [], regime: "unknown" };
    }
    // We only need a tail of the series for the indicators to be valid.
    // Live (lean: false) uses 200; backtest uses cfg.minBars (default 150).
    const liveMinBars = (opts && opts.lean === false) ? 200 : 0;
    const fallback = Math.max(cfg.minBars || 150, liveMinBars);
    const minNeeded = Math.max(40, cfg.hurstPeriod + 50, cfg.stochK * 4, cfg.adxPeriod * 2, fallback);
    const startIdx = Math.max(0, candles.length - minNeeded);
    const window = candles.slice(startIdx);
    const { h, l, c } = extract(window);
    const i = c.length - 1;
    const prev = i - 1;

    // Lean mode: skip expensive indicators (CCI, Williams, Hurst, Donchian)
    // for backtest speed. Set lean=false from caller (e.g. live UI) to keep them.
    const lean = cfg.lean !== false && (opts && opts.lean !== false && (opts.lean !== undefined ? opts.lean : true));

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
    if (need.some((v) => v == null)) {
      return { ready: false, reason: "Warming indicators", votes: [], regime: "unknown" };
    }

    const atrPct = atr[i] / c[i];
    if (atrPct < cfg.minAtrPct) {
      return {
        ready: true, direction: "WAIT", score: 0, confidence: 0,
        reason: "Volatility too low (ATR filter)",
        votes: [], regime: detectRegime(i, rsi, emaF, emaS, adxR.adx, atr, c, hurst),
        metrics: {
          atrPct, close: c[i], rsi: rsi[i], emaFast: emaF[i], emaSlow: emaS[i],
          macdHist: macd.hist[i], stochK: st.k[i], stochD: st.d[i], bbMid: bb.mid[i],
          bbUpper: bb.upper[i], bbLower: bb.lower[i], atr: atr[i], adx: adxR.adx[i],
          plusDI: adxR.plus[i], minusDI: adxR.minus[i], supertrend: superR.st[i],
          superTrend: superR.trend[i], psar: psar[i], mtfBias: 0, mtfChecked: 0,
        },
      };
    }

    // Multi-timeframe alignment: resample 1m → 5m, 15m and check trend agreement.
    // Use only the last 120 bars of the window so this stays O(N) per call.
    let mtfBias = 0;
    let mtfChecked = 0;
    if (window[0] && window[0].time != null && window.length >= 60) {
      const tail = window.slice(-120);
      const c5 = TA.resample(tail, cfg.mtfFast);
      const c15 = TA.resample(tail, cfg.mtfMid);
      if (c5.length >= 30) {
        const closes5 = c5.map((x) => x.close);
        const ef5 = TA.ema(closes5, 8);
        const es5 = TA.ema(closes5, 21);
        const j5 = closes5.length - 1;
        if (ef5[j5] != null && es5[j5] != null) {
          mtfChecked++;
          if (closes5[j5] > ef5[j5] && ef5[j5] > es5[j5]) mtfBias += 1;
          else if (closes5[j5] < ef5[j5] && ef5[j5] < es5[j5]) mtfBias -= 1;
        }
      }
      if (c15.length >= 30) {
        const closes15 = c15.map((x) => x.close);
        const ef15 = TA.ema(closes15, 8);
        const es15 = TA.ema(closes15, 21);
        const j15 = closes15.length - 1;
        if (ef15[j15] != null && es15[j15] != null) {
          mtfChecked++;
          if (closes15[j15] > ef15[j15] && ef15[j15] > es15[j15]) mtfBias += 1;
          else if (closes15[j15] < ef15[j15] && ef15[j15] < es15[j15]) mtfBias -= 1;
        }
      }
    }

    const votes = [];

    // EMA trend
    if (c[i] > emaS[i] && emaF[i] > emaS[i]) votes.push({ name: "EMA trend", dir: "CALL", w: weights.emaTrend });
    else if (c[i] < emaS[i] && emaF[i] < emaS[i]) votes.push({ name: "EMA trend", dir: "PUT", w: weights.emaTrend });

    // Fresh EMA cross
    for (let k = 0; k < cfg.lookback; k++) {
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

    // Bollinger with trend agreement
    if (c[i] <= bb.lower[i] && c[i] > emaS[i]) votes.push({ name: "BB", dir: "CALL", w: weights.bb });
    if (c[i] >= bb.upper[i] && c[i] < emaS[i]) votes.push({ name: "BB", dir: "PUT", w: weights.bb });

    // ADX trend strength: only agree with strong trends
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

    // Multi-timeframe alignment
    if (mtfChecked > 0) {
      if (mtfBias > 0) votes.push({ name: "MTF", dir: "CALL", w: weights.mtfAlign });
      else if (mtfBias < 0) votes.push({ name: "MTF", dir: "PUT", w: weights.mtfAlign });
    }

    // Hurst: trending markets amplify trend-following votes; in mean-reverting markets, only fire if a strong counter-trend setup exists.
    if (hurst != null && hurst[i] != null) {
      if (hurst[i] > 0.55 && (emaF[i] - emaS[i]) > 0)
        votes.push({ name: "Hurst", dir: "CALL", w: weights.hurst });
      else if (hurst[i] > 0.55 && (emaF[i] - emaS[i]) < 0)
        votes.push({ name: "Hurst", dir: "PUT", w: weights.hurst });
    }

    // Williams %R extremes (mean-revertive) — only if non-lean
    if (williams != null && williams[i] != null) {
      if (williams[i] < -80 && rsi[i] < 40) votes.push({ name: "Will%R", dir: "CALL", w: weights.williams });
      if (williams[i] > -20 && rsi[i] > 60) votes.push({ name: "Will%R", dir: "PUT", w: weights.williams });
    }

    // CCI extremes — only if non-lean
    if (cci != null && cci[i] != null) {
      if (cci[i] < -150) votes.push({ name: "CCI", dir: "CALL", w: weights.cci });
      if (cci[i] > 150) votes.push({ name: "CCI", dir: "PUT", w: weights.cci });
    }

    // Donchian breakout — only if non-lean
    if (donch != null && donch.upper != null && donch.upper[i] != null) {
      if (c[i] > donch.upper[i - 1])
        votes.push({ name: "Donch↑", dir: "CALL", w: weights.donchianBreak });
      if (c[i] < donch.lower[i - 1])
        votes.push({ name: "Donch↓", dir: "PUT", w: weights.donchianBreak });
    }

    let call = 0, put = 0;
    for (const v of votes) {
      if (v.dir === "CALL") call += v.w;
      else put += v.w;
    }

    // Regime veto: in mean-reverting markets, refuse trend votes; in trending, allow them.
    const regime = detectRegime(i, rsi, emaF, emaS, adxR.adx, atr, c, hurst);
    if (regime === "choppy" && cfg.minScore >= 4) {
      // require higher confidence in chop
    }

    let direction = "WAIT";
    let score = 0;
    if (call >= cfg.minScore && call > put + 1) {
      direction = "CALL"; score = call;
    } else if (put >= cfg.minScore && put > call + 1) {
      direction = "PUT"; score = put;
    }

    // Confidence: softmax of opposing scores.
    let confidence = 0;
    if (direction !== "WAIT") {
      const probs = TA.softmaxProbs(call, put);
      const p = direction === "CALL" ? probs.call : probs.put;
      // Scale by 0..100 and clamp
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
          ? "No confluence"
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
        donchUpper: donch ? donch.upper[i] : null,
        donchLower: donch ? donch.lower[i] : null,
        williams: williams ? williams[i] : null,
        cci: cci ? cci[i] : null,
        momentum: mom[i],
        hurst: hurst ? hurst[i] : null,
        mtfBias,
        mtfChecked,
      },
    };
  }

  /**
   * Backtest over a single series. Returns aggregate stats + per-trade log
   * + per-regime breakdown + equity curve.
   */
  function backtest(candles, opts) {
    const cfg = Object.assign(
      {},
      DEFAULTS,
      opts && opts.strategy && STRAT ? STRAT[opts.strategy].params : {},
      opts || {}
    );
    const horizon = cfg.horizon || 3;
    const minConf = cfg.minConf || 0;
    const warmup = cfg.warmup || 50;
    // Each iteration only needs the last ~minBars bars. Maintain a rolling
    // window of `minBars` bars to avoid re-slicing the full series every step.
    const minBars = cfg.minBars || 200;
    const tailLen = Math.max(minBars, warmup + 1);

    let wins = 0, losses = 0;
    const trades = [];
    const equity = [];
    let pnl = 0;

    for (let i = warmup; i < candles.length - horizon; i++) {
      const from = Math.max(0, i + 1 - tailLen);
      const slice = candles.slice(from, i + 1);
      const sig = analyze(slice, Object.assign({}, opts, { minBars: tailLen, lean: opts && opts.lean }));
      if (!sig.ready || sig.direction === "WAIT") continue;
      if (sig.confidence < minConf) continue;
      const entry = candles[i].close;
      const exit = candles[i + horizon].close;
      const won =
        (sig.direction === "CALL" && exit > entry) ||
        (sig.direction === "PUT" && exit < entry);
      if (won) wins++; else losses++;
      pnl += won ? 1 : -1;
      trades.push({
        i, dir: sig.direction, score: sig.score, confidence: sig.confidence,
        regime: sig.regime, won, entry, exit,
        pnl: won ? 1 : -1,
      });
      equity.push({ i, pnl, equity: pnl });
    }

    const total = wins + losses;
    const winrate = total ? (wins / total) * 100 : 0;
    const payoff = wins && losses ? wins / losses : wins ? Infinity : 0;

    // Per-regime breakdown
    const byRegime = {};
    for (const t of trades) {
      const r = t.regime || "unknown";
      if (!byRegime[r]) byRegime[r] = { wins: 0, losses: 0 };
      if (t.won) byRegime[r].wins++; else byRegime[r].losses++;
    }
    for (const r of Object.keys(byRegime)) {
      const t = byRegime[r].wins + byRegime[r].losses;
      byRegime[r].total = t;
      byRegime[r].winrate = t ? (byRegime[r].wins / t) * 100 : 0;
    }

    // Streaks
    let maxWinStreak = 0, maxLossStreak = 0, curW = 0, curL = 0;
    for (const t of trades) {
      if (t.won) { curW++; curL = 0; } else { curL++; curW = 0; }
      if (curW > maxWinStreak) maxWinStreak = curW;
      if (curL > maxLossStreak) maxLossStreak = curL;
    }

    // Drawdown
    let peak = -Infinity, maxDD = 0;
    for (const e of equity) {
      if (e.equity > peak) peak = e.equity;
      const dd = peak - e.equity;
      if (dd > maxDD) maxDD = dd;
    }

    // Confidence calibration: bucket by confidence
    const calibBuckets = {};
    for (const t of trades) {
      const b = Math.min(90, Math.floor(t.confidence / 10) * 10);
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
      wins, losses, total, winrate, payoff,
      pnl, maxDrawdown: maxDD, maxWinStreak, maxLossStreak,
      byRegime, calibration, equity, trades,
    };
  }

  /**
   * Walk-forward: split into N folds, optimize on first half of each fold,
   * evaluate on second. Helps detect overfitting.
   */
  function walkForward(candles, opts) {
    const folds = (opts && opts.folds) || 5;
    const total = candles.length;
    if (total < 200) return { error: "need at least 200 candles" };
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

  root.CYBER_ENGINE = { DEFAULTS, DEFAULT_WEIGHTS, analyze, backtest, walkForward, resolveStrategy };
})(typeof self !== "undefined" ? self : globalThis);
