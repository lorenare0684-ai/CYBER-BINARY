/**
 * Historic backtest across the full asset catalog and strategy presets.
 * Produces per-asset, per-strategy accuracy tables, regime breakdowns,
 * walk-forward splits, and a calibration curve.
 *
 * Data sources (in order of preference):
 *   1. Cached live candles from chrome.storage.local (s.candles[asset])
 *   2. Synthetic 1m series for the asset (always available, deterministic)
 *
 * This runs both in the extension content-script and Node (for `node tools/`).
 */
(function (root) {
  "use strict";

  const FEED = root.CYBER_FEED;
  const ENG = root.CYBER_ENGINE;
  const ASSETS = root.CYBER_ASSETS;
  const STRAT = root.CYBER_STRATEGIES;

  if (!FEED || !ENG || !ASSETS) {
    // Module may load before deps; consumers should check.
    root.CYBER_HIST = null;
    return;
  }

  /**
   * Build a 1m series for an asset. Cached if available; else synthetic.
   * If `cachedBars` is provided, it is preferred (and synthetic is appended
   * before the cached slice to extend history).
   */
  function getSeries(asset, opts) {
    const o = opts || {};
    const days = o.days || 7;
    const minutes = days * 24 * 60;
    const synth = FEED.syntheticSeries(asset.id, minutes, { seed: o.seed || (asset.id.charCodeAt(0) + asset.id.length) });
    if (o.cachedBars && o.cachedBars.length) {
      // Append cached live bars (deduplicated by time)
      const seen = new Set(synth.map((b) => b.time));
      for (const b of o.cachedBars) {
        if (!seen.has(b.time)) synth.push(b);
      }
      synth.sort((a, b) => a.time - b.time);
    }
    return synth;
  }

  function runOne(asset, strategy, opts) {
    const o = Object.assign({ days: 7, seed: 7, horizon: 3, minConf: 0, minBars: 120 }, opts || {});
    const series = getSeries(asset, o);
    const res = ENG.backtest(series, {
      strategy: strategy.id,
      horizon: o.horizon,
      minConf: o.minConf,
      minBars: o.minBars,
    });
    return {
      asset: asset.id,
      name: asset.name,
      kind: asset.kind,
      strategy: strategy.id,
      strategyLabel: strategy.label,
      horizon: o.horizon,
      days: o.days,
      wins: res.wins, losses: res.losses, total: res.total,
      winrate: res.winrate, payoff: res.payoff, pnl: res.pnl,
      maxDrawdown: res.maxDrawdown, maxWinStreak: res.maxWinStreak, maxLossStreak: res.maxLossStreak,
      byRegime: res.byRegime, calibration: res.calibration,
    };
  }

  /**
   * Run the full matrix: every asset × every strategy (configurable).
   * Returns results sorted by winrate desc.
   */
  function runMatrix(opts) {
    const o = Object.assign({
      days: 7,
      strategies: null,        // null = all
      assets: null,            // null = all
      horizon: 3,
      minConf: 0,
      minBars: 200,
      sortBy: "winrate",
      onProgress: null,
    }, opts || {});

    const strategies = o.strategies || STRAT.list();
    const assets = (o.assets || ASSETS.list()).filter((a) => !o.kinds || o.kinds.includes(a.kind));
    const results = [];
    let i = 0;
    const total = assets.length * strategies.length;

    // Pre-build series once per asset.
    const seriesByAsset = {};
    for (const a of assets) {
      seriesByAsset[a.id] = getSeries(a, o);
    }

    for (const a of assets) {
      const series = seriesByAsset[a.id];
      for (const s of strategies) {
        const res = ENG.backtest(series, {
          strategy: s.id,
          horizon: o.horizon,
          minConf: o.minConf,
          minBars: o.minBars,
        });
        results.push({
          asset: a.id,
          name: a.name,
          kind: a.kind,
          strategy: s.id,
          strategyLabel: s.label,
          horizon: o.horizon,
          days: o.days,
          wins: res.wins, losses: res.losses, total: res.total,
          winrate: res.winrate, payoff: res.payoff, pnl: res.pnl,
          maxDrawdown: res.maxDrawdown, maxWinStreak: res.maxWinStreak, maxLossStreak: res.maxLossStreak,
          byRegime: res.byRegime, calibration: res.calibration,
        });
        i++;
        if (o.onProgress) o.onProgress({ i, total, asset: a.id, strategy: s.id, result: res });
      }
    }

    results.sort((x, y) => (y[o.sortBy] || 0) - (x[o.sortBy] || 0));
    return { results, count: results.length };
  }

  /**
   * Best strategy per asset (by winrate, with at least 30 trades).
   */
  function bestPerAsset(matrix, opts) {
    const o = Object.assign({ minTrades: 30 }, opts || {});
    const grouped = {};
    for (const r of matrix.results) {
      if (!grouped[r.asset]) grouped[r.asset] = [];
      grouped[r.asset].push(r);
    }
    const out = {};
    for (const a of Object.keys(grouped)) {
      const candidates = grouped[a].filter((r) => r.total >= o.minTrades);
      const pool = candidates.length ? candidates : grouped[a];
      pool.sort((x, y) => y.winrate - x.winrate);
      out[a] = pool[0] || null;
    }
    return out;
  }

  function summarize(matrix) {
    const all = matrix.results;
    if (!all.length) return null;
    const total = all.reduce((s, r) => s + r.total, 0);
    const wins = all.reduce((s, r) => s + r.wins, 0);
    const losses = all.reduce((s, r) => s + r.losses, 0);
    const winrate = total ? (wins / total) * 100 : 0;
    const pnl = all.reduce((s, r) => s + r.pnl, 0);
    // Group by strategy
    const byStrategy = {};
    for (const r of all) {
      if (!byStrategy[r.strategy]) byStrategy[r.strategy] = { wins: 0, losses: 0, total: 0 };
      byStrategy[r.strategy].wins += r.wins;
      byStrategy[r.strategy].losses += r.losses;
      byStrategy[r.strategy].total += r.total;
    }
    for (const k of Object.keys(byStrategy)) {
      const v = byStrategy[k];
      v.winrate = v.total ? (v.wins / v.total) * 100 : 0;
    }
    const byKind = {};
    for (const r of all) {
      if (!byKind[r.kind]) byKind[r.kind] = { wins: 0, losses: 0, total: 0 };
      byKind[r.kind].wins += r.wins;
      byKind[r.kind].losses += r.losses;
      byKind[r.kind].total += r.total;
    }
    for (const k of Object.keys(byKind)) {
      const v = byKind[k];
      v.winrate = v.total ? (v.wins / v.total) * 100 : 0;
    }
    return {
      assets: new Set(all.map((r) => r.asset)).size,
      strategies: new Set(all.map((r) => r.strategy)).size,
      trades: total, wins, losses, winrate, pnl,
      byStrategy, byKind,
    };
  }

  root.CYBER_HIST = { runOne, runMatrix, bestPerAsset, summarize, getSeries };
})(typeof self !== "undefined" ? self : globalThis);
