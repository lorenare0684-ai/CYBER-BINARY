/**
 * Historic backtest across the full asset catalog and strategy presets.
 * Produces per-asset, per-strategy accuracy tables, regime breakdowns,
 * walk-forward splits, and a calibration curve.
 *
 * Data sources (in order of preference):
 *   1. Cached Quotex live/tick-built candles from chrome.storage.local (s.candles[asset])
 *   2. Synthetic 1m series only when liveOnly/requireLive is not requested
 *
 * This runs both in the extension content-script and Node (for `node tools/`).
 */
(function (root) {
  "use strict";

  const FEED = root.CYBER_FEED;
  const ENG = root.CYBER_ENGINE;
  const ASSETS = root.CYBER_ASSETS;
  const STRAT = root.CYBER_STRATEGIES;

  if (!FEED || !ENG || !ASSETS || !STRAT) {
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
    const o = opts && typeof opts === "object" ? opts : {};
    if (!asset || typeof asset.id !== "string" || !asset.id) return [];
    const requestedDays = Number(o.days);
    const days = Number.isFinite(requestedDays) ? Math.max(1, Math.min(31, requestedDays)) : 7;
    const minutes = Math.round(days * 24 * 60);
    const requestedSeed = Number(o.seed);
    const seed = Number.isFinite(requestedSeed) ? requestedSeed : 7;
    const cachedByAsset = o.cachedByAsset && typeof o.cachedByAsset === "object" ? o.cachedByAsset : null;
    const cached = cachedByAsset && Object.prototype.hasOwnProperty.call(cachedByAsset, asset.id)
      ? cachedByAsset[asset.id] : o.cachedBars;
    const byTime = new Map();
    if (Array.isArray(cached) && cached.length) {
      // Storage keeps this ascending, so the bounded tail is also the newest
      // data. Duplicates are replaced by the last cached value.
      for (const b of cached.slice(-10000)) {
        if (!b || typeof b !== "object" || Array.isArray(b)) continue;
        let time = Number(b.time);
        const open = Number(b.open), high = Number(b.high), low = Number(b.low), close = Number(b.close);
        while (Math.abs(time) >= 1e14) time /= 1000;
        if (Math.abs(time) < 1e11) time *= 1000;
        time = Math.floor(time);
        if (![time, open, high, low, close].every(Number.isFinite) || !Number.isSafeInteger(time) || time < 0 ||
            open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
            high < Math.max(open, low, close) || low > Math.min(open, high, close)) continue;
        const rawVolume = Number(b.volume);
        byTime.set(time, {
          time, open, high, low, close,
          volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? Math.min(Number.MAX_VALUE, rawVolume) : 0,
        });
      }
    }
    let cleanCached = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    if (cleanCached.length > minutes) cleanCached = cleanCached.slice(-minutes);
    if (o.liveOnly === true || o.requireLive === true) return cleanCached;
    const missing = Math.max(0, minutes - cleanCached.length);
    if (!missing || (cleanCached.length && cleanCached[0].time < missing * 60000)) return cleanCached;
    const startTime = cleanCached.length ? cleanCached[0].time - missing * 60000 : undefined;
    const synth = FEED.syntheticSeries(asset.id, missing, { seed, startTime });
    if (cleanCached.length && synth.length) {
      // Join the synthetic prefix continuously to the first real bar. Without
      // this, a profile base around 1.0 followed by a cached BTC bar around
      // 60,000 creates a fake multi-million-percent breakout at the seam.
      const tail = synth[synth.length - 1].close;
      const scale = Number.isFinite(tail) && tail > 0 ? cleanCached[0].open / tail : 1;
      for (const bar of synth) {
        bar.open *= scale; bar.high *= scale; bar.low *= scale; bar.close *= scale;
      }
    }
    return synth.concat(cleanCached);
  }

  function normalizedOptions(opts) {
    const source = opts && typeof opts === "object" ? opts : {};
    const o = Object.assign({}, source);
    const days = Number(source.days), seed = Number(source.seed), horizon = Number(source.horizon);
    const minConf = Number(source.minConf), minBars = Number(source.minBars);
    o.days = Number.isFinite(days) ? Math.max(1, Math.min(31, days)) : 7;
    o.seed = Number.isFinite(seed) ? seed : 7;
    o.horizon = Number.isFinite(horizon) ? Math.max(1, Math.min(1440, Math.floor(horizon))) : 3;
    o.minConf = Number.isFinite(minConf) ? Math.max(0, Math.min(100, minConf)) : 0;
    o.minBars = Number.isFinite(minBars) ? Math.max(40, Math.min(2000, Math.floor(minBars))) : 200;
    return o;
  }

  function runOne(asset, strategy, opts) {
    asset = ASSETS.get(typeof asset === "string" ? asset : asset && asset.id);
    strategy = STRAT && STRAT.get(typeof strategy === "string" ? strategy : strategy && strategy.id);
    if (!asset || !strategy) return null;
    const o = normalizedOptions(opts);
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
      wins: res.wins, losses: res.losses, draws: res.draws || 0, total: res.total,
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
    const o = normalizedOptions(opts);
    const seenStrategies = new Set();
    const strategies = [];
    const strategyInput = Array.isArray(o.strategies) ? o.strategies : STRAT.list();
    for (const value of strategyInput) {
      const strategy = STRAT.get(typeof value === "string" ? value : value && value.id);
      if (!strategy || seenStrategies.has(strategy.id)) continue;
      seenStrategies.add(strategy.id); strategies.push(strategy);
      if (strategies.length >= 128) break;
    }
    const allowedKinds = Array.isArray(o.kinds) ? new Set(o.kinds.filter((v) => typeof v === "string")) : null;
    const seenAssets = new Set();
    const assets = [];
    const assetInput = Array.isArray(o.assets) ? o.assets : ASSETS.list();
    for (const value of assetInput) {
      const asset = ASSETS.get(typeof value === "string" ? value : value && value.id);
      const kindMatch = !allowedKinds || Array.from(allowedKinds).some((kind) =>
        typeof ASSETS.matchesKind === "function" ? ASSETS.matchesKind(asset, kind) : asset && asset.kind === kind);
      if (!asset || seenAssets.has(asset.id) || !kindMatch) continue;
      seenAssets.add(asset.id); assets.push(asset);
      if (assets.length >= 256) break;
    }
    const results = [];
    let i = 0;
    const total = assets.length * strategies.length;

    for (const a of assets) {
      // Keep only the current asset's candles. The former all-asset map made
      // this synchronous fallback consume hundreds of MB at 31 days.
      const series = getSeries(a, o);
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
          wins: res.wins, losses: res.losses, draws: res.draws || 0, total: res.total,
          winrate: res.winrate, payoff: res.payoff, pnl: res.pnl,
          maxDrawdown: res.maxDrawdown, maxWinStreak: res.maxWinStreak, maxLossStreak: res.maxLossStreak,
          byRegime: res.byRegime, calibration: res.calibration,
        });
        i++;
        try { if (typeof o.onProgress === "function") o.onProgress({ i, total, asset: a.id, strategy: s.id, result: res }); } catch (_) {}
      }
    }

    const sortable = new Set(["winrate", "wins", "losses", "draws", "total", "payoff", "pnl", "maxDrawdown", "maxWinStreak", "maxLossStreak"]);
    const sortBy = sortable.has(o.sortBy) ? o.sortBy : "winrate";
    results.sort((x, y) => {
      const rawA = Number(x[sortBy]), rawB = Number(y[sortBy]);
      const a = Number.isNaN(rawA) ? -Infinity : rawA;
      const b = Number.isNaN(rawB) ? -Infinity : rawB;
      return a === b ? 0 : (b > a ? 1 : -1);
    });
    return { results, count: results.length };
  }

  /**
   * Best strategy per asset (by winrate, with at least 30 trades).
   */
  function bestPerAsset(matrix, opts) {
    const requestedMin = Number(opts && opts.minTrades);
    const minTrades = Number.isFinite(requestedMin) ? Math.max(0, Math.min(1000000000, Math.floor(requestedMin))) : 30;
    const grouped = Object.create(null);
    const results = matrix && Array.isArray(matrix.results) ? matrix.results : [];
    for (const r of results) {
      if (!r || typeof r !== "object" || typeof r.asset !== "string" || !r.asset) continue;
      if (!grouped[r.asset]) grouped[r.asset] = [];
      grouped[r.asset].push(r);
    }
    const out = Object.create(null);
    for (const a of Object.keys(grouped)) {
      const candidates = grouped[a].filter((r) => Number(r.total) >= minTrades);
      const pool = candidates.length ? candidates : grouped[a].slice();
      pool.sort((x, y) => {
        const aRate = Number(x.winrate), bRate = Number(y.winrate);
        return (Number.isFinite(bRate) ? bRate : -Infinity) - (Number.isFinite(aRate) ? aRate : -Infinity);
      });
      out[a] = pool[0] || null;
    }
    return out;
  }

  function summarize(matrix) {
    const input = matrix && Array.isArray(matrix.results) ? matrix.results : [];
    const all = input.filter((r) => r && typeof r === "object");
    if (!all.length) return null;
    const count = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
    };
    let wins = 0, losses = 0, draws = 0, pnl = 0, maxDrawdown = 0;
    const byStrategy = Object.create(null);
    const byKind = Object.create(null);
    const assetIds = new Set(), strategyIds = new Set();
    for (const r of all) {
      const rowWins = count(r.wins), rowLosses = count(r.losses), rowDraws = count(r.draws);
      wins += rowWins; losses += rowLosses; draws += rowDraws;
      const rowPnl = Number(r.pnl);
      if (Number.isFinite(rowPnl)) pnl += rowPnl;
      const rowDrawdown = Number(r.maxDrawdown);
      if (Number.isFinite(rowDrawdown) && rowDrawdown >= 0) maxDrawdown = Math.max(maxDrawdown, rowDrawdown);
      if (typeof r.asset === "string" && r.asset) assetIds.add(r.asset);
      if (typeof r.strategy === "string" && r.strategy) strategyIds.add(r.strategy);
      const strategy = typeof r.strategy === "string" && r.strategy ? r.strategy : "unknown";
      const kind = typeof r.kind === "string" && r.kind ? r.kind : "unknown";
      if (!byStrategy[strategy]) byStrategy[strategy] = { wins: 0, losses: 0, total: 0 };
      if (!byKind[kind]) byKind[kind] = { wins: 0, losses: 0, total: 0 };
      for (const group of [byStrategy[strategy], byKind[kind]]) {
        group.wins += rowWins; group.losses += rowLosses; group.total += rowWins + rowLosses;
      }
    }
    for (const groups of [byStrategy, byKind]) {
      for (const k of Object.keys(groups)) {
        const v = groups[k];
        v.winrate = v.total ? (v.wins / v.total) * 100 : 0;
      }
    }
    const total = wins + losses;
    return {
      assets: assetIds.size, strategies: strategyIds.size,
      trades: total, decisions: total + draws, wins, losses, draws,
      winrate: total ? (wins / total) * 100 : 0, pnl, maxDrawdown,
      byStrategy, byKind,
    };
  }

  root.CYBER_HIST = { runOne, runMatrix, bestPerAsset, summarize, getSeries };
})(typeof self !== "undefined" ? self : globalThis);
