#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.join(__dirname, "..");
const required = [
  "manifest.json",
  "src/background.js",
  "src/content.js",
  "src/content.css",
  "src/dashboard.html",
  "src/dashboard.js",
  "src/dashboard.css",
  "src/lib/indicators.js",
  "src/lib/engine.js",
  "src/lib/feed.js",
  "src/page-hook.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

let failed = 0;
for (const f of required) {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.error("MISSING", f);
    failed++;
  }
}

const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
if (man.manifest_version !== 3) {
  console.error("manifest_version must be 3");
  failed++;
}

const sandbox = { self: {}, globalThis: null, console };
sandbox.globalThis = sandbox.self;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "src/lib/indicators.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "src/lib/engine.js"), "utf8"), sandbox);
vm.runInContext(fs.readFileSync(path.join(root, "src/lib/feed.js"), "utf8"), sandbox);
if (!sandbox.self.CYBER_FEED) {
  console.error("feed missing");
  failed++;
} else {
  const f = sandbox.self.CYBER_FEED.createFeed({ tfMs: 60000 });
  f.seedHistory(50, 1.1);
  if (f.series().length < 40) {
    console.error("feed seed failed");
    failed++;
  }
}

const rsi = sandbox.self.CYBER_TA.rsi([1, 2, 3, 4, 3, 2, 3, 4, 5, 6, 5, 4, 5, 6, 7, 8], 5);
if (!rsi.some((v) => v != null)) {
  console.error("RSI failed");
  failed++;
}

const candles = [];
let p = 1;
for (let i = 0; i < 80; i++) {
  const c = p + (i % 7 === 0 ? -0.01 : 0.004);
  candles.push({ time: i, open: p, high: Math.max(p, c), low: Math.min(p, c), close: c });
  p = c;
}
const sig = sandbox.self.CYBER_ENGINE.analyze(candles);
if (!sig.ready) {
  console.error("engine not ready on sufficient data");
  failed++;
}

if (failed) {
  console.error("FAILED", failed);
  process.exit(1);
}
console.log("OK — structure + engine checks passed");
