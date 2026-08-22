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
  return function () {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function series(n, seed, regime) {
  const rnd = seeded(seed);
  const out = [];
  let p = 1.085;
  let t = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const trend =
      regime === "up" ? 0.00008 : regime === "down" ? -0.00008 : 0;
    const shock = (rnd() - 0.5) * 0.0014;
    const next = Math.max(0.2, p * (1 + trend + shock));
    const high = Math.max(p, next) * (1 + rnd() * 0.0003);
    const low = Math.min(p, next) * (1 - rnd() * 0.0003);
    out.push({ time: t, open: p, high, low, close: next });
    p = next;
    t += 60000;
  }
  return out;
}

function run() {
  const engine = sandbox.self.CYBER_ENGINE;
  const sets = [
    { name: "trend-up", data: series(4000, 7, "up") },
    { name: "trend-down", data: series(4000, 11, "down") },
    { name: "range", data: series(4000, 19, "flat") },
    { name: "mixed", data: series(2000, 3, "up").concat(series(2000, 5, "down")) },
  ];

  let tw = 0;
  let tl = 0;
  for (const s of sets) {
    const r = engine.backtest(s.data, { horizon: 3 });
    tw += r.wins;
    tl += r.losses;
    console.log(
      s.name.padEnd(12),
      "trades",
      String(r.total).padStart(4),
      "WR",
      r.winrate.toFixed(2) + "%",
      "W/L",
      r.wins + "/" + r.losses
    );
  }
  const tot = tw + tl;
  console.log("ALL          trades", tot, "WR", ((tw / tot) * 100).toFixed(2) + "%");
}

run();
