/**
 * Candle feed: live ticks, or a seeded demo market when Quotex is offline.
 */
(function (root) {
  "use strict";

  function createFeed(opts) {
    const tf = (opts && opts.tfMs) || 60000;
    const max = (opts && opts.max) || 400;
    let candles = [];
    let current = null;
    let last = null;

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
        open: p,
        high: p,
        low: p,
        close: p,
      };
      return series();
    }

    return {
      ingest,
      series,
      seedHistory,
      lastPrice: function () {
        return last;
      },
      reset: function () {
        candles = [];
        current = null;
        last = null;
      },
    };
  }

  function demoTick(price) {
    const step = price * (0.00012 + Math.random() * 0.00025);
    const dir = Math.random() > 0.48 ? 1 : -1;
    return Math.max(0.2, price + dir * step);
  }

  root.CYBER_FEED = { createFeed, demoTick };
})(typeof self !== "undefined" ? self : globalThis);
