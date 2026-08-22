#!/usr/bin/env node
"use strict";

/**
 * Bounded parameter grid search with parallel workers.
 */
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const sandbox = { console, self: {}, process, require, module, __filename, __dirname };
sandbox.globalThis = sandbox.self;
vm.createContext(sandbox);
const lib = path.join(__dirname, "..", "src", "lib");
for (const f of ["indicators.js", "assets.js", "strategy.js", "feed.js", "engine.js", "backtest.js", "workers.js"]) {
  vm.runInContext(fs.readFileSync(path.join(lib, f), "utf8"), sandbox);
}

const FEED = sandbox.self.CYBER_FEED;
const ENG = sandbox.self.CYBER_ENGINE;
const ASSETS = sandbox.self.CYBER_ASSETS;

const grid = [];
for (const minScore of [3, 4]) {
  for (const horizon of [2, 3]) {
    for (const minAtrPct of [0.0001, 0.0002]) {
      for (const minConf of [0, 60]) {
        grid.push({ minScore, horizon, minAtrPct, minConf });
      }
    }
  }
}
console.error("Grid size:", grid.length);

(async () => {
  // Small training set: 1 day on EURUSD.
  const train = [
    { aid: "EURUSD", sid: "confluence", days: 1 },
  ];
  const seriesByAid = {};
  for (const t of train) {
    const a = ASSETS.get(t.aid);
    seriesByAid[t.aid] = FEED.syntheticSeries(a, t.days * 24 * 60, { seed: a.id.length * 13 });
  }

  let best = null;
  for (const g of grid) {
    let w = 0, l = 0;
    for (const t of train) {
      const r = ENG.backtest(seriesByAid[t.aid], Object.assign({ strategy: t.sid, minBars: 100 }, g));
      w += r.wins; l += r.losses;
    }
    const tot = w + l;
    if (tot < 20) continue;
    const wr = w / tot;
    const score = wr * Math.log(tot);
    if (!best || score > best.score) best = { ...g, w, l, tot, wr, score };
  }
  console.log(JSON.stringify(best, null, 2));
})();
