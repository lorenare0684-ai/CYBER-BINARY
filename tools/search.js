#!/usr/bin/env node
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");
const sandbox = { console, self: {} };
sandbox.globalThis = sandbox.self;
vm.createContext(sandbox);
const lib = path.join(__dirname, "..", "src", "lib");
vm.runInContext(fs.readFileSync(path.join(lib, "indicators.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(lib, "engine.js"), "utf8"), sandbox);

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
function series(n, seed, regime) {
  const rnd = seeded(seed);
  const out = [];
  let p = 1.085;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const trend = regime === "up" ? 0.00009 : regime === "down" ? -0.00009 : 0;
    const next = Math.max(0.2, p * (1 + trend + (rnd() - 0.5) * 0.0012));
    out.push({
      time: t,
      open: p,
      high: Math.max(p, next) * 1.0002,
      low: Math.min(p, next) * 0.9998,
      close: next,
    });
    p = next;
    t += 60000;
  }
  return out;
}

const data = {
  up: series(3000, 7, "up"),
  down: series(3000, 11, "down"),
  flat: series(3000, 19, "flat"),
};
const engine = sandbox.self.CYBER_ENGINE;

const grid = [];
for (const minScore of [3, 4, 5, 6]) {
  for (const horizon of [1, 2, 3, 5]) {
    for (const minAtrPct of [0.00008, 0.00015, 0.00025]) {
      grid.push({ minScore, horizon, minAtrPct });
    }
  }
}

let best = null;
for (const g of grid) {
  let w = 0,
    l = 0;
  for (const k of Object.keys(data)) {
    const r = engine.backtest(data[k], g);
    w += r.wins;
    l += r.losses;
  }
  const tot = w + l;
  if (tot < 40) continue;
  const wr = w / tot;
  const score = wr * Math.log(tot);
  if (!best || score > best.score) best = { ...g, w, l, tot, wr, score };
}
console.log(JSON.stringify(best, null, 2));
