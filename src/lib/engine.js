/**
 * Confluence signal engine for short-horizon binary direction.
 * Tuned via tools/backtest.js — conservative filters beat raw oscillators.
 */
(function (root) {
  "use strict";

  const TA = root.CYBER_TA;
  if (!TA) throw new Error("CYBER_TA missing");

  const DEFAULTS = Object.freeze({
    rsiPeriod: 14,
    rsiBuy: 42,
    rsiSell: 58,
    emaFast: 8,
    emaSlow: 21,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    stochK: 14,
    stochD: 3,
    stochOs: 22,
    stochOb: 78,
    bbPeriod: 20,
    bbMult: 2,
    atrPeriod: 14,
    minAtrPct: 0.00012,
    minScore: 4,
    lookback: 3,
  });

  function extract(candles) {
    const o = [];
    const h = [];
    const l = [];
    const c = [];
    const t = [];
    for (let i = 0; i < candles.length; i++) {
      const x = candles[i];
      o.push(x.open);
      h.push(x.high);
      l.push(x.low);
      c.push(x.close);
      t.push(x.time);
    }
    return { o, h, l, c, t };
  }

  function analyze(candles, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    if (!candles || candles.length < 40) {
      return { ready: false, reason: "Need at least 40 candles", votes: [] };
    }

    const { h, l, c } = extract(candles);
    const i = c.length - 1;
    const prev = i - 1;

    const rsi = TA.rsi(c, cfg.rsiPeriod);
    const emaF = TA.ema(c, cfg.emaFast);
    const emaS = TA.ema(c, cfg.emaSlow);
    const macd = TA.macd(c, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
    const st = TA.stochastic(h, l, c, cfg.stochK, cfg.stochD);
    const bb = TA.bollinger(c, cfg.bbPeriod, cfg.bbMult);
    const atr = TA.atr(h, l, c, cfg.atrPeriod);

    const needed = [rsi[i], emaF[i], emaS[i], macd.hist[i], st.k[i], st.d[i], bb.mid[i], atr[i]];
    if (needed.some((v) => v == null)) {
      return { ready: false, reason: "Warming indicators", votes: [] };
    }

    const atrPct = atr[i] / c[i];
    if (atrPct < cfg.minAtrPct) {
      return {
        ready: true,
        direction: "WAIT",
        score: 0,
        confidence: 0,
        reason: "Volatility too low (ATR filter)",
        votes: [],
        metrics: snapshot(),
      };
    }

    const votes = [];

    // Trend: price vs slow EMA + fast/slow relation
    if (c[i] > emaS[i] && emaF[i] > emaS[i]) votes.push({ name: "EMA trend", dir: "CALL", w: 2 });
    else if (c[i] < emaS[i] && emaF[i] < emaS[i]) votes.push({ name: "EMA trend", dir: "PUT", w: 2 });

    // Fresh EMA cross in last lookback bars
    for (let k = 0; k < cfg.lookback; k++) {
      const a = i - k;
      const b = a - 1;
      if (b < 0 || emaF[a] == null || emaS[a] == null || emaF[b] == null || emaS[b] == null) continue;
      if (emaF[b] <= emaS[b] && emaF[a] > emaS[a]) {
        votes.push({ name: "EMA cross", dir: "CALL", w: 2 });
        break;
      }
      if (emaF[b] >= emaS[b] && emaF[a] < emaS[a]) {
        votes.push({ name: "EMA cross", dir: "PUT", w: 2 });
        break;
      }
    }

    // RSI pullback in trend (not extreme chase)
    if (rsi[i] < cfg.rsiBuy && rsi[i] > 22 && c[i] > emaS[i]) votes.push({ name: "RSI dip", dir: "CALL", w: 1 });
    if (rsi[i] > cfg.rsiSell && rsi[i] < 78 && c[i] < emaS[i]) votes.push({ name: "RSI pop", dir: "PUT", w: 1 });

    // MACD histogram turning
    if (macd.hist[prev] != null) {
      if (macd.hist[i] > 0 && macd.hist[i] > macd.hist[prev]) votes.push({ name: "MACD", dir: "CALL", w: 1 });
      if (macd.hist[i] < 0 && macd.hist[i] < macd.hist[prev]) votes.push({ name: "MACD", dir: "PUT", w: 1 });
    }

    // Stochastic leaving extremes
    if (st.k[prev] != null && st.d[prev] != null) {
      if (st.k[prev] < cfg.stochOs && st.k[i] > st.d[i] && st.k[i] < 50)
        votes.push({ name: "Stoch", dir: "CALL", w: 1 });
      if (st.k[prev] > cfg.stochOb && st.k[i] < st.d[i] && st.k[i] > 50)
        votes.push({ name: "Stoch", dir: "PUT", w: 1 });
    }

    // Bollinger mean reversion only with trend agreement
    if (c[i] <= bb.lower[i] && c[i] > emaS[i]) votes.push({ name: "BB", dir: "CALL", w: 1 });
    if (c[i] >= bb.upper[i] && c[i] < emaS[i]) votes.push({ name: "BB", dir: "PUT", w: 1 });

    let call = 0;
    let put = 0;
    for (const v of votes) {
      if (v.dir === "CALL") call += v.w;
      else put += v.w;
    }

    let direction = "WAIT";
    let score = 0;
    if (call >= cfg.minScore && call > put + 1) {
      direction = "CALL";
      score = call;
    } else if (put >= cfg.minScore && put > call + 1) {
      direction = "PUT";
      score = put;
    }

    const maxW = 8;
    const confidence = direction === "WAIT" ? 0 : Math.min(99, Math.round((score / maxW) * 100));

    return {
      ready: true,
      direction,
      score,
      confidence,
      reason:
        direction === "WAIT"
          ? "No confluence"
          : votes
              .filter((v) => v.dir === direction)
              .map((v) => v.name)
              .join(" · "),
      votes,
      metrics: snapshot(),
    };

    function snapshot() {
      return {
        close: c[i],
        rsi: rsi[i],
        emaFast: emaF[i],
        emaSlow: emaS[i],
        macdHist: macd.hist[i],
        stochK: st.k[i],
        stochD: st.d[i],
        bbMid: bb.mid[i],
        atr: atr[i],
        atrPct,
      };
    }
  }

  /**
   * Backtest: enter on closed bar signal, expire after `horizon` bars.
   * Win if CALL and future close > entry close (and inverse for PUT).
   */
  function backtest(candles, opts) {
    const cfg = Object.assign({}, DEFAULTS, opts || {});
    const horizon = cfg.horizon || 3;
    let wins = 0;
    let losses = 0;
    const trades = [];

    for (let i = 50; i < candles.length - horizon; i++) {
      const slice = candles.slice(0, i + 1);
      const sig = analyze(slice, cfg);
      if (!sig.ready || sig.direction === "WAIT") continue;

      const entry = candles[i].close;
      const exit = candles[i + horizon].close;
      const won =
        (sig.direction === "CALL" && exit > entry) ||
        (sig.direction === "PUT" && exit < entry);
      if (won) wins++;
      else losses++;
      trades.push({
        i,
        dir: sig.direction,
        score: sig.score,
        won,
        entry,
        exit,
      });
    }

    const total = wins + losses;
    const winrate = total ? (wins / total) * 100 : 0;
    return { wins, losses, total, winrate, trades };
  }

  root.CYBER_ENGINE = { DEFAULTS, analyze, backtest };
})(typeof self !== "undefined" ? self : globalThis);
