/**
 * Multi-asset candle feed.
 *  - createFeed: live tick ingestion for a single asset. Internally keeps a
 *    sorted, de-duplicated array of CLOSED bars plus one "current" live bar.
 *    `ingestCandle` / `mergeCandles` are order-safe (oldest-first OR
 *    newest-first broker history works correctly) and replace synthetic
 *    seed data with real broker history instead of mixing the two.
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
    let candles = [];       // sorted CLOSED bars only (oldest → newest)
    let current = null;     // in-progress bar
    let last = null;
    const volProfile = (opts && opts.volProfile) || null;

    function bucket(ts) {
      return Math.floor(ts / tf) * tf;
    }

    function cap() {
      if (candles.length > max) candles = candles.slice(-max);
    }

    function pushClosed(c) {
      if (!c) return;
      // De-dupe by time before appending (never push the same bar twice).
      const n = candles.length;
      if (n && candles[n - 1].time === c.time) candles[n - 1] = c;
      else candles.push(c);
      cap();
    }

    function normalizeCandle(c) {
      if (!c || !Number.isFinite(Number(c.time))) return null;
      const time = Number(c.time) > 1e12 ? Math.floor(Number(c.time)) : Math.floor(Number(c.time) * 1000);
      const open = Number(c.open);
      const close = Number(c.close);
      if (!Number.isFinite(open) || !Number.isFinite(close)) return null;
      let high = Number.isFinite(Number(c.high)) ? Number(c.high) : Math.max(open, close);
      let low = Number.isFinite(Number(c.low)) ? Number(c.low) : Math.min(open, close);
      if (high < low) { const tmp = high; high = low; low = tmp; }
      const volume = Number.isFinite(Number(c.volume)) ? Number(c.volume) : 0;
      return { time, open, high, low, close, volume };
    }

    /**
     * Merge a batch of candles (any order, may be empty) with the current
     * series. The newest bar in the merged set becomes the live bar; every
     * other bar is a closed bar. Returning `closed` tells callers which bar
     * just closed so pending signals can be settled.
     */
    function mergeCandles(list) {
      if (!Array.isArray(list) || !list.length) return { closed: null, current, last };
      const map = Object.create(null);
      for (let i = 0; i < candles.length; i++) map[candles[i].time] = candles[i];
      if (current) map[current.time] = current;
      for (let i = 0; i < list.length; i++) {
        const n = normalizeCandle(list[i]);
        if (n) map[n.time] = n;
      }
      const keys = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
      if (!keys.length) return { closed: null, current, last };
      const all = [];
      for (let i = 0; i < keys.length; i++) all.push(map[keys[i]]);
      const prevCurrentTime = current ? current.time : null;
      candles = all.slice(0, -1);
      cap();
      current = Object.assign({}, all[all.length - 1]);
      last = current.close;
      const closed = prevCurrentTime != null && prevCurrentTime !== current.time ? map[prevCurrentTime] : null;
      return { closed, current, last };
    }

    function ingest(price, ts) {
      if (!Number.isFinite(price) || price <= 0) return null;
      last = price;
      const t = bucket(ts || Date.now());
      let closed = null;
      if (!current || current.time !== t) {
        if (current) {
          pushClosed(current);
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

    /**
     * Replace the whole series (e.g. real broker history arriving after a
     * synthetic seed). Sorts + de-dupes. The last bar becomes the live bar.
     * This truly replaces — it never merges with the previous seed.
     */
    function setSeries(arr) {
      if (!Array.isArray(arr) || !arr.length) {
        candles = []; current = null; last = null;
        return series();
      }
      const list = [];
      for (let i = 0; i < arr.length; i++) {
        const n = normalizeCandle(arr[i]);
        if (n) list.push(n);
      }
      const map = Object.create(null);
      for (let i = 0; i < list.length; i++) map[list[i].time] = list[i];
      const keys = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
      candles = []; current = null; last = null;
      for (let i = 0; i < keys.length; i++) candles.push(map[keys[i]]);
      cap();
      if (candles.length) {
        current = Object.assign({}, candles.pop());
        last = current.close;
        // cap() above already trimmed; ensure final current is the newest.
      }
      return series();
    }

    // Backwards-compatible alias used by v2.1 callers.
    function replaceCandles(arr) { return setSeries(arr); }

    /**
     * v2.1: ingest a fully-formed OHLCV candle (e.g. delivered by the
     * page's WebSocket). Order-safe: old history inserts at the correct
     * position, a live update patches the current bar, a newer bar closes
     * the previous one. Returns {closed, current, last} so callers can
     * detect bar closes uniformly.
     */
    function ingestCandle(c) {
      return mergeCandles([c]);
    }

    /** Close the current bar if it is stale (bucket older than `ts`). */
    function forceClose(ts) {
      if (!current) return null;
      const t = bucket(ts || Date.now());
      if (current.time >= t) return null;
      const closed = current;
      pushClosed(closed);
      current = null;
      return { closed, current, last };
    }

    /**
     * Drop every closed bar older than `ts` (and the current bar too if it is
     * older). Used when real broker history arrives: the synthetic seed bars
     * live entirely before the first real candle, so this purges them before
     * `mergeCandles` inserts the actual history.
     */
    function pruneBefore(ts) {
      if (ts == null) return 0;
      const before = candles.length;
      candles = candles.filter((c) => c.time >= ts);
      if (current && current.time < ts) current = null;
      return before - candles.length;
    }

    return {
      ingest, ingestCandle, mergeCandles, series, seedHistory, setSeries,
      replaceCandles, forceClose, pruneBefore,
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
