#!/usr/bin/env node
"use strict";

/**
 * Real Quotex candle capture via Playwright (v2.6.7).
 *
 * WHY THIS EXISTS: the dev sandbox's network allowlist blocks qxbroker.com,
 * so real candles must be captured on YOUR machine. This script drives a
 * real Chromium, injects the extension's ACTUAL protocol decoder
 * (src/page-hook.js — same parsing the live extension uses), logs into your
 * DEMO account, and records genuine 1m candles + raw WebSocket frame
 * samples for the assets you choose. The output file can be dropped back
 * into the workspace and verified with tools/data-quality.js and
 * tools/accuracy.js --candles.
 *
 * SETUP (on your machine, once):
 *   npm install playwright
 *   npx playwright install chromium
 *
 * RUN (demo account — credentials stay on your machine, never sent anywhere):
 *   node tools/capture-quotex.js --email you@example.com --password 'demo-pass' \
 *        --assets EURUSD_otc,XAUUSD_otc,BTCUSD_otc --minutes 10
 *
 * NO-CREDENTIALS MODE (recommended): omit --email/--password and add --headed;
 * the browser opens visibly, you log in yourself, and the script continues
 * automatically once the trade page appears.
 *
 * OUTPUT: cyber-binary-capture-<timestamp>.json in the export shape
 * { exportedAt, source, totalAssets, totalBars, candles: { assetId: [bars] } }
 * plus a `diagnostics` block with raw frame samples so the parsing itself
 * can be verified against real payloads.
 */
const fs = require("fs");
const path = require("path");

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v == null || String(v).startsWith("--") ? true : v;
}

const EMAIL = arg("email", null);
const PASSWORD = arg("password", null);
const ASSETS = String(arg("assets", "EURUSD_otc,XAUUSD_otc,BTCUSD_otc")).split(",").map((s) => s.trim()).filter(Boolean);
const MINUTES = Math.max(2, Math.min(240, Number(arg("minutes", 10)) || 10));
const HEADED = arg("headed", false) === true || arg("headed", true) === true;
const OUT = arg("out", null) || path.join(process.cwd(), "cyber-binary-capture-" + Date.now() + ".json");

async function main() {
  let pw;
  try { pw = require("playwright"); } catch (_) {
    try { pw = require("playwright-core"); } catch (_) {
      console.error("playwright is not installed. Run: npm install playwright && npx playwright install chromium");
      process.exit(1);
    }
  }
  const hookSource = fs.readFileSync(path.join(__dirname, "..", "src", "page-hook.js"), "utf8");

  const browser = await pw.chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 850 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  // Injected before any page script: the extension's real MAIN-world hook +
  // a harvester that records everything it emits plus raw WS frames.
  await page.addInitScript(`
    (function () {
      self.__cyberCapture = { events: [], candles: {}, ticks: {}, frames: [], wsUrls: [], counts: {} };
      try { ${"/* hook begin */"} ${""}
        (function () { ${hookSource} })();
      } catch (e) { self.__cyberCapture.hookError = String(e && e.message || e); }
      var MAX_FRAMES = 400;
      self.__cyberCapture.wrapWs = function () {
        try {
          var OrigWs = window.WebSocket;
          if (!OrigWs || OrigWs.__cyberWrapped) return;
          var Wrapped = function (url, protocols) {
            var ws = protocols === undefined ? new OrigWs(url) : new OrigWs(url, protocols);
            try {
              self.__cyberCapture.wsUrls.push(String(url));
              ws.addEventListener("message", function (ev) {
                try {
                  if (self.__cyberCapture.frames.length < MAX_FRAMES) {
                    var d = ev.data;
                    if (typeof d === "string") self.__cyberCapture.frames.push(d.slice(0, 2000));
                    else if (d && d.byteLength != null && d.byteLength < 4096 && self.__cyberCapture.frames.length < MAX_FRAMES) {
                      self.__cyberCapture.frames.push({ binary: d.byteLength });
                    }
                  }
                } catch (_) {}
              });
            } catch (_) {}
            return ws;
          };
          Wrapped.prototype = OrigWs.prototype;
          Wrapped.__cyberWrapped = true;
          Object.defineProperty(window, "WebSocket", { value: Wrapped, writable: true, configurable: true });
        } catch (_) {}
      };
      self.__cyberCapture.wrapWs();
      window.addEventListener("message", function (ev) {
        try {
          var d = ev.data;
          if (!d || d.source !== "CYBER_BINARY_HOOK") return;
          self.__cyberCapture.counts[d.kind] = (self.__cyberCapture.counts[d.kind] || 0) + 1;
          if (d.kind === "candle" && d.payload) {
            var p = d.payload;
            if (p && p.asset && Array.isArray(p.candles)) {
              self.__cyberCapture.candles[p.asset + "@" + (p.period || 60)] = {
                period: p.period || 60,
                candles: p.candles,
                verified: p.verified === true,
                at: Date.now(),
              };
            }
          } else if (d.kind === "tick" && d.payload && d.payload.symbol) {
            self.__cyberCapture.ticks[d.payload.symbol] = { price: d.payload.price, time: d.payload.time, at: Date.now() };
          } else if (self.__cyberCapture.events.length < 2000) {
            self.__cyberCapture.events.push({ kind: d.kind, payload: d.kind === "snapshot" ? null : d.payload, at: Date.now() });
          }
        } catch (_) {}
      });
    })();
  `);

  console.log("[1/4] opening qxbroker.com …");
  await page.goto("https://qxbroker.com/", { waitUntil: "domcontentloaded", timeout: 60000 });

  const alreadyLoggedIn = async () => /\/trade/i.test(page.url());
  if (!(await alreadyLoggedIn())) {
    console.log("[2/4] login page — " + (EMAIL ? "auto-filling credentials" : "waiting for MANUAL login (headed mode)"));
    try {
      await page.waitForSelector("input[type=email], input[name=email], input[autocomplete=username]", { timeout: 20000 });
      if (EMAIL) {
        const emailField = await page.$("input[type=email], input[name=email], input[autocomplete=username]");
        const passField = await page.$("input[type=password], input[name=password]");
        if (emailField && passField && PASSWORD) {
          await emailField.fill(String(EMAIL));
          await passField.fill(String(PASSWORD));
          const btn = await page.$("button[type=submit]") ||
            (await page.$$("button")).find(async (b) => /log\\s*in|sign\\s*in/i.test(await b.innerText().catch(() => "")));
          if (btn) await btn.click();
        }
      }
    } catch (_) { /* selectors differ or already past login */ }
    // Wait until the trade page appears (auto or manual login).
    await page.waitForURL(/\/trade/i, { timeout: HEADED ? 15 * 60000 : 90000 }).catch(() => {});
  }
  if (!(/\/trade/i.test(page.url()))) {
    await page.screenshot({ path: OUT.replace(/\.json$/, "-login.png") });
    console.error("Could not reach the trade page. Screenshot saved next to the output file. " +
      "Re-run with --headed and no --email to log in manually.");
    await browser.close();
    process.exit(1);
  }
  console.log("[3/4] on the trade page — capturing for " + MINUTES + " minutes. Keep this tab focused on one of: " + ASSETS.join(", "));

  // Mirror the extension: ask the hook to subscribe 1m history per asset.
  const subscribe = (asset) => page.evaluate((a) => {
    window.postMessage({
      source: "CYBER_BINARY_CONTENT", kind: "subscribe",
      payload: { requestId: "capture_" + a + "_" + Date.now(), asset: a, period: 60, limit: 5000 },
    }, "*");
  }, asset);

  const deadline = Date.now() + MINUTES * 60000;
  let lastReport = 0;
  while (Date.now() < deadline) {
    for (const a of ASSETS) {
      try { await subscribe(a); } catch (_) {}
    }
    await page.waitForTimeout(15000);
    const state = await page.evaluate(() => {
      const c = self.__cyberCapture;
      const keys = Object.keys(c.candles);
      return {
        keys: keys.map((k) => k + ":" + (c.candles[k].candles.length || 0) + (c.candles[k].verified ? ":verified" : ":unverified")),
        counts: c.counts, hookError: c.hookError || null, ws: c.wsUrls.length,
      };
    }).catch(() => null);
    if (state && Date.now() - lastReport > 45000) {
      lastReport = Date.now();
      console.log("      " + (state.keys.join(" | ") || "no candle batches yet") +
        "  [events " + JSON.stringify(state.counts) + (state.hookError ? " HOOK-ERROR " + state.hookError : "") + "]");
    }
  }

  console.log("[4/4] harvesting capture …");
  const capture = await page.evaluate(() => self.__cyberCapture);
  await browser.close();

  const candles = {};
  let totalBars = 0;
  for (const key of Object.keys(capture.candles)) {
    const entry = capture.candles[key];
    if (entry.period !== 60) continue;                 // engine runs on 1m bars
    const bars = (entry.candles || []).slice(-5000);
    if (bars.length >= 2) { candles[key.split("@")[0]] = bars; totalBars += bars.length; }
  }
  const out = {
    exportedAt: new Date().toISOString(),
    source: "Quotex live capture via Playwright + CYBER BINARY page-hook (demo account)",
    totalAssets: Object.keys(candles).length,
    totalBars,
    candles,
    diagnostics: {
      note: "raw frame samples and event counts for parser verification",
      wsUrls: capture.wsUrls.slice(0, 5),
      eventCounts: capture.counts,
      hookError: capture.hookError || null,
      framesSample: capture.frames.slice(0, 60),
      lastTicks: capture.ticks,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log("\nwrote " + OUT);
  console.log("assets: " + Object.keys(candles).map((a) => a + " (" + candles[a].length + " bars)").join(", ") || "NONE captured");
  console.log("\nnext steps:");
  console.log("  node tools/data-quality.js --candles " + path.basename(OUT));
  console.log("  node tools/accuracy.js    --candles " + path.basename(OUT) + " --horizon 8");
  console.log("Then attach " + path.basename(OUT) + " in the chat for full verification.");
}

main().catch((e) => { console.error("capture failed: " + (e && e.message || e)); process.exit(1); });
