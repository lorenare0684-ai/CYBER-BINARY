"use strict";

// Dedicated dashboard backtest worker. Heavy indicator/backtest loops stay off
// the UI thread; workers.js still provides a bounded chunked fallback for
// environments where extension workers are unavailable.
importScripts(
  "lib/indicators.js",
  "lib/assets.js",
  "lib/strategy.js",
  "lib/feed.js",
  "lib/engine.js",
  "lib/backtest.js",
  "lib/workers.js"
);

let started = false;

self.onmessage = function (event) {
  if (started) return;
  started = true;
  const input = event && event.data && typeof event.data === "object" ? event.data : {};
  const workers = self.CYBER_WORKERS;
  if (!workers || typeof workers.runBrowserChunked !== "function") {
    self.postMessage({ type: "error" });
    return;
  }
  workers.runBrowserChunked({
    assets: Array.isArray(input.assets) ? input.assets : [],
    strategies: Array.isArray(input.strategies) ? input.strategies : [],
    days: input.days,
    seed: input.seed,
    horizon: input.horizon,
    minConf: input.minConf,
    minBars: input.minBars,
    payout: input.payout,
    payoutByAsset: input.payoutByAsset,
    useAdaptiveExpiry: input.useAdaptiveExpiry,
    adaptiveExpiryMin: input.adaptiveExpiryMin,
    adaptiveExpiryMax: input.adaptiveExpiryMax,
    sortBy: input.sortBy,
    cachedByAsset: input.cachedByAsset && typeof input.cachedByAsset === "object" ? input.cachedByAsset : null,
    liveOnly: input.liveOnly === true || input.requireLive === true,
    onProgress: function (progress) {
      self.postMessage({ type: "progress", i: progress.i, total: progress.total });
    },
  }).then(function (result) {
    self.postMessage({ type: "done", result: result });
  }).catch(function () {
    self.postMessage({ type: "error" });
  });
};
