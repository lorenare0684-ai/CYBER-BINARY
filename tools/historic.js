#!/usr/bin/env node
"use strict";

/**
 * Historic accuracy report.
 *
 * Runs the engine across the full asset catalog × strategy presets on
 * deterministic synthetic 1m candles, then prints a summary table.
 *
 * Usage:
 *   node tools/historic.js                # default 7d, all assets/strategies
 *   node tools/historic.js --days 14      # 14 days
 *   node tools/historic.js --kinds fx     # only FX
 *   node tools/historic.js --strategies trend,meanrev
 *   node tools/historic.js --json         # machine-readable output
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const opts = { days: 2, kinds: null, strategies: null, json: false, minConf: 0, horizon: 3, minBars: 120 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--days") opts.days = Number(args[++i]) || 2;
  else if (args[i] === "--kinds") opts.kinds = args[++i].split(",");
  else if (args[i] === "--strategies") opts.strategies = args[++i].split(",");
  else if (args[i] === "--json") opts.json = true;
  else if (args[i] === "--minConf") opts.minConf = Number(args[++i]) || 0;
  else if (args[i] === "--horizon") opts.horizon = Number(args[++i]) || 3;
  else if (args[i] === "--minBars") opts.minBars = Number(args[++i]) || 200;
}

const sandbox = { console, self: {}, process, require, module, __filename, __dirname };
sandbox.globalThis = sandbox.self;
vm.createContext(sandbox);
const lib = path.join(__dirname, "..", "src", "lib");
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "backtest.js", "storage.js", "auto.js", "workers.js"]) {
  vm.runInContext(fs.readFileSync(path.join(lib, f), "utf8"), sandbox);
}

const HIST = sandbox.self.CYBER_HIST;
const ASSETS = sandbox.self.CYBER_ASSETS;
const WORKERS = sandbox.self.CYBER_WORKERS;

const stratList = opts.strategies
  ? opts.strategies.map((id) => sandbox.self.CYBER_STRATEGIES.get(id)).filter(Boolean)
  : sandbox.self.CYBER_STRATEGIES.list();

const assetList = opts.kinds
  ? opts.kinds.flatMap((k) => ASSETS.byKind(k))
  : ASSETS.list();

if (!opts.json) {
  console.log("CYBER BINARY · historic backtest");
  console.log("─".repeat(60));
  console.log("days:", opts.days, "horizon:", opts.horizon, "minConf:", opts.minConf);
  console.log("assets:", assetList.length, "strategies:", stratList.length);
  console.log("");
}

(async () => {
  const t0 = Date.now();
  const matrix = WORKERS
    ? await WORKERS.run({
        days: opts.days,
        horizon: opts.horizon,
        minConf: opts.minConf,
        strategies: stratList,
        assets: assetList,
        kinds: opts.kinds,
        minBars: opts.minBars,
        sortBy: "winrate",
        libDir: path.join(__dirname, "..", "src", "lib"),
      })
    : HIST.runMatrix({
        days: opts.days,
        horizon: opts.horizon,
        minConf: opts.minConf,
        strategies: stratList,
        assets: assetList,
        kinds: opts.kinds,
        minBars: opts.minBars,
      });

  const sum = HIST.summarize(matrix);

  if (opts.json) {
    process.stdout.write(JSON.stringify({ options: opts, summary: sum, results: matrix.results }, null, 2));
    process.exit(0);
  }

  function row(cells, widths) {
    return cells.map((c, i) => String(c).padEnd(widths[i])).join("  ");
  }
  const W = [16, 18, 8, 8, 8, 10, 8];

  console.log(row(["Strategy", "Asset", "Trades", "Wins", "Losses", "Win rate", "P&L"], W));
  console.log(row(W.map((w) => "─".repeat(w)), W));

  for (const r of matrix.results) {
    console.log(row([r.strategy, r.name, r.total, r.wins, r.losses, r.winrate.toFixed(1) + "%", r.pnl], W));
  }

  console.log("");
  console.log("─".repeat(60));
  console.log("Summary");
  console.log("─".repeat(60));
  console.log("  Trades:    " + sum.trades);
  console.log("  Wins:      " + sum.wins);
  console.log("  Losses:    " + sum.losses);
  console.log("  Win rate:  " + sum.winrate.toFixed(2) + "%");
  console.log("  P&L:       " + sum.pnl + " units");
  console.log("");
  console.log("By strategy:");
  for (const k of Object.keys(sum.byStrategy).sort((a, b) => sum.byStrategy[b].winrate - sum.byStrategy[a].winrate)) {
    const v = sum.byStrategy[k];
    console.log("  " + k.padEnd(14) + " " + String(v.total).padStart(5) + " trades  " + v.winrate.toFixed(1).padStart(6) + "%");
  }
  console.log("");
  console.log("By class:");
  for (const k of Object.keys(sum.byKind).sort((a, b) => sum.byKind[b].winrate - sum.byKind[a].winrate)) {
    const v = sum.byKind[k];
    console.log("  " + k.padEnd(12) + " " + String(v.total).padStart(5) + " trades  " + v.winrate.toFixed(1).padStart(6) + "%");
  }
  console.log("");
  console.log("Best per asset (top 8):");
  const bestMap = HIST.bestPerAsset(matrix);
  const bestArr = Object.entries(bestMap).map(([k, v]) => ({ k, v })).filter((x) => x.v).sort((a, b) => b.v.winrate - a.v.winrate).slice(0, 8);
  for (const x of bestArr) {
    console.log("  " + x.k.padEnd(8) + " " + (x.v.strategy || "").padEnd(12) + " " + x.v.winrate.toFixed(1) + "%  (" + x.v.total + " trades)");
  }
})();
