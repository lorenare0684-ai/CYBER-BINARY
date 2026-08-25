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

  function numberValue(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    try {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function assetSeed(value, base) {
    const numericBase = numberValue(base);
    let hash = ((numericBase == null ? 0 : numericBase) >>> 0) || 2166136261;
    let text = "";
    try { text = String(value == null ? "" : value); } catch (_) {}
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
    return hash || 1;
  }

  function seeded(seed) {
    let s = (seed >>> 0) || 1;
    return function () {
      s = (1664525 * s + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  function createFeed(opts) {
    const requestedTf = numberValue(opts && opts.tfMs);
    const requestedMax = numberValue(opts && opts.max);
    const tf = requestedTf != null && requestedTf >= 100 && requestedTf <= 86400000
      ? Math.floor(requestedTf) : 60000;
    const max = requestedMax != null && requestedMax >= 2
      ? Math.min(100000, Math.floor(requestedMax)) : 600;
    let candles = [];       // sorted CLOSED bars only (oldest → newest)
    let current = null;     // in-progress bar
    let last = null;
    let lastBrokerTime = null; // last broker timestamp seen, for time-sync
    const volProfile = (opts && opts.volProfile) || null;

    function timestampMs(value) {
      let n = numberValue(value);
      if (n == null) return null;
      while (Math.abs(n) >= 1e14) n /= 1000;
      if (Math.abs(n) < 1e11) n *= 1000;
      n = Math.floor(n);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }

    function bucket(ts) {
      return Math.floor(ts / tf) * tf;
    }

    // Quotex candles are UTC-aligned to period boundaries. Flooring incoming
    // times to the period ensures history rows (which may carry ms offsets)
    // and live tick buckets land on the same epoch, so the engine and the
    // platform chart share the same candle slots.
    function bucketedTimestampMs(value) {
      const ms = timestampMs(value);
      if (ms == null) return null;
      return bucket(ms);
    }

    function cap(reserveCurrent) {
      const reserve = reserveCurrent == null ? (current ? 1 : 0) : (reserveCurrent ? 1 : 0);
      const limit = Math.max(0, max - reserve);
      if (candles.length > limit) candles = candles.slice(-limit || candles.length);
      if (limit === 0) candles = [];
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
      if (!c || typeof c !== "object") return null;
      // Broker times must be bucketed to tf so engine, live bar and platform
      // chart all share the same candle open. This eliminates drift where
      // a candle like 1714000001234 would otherwise create a different slot
      // than floor(1714000001234/60000)*60000 used by ticks.
      const time = bucketedTimestampMs(c.time);
      const open = numberValue(c.open);
      const close = numberValue(c.close);
      if (!Number.isSafeInteger(time) || time < 0 || open == null || close == null ||
          open <= 0 || close <= 0 || open > 1e15 || close > 1e15) return null;
      const candidateHigh = numberValue(c.high);
      const candidateLow = numberValue(c.low);
      const rawHigh = candidateHigh == null ? Math.max(open, close) : candidateHigh;
      const rawLow = candidateLow == null ? Math.min(open, close) : candidateLow;
      if (rawHigh <= 0 || rawLow <= 0 || rawHigh > 1e15 || rawLow > 1e15) return null;
      const high = Math.max(rawHigh, rawLow, open, close);
      const low = Math.min(rawHigh, rawLow, open, close);
      const rawVolume = numberValue(c.volume);
      const volume = rawVolume != null && rawVolume >= 0 ? Math.min(Number.MAX_VALUE, rawVolume) : 0;
      return { time, open, high, low, close, volume };
    }

    /**
     * Merge a batch of candles (any order, may be empty) with the current
     * series. The newest bar in the merged set becomes the live bar; every
     * other bar is a closed bar. Returning `closed` tells callers which bar
     * just closed so pending signals can be settled.
     */
    function mergeCandles(list) {
      if (!Array.isArray(list) || !list.length) return { closed: null, closedBars: [], current, last };
      const priorLatestTime = current ? current.time : (candles.length ? candles[candles.length - 1].time : null);
      const map = Object.create(null);
      for (let i = 0; i < candles.length; i++) map[candles[i].time] = candles[i];
      if (current) map[current.time] = current;
      for (let i = 0; i < list.length; i++) {
        const n = normalizeCandle(list[i]);
        if (n) {
          map[n.time] = n;
          if (lastBrokerTime == null || n.time > lastBrokerTime) lastBrokerTime = n.time;
        }
      }
      const keys = Object.keys(map).map(Number).sort(function (a, b) { return a - b; });
      if (!keys.length) return { closed: null, closedBars: [], current, last };
      const all = [];
      for (let i = 0; i < keys.length; i++) all.push(map[keys[i]]);
      const prevCurrentTime = current ? current.time : null;
      const allClosed = all.slice(0, -1);
      const closedBars = priorLatestTime == null ? [] : allClosed.filter((bar) => bar.time >= priorLatestTime);
      candles = allClosed;
      cap(true);
      current = Object.assign({}, all[all.length - 1]);
      last = current.close;
      if (current && (lastBrokerTime == null || current.time > lastBrokerTime)) lastBrokerTime = current.time;
      const closed = closedBars.length ? closedBars[closedBars.length - 1]
        : (prevCurrentTime != null && prevCurrentTime !== current.time ? map[prevCurrentTime] : null);
      return { closed, closedBars, current, last };
    }

    function canIngest(ts) {
      const parsedTickTime = ts != null ? numberValue(ts) : Date.now();
      const tickTime = parsedTickTime == null ? NaN : parsedTickTime;
      if (!Number.isSafeInteger(tickTime) || tickTime < 0) return false;
      const t = bucket(tickTime);
      // When forceClose() moved the live bar into `candles`, that bucket is
      // final; otherwise the current bucket may still receive updates.
      const newestClosedTime = candles.length ? candles[candles.length - 1].time : null;
      return !((current && t < current.time) || (!current && newestClosedTime != null && t <= newestClosedTime));
    }

    function ingest(price, ts) {
      price = numberValue(price);
      if (price == null || price <= 0 || price > 1e15 || !canIngest(ts)) return null;
      const parsedTickTime = ts != null ? numberValue(ts) : Date.now();
      const tickTime = parsedTickTime == null ? NaN : parsedTickTime;
      if (!Number.isSafeInteger(tickTime) || tickTime < 0) return null;
      const t = bucket(tickTime);
      // v2.6.10 + broker-clock fix: reject glitched far-future timestamps.
      // The check is dual-reference: a tick is rejected only if it is far
      // ahead of BOTH local wall-clock AND the last broker timestamp. This
      // prevents a local clock that is minutes behind broker from dropping
      // valid broker ticks, while still blocking a timestamp that would
      // jump hours forward and swallow all subsequent ticks.
      const farThreshold = Math.max(10 * tf, 600000);
      const nowLocalBucket = bucket(Date.now());
      if (t - nowLocalBucket > farThreshold) {
        if (lastBrokerTime == null || t - bucket(lastBrokerTime) > farThreshold) return null;
      }
      // Also reject if far behind broker clock (stale replay)
      if (lastBrokerTime != null && bucket(lastBrokerTime) - t > farThreshold * 6) {
        // more than ~60min behind broker, likely stale replay
        return null;
      }
      last = price;
      lastBrokerTime = tickTime;
      let closed = null;
      if (!current || current.time !== t) {
        if (current) {
          pushClosed(current);
          closed = current;
        }
        current = { time: t, open: price, high: price, low: price, close: price, volume: 0 };
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
      }
      return { closed, closedBars: closed ? [closed] : [], current, last };
    }

    function series() {
      const out = candles.slice();
      if (current) out.push(Object.assign({}, current));
      return out;
    }

    function seedHistory(n, startPrice) {
      candles = [];
      current = null;
      const requestedCount = numberValue(n);
      n = Math.max(0, Math.min(Math.max(0, max - 1), Math.floor(requestedCount == null ? 0 : requestedCount)));
      const requestedStart = numberValue(startPrice);
      let p = requestedStart != null && requestedStart > 0 && requestedStart <= 1e15 ? requestedStart : 1.0854;
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
        candles = []; current = null; last = null; lastBrokerTime = null;
        return series();
      }
      const list = [];
      for (let i = 0; i < arr.length; i++) {
        const n = normalizeCandle(arr[i]);
        if (n) {
          list.push(n);
          if (lastBrokerTime == null || n.time > lastBrokerTime) lastBrokerTime = n.time;
        }
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
        if (current && (lastBrokerTime == null || current.time > lastBrokerTime)) lastBrokerTime = current.time;
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

    /**
     * Scale an existing warm-up series so its newest close matches a real
     * quote. This is intentionally explicit: callers use it only before real
     * broker history has arrived, preventing the first live tick from drawing
     * a giant synthetic-to-live candle and corrupting every indicator scale.
     */
    function rebase(price) {
      const target = numberValue(price);
      const source = current ? current.close : (candles.length ? candles[candles.length - 1].close : null);
      if (target == null || target <= 0 || target > 1e15 ||
          source == null || source <= 0 || source > 1e15) return false;
      const ratio = target / source;
      if (!Number.isFinite(ratio) || ratio <= 0) return false;
      const scale = (bar) => {
        if (!bar) return null;
        const open = bar.open * ratio;
        const high = bar.high * ratio;
        const low = bar.low * ratio;
        const close = bar.close * ratio;
        if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0 && value <= 1e15)) return null;
        return Object.assign({}, bar, { open, high, low, close });
      };
      const scaledCandles = [];
      for (let i = 0; i < candles.length; i++) {
        const bar = scale(candles[i]);
        if (!bar) return false;
        scaledCandles.push(bar);
      }
      const scaledCurrent = current ? scale(current) : null;
      if (current && !scaledCurrent) return false;
      candles = scaledCandles;
      current = scaledCurrent;
      // Avoid a tiny floating-point mismatch at the join with the first real
      // quote; the newest close is the requested broker price by definition.
      if (current) current.close = target;
      else if (candles.length) candles[candles.length - 1].close = target;
      last = target;
      return true;
    }

    /** Close the current bar if it is stale (bucket older than `ts`). */
    function forceClose(ts) {
      if (!current) return null;
      const parsedCloseTime = ts != null ? numberValue(ts) : Date.now();
      const closeTime = parsedCloseTime == null ? NaN : parsedCloseTime;
      if (!Number.isSafeInteger(closeTime) || closeTime < 0) return null;
      const t = bucket(closeTime);
      if (current.time >= t) return null;
      const closed = current;
      current = null;
      pushClosed(closed);
      return { closed, closedBars: [closed], current, last };
    }

    /**
     * Drop every closed bar older than `ts` (and the current bar too if it is
     * older). Used when real broker history arrives: the synthetic seed bars
     * live entirely before the first real candle, so this purges them before
     * `mergeCandles` inserts the actual history.
     */
    function pruneBefore(ts) {
      const parsedCutoff = numberValue(ts);
      const cutoff = parsedCutoff == null ? NaN : parsedCutoff;
      if (!Number.isSafeInteger(cutoff) || cutoff < 0) return 0;
      const before = candles.length;
      candles = candles.filter((c) => c.time >= cutoff);
      if (current && current.time < cutoff) current = null;
      last = current ? current.close : (candles.length ? candles[candles.length - 1].close : null);
      return before - candles.length;
    }

    function detectGaps() {
      if (candles.length < 2) return [];
      const gaps = [];
      for (let i = 1; i < candles.length; i++) {
        const prev = candles[i-1], cur = candles[i];
        if (!prev || !cur) continue;
        const diff = cur.time - prev.time;
        if (diff > tf * 1.5) {
          const missing = Math.round(diff / tf) - 1;
          if (missing > 0 && missing <= 1000) {
            gaps.push({ from: prev.time + tf, to: cur.time - tf, missing, after: prev.time, before: cur.time });
          }
        }
      }
      // Also check gap between last closed and current
      if (current && candles.length) {
        const lastClosed = candles[candles.length-1];
        const diff = current.time - lastClosed.time;
        if (diff > tf * 1.5) {
          const missing = Math.round(diff / tf) - 1;
          if (missing > 0 && missing <= 1000) {
            gaps.push({ from: lastClosed.time + tf, to: current.time - tf, missing, after: lastClosed.time, before: current.time, liveGap: true });
          }
        }
      }
      return gaps;
    }

    function getContinuity() {
      if (candles.length < 2) return 1;
      const gaps = detectGaps();
      const totalMissing = gaps.reduce((s,g)=>s+(g.missing||0),0);
      const total = candles.length + totalMissing;
      return total > 0 ? Math.max(0, Math.min(1, candles.length / total)) : 1;
    }

    function validateSeries() {
      if (!candles.length) return { valid: true, issues: [] };
      const issues = [];
      for (let i = 0; i < candles.length; i++) {
        const c = candles[i];
        if (!c || typeof c !== "object") { issues.push({ idx: i, issue: "invalid object" }); continue; }
        if (!Number.isSafeInteger(c.time) || c.time < 0) issues.push({ idx: i, issue: "bad time" });
        if (!(c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0)) issues.push({ idx: i, time: c.time, issue: "bad OHLC" });
        if (c.high < Math.max(c.open, c.close) - 1e-9) issues.push({ idx: i, time: c.time, issue: "high too low" });
        if (c.low > Math.min(c.open, c.close) + 1e-9) issues.push({ idx: i, time: c.time, issue: "low too high" });
      }
      // Check ordering
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].time <= candles[i-1].time) issues.push({ idx: i, issue: "out of order", time: candles[i].time });
      }
      return { valid: issues.length === 0, issues: issues.slice(0, 20), count: candles.length };
    }

    return {
      ingest, canIngest, ingestCandle, mergeCandles, series, seedHistory, setSeries, rebase,
      replaceCandles, forceClose, pruneBefore, detectGaps, getContinuity, validateSeries,
      lastPrice: () => last,
      hasCurrent: () => !!current,
      reset: () => { candles = []; current = null; last = null; lastBrokerTime = null; },
      size: () => candles.length + (current ? 1 : 0),
      lastBrokerTime: () => lastBrokerTime,
      bucket,
      get tfMs() { return tf; }
    };
  }

  /**
   * Build a realistic per-asset 1m candle series.
   * Includes regime cycling (trending → ranging → chop → back to trending).
   * `minutes` = total bars to generate. `regimePeriod` = bars per regime.
   */
  function syntheticSeries(asset, minutes, opts) {
    const a = (ASSETS && ASSETS.get(asset)) || asset || { basePrice: 1.0, vol: 0.0001, drift: 0, jumpRate: 0.005, decimals: 5 };
    const requestedMinutes = numberValue(minutes);
    minutes = Math.max(0, Math.min(1000000, Math.floor(requestedMinutes == null ? 0 : requestedMinutes)));
    const requestedSeed = numberValue(opts && opts.seed);
    const seed = assetSeed(a && a.id ? a.id : asset, requestedSeed != null ? requestedSeed : 7);
    const requestedRegime = numberValue(opts && opts.regimePeriod);
    const regimePeriod = requestedRegime != null && requestedRegime > 0
      ? Math.floor(requestedRegime) : Math.max(120, Math.floor(minutes / 6));
    const rnd = seeded(seed);
    const out = [];
    const rawBase = numberValue(a.basePrice), volatility = numberValue(a.vol);
    const driftBase = numberValue(a.drift), jumpRate = numberValue(a.jumpRate);
    const base = rawBase != null && rawBase > 0 ? Math.min(1e12, rawBase) : 1;
    const safeVol = volatility != null && volatility >= 0 ? Math.min(1, volatility) : 0.0001;
    const safeDrift = driftBase != null ? Math.max(-1, Math.min(1, driftBase)) : 0;
    let p = base;
    const requestedStart = opts && opts.startTime != null ? numberValue(opts.startTime) : Date.UTC(2024, 0, 1, 0, 0, 0);
    let t = requestedStart == null ? Date.UTC(2024, 0, 1, 0, 0, 0) : requestedStart;
    while (Math.abs(t) >= 1e14) t /= 1000;
    if (Math.abs(t) < 1e11) t *= 1000;
    t = Math.floor(t);
    if (!Number.isSafeInteger(t) || t < 0 || t > Number.MAX_SAFE_INTEGER - minutes * 60000) {
      t = Date.UTC(2024, 0, 1, 0, 0, 0);
    }
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
      const vol = safeVol;
      if (regime === "trending") { trend = vol * 0.6; volMult = 1.0; }
      else if (regime === "trending-down") { trend = -vol * 0.6; volMult = 1.0; }
      else if (regime === "ranging") { meanRevPull = (base - p) / p * 0.04; volMult = 0.6; }
      else if (regime === "choppy") { trend = (rnd() - 0.5) * vol * 0.2; volMult = 1.6; }

      const shock = (rnd() - 0.5) * 2 * vol * volMult;
      const jump = rnd() < (jumpRate != null ? Math.max(0, Math.min(1, jumpRate)) : 0) ? (rnd() - 0.5) * vol * 8 : 0;
      const drift = safeDrift + trend + meanRevPull;
      const rawNext = p * (1 + drift + shock + jump);
      const next = Number.isFinite(rawNext) ? Math.max(0.01, Math.min(1e15, rawNext)) : p;

      const range = Math.abs(next - p) + safeVol * p * 0.5;
      const h = Math.max(p, next) + rnd() * range * 0.4;
      const l = Math.min(p, next) - rnd() * range * 0.4;
      out.push({
        time: t,
        open: p,
        high: h,
        low: Math.max(0.01, l),
        close: next,
        volume: Math.max(1, Math.round(100 + rnd() * 900 + Math.abs(jump) * 100000)),
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

  root.CYBER_FEED = { createFeed, syntheticSeries, demoTick, seeded, assetSeed };
})(typeof self !== "undefined" ? self : globalThis);
