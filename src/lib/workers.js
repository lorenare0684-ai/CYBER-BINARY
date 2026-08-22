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

  if (!FEED || !ENG || !ASSETS) {
    root.CYBER_WORKERS = null;
    return;
  }

  function buildJob(assets, strategies, opts) {
    // Pre-build series for each asset, return as plain array of objects.
    const seriesByAsset = {};
    for (const a of assets) {
      const o = Object.assign({}, opts, { cachedBars: undefined });
      const s = FEED.syntheticSeries(a, (opts.days || 2) * 24 * 60, { seed: (opts.seed || 7) + a.id.length });
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
    const out = [];
    for (const j of jobs) {
      const a = j.asset;
      const s = j.strategy;
      const series = seriesByAsset[a.id];
      const res = ENG.backtest(series, {
        strategy: s.id,
        horizon: opts.horizon || 3,
        minConf: opts.minConf || 0,
        minBars: opts.minBars || 200,
      });
      out.push({
        asset: a.id, name: a.name, kind: a.kind,
        strategy: s.id, strategyLabel: s.label,
        horizon: opts.horizon || 3, days: opts.days || 2,
        wins: res.wins, losses: res.losses, total: res.total,
        winrate: res.winrate, payoff: res.payoff, pnl: res.pnl,
        maxDrawdown: res.maxDrawdown, maxWinStreak: res.maxWinStreak, maxLossStreak: res.maxLossStreak,
        byRegime: res.byRegime, calibration: res.calibration,
      });
    }
    return out;
  }

  /* Node: worker_threads pool */
  function runNode(opts) {
    return new Promise((resolve, reject) => {
      let threads;
      try { threads = require("worker_threads"); } catch (e) { threads = null; }
      if (!threads) {
        // Fallback: single-threaded
        const { seriesByAsset, jobs } = buildJob(
          (opts.assets || ASSETS.list()).filter((a) => !opts.kinds || opts.kinds.includes(a.kind)),
          opts.strategies || root.CYBER_STRATEGIES.list(),
          opts
        );
        return resolve(runChunk(seriesByAsset, jobs, opts));
      }
      const numCpus = (require("os").cpus() || []).length || 4;
      // Cap at 4 workers to avoid heavy contention on shared series build
      // and to keep the postMessage fan-in bounded.
      const poolSize = Math.max(1, Math.min(numCpus, 4));
      const assets = (opts.assets || ASSETS.list()).filter((a) => !opts.kinds || opts.kinds.includes(a.kind));
      const strategies = opts.strategies || root.CYBER_STRATEGIES.list();

      // Build jobs (small payload: just asset id + strategy id).
      const jobs = [];
      for (const a of assets) {
        for (const st of strategies) {
          jobs.push({ aid: a.id, sid: st.id });
        }
      }

      // Split jobs into N chunks
      const chunks = [];
      for (let i = 0; i < poolSize; i++) chunks.push([]);
      jobs.forEach((j, i) => chunks[i % poolSize].push(j));

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
          const seriesByAid = {};
          const aMeta = {};
          for (const j of jobs) {
            if (seriesByAid[j.aid]) continue;
            const a = ASSETS.get(j.aid);
            if (!a) continue;
            const series = FEED.syntheticSeries(a, (opts.days || 2) * 24 * 60, { seed: (opts.seed || 7) + a.id.length });
            seriesByAid[j.aid] = series;
            aMeta[j.aid] = { name: a.name, kind: a.kind };
          }
          for (const j of jobs) {
            const series = seriesByAid[j.aid];
            if (!series) continue;
            const res = ENG.backtest(series, {
              strategy: j.sid,
              horizon: opts.horizon || 3,
              minConf: opts.minConf || 0,
              minBars: opts.minBars || 120,
            });
            out.push({
              asset: j.aid, name: aMeta[j.aid].name, kind: aMeta[j.aid].kind,
              strategy: j.sid, strategyLabel: j.sid,
              horizon: opts.horizon || 3, days: opts.days || 2,
              wins: res.wins, losses: res.losses, total: res.total,
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
        try { libDir = path.resolve(__dirname); } catch (e) {}
      }
      if (!libDir) libDir = process.cwd();
      libDir = libDir.replace(/\\/g, "/");
      let msgDone = 0;
      let exitDone = 0;
      const all = [];
      const errors = [];
      function maybeFinish() {
        // Resolve when all workers have sent a message AND exited.
        if (msgDone >= poolSize && exitDone >= poolSize) {
          if (all.length === 0 && errors.length) {
            return resolve({ results: [], count: 0, error: errors.join("; ") });
          }
          all.sort((x, y) => (y[opts.sortBy || "winrate"] || 0) - (x[opts.sortBy || "winrate"] || 0));
          resolve({ results: all, count: all.length });
        }
      }
      for (let i = 0; i < poolSize; i++) {
        if (!chunks[i].length) { msgDone++; exitDone++; continue; }
        const w = new threads.Worker(workerSrc, {
          eval: true,
          workerData: { jobs: chunks[i], opts, libDir },
        });
        w.on("message", (m) => {
          if (m && m.ok) {
            for (const r of m.results) all.push(r);
          } else if (m && m.error) {
            errors.push(m.error);
          }
          msgDone++; maybeFinish();
        });
        w.on("error", (e) => { errors.push(String(e && e.message || e)); msgDone++; maybeFinish(); });
        w.on("exit", (code) => {
          if (code !== 0) errors.push("worker exited " + code);
          exitDone++; maybeFinish();
        });
      }
      if (poolSize === 0 || chunks.every((c) => c.length === 0)) {
        return resolve({ results: [], count: 0 });
      }
    });
  }

  /* Browser: simple chunked async */
  function runBrowser(opts) {
    return new Promise((resolve) => {
      const assets = (opts.assets || ASSETS.list()).filter((a) => !opts.kinds || opts.kinds.includes(a.kind));
      const strategies = opts.strategies || root.CYBER_STRATEGIES.list();
      const { seriesByAsset, jobs } = buildJob(assets, strategies, opts);
      const out = [];
      let i = 0;
      function step() {
        // Run a chunk of 2 jobs per tick to balance progress vs overhead.
        const slice = jobs.slice(i, i + 2);
        i += slice.length;
        for (const r of runChunk(seriesByAsset, slice, opts)) out.push(r);
        if (opts.onProgress) opts.onProgress({ i, total: jobs.length });
        if (i < jobs.length) {
          setTimeout(step, 0);
        } else {
          out.sort((x, y) => (y[opts.sortBy || "winrate"] || 0) - (x[opts.sortBy || "winrate"] || 0));
          resolve({ results: out, count: out.length });
        }
      }
      step();
    });
  }

  function run(opts) {
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

  root.CYBER_WORKERS = { run, runNode, runBrowser, buildJob, runChunk };
})(typeof self !== "undefined" ? self : globalThis);
