#!/usr/bin/env node
"use strict";

/**
 * Candle data-quality checker (v2.6.5).
 *
 * Usage:
 *   node tools/data-quality.js                # self-test: detector must catch every injected corruption
 *   node tools/data-quality.js --candles <export.json>
 *                                             # validate a real-candle export produced by the
 *                                             # dashboard's "Export live candles" button
 *
 * Checks per asset: OHLC invariants (high/low must envelope open/close),
 * duplicate bar times, non-monotonic time, off-grid timestamps (must sit on
 * exact minute boundaries), missing-minute gaps, stale last bar, extreme
 * per-bar jumps, and zero-range share. Structural failures (duplicates,
 * non-monotonic, OHLC violations, off-grid) exit 1 — those are the bugs that
 * make an extension chart diverge from the broker chart. Gaps and jumps are
 * reported as warnings because real OTC feeds legitimately contain quiet
 * minutes and spikes.
 */
const fs = require("fs");

let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

const MINUTE = 60000;

/** Returns {bars, nonFinite, ohlcBad, dupTimes, nonMono, offGrid, gaps, jumpBars, zeroRange, staleMin} */
function audit(series, nowMs) {
  const r = {
    bars: Array.isArray(series) ? series.length : 0,
    nonFinite: 0, ohlcBad: 0, dupTimes: 0, nonMono: 0, offGrid: 0,
    gaps: 0, jumpBars: 0, zeroRange: 0, staleMin: 0,
    firstTime: null, lastTime: null, spacing: null,
  };
  if (!r.bars) return r;
  const seen = new Set();
  let prevClose = null;
  let spacingHist = Object.create(null);
  for (const c of series) {
    if (!c || typeof c !== "object") { r.nonFinite++; continue; }
    const t = Number(c.time), o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
    if (![t, o, h, l, cl].every(Number.isFinite) || o <= 0 || h <= 0 || l <= 0 || cl <= 0) { r.nonFinite++; continue; }
    if (h < Math.max(o, cl) - 1e-12 || l > Math.min(o, cl) + 1e-12 || h < l) r.ohlcBad++;
    if (seen.has(t)) r.dupTimes++;
    seen.add(t);
    if (r.firstTime == null) r.firstTime = t;
    if (r.lastTime != null) {
      if (t < r.lastTime) r.nonMono++;
      else if (t > r.lastTime) {
        const dt = t - r.lastTime;
        spacingHist[dt] = (spacingHist[dt] || 0) + 1;
        if (dt > MINUTE) r.gaps += Math.round(dt / MINUTE) - 1;
        if (prevClose != null && Math.abs(cl - prevClose) / prevClose > 0.10) r.jumpBars++;
      }
    }
    if (t % MINUTE !== 0) r.offGrid++;
    if (h === l) r.zeroRange++;
    r.lastTime = t;
    prevClose = cl;
  }
  let best = null;
  for (const k of Object.keys(spacingHist)) {
    if (best == null || spacingHist[k] > spacingHist[best]) best = k;
  }
  r.spacing = best != null ? Number(best) : null;
  if (nowMs && r.lastTime != null) r.staleMin = Math.max(0, Math.round((nowMs - r.lastTime) / MINUTE));
  return r;
}

function structuralFailures(r) {
  return r.ohlcBad + r.dupTimes + r.nonMono + r.offGrid + (r.bars === 0 ? 1 : 0) + (r.nonFinite ? 1 : 0);
}

/* ---------------- self-test ---------------- */
function cleanSeries(n, seed) {
  let a = (seed || 1) * 2147483647 % 16807;
  const rnd = () => { a = (a * 16807) % 2147483647; return (a & 1023) / 1023; };
  const t0 = Math.floor(Date.now() / MINUTE) * MINUTE - n * MINUTE;
  const out = [];
  let p = 1.1;
  for (let i = 0; i < n; i++) {
    const c = p * (1 + (rnd() - 0.5) * 0.001);
    out.push({ time: t0 + i * MINUTE, open: p, close: c, high: Math.max(p, c) * 1.0001, low: Math.min(p, c) * 0.9999 });
    p = c;
  }
  return out;
}
function runSelfTest() {
  console.log("== data-quality self-test ==");
  const clean = audit(cleanSeries(600, 7), Date.now());
  check("clean synthetic 1m series has no structural failures", structuralFailures(clean) === 0 && clean.gaps === 0, JSON.stringify(clean));

  const dup = cleanSeries(300, 3).slice();
  dup.push(Object.assign({}, dup[100]));
  check("duplicate bar time detected", audit(dup, 0).dupTimes === 1);

  const mono = cleanSeries(300, 5).slice();
  const tmp = mono[50]; mono[50] = mono[51]; mono[51] = tmp;
  check("non-monotonic time detected", audit(mono, 0).nonMono >= 1);

  const badOhlc = cleanSeries(300, 9).slice();
  badOhlc[40] = Object.assign({}, badOhlc[40], { high: badOhlc[40].low * 0.5 });
  check("OHLC violation (high below low) detected", audit(badOhlc, 0).ohlcBad === 1);

  const gapped = cleanSeries(300, 11).slice(0, 150).concat(cleanSeries(300, 13).slice(160));
  check("missing-minute gap detected", audit(gapped, 0).gaps >= 9);

  const offGrid = cleanSeries(300, 15).slice();
  offGrid[77] = Object.assign({}, offGrid[77], { time: offGrid[77].time + 40000 });
  check("off-grid timestamp detected", audit(offGrid, 0).offGrid === 1);

  const jumpy = cleanSeries(300, 17).slice();
  jumpy[200] = Object.assign({}, jumpy[200], { close: jumpy[200].close * 0.5, open: jumpy[200].close * 0.5, high: jumpy[200].close * 0.6, low: jumpy[200].close * 0.4 });
  check("extreme per-bar jump detected", audit(jumpy, 0).jumpBars >= 1);

  const stale = audit(cleanSeries(60, 19), Date.now() + 30 * MINUTE);
  check("stale last bar detected", stale.staleMin >= 25);

  check("empty series is a structural failure", structuralFailures(audit([], 0)) > 0);
  check("modal spacing of a 1m series is 60000ms", clean.spacing === 60000);
}

/* ---------------- file mode ---------------- */
function runFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    console.error("cannot read " + file + ": " + e.message);
    process.exit(1);
  }
  const candles = parsed && typeof parsed.candles === "object" && !Array.isArray(parsed.candles) ? parsed.candles : null;
  if (!candles) {
    console.error("expected { exportedAt, candles: { assetId: [bars] } } — use the dashboard's Export live candles button");
    process.exit(1);
  }
  const exportedAt = parsed.exportedAt ? Date.parse(parsed.exportedAt) : Date.now();
  const assets = Object.keys(candles).filter((k) => Array.isArray(candles[k]));
  if (!assets.length) { console.error("export contains no candle arrays"); process.exit(1); }

  console.log("== candle export quality: " + assets.length + " assets ==");
  if (parsed.source) console.log("   source: " + String(parsed.source).slice(0, 100));
  let totalBars = 0, totalBad = 0, totalGaps = 0;
  for (const id of assets) {
    const r = audit(candles[id], Number.isFinite(exportedAt) ? exportedAt : 0);
    totalBars += r.bars; totalBad += structuralFailures(r); totalGaps += r.gaps;
    const verdict = structuralFailures(r) ? "STRUCTURAL FAILURES" : "clean";
    console.log("   " + String(id).slice(0, 24).padEnd(24) +
      String(r.bars).padStart(6) + " bars  " +
      ("spacing " + (r.spacing == null ? "?" : (r.spacing / 1000 + "s")) + "  ") +
      ("gaps " + r.gaps + "  ") +
      ("jumps " + r.jumpBars + "  ") +
      ("flat " + (r.bars ? (r.zeroRange / r.bars * 100).toFixed(1) : "0") + "%  ") +
      ("stale " + r.staleMin + "m  ") +
      verdict);
    if (structuralFailures(r)) {
      console.log("      nonFinite " + r.nonFinite + " · ohlcBad " + r.ohlcBad + " · dupTimes " + r.dupTimes + " · nonMono " + r.nonMono + " · offGrid " + r.offGrid);
    }
  }
  console.log("\n   total: " + totalBars + " bars · " + totalGaps + " missing minutes · " + (totalBad ? totalBad + " structural failures" : "no structural failures"));
  if (totalBad) {
    console.log("   structural failures mean the cached feed itself is corrupted (bad merge, layout mis-parse or");
    console.log("   unit bug) — report the asset list before trusting any backtest on this export.");
    process.exit(1);
  }
  console.log("   clean structure. Gaps/jumps/flat minutes are reported, not failed: real OTC feeds have quiet");
  console.log("   minutes and spikes. Compare bar-for-bar against the platform chart for final confirmation.");
}

const arg = process.argv[2];
if (arg === "--candles" && process.argv[3]) runFile(process.argv[3]);
else if (arg && arg !== "--self-test") {
  console.error("usage: node tools/data-quality.js [--candles export.json]");
  process.exit(1);
} else {
  runSelfTest();
  process.exit(failed ? 1 : 0);
}
