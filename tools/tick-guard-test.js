#!/usr/bin/env node
"use strict";

/**
 * Tick-integrity guards (v2.6.10).
 *
 * A single glitched far-future quote timestamp used to be able to open a
 * feed bucket hours ahead; every subsequent real tick was then rejected
 * forever (canIngest refuses t < current.time). Guards now exist at BOTH
 * layers: the content pre-filter (10-minute forward bound for live quotes)
 * and the feed itself (no bucket more than 10 minutes ahead of wall-clock).
 * These proofs pin the behavior, including the cases that must still pass:
 * normal ticks, realistic server skew, and fresh ticks over lagging history.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let failed = 0;
function check(name, cond, extra) {
  if (!cond) { console.error("FAIL " + name + (extra ? " — " + extra : "")); failed++; }
  else console.log("ok   " + name);
}

const sb = { self: {}, console };
sb.globalThis = sb.self;
vm.createContext(sb);
for (const f of ["feed", "assets"]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "lib", f + ".js"), "utf8"), sb);
}
const FEED = sb.self.CYBER_FEED;
const ASSETS = sb.self.CYBER_ASSETS;

const feed = FEED.createFeed({ tfMs: 60000, max: 500 });
feed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD_otc"), 120, {}));
const before = feed.series().length;

check("2h-future glitched tick rejected at feed level", feed.ingest(1.23, Date.now() + 2 * 3600000) === null);
check("no future bar was created", !feed.series().some((c) => c.time > Date.now() + 660000) && feed.series().length === before);
check("normal fresh tick accepted", feed.ingest(1.2345, Date.now() + 30000) !== null);
check("3-minute server-clock skew accepted", feed.ingest(1.2346, Date.now() + 180000) !== null);

const lag = FEED.createFeed({ tfMs: 60000, max: 500 });
lag.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD_otc"), 120, { startTime: Date.now() - 180 * 60000 }));
const span = lag.series();
check("lagging series fixture ends ~1h in the past", span[span.length - 1].time < Date.now() - 55 * 60000);
check("fresh tick over lagging history accepted (reconnect case)", lag.ingest(1.1, Date.now() + 15000) !== null);

console.log(failed ? failed + " FAILED" : "all tick-guard proofs pass");
process.exit(failed ? 1 : 0);
