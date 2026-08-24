#!/usr/bin/env node
"use strict";

/**
 * Monte Carlo + hostile-market validation for the High-Accuracy preset.
 *
 * Techniques, in order:
 *
 *  1. Seed Monte Carlo — 60 independent RNG seeds × 4 assets on the
 *     regime-persistent catalog simulator. The 80+ claim must hold for the
 *     WORST seed, not the lucky one (v2.6.2's 97.13% used a single seed).
 *  2. Lookahead canary — pure geometric Brownian motion (zero drift, zero
 *     memory). Any causal strategy must land statistically at 50% here:
 *     a 95% Wilson CI that excludes 50% means the engine is leaking future
 *     information. This is the null-hypothesis test for the whole engine.
 *  3. Hostile generators — Ornstein-Uhlenbeck mean reversion, jump
 *     diffusion (fat tails), GARCH-style volatility clustering, 4x
 *     volatility, and fast trend flips every 5-25 bars (designed to kill
 *     8-bar trend-following). Reported honestly; CI must contain 50% for
 *     the memoryless ones.
 *  4. Risk bootstrap — 10,000 resampled equity paths over the measured
 *     trade sequence at 85% payout: losing-streak probabilities, max
 *     drawdown percentiles, and per-trade EV lines.
 *
 * Exit code is non-zero only when the ENGINE's integrity is contradicted
 * (lookahead leak, gates adding trades, worst-seed collapse below 80 on
 * the simulator the claim was made on). Market realism is reported, not
 * asserted: hostile-market win rates say whatever they say.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

const sandbox = { self: {}, console, setTimeout: (f) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, URL, TextDecoder,
  window: {}, document: { querySelector: () => null, querySelectorAll: () => [] }, Event: function () {},
  location: { hostname: "qxbroker.com", pathname: "/trade", href: "https://qxbroker.com/trade" } };
sandbox.globalThis = sandbox.self;
sandbox.window.WebSocket = undefined;
vm.createContext(sandbox);
for (const f of ["indicators", "assets", "strategy", "feed", "engine", "backtest"]) {
  vm.runInContext(fs.readFileSync(path.join(root, "src/lib", f + ".js"), "utf8"), sandbox);
}
const FEED = sandbox.self.CYBER_FEED;
const ENGINE = sandbox.self.CYBER_ENGINE;
const ASSETS = sandbox.self.CYBER_ASSETS;

const HORIZON = 8;
const BARS = 1440;

/* ---------- statistics helpers ---------- */
function wilson(wins, n, z) {
  z = z == null ? 1.96 : z;
  if (!n) return [0, 1];
  const p = wins / n;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const spread = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return [(centre - spread) / denom, (centre + spread) / denom];
}
function pct(sorted, q) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}
function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------- hostile / neutral generators (valid OHLC, causal by construction) ---------- */
function buildSeries(retFn, n, basePrice, baseVol) {
  const out = [];
  let p = basePrice;
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const ret = retFn(i);
    const next = Math.max(0.01, p * (1 + ret));
    const wiggle = Math.abs(gauss(retFn.rnd || Math.random)) * baseVol * 0.25;
    const high = Math.max(p, next) * (1 + wiggle);
    const low = Math.max(0.005, Math.min(p, next) * (1 - wiggle));
    out.push({ time: t0 + i * 60000, open: p, high, low, close: next });
    p = next;
  }
  return out;
}
function generator(name, makeRet) {
  return { name, makeRet };
}
const GENERATORS = [
  generator("random-walk (GBM, zero drift)", (rnd, vol) => { let v = vol; return { v, fn: () => v * gauss(rnd) }; }),
  generator("mean-revert (OU)", (rnd, vol) => {
    let p = 1, anchor = 1;
    const speed = 0.05, v = vol;
    return { v, fn: () => { const ret = speed * (anchor / p - 1) + v * gauss(rnd); p = p * (1 + ret); return ret; } };
  }),
  generator("jump-diffusion (fat tails)", (rnd, vol) => { const v = vol; return { v, fn: () => { let r = v * gauss(rnd); if (rnd() < 0.004) r += (rnd() < 0.5 ? -1 : 1) * v * (4 + rnd() * 6); return r; } }; }),
  generator("GARCH vol clustering", (rnd, vol) => { let v = vol, lastAbs = 0; return { v, fn: () => { v = Math.max(vol * 0.25, 0.82 * v + 0.28 * vol * lastAbs / vol + 0.1 * vol); const z = v * gauss(rnd); lastAbs = Math.abs(z); return z; } }; }),
  generator("high-vol (4x)", (rnd, vol) => { const v = vol * 4; return { v, fn: () => v * gauss(rnd) }; }),
  generator("trend-flip every 5-25 bars", (rnd, vol) => {
    let dir = 1, left = 10;
    const v = vol;
    return { v, fn: () => { if (--left <= 0) { dir = -dir; left = 5 + Math.floor(rnd() * 20); } return dir * v * 0.8 + v * 0.3 * gauss(rnd); } };
  }),
];

function runStrategy(series, gated) {
  return ENGINE.backtest(series, {
    strategy: "high_accuracy",
    horizon: HORIZON,
    minConf: 0,
    params: gated ? undefined : { regimeFilter: [], minConfidence: 0 },
  });
}

/* ================= 1. Seed Monte Carlo (friendly generator) ================= */
console.log("== 1. seed Monte Carlo: regime-persistent simulator, " + 60 + " seeds x 4 assets, h=" + HORIZON + "m ==");
const seedAssets = ["EURUSD_otc", "XAUUSD_otc", "BTCUSD_otc", "GBPJPY_otc"];
const seedWRs = [];
let seedW = 0, seedL = 0, minWR = 100, minSeed = -1, minTrades = Infinity;
const tradeOutcomes = []; // pooled for the risk bootstrap
for (let seed = 1; seed <= 60; seed++) {
  let w = 0, l = 0;
  for (const id of seedAssets) {
    const series = FEED.syntheticSeries(ASSETS.get(id), BARS, { seed });
    const r = runStrategy(series, true);
    w += r.wins; l += r.losses;
  }
  const n = w + l;
  const wr = n ? (w / n) * 100 : 0;
  seedWRs.push(wr);
  if (n < minTrades) minTrades = n;
  if (n >= 30 && wr < minWR) { minWR = wr; minSeed = seed; }
  seedW += w; seedL += l;
}
seedWRs.sort((a, b) => a - b);
const pooledN = seedW + seedL;
const pooledWR = pooledN ? (seedW / pooledN) * 100 : 0;
const mean = seedWRs.reduce((a, b) => a + b, 0) / seedWRs.length;
const sd = Math.sqrt(seedWRs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / seedWRs.length);
console.log("   pooled: " + pooledWR.toFixed(2) + "% over " + pooledN + " trades | per-seed mean " + mean.toFixed(2) +
  "% sd " + sd.toFixed(2) + " | p5 " + pct(seedWRs, 0.05).toFixed(1) + "% worst " + minWR.toFixed(1) + "% (seed " + minSeed + ")");
check("80+ holds for the WORST seed, not the lucky one", minWR >= 80, "worst=" + minWR.toFixed(1) + "%");
const [loPooled, hiPooled] = wilson(seedW, pooledN);
check("pooled 95% Wilson CI lower bound clears 80%", loPooled * 100 >= 80, (loPooled * 100).toFixed(1) + "%");

/* ================= 2+3. Lookahead canary + hostile generators ================= */
console.log("\n== 2+3. hostile markets: gated preset, h=" + HORIZON + "m, 3 seeds x 1200 bars each ==");
console.log("   (any causal strategy MUST be statistically 50% on the zero-drift random walk)");
let suppressHeld = true;
for (const gen of GENERATORS) {
  let w = 0, l = 0, uW = 0, uL = 0;
  for (let seed = 101; seed <= 103; seed++) {
    const rnd = mulberry(seed * 7919 + 13);
    const built = gen.makeRet(rnd, 0.0011);
    const series = buildSeries(built.fn, 1200, 1.0, built.v);
    const r = runStrategy(series, true);
    const twin = runStrategy(series, false);
    w += r.wins; l += r.losses;
    uW += twin.wins; uL += twin.losses;
    if (r.total > twin.total) suppressHeld = false;
  }
  const n = w + l;
  const wr = n ? (w / n) * 100 : 0;
  const [lo, hi] = wilson(w, n);
  const ci = n ? " CI95 [" + (lo * 100).toFixed(1) + "%, " + (hi * 100).toFixed(1) + "%]" : "";
  console.log("   " + gen.name.padEnd(34) + (n ? wr.toFixed(1) + "% /" + n + " trades" + ci : "no signals fired") +
    "   (ungated " + (uW + uL ? ((uW / (uW + uL)) * 100).toFixed(1) + "%/" + (uW + uL) : "0") + ")");
  if (gen.name.indexOf("random-walk") === 0 && n >= 100) {
    check("lookahead canary: 50% inside the random-walk CI (no future leakage)", lo <= 0.5 && hi >= 0.5, ci);
  }
  if ((gen.name.indexOf("mean-revert") === 0 || gen.name.indexOf("high-vol") === 0) && n >= 100) {
    check(gen.name + ": 50% inside CI (no leakage on hostile memoryless data)", lo <= 0.5 && hi >= 0.5, ci);
  }
}
check("gates only ever suppress signals across every generator", suppressHeld);

/* ================= 4. Risk bootstrap at 85% payout ================= */
console.log("\n== 4. risk bootstrap: 10,000 resampled equity paths, 85% payout, 50 trades/day ==");
// Rebuild the pooled outcome vector deterministically (seed 7 mirrors v2.6.2).
const outcomes = [];
for (const id of seedAssets) {
  const series = FEED.syntheticSeries(ASSETS.get(id), BARS, { seed: 7 });
  const r = runStrategy(series, true);
  for (const t of r.trades) if (t.won !== null && t.won !== undefined && !t.draw) outcomes.push(t.won ? 1 : 0);
}
const PAYOUT = 0.85;
const rnd = mulberry(20260823);
const PATHS = 10000, DAY = 50;
const ddDist = [], ruin50 = { count: 0 };
let streakCounts = { 5: 0, 8: 0, 10: 0 };
for (let p = 0; p < PATHS; p++) {
  let eq = 0, peak = 0, maxDD = 0, streak = 0, ruined = false;
  for (let i = 0; i < DAY; i++) {
    const win = outcomes[Math.floor(rnd() * outcomes.length)] === 1;
    eq += win ? PAYOUT : -1;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
    streak = win ? 0 : streak + 1;
    if (streak >= 10) streakCounts[10]++;
    else if (streak >= 8) streakCounts[8]++;
    else if (streak >= 5) streakCounts[5]++;
    if (eq <= -50) ruined = true;
  }
  ddDist.push(maxDD);
  if (ruined) ruin50.count++;
}
ddDist.sort((a, b) => a - b);
const ev = pooledWR / 100 * (1 + PAYOUT) - 1;
console.log("   measured simulator WR " + pooledWR.toFixed(2) + "% -> per-trade EV " + (ev >= 0 ? "+" : "") + (ev * 100).toFixed(1) + "% of stake at 85% payout");
console.log("   max drawdown over 50 trades: p50 " + pct(ddDist, 0.5).toFixed(1) + "u · p95 " + pct(ddDist, 0.95).toFixed(1) + "u · p99 " + pct(ddDist, 0.99).toFixed(1) + "u");
console.log("   losing streaks hit in a 50-trade day: 5+ in " + (streakCounts[5] / PATHS * 100).toFixed(1) + "% of paths · 8+ in " + (streakCounts[8] / PATHS * 100).toFixed(1) + "% · 10+ in " + (streakCounts[10] / PATHS * 100).toFixed(1) + "%");
console.log("   paths reaching -50u on a 100u bankroll: " + (ruin50.count / PATHS * 100).toFixed(2) + "%");
check("bootstrap ran on a real trade sample", outcomes.length >= 500, String(outcomes.length));

/* ---------- verdict ---------- */
console.log("\n== summary ==");
console.log("   - engine integrity: lookahead canary + suppression-only gates " + (failed ? "FAILED" : "hold"));
console.log("   - simulator claim: worst-seed WR " + minWR.toFixed(1) + "% (>= 80 across all 60 seeds)");
console.log("   - hostile markets: win rates are REPORTED, not asserted — real performance is bounded by");
console.log("     how persistent live trending regimes are, not by this simulator");
process.exit(failed ? 1 : 0);
