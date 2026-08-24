/**
 * Worker-pool parallel backtester.
 * Node: uses worker_threads.
 * Browser: uses a single worker (best-effort) or falls back to chunked async.
 *
 * Each worker receives a chunk of (asset, strategy) pairs and returns
 * { results: [...] }.
 */
(function (root) {
  "use strict";

  const FEED = root.CYBER_FEED;
  const ENG = root.CYBER_ENGINE;
  const ASSETS = root.CYBER_ASSETS;
  const STRATEGIES = root.CYBER_STRATEGIES;

  if (!FEED || !ENG || !ASSETS || !STRATEGIES) {
    root.CYBER_WORKERS = null;
    return;
  }

  function numberValue(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    try {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function boundedDays(value) {
    const n = numberValue(value);
    return n != null ? Math.max(1, Math.min(31, Math.floor(n))) : 2;
  }

  function resolveAsset(value) {
    const id = typeof value === "string" ? value
      : (value && typeof value === "object" && typeof value.id === "string" ? value.id : "");
    return id ? ASSETS.get(id) : null;
  }

  function resolveStrategy(value) {
    const id = typeof value === "string" ? value
      : (value && typeof value === "object" && typeof value.id === "string" ? value.id : "");
    return id ? STRATEGIES.get(id) : null;
  }

  function matchesKinds(asset, kinds) {
    if (!Array.isArray(kinds)) return true;
    return kinds.some((kind) => typeof ASSETS.matchesKind === "function"
      ? ASSETS.matchesKind(asset, kind) : !!asset && asset.kind === kind);
  }

  function sortResults(results, requestedKey) {
    const allowed = new Set(["winrate", "wins", "losses", "draws", "total", "payoff", "pnl", "maxDrawdown", "maxWinStreak", "maxLossStreak"]);
    const key = allowed.has(requestedKey) ? requestedKey : "winrate";
    results.sort((x, y) => {
      const rawA = x && typeof x[key] === "number" ? numberValue(x[key]) : null;
      const rawB = y && typeof y[key] === "number" ? numberValue(y[key]) : null;
      const a = rawA == null ? -Infinity : rawA;
      const b = rawB == null ? -Infinity : rawB;
      return a === b ? 0 : (b > a ? 1 : -1);
    });
  }

  function uniqueById(values, resolve, limit) {
    const out = [], seen = new Set();
    if (!Array.isArray(values)) return out;
    for (const value of values) {
      const item = resolve(value);
      const id = item && typeof item.id === "string" ? item.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  function buildJob(assets, strategies, opts) {
    opts = opts || {};
    assets = uniqueById(assets, resolveAsset, 256);
    if (Array.isArray(opts.kinds)) assets = assets.filter((a) => matchesKinds(a, opts.kinds));
    strategies = uniqueById(strategies, resolveStrategy, 128);
    // Pre-build series for each asset, return as plain array of objects.
    const seriesByAsset = Object.create(null);
    const days = boundedDays(opts.days);
    const rawSeed = numberValue(opts.seed);
    const seed = rawSeed != null ? rawSeed : 7;
    const cachedByAsset = opts.cachedByAsset && typeof opts.cachedByAsset === "object" ? opts.cachedByAsset : null;
    for (const a of assets) {
      let s = null;
      if (cachedByAsset && Array.isArray(cachedByAsset[a.id]) && root.CYBER_HIST && root.CYBER_HIST.getSeries) {
        s = root.CYBER_HIST.getSeries(a, { days, seed, cachedByAsset, liveOnly: opts.liveOnly === true || opts.requireLive === true });
      }
      if (!s) s = (opts.liveOnly === true || opts.requireLive === true) ? [] : FEED.syntheticSeries(a, days * 24 * 60, { seed });
      seriesByAsset[a.id] = s;
    }
    const jobs = [];
    for (const a of assets) {
      for (const st of strategies) {
        jobs.push({ asset: a, strategy: st });
      }
    }
    return { seriesByAsset, jobs };
  }

  function runChunk(seriesByAsset, jobs, opts) {
    opts = opts || {};
    const out = [];
    const days = boundedDays(opts.days);
    const rawHorizon = numberValue(opts.horizon);
    const horizon = rawHorizon != null ? Math.max(1, Math.min(1440, Math.floor(rawHorizon))) : 3;
    const rawMinConf = numberValue(opts.minConf);
    const minConf = rawMinConf != null ? Math.max(0, Math.min(100, rawMinConf)) : 0;
    const rawMinBars = numberValue(opts.minBars);
    const minBars = rawMinBars != null ? Math.max(40, Math.min(2000, Math.floor(rawMinBars))) : 200;
    if (!seriesByAsset || typeof seriesByAsset !== "object" || !Array.isArray(jobs)) return out;
    for (const j of jobs) {
      const a = j && j.asset;
      const s = j && j.strategy;
      if (!a || typeof a.id !== "string" || !s || typeof s.id !== "string") continue;
      const series = seriesByAsset[a.id];
      if (!Array.isArray(series)) continue;
      const res = ENG.backtest(series, {
        strategy: s.id,
        horizon,
        minConf,
        minBars,
      });
      out.push({
        asset: a.id, name: a.name, kind: a.kind,
        strategy: s.id, strategyLabel: s.label,
        horizon, days,
        wins: res.wins, losses: res.losses, draws: res.draws || 0, total: res.total,
        winrate: res.winrate, payoff: res.payoff, pnl: res.pnl,
        maxDrawdown: res.maxDrawdown, maxWinStreak: res.maxWinStreak, maxLossStreak: res.maxLossStreak,
        byRegime: res.byRegime, calibration: res.calibration,
      });
    }
    return out;
  }

  /* Node: worker_threads pool */
  function runNode(opts) {
    opts = opts || {};
    return new Promise((resolve, reject) => {
      let threads;
      try { threads = require("worker_threads"); } catch (e) { threads = null; }
      if (!threads) {
        // Fallback: single-threaded
        const fallbackAssets = Array.isArray(opts.assets) ? opts.assets : ASSETS.list();
        const fallbackStrategies = Array.isArray(opts.strategies) ? opts.strategies : STRATEGIES.list();
        const { seriesByAsset, jobs } = buildJob(fallbackAssets, fallbackStrategies, opts);
        const fallbackResults = runChunk(seriesByAsset, jobs, opts);
        return resolve({ results: fallbackResults, count: fallbackResults.length });
      }
      const numCpus = (require("os").cpus() || []).length || 4;
      // Cap at 4 workers to avoid heavy contention on shared series build
      // and to keep the postMessage fan-in bounded.
      const poolSize = Math.max(1, Math.min(numCpus, 4));
      const assets = uniqueById(Array.isArray(opts.assets) ? opts.assets : ASSETS.list(),
        resolveAsset, 256)
        .filter((a) => matchesKinds(a, opts.kinds));
      const strategies = uniqueById(Array.isArray(opts.strategies) ? opts.strategies : STRATEGIES.list(),
        resolveStrategy, 128);

      // Keep every strategy for an asset in the same worker. The old
      // per-job round-robin made up to four workers regenerate the identical
      // asset series, multiplying historic-run CPU and allocation cost.
      const chunks = [];
      for (let i = 0; i < poolSize; i++) chunks.push([]);
      assets.forEach((asset, assetIndex) => {
        const chunk = chunks[assetIndex % poolSize];
        for (const strategy of strategies) chunk.push({ aid: asset.id, sid: strategy.id });
      });

      // Send only: jobs, libDir, opts. Workers rebuild series themselves.
      const workerSrc = `
        const { parentPort, workerData } = require('worker_threads');
        const vm = require('vm');
        const fs = require('fs');
        const path = require('path');
        const sb = { self: {}, globalThis: null, console };
        sb.globalThis = sb.self;
        vm.createContext(sb);
        const lib = workerData.libDir;
        for (const f of ['indicators.js','assets.js','strategy.js','feed.js','engine.js','backtest.js']) {
          vm.runInContext(fs.readFileSync(path.join(lib, f), 'utf8'), sb);
        }
        const FEED = sb.self.CYBER_FEED;
        const ENG = sb.self.CYBER_ENGINE;
        const ASSETS = sb.self.CYBER_ASSETS;
        const jobs = workerData.jobs;
        const opts = workerData.opts;
        const out = [];
        try {
          let currentAid = '', currentSeries = null, currentMeta = null;
          for (const j of jobs) {
            if (currentAid !== j.aid) {
              const a = ASSETS.get(j.aid);
              currentAid = j.aid;
              currentSeries = a
                ? FEED.syntheticSeries(a, (opts.days || 2) * 24 * 60, { seed: opts.seed }) : null;
              currentMeta = a ? { name: a.name, kind: a.kind } : null;
            }
            const strategy = sb.self.CYBER_STRATEGIES.get(j.sid);
            if (!currentSeries || !currentMeta || !strategy) continue;
            const res = ENG.backtest(currentSeries, {
              strategy: strategy.id,
              horizon: opts.horizon || 3,
              minConf: opts.minConf || 0,
              minBars: opts.minBars != null ? opts.minBars : 200,
            });
            out.push({
              asset: j.aid, name: currentMeta.name, kind: currentMeta.kind,
              strategy: strategy.id, strategyLabel: strategy.label,
              horizon: opts.horizon || 3, days: opts.days || 2,
              wins: res.wins, losses: res.losses, draws: res.draws || 0, total: res.total,
              winrate: res.winrate, payoff: res.payoff, pnl: res.pnl,
              maxDrawdown: res.maxDrawdown, maxWinStreak: res.maxWinStreak, maxLossStreak: res.maxLossStreak,
              byRegime: res.byRegime, calibration: res.calibration,
            });
          }
          parentPort.postMessage({ ok: true, results: out });
        } catch (e) {
          parentPort.postMessage({ ok: false, error: String(e && e.stack || e) });
        }
      `;

      // Resolve the lib dir. Prefer the explicit option, then the outer
      // Node __dirname (if this module is loaded directly), then cwd.
      let libDir = opts.libDir;
      if (!libDir) {
        try { libDir = require("path").resolve(__dirname); } catch (e) {}
      }
      if (!libDir) libDir = process.cwd();
      libDir = libDir.replace(/\\/g, "/");
      const activeChunks = chunks.filter((c) => c.length > 0);
      if (!activeChunks.length) return resolve({ results: [], count: 0 });
      let reportDone = 0;
      let exitDone = 0;
      let resolved = false;
      const all = [];
      const errors = [];
      const rawHorizon = numberValue(opts.horizon), rawMinConf = numberValue(opts.minConf), rawMinBars = numberValue(opts.minBars);
      const rawSeed = numberValue(opts.seed);
      const workerOpts = {
        days: boundedDays(opts.days),
        seed: rawSeed != null ? rawSeed : 7,
        horizon: rawHorizon != null ? Math.max(1, Math.min(1440, Math.floor(rawHorizon))) : 3,
        minConf: rawMinConf != null ? Math.max(0, Math.min(100, rawMinConf)) : 0,
        minBars: rawMinBars != null ? Math.max(40, Math.min(2000, Math.floor(rawMinBars))) : 200,
      };
      function maybeFinish() {
        if (resolved || reportDone < activeChunks.length || exitDone < activeChunks.length) return;
        resolved = true;
        if (all.length === 0 && errors.length) {
          return resolve({ results: [], count: 0, error: errors.join("; ") });
        }
        sortResults(all, opts.sortBy);
        resolve({ results: all, count: all.length, errors: errors.length ? errors.slice() : undefined });
      }
      for (let i = 0; i < activeChunks.length; i++) {
        let reported = false;
        let exited = false;
        let w;
        try {
          w = new threads.Worker(workerSrc, {
            eval: true,
            workerData: { jobs: activeChunks[i], opts: workerOpts, libDir },
          });
        } catch (e) {
          errors.push(String(e && e.message || e));
          reportDone++; exitDone++;
          maybeFinish();
          continue;
        }
        w.on("message", (m) => {
          if (reported) return;
          reported = true;
          if (m && m.ok && Array.isArray(m.results)) {
            for (const r of m.results) all.push(r);
          } else if (m && m.error) {
            errors.push(m.error);
          } else {
            errors.push("worker returned an invalid response");
          }
          reportDone++; maybeFinish();
        });
        w.on("error", (e) => {
          errors.push(String(e && e.message || e));
          if (!reported) { reported = true; reportDone++; }
          maybeFinish();
        });
        w.on("exit", (code) => {
          if (exited) return;
          exited = true;
          if (code !== 0) errors.push("worker exited " + code);
          if (!reported) { reported = true; reportDone++; }
          exitDone++; maybeFinish();
        });
      }
    });
  }

  /* Browser fallback: simple chunked async on the current thread. */
  function runBrowserChunked(opts) {
    opts = opts || {};
    return new Promise((resolve) => {
      const assets = uniqueById(Array.isArray(opts.assets) ? opts.assets : ASSETS.list(),
        resolveAsset, 256)
        .filter((a) => matchesKinds(a, opts.kinds));
      const strategies = uniqueById(Array.isArray(opts.strategies) ? opts.strategies : STRATEGIES.list(),
        resolveStrategy, 128);
      const jobs = [];
      for (const asset of assets) for (const strategy of strategies) jobs.push({ asset, strategy });
      const out = [];
      const days = boundedDays(opts.days);
      let i = 0, seriesAsset = "", series = null;
      function step() {
        // Generate only one asset's candles at a time. The former eager map
        // allocated every asset × every day up front (hundreds of MB for the
        // 31-day UI option) and froze or killed the dashboard before job one.
        const job = jobs[i];
        if (!job) {
          sortResults(out, opts.sortBy);
          resolve({ results: out, count: out.length });
          return;
        }
        if (seriesAsset !== job.asset.id) {
          seriesAsset = job.asset.id;
          const cachedByAsset = opts.cachedByAsset && typeof opts.cachedByAsset === "object" ? opts.cachedByAsset : null;
          series = null;
          if (cachedByAsset && Array.isArray(cachedByAsset[job.asset.id]) && root.CYBER_HIST && root.CYBER_HIST.getSeries) {
            series = root.CYBER_HIST.getSeries(job.asset, {
              days, seed: opts.seed, cachedByAsset,
              liveOnly: opts.liveOnly === true || opts.requireLive === true,
            });
          }
          if (!series) series = (opts.liveOnly === true || opts.requireLive === true)
            ? [] : FEED.syntheticSeries(job.asset, Math.round(days * 24 * 60), { seed: opts.seed });
        }
        for (const result of runChunk({ [job.asset.id]: series }, [job], opts)) out.push(result);
        i++;
        try { if (typeof opts.onProgress === "function") opts.onProgress({ i, total: jobs.length }); } catch (_) {}
        // One job per task keeps controls/painting responsive even at 31 days.
        setTimeout(step, 0);
      }
      step();
    });
  }

  function runBrowser(opts) {
    opts = opts || {};
    const runtime = root.chrome && root.chrome.runtime;
    if (typeof root.Worker !== "function" || !runtime || typeof runtime.getURL !== "function") {
      return runBrowserChunked(opts);
    }
    const assets = uniqueById(Array.isArray(opts.assets) ? opts.assets : ASSETS.list(),
      resolveAsset, 256)
      .filter((a) => matchesKinds(a, opts.kinds));
    const strategies = uniqueById(Array.isArray(opts.strategies) ? opts.strategies : STRATEGIES.list(),
      resolveStrategy, 128);
    if (!assets.length || !strategies.length) {
      return Promise.resolve({ results: [], count: 0 });
    }
    const rawSeed = numberValue(opts.seed);
    const rawHorizon = numberValue(opts.horizon), rawMinConf = numberValue(opts.minConf), rawMinBars = numberValue(opts.minBars);
    const basePayload = {
      strategies: strategies.map((s) => s.id),
      days: boundedDays(opts.days),
      seed: rawSeed != null ? rawSeed : 7,
      horizon: rawHorizon != null ? Math.max(1, Math.min(1440, Math.floor(rawHorizon))) : 3,
      minConf: rawMinConf != null ? Math.max(0, Math.min(100, rawMinConf)) : 0,
      minBars: rawMinBars != null ? Math.max(40, Math.min(2000, Math.floor(rawMinBars))) : 200,
      sortBy: opts.sortBy,
      cachedByAsset: opts.cachedByAsset && typeof opts.cachedByAsset === "object" ? opts.cachedByAsset : null,
      liveOnly: opts.liveOnly === true || opts.requireLive === true,
    };
    // Pool of dedicated workers so full-catalog runs (every asset × every
    // strategy) finish in a fraction of the single-worker time. Assets are
    // split into contiguous chunks; a worker that dies has only its own
    // chunk replayed by the responsive chunked runner on the main thread.
    let cores = 0;
    try { cores = Math.max(1, Math.floor(Number(root.navigator && root.navigator.hardwareConcurrency) || 0)); } catch (_) {}
    const poolSize = Math.max(1, Math.min(cores || 2, 4, assets.length));
    const chunks = [];
    for (let ci = 0; ci < poolSize; ci++) chunks.push([]);
    const per = Math.ceil(assets.length / poolSize);
    for (let ai = 0; ai < assets.length; ai++) {
      chunks[Math.min(poolSize - 1, Math.floor(ai / per))].push(assets[ai]);
    }
    const activeChunks = chunks.filter((c) => c.length > 0);
    const totalJobs = assets.length * strategies.length;
    return new Promise((resolve) => {
      const results = [];
      const failedAssets = [];
      const progress = new Array(activeChunks.length).fill(0);
      let settled = 0;
      let reported = false;
      function reportProgress() {
        try {
          if (typeof opts.onProgress !== "function") return;
          let done = 0;
          for (const p of progress) done += p;
          opts.onProgress({ i: done, total: totalJobs });
        } catch (_) {}
      }
      function finish() {
        if (reported || settled < activeChunks.length) return;
        reported = true;
        if (!failedAssets.length) {
          sortResults(results, opts.sortBy);
          resolve({ results, count: results.length });
          return;
        }
        runBrowserChunked(Object.assign({}, opts, { assets: failedAssets, onProgress: null }))
          .then((recovered) => {
            if (recovered && Array.isArray(recovered.results)) {
              for (const r of recovered.results) results.push(r);
            }
            sortResults(results, opts.sortBy);
            resolve({ results, count: results.length });
          })
          .catch(() => {
            sortResults(results, opts.sortBy);
            resolve({ results, count: results.length });
          });
      }
      activeChunks.forEach((chunk, wi) => {
        let worker = null;
        try {
          worker = new root.Worker(runtime.getURL("src/historic-worker.js"));
        } catch (e) {
          for (const a of chunk) failedAssets.push(a);
          settled++;
          finish();
          return;
        }
        let done = false;
        function fail() {
          if (done) return;
          done = true;
          try { worker.terminate(); } catch (_) {}
          for (const a of chunk) failedAssets.push(a);
          settled++;
          finish();
        }
        worker.onmessage = (event) => {
          const message = event && event.data;
          if (!message || typeof message !== "object" || done) return;
          if (message.type === "error") { fail(); return; }
          if (message.type === "progress") {
            progress[wi] = Math.max(0, Math.floor(numberValue(message.i) || 0));
            reportProgress();
            return;
          }
          if (message.type === "done" && message.result && Array.isArray(message.result.results)) {
            done = true;
            for (const r of message.result.results) results.push(r);
            progress[wi] = chunk.length * strategies.length;
            reportProgress();
            try { worker.terminate(); } catch (_) {}
            settled++;
            finish();
          }
        };
        worker.onerror = fail;
        worker.onmessageerror = fail;
        try {
          worker.postMessage(Object.assign({}, basePayload, { assets: chunk.map((a) => a.id) }));
        } catch (e) {
          fail();
        }
      });
    });
  }

  function run(opts) {
    opts = opts || {};
    // Detect Node by checking for `process.versions.node` AND for `require`.
    // Both must be present to use worker_threads.
    const isNode = (function () {
      try { return typeof require === "function" && typeof process !== "undefined" && process && process.versions && process.versions.node; }
      catch (e) { return false; }
    })();
    if (isNode) {
      try { return runNode(opts); } catch (e) { /* fall through */ }
    }
    return runBrowser(opts);
  }

  root.CYBER_WORKERS = { run, runNode, runBrowser, runBrowserChunked, buildJob, runChunk };
})(typeof self !== "undefined" ? self : globalThis);
