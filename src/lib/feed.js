/**
 * Multi-asset candle feed.
 *  - createFeed: live tick ingestion for a single asset.
 *  - syntheticSeries: build a long 1m series for any asset profile with
 *    realistic regime cycles (trending → ranging → volatile → ranging).
 *  - cycSynthetic: cyclical, regime-aware generator used by historic backtest.
 */
(function (root) {
  "use strict";

  const ASSETS = (root.CYBER_ASSETS && root.CYBER_ASSETS) || null;

  function seeded(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function createFeed(opts) {
    const tf = (opts && opts.tfMs) || 60000;
    const max = (opts && opts.max) || 600;
    let candles = [];
    let current = null;
    let last = null;
    const volProfile = (opts && opts.volProfile) || null;

    function bucket(ts) {
      return Math.floor(ts / tf) * tf;
    }

    function ingest(price, ts) {
      if (!Number.isFinite(price) || price <= 0) return null;
      last = price;
      const t = bucket(ts || Date.now());
      let closed = null;
      if (!current || current.time !== t) {
        if (current) {
          candles.push(current);
          if (candles.length > max) candles = candles.slice(-max);
          closed = current;
        }
        current = { time: t, open: price, high: price, low: price, close: price };
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
      }
      return { closed, current, last };
    }

    function series() {
      const out = candles.slice();
      if (current) out.push(Object.assign({}, current));
      return out;
    }

    function seedHistory(n, startPrice) {
      candles = [];
      current = null;
      let p = startPrice || 1.0854;
      let t = bucket(Date.now()) - n * tf;
      for (let i = 0; i < n; i++) {
        const drift = (Math.sin(i / 18) + (Math.random() - 0.48)) * 0.00035;
        const c = Math.max(0.2, p * (1 + drift));
        const h = Math.max(p, c) * (1 + Math.random() * 0.00025);
        const l = Math.min(p, c) * (1 - Math.random() * 0.00025);
        candles.push({ time: t, open: p, high: h, low: l, close: c });
        p = c;
        t += tf;
      }
      last = p;
      current = {
        time: bucket(Date.now()),
        open: p, high: p, low: p, close: p,
      };
      return series();
    }

    function setSeries(arr) {
      candles = arr.slice();
      if (candles.length > max) candles = candles.slice(-max);
      const lastBar = candles[candles.length - 1];
      last = lastBar ? lastBar.close : null;
      current = lastBar ? Object.assign({}, lastBar) : null;
    }

    /**
     * v2.1: ingest a fully-formed OHLCV candle (e.g. delivered by the
     * page's WebSocket). Returns {closed, current, last} for the
     * same shape as `ingest` so callers can detect bar closes
     * uniformly.
     */
    function ingestCandle(c) {
      if (!c || typeof c.time !== "number") return null;
      if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return null;
      let closed = null;
      if (current && current.time === c.time) {
        // Update the in-progress bar in place.
        if (Number.isFinite(c.high)) current.high = Math.max(current.high, c.high);
        if (Number.isFinite(c.low))  current.low  = Math.min(current.low,  c.low);
        current.close = c.close;
        if (Number.isFinite(c.open)) current.open = c.open;
      } else {
        // New bar. Close the previous one if it exists.
        if (current) {
          candles.push(current);
          if (candles.length > max) candles = candles.slice(-max);
          closed = current;
        }
        current = {
          time: c.time,
          open: c.open,
          high: Number.isFinite(c.high) ? c.high : Math.max(c.open, c.close),
          low:  Number.isFinite(c.low)  ? c.low  : Math.min(c.open, c.close),
          close: c.close,
          volume: c.volume || 0,
        };
      }
      last = c.close;
      return { closed, current, last };
    }

    return {
      ingest, ingestCandle, series, seedHistory, setSeries,
      lastPrice: () => last,
      reset: () => { candles = []; current = null; last = null; },
      size: () => candles.length + (current ? 1 : 0),
    };
  }

  /**
   * Build a realistic per-asset 1m candle series.
   * Includes regime cycling (trending → ranging → chop → back to trending).
   * `minutes` = total bars to generate. `regimePeriod` = bars per regime.
   */
  function syntheticSeries(asset, minutes, opts) {
    const a = (ASSETS && ASSETS.get(asset)) || asset || { basePrice: 1.0, vol: 0.0001, drift: 0, jumpRate: 0.005, decimals: 5 };
    const seed = (opts && opts.seed) || 7;
    const regimePeriod = (opts && opts.regimePeriod) || Math.max(120, Math.floor(minutes / 6));
    const rnd = seeded(seed);
    const out = [];
    let p = a.basePrice;
    let t = (opts && opts.startTime) || Date.UTC(2024, 0, 1, 0, 0, 0);
    let regimeIdx = 0;
    let barsInRegime = 0;
    const regimeList = ["trending", "ranging", "choppy", "trending-down"];

    for (let i = 0; i < minutes; i++) {
      if (barsInRegime >= regimePeriod) {
        barsInRegime = 0;
        regimeIdx = (regimeIdx + 1) % regimeList.length;
      }
      const regime = regimeList[regimeIdx];
      barsInRegime++;

      let trend = 0;
      let volMult = 1;
      let meanRevPull = 0;
      if (regime === "trending") { trend = a.vol * 0.6; volMult = 1.0; }
      else if (regime === "trending-down") { trend = -a.vol * 0.6; volMult = 1.0; }
      else if (regime === "ranging") { meanRevPull = (a.basePrice - p) / p * 0.04; volMult = 0.6; }
      else if (regime === "choppy") { trend = (rnd() - 0.5) * a.vol * 0.2; volMult = 1.6; }

      const shock = (rnd() - 0.5) * 2 * a.vol * volMult;
      const jump = rnd() < (a.jumpRate || 0) ? (rnd() - 0.5) * a.vol * 8 : 0;
      const drift = (a.drift || 0) + trend + meanRevPull;
      const next = Math.max(0.01, p * (1 + drift + shock + jump));

      const range = Math.abs(next - p) + a.vol * p * 0.5;
      const h = Math.max(p, next) + rnd() * range * 0.4;
      const l = Math.min(p, next) - rnd() * range * 0.4;
      out.push({
        time: t,
        open: p,
        high: h,
        low: Math.max(0.01, l),
        close: next,
        regime,
      });
      p = next;
      t += 60000;
    }
    return out;
  }

  function demoTick(price) {
    const step = price * (0.00012 + Math.random() * 0.00025);
    const dir = Math.random() > 0.48 ? 1 : -1;
    return Math.max(0.2, price + dir * step);
  }

  root.CYBER_FEED = { createFeed, syntheticSeries, demoTick, seeded };
})(typeof self !== "undefined" ? self : globalThis);
