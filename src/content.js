"use strict";

/**
 * CYBER BINARY v2.3 — content script.
 *
 * Runs in the page's ISOLATED world. Reads the live state the page-hook
 * pushes via window.postMessage, keeps one feed per detected asset, runs
 * the confluence engine, and bridges results to the popup dashboard.
 *
 * v2.3 detection: the active asset now comes from (in order) the socket
 * symbol (outgoing-frame sniffing + incoming ticks/history), the adapter's
 * DOM helpers, class selectors, a text-scan of visible labels against the
 * full catalog (hashed CSS-module class names), page title and URL.
 *
 * v2.2 fixes:
 *   - Real broker history REPLACES the synthetic seed (no more mixed
 *     synthetic/real candles, no more "chart isn't similar").
 *   - History is accepted for ANY broker timeframe; the engine's 1m feed is
 *     built from real 60s bars + `quotes/stream` ticks.
 *   - Signals + MACD/indicator readings are computed on CLOSED bars only,
 *     so they no longer jitter with every tick.
 *   - Asset detection registers symbols on the fly (works with the broker's
 *     own `_otc` conventions), supports numeric broker IDs, and responds to
 *     CYBER_SET_ASSET / CYBER_DETECT_ASSET from the dashboard.
 *   - Late attach: requests a snapshot from the page-hook (instruments,
 *     balance, candles, orders, status) and replays it, then asks the broker
 *     for history on the page's own socket.
 */
(function () {
  if (window.__CYBER_BINARY__) return;
  window.__CYBER_BINARY__ = true;

  const TF_MS = 60000;
  const PRICE_RE = /(?:\d{1,8}(?:[.,]\d{1,8})?)/;
  const ASSETS = self.CYBER_ASSETS;
  const STORE = self.CYBER_STORE;
  const AUTO = self.CYBER_AUTO;
  const STRAT = self.CYBER_STRATEGIES;
  const QUOTEX = self.CYBER_QUOTEX || null;

  // Per-asset feeds + state.
  const feeds = Object.create(null);
  const series = Object.create(null);
  const historySeeded = Object.create(null);   // assetId -> first batch applied
  const historyRequestedAt = Object.create(null);
  const chartHistory = Object.create(null);    // assetId -> {period, candles}
  let activeAsset = "EURUSD";
  let activeFeed = createFeedFor(activeAsset);
  let autoController = null;
  let currentStrategy = "confluence";
  let lastSignalKey = "";
  let attached = false;
  let dashOpened = false;
  let pollTimer = null;
  let lastWsPrice = null;
  let lastWsSymbol = null;
  let manualAsset = null; // set by dashboard selection; null = auto-detect
  let lastQuotexStatus = { state: "idle" };
  let lastInstruments = [];
  let lastBalance = null;
  let lastOrders = [];
  const pendingWs = Object.create(null); // place_ws requestId -> resolver

  const stats = {
    wins: 0, losses: 0, pending: null, history: [],
    byStrategy: {}, byAsset: {}, byRegime: {},
  };

  function createFeedFor(assetId) {
    if (feeds[assetId]) return feeds[assetId];
    const f = self.CYBER_FEED.createFeed({ tfMs: TF_MS, max: 400 });
    feeds[assetId] = f;
    const a = ASSETS.get(assetId) || ASSETS.ensureRegistered(assetId) ||
      { id: assetId, basePrice: 1.0, vol: 0.0001, jumpRate: 0.005, decimals: 5 };
    // Synthetic seed only until real history/ticks arrive (v2.2: real data
    // purges it through feed.pruneBefore + mergeCandles).
    f.setSeries(self.CYBER_FEED.syntheticSeries(a, 120));
    return f;
  }

  function parsePrice(text) {
    if (!text) return null;
    const m = String(text).replace(/\s/g, "").match(PRICE_RE);
    if (!m) return null;
    const n = parseFloat(m[0].replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function visibleText(el) {
    if (!el) return "";
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  /* -------- automatic asset detection (v2.2) -------- */
  function assetFromText(text) {
    if (!text) return null;
    // Prefer a registered Quotex symbol (e.g. "EURUSD_otc"), then aliases.
    if (ASSETS.ensureRegistered(String(text).replace(/\s+/g, ""))) {
      const det = ASSETS.detect(text);
      if (det) return det;
    }
    return ASSETS.detect(text);
  }

  let lastDomTextScan = 0;

  /**
   * v2.3: text-based fallback. The modern Quotex UI ships hashed CSS-module
   * class names, so `[class*='asset']` style selectors miss it. Instead scan
   * small leaf nodes for strings that match the (now complete) asset catalog
   * — "EUR/USD", "EUR/USD OTC", "Bitcoin (OTC)", "Apple", "S&P 500" — and
   * prefer the shortest match (most specific label).
   */
  function scanDomForAssetText(force) {
    const now = Date.now();
    if (!force && now - lastDomTextScan < 2000) return null; // throttle
    lastDomTextScan = now;
    let best = null;
    let bestLen = 1e9;
    const nodes = document.querySelectorAll("span, div, button, a, h1, h2, h3, td, p");
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el.id === "cyber-binary-hud" || (el.closest && el.closest("#cyber-binary-hud"))) continue;
      if (el.children.length > 2) continue; // skip containers with many children
      if (!el.offsetParent && el.getClientRects().length === 0) continue; // hidden
      const t = visibleText(el);
      if (!t || t.length < 2 || t.length > 40) continue;
      if (/^[\d.,\s%+\-—:]+$/.test(t)) continue; // pure price/percent text
      const det = ASSETS.detect(t);
      if (!det) continue;
      // Score: exact-ish short labels win. Penalize OTC-less matches for OTC
      // text and vice versa so "EUR/USD" (base) isn't outvoted by noise.
      const wantsOtc = /OTC|\(OT\)/i.test(t);
      const isOtc = /_otc$/i.test(det.id);
      if (wantsOtc !== isOtc) continue;
      const score = t.length;
      if (score < bestLen) {
        bestLen = score;
        best = det;
      }
    }
    return best;
  }

  function detectAssetFromDom() {
    // First choice: the adapter's canonical DOM helpers.
    if (QUOTEX && QUOTEX.findAssetHeader) {
      const h = QUOTEX.findAssetHeader();
      if (h && h.text) {
        const det = assetFromText(h.text);
        if (det) return det;
      }
    }
    const sels = [
      "[class*='current-symbol']",
      "[class*='asset-select']",
      "[class*='pair-name']",
      "[class*='symbol-name']",
      "[class*='assetName']",
      "[class*='asset-name']",
      "[class*='symbol']",
      "[class*='asset'] [class*='name']",
      "[class*='trading-pair']",
      "[class*='active-asset']",
      "header [class*='active']",
      "[data-testid*='asset']",
      "[data-test*='symbol']",
    ];
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      for (const el of els) {
        const t = visibleText(el);
        if (t && t.length >= 2 && t.length < 48) {
          const det = assetFromText(t);
          if (det) return det;
        }
      }
    }
    // v2.3: hashed-class fallback — match by visible text against the catalog.
    const textDet = scanDomForAssetText(false);
    if (textDet) return textDet;
    const titleAsset = ASSETS.detect(document.title);
    if (titleAsset) return titleAsset;
    const urlAsset = ASSETS.detect(location.href);
    if (urlAsset) return urlAsset;
    if (lastWsSymbol) {
      const det = assetFromText(lastWsSymbol);
      if (det) return det;
    }
    return null;
  }

  function syncActiveAsset() {
    // Manual dashboard selection pins the asset; auto-detection resumes only
    // when a different symbol arrives from the page WS (see message router).
    if (manualAsset) {
      const m = ASSETS.get(manualAsset) || ASSETS.ensureRegistered(manualAsset);
      if (m && m.id !== activeAsset) {
        activeAsset = m.id;
        activeFeed = createFeedFor(activeAsset);
      }
      return m;
    }
    // The page WS symbol is authoritative — DOM detection must never
    // overwrite it (that was the "chart flips between EURUSD and the OTC
    // pair / demo feed" bug: hidden DOM elements matched first).
    let detected = null;
    if (lastWsSymbol) detected = assetFromText(lastWsSymbol);
    if (!detected) detected = detectAssetFromDom();
    if (detected && detected.id !== activeAsset) {
      activeAsset = detected.id;
      activeFeed = createFeedFor(activeAsset);
    }
    return detected;
  }

  function findPrice() {
    if (lastWsPrice) return lastWsPrice;
    if (QUOTEX) {
      const p = QUOTEX.findPriceLabel();
      if (p && p.price) return p.price;
    }
    const selectors = [
      "[class*='current-profit']",
      "[class*='current-price']",
      "[class*='currentPrice']",
      "[class*='chart-price']",
      "[class*='asset-price']",
      "[class*='price-info']",
      ".value__val",
      "[class*='value__val']",
      "[data-test*='price']",
      "[class*='quotes'] [class*='price']",
    ];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const p = parsePrice(visibleText(el));
        if (p && p > 0.01 && p < 1e8) return p;
      }
    }
    const nodes = document.querySelectorAll("span, div, strong, b");
    for (const el of nodes) {
      if (el.children.length > 1) continue;
      const t = visibleText(el);
      if (t.length < 2 || t.length > 22) continue;
      const p = parsePrice(t);
      if (!p) continue;
      const cls = (el.className || "").toString().toLowerCase();
      if (/price|quote|rate|last|valor|curso/.test(cls)) return p;
    }
    return null;
  }

  function assetName() {
    const det = syncActiveAsset();
    return det ? det.name : (document.title.replace(/[-|].*$/, "").trim() || "Quotex");
  }

  /* -------- pipeline -------- */
  function settlePending(close, time) {
    const p = stats.pending;
    if (!p || time < p.expireAt) return;
    const won =
      (p.dir === "CALL" && close > p.entry) || (p.dir === "PUT" && close < p.entry);
    if (won) stats.wins += 1;
    else stats.losses += 1;
    const t = {
      at: time, asset: p.asset, dir: p.dir, won, entry: p.entry, exit: close,
      score: p.score, confidence: p.confidence, regime: p.regime, strategy: p.strategy,
    };
    stats.history.unshift(t);
    if (stats.history.length > 200) stats.history.length = 200;
    stats.pending = null;
    if (autoController) autoController.updateDailyPnl(won ? 0.85 : -1);
    persistAll();
  }

  function persistAll() {
    try {
      STORE.recordTrade({
        asset: stats.history[0] && stats.history[0].asset,
        dir: stats.history[0] && stats.history[0].dir,
        won: stats.history[0] && stats.history[0].won,
        strategy: stats.history[0] && stats.history[0].strategy,
        regime: stats.history[0] && stats.history[0].regime,
        confidence: stats.history[0] && stats.history[0].confidence,
        entry: stats.history[0] && stats.history[0].entry,
        exit: stats.history[0] && stats.history[0].exit,
        payout: 0.85,
      }).catch(() => {});
      chrome.storage.local.set({
        cyberStats: {
          wins: stats.wins, losses: stats.losses,
          byStrategy: stats.byStrategy, byAsset: stats.byAsset, byRegime: stats.byRegime,
          history: stats.history.slice(0, 40),
        },
      });
    } catch (_) {}
  }

  function loadStats() {
    try {
      chrome.storage.local.get("cyberStats", function (d) {
        const s = d && d.cyberStats;
        if (!s) return;
        stats.wins = s.wins || 0;
        stats.losses = s.losses || 0;
        stats.byStrategy = s.byStrategy || {};
        stats.byAsset = s.byAsset || {};
        stats.byRegime = s.byRegime || {};
        stats.history = Array.isArray(s.history) ? s.history : [];
      });
    } catch (_) {}
  }

  async function loadSettingsAndArmAuto() {
    const s = await STORE.getSettings();
    currentStrategy = s.strategy || "confluence";
    if (autoController) {
      autoController.setMode(s.autoMode || "off");
      autoController.setArmed(!!s.armed);
    } else {
      autoController = AUTO.startAuto({
        config: s,
        onSignal: function () { },
        onTrade: function (decision) {
          try { chrome.runtime.sendMessage({ type: "CYBER_AUTO_DECISION", payload: decision }).catch(() => {}); } catch (_) {}
        },
        onLog: function (entry) {
          try { chrome.runtime.sendMessage({ type: "CYBER_AUTO_LOG", payload: entry }).catch(() => {}); } catch (_) {}
        },
        onState: function (state) {
          try { chrome.runtime.sendMessage({ type: "CYBER_AUTO_STATE", payload: state }).catch(() => {}); } catch (_) {}
        },
      });
      autoController.setMode(s.autoMode || "off");
      autoController.setArmed(!!s.armed);
    }
    return s;
  }

  /* -------- v2.2: real-candle ingest from the page WS -------- */
  function ingestLiveCandles(asset, period, candles) {
    if (!asset || !Array.isArray(candles) || !candles.length) return;
    const det = ASSETS.ensureRegistered(asset);
    if (!det) return;
    const id = det.id;
    const feed = createFeedFor(id);
    const real = [];
    let minT = Infinity;
    for (const c of candles) {
      if (!c || typeof c.time !== "number") continue;
      if (c.time < minT) minT = c.time;
      real.push(c);
    }
    if (!real.length) return;

    // The engine runs on 1m bars; accept 60s history directly and build 1m
    // from ticks for everything else (the chart shows the broker timeframe).
    const useForEngine = !period || period === 60;
    if (!historySeeded[id]) {
      historySeeded[id] = true;
      if (useForEngine) {
        // First real batch REPLACES the synthetic seed wholesale (never merge
        // — synthetic+real mixing produced discontinuous charts and MACD
        // glitches). Later batches merge incrementally.
        feed.setSeries(real);
        const ev = feed.mergeCandles([]);
        if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
      }
    } else if (useForEngine) {
      const ev = feed.mergeCandles(real);
      if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
    }
    chartHistory[id] = {
      period: period || 60,
      candles: real.slice(-400),
      ts: Date.now(),
    };
    if (id !== activeAsset) {
      activeAsset = id;
      activeFeed = feed;
    }
  }

  function applyHookSnapshot(snap) {
    if (!snap || typeof snap !== "object") return;
    if (snap.status) lastQuotexStatus = snap.status;
    if (Array.isArray(snap.instruments) && snap.instruments.length) {
      lastInstruments = snap.instruments;
      for (const it of lastInstruments) {
        if (it && it.symbol) { try { ASSETS.registerQuotexAsset(it); } catch (_) {} }
      }
      try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_INSTRUMENTS", payload: lastInstruments }).catch(() => {}); } catch (_) {}
    }
    if (snap.balance) {
      lastBalance = snap.balance;
      try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_BALANCE", payload: lastBalance }).catch(() => {}); } catch (_) {}
    }
    if (Array.isArray(snap.orders) && snap.orders.length) {
      lastOrders = snap.orders.slice(0, 50);
      try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_TRADE_RESULT", payload: lastOrders[0] }).catch(() => {}); } catch (_) {}
    }
    // v2.3: the hook's last-known socket symbol (from outgoing frames or
    // history responses) is authoritative for late attaches.
    if (snap.lastWsSymbol) lastWsSymbol = snap.lastWsSymbol;
    const ticks = snap.ticks || {};
    let bestSymbol = lastWsSymbol;
    let bestTime = 0;
    for (const sym in ticks) {
      const q = ticks[sym];
      if (q && q.symbol && (!bestTime || (q.time || 0) >= bestTime)) {
        bestTime = q.time || 0;
        bestSymbol = sym;
        lastWsPrice = q.price;
        lastWsSymbol = q.symbol;
      }
    }
    if (bestSymbol) {
      const det = ASSETS.ensureRegistered(bestSymbol);
      if (det && det.id !== activeAsset) {
        activeAsset = det.id;
        activeFeed = createFeedFor(activeAsset);
      }
    }
    const candlesMap = snap.candles || {};
    for (const key in candlesMap) {
      const m = key.match(/^(.+)@(\d+)$/);
      if (!m) continue;
      const list = candlesMap[key];
      if (Array.isArray(list) && list.length) ingestLiveCandles(m[1], parseInt(m[2], 10) || 60, list);
    }
  }

  async function maybeSignal() {
    const asset = syncActiveAsset();
    const full = activeFeed.series();
    // v2.2: compute indicators on CLOSED bars only — the last element of the
    // feed is the in-progress bar, so exclude it for stable MACD/signals.
    let a = full;
    if (full.length > 1) a = full.slice(0, -1);
    if (a.length < 2) a = full;
    const strat = STRAT.get(currentStrategy) || STRAT.defaults();
    const sig = self.CYBER_ENGINE.analyze(a, { strategy: currentStrategy, params: strat.params, weights: strat.weights, lean: false });
    sig.asset = asset ? asset.id : activeAsset;
    sig.assetName = asset ? asset.name : activeAsset;
    sig.strategy = currentStrategy;
    // v2.3: tag the closed bar the signal was computed on, so the auto
    // controller can dedup per (asset, bar, direction) and the dashboard can
    // show the bar time. Without it the controller re-fires every tick.
    if (a.length) {
      const lastBar = a[a.length - 1];
      if (lastBar && lastBar.time != null) sig.time = lastBar.time;
    }
    paintHud(sig);
    pushState(sig);

    if (autoController) {
      try { autoController.handleSignal(sig); } catch (_) {}
    }

    if (!sig.ready || sig.direction === "WAIT") return;
    if (stats.pending) return;
    if (a.length < 2) return;
    const closed = a[a.length - 1];
    const key = closed.time + ":" + sig.direction;
    if (key === lastSignalKey) return;
    lastSignalKey = key;
    stats.pending = {
      asset: sig.asset,
      dir: sig.direction,
      entry: closed.close,
      expireAt: closed.time + 3 * TF_MS,
      score: sig.score,
      confidence: sig.confidence,
      regime: sig.regime,
      strategy: currentStrategy,
    };
  }

  function pushState(sig) {
    const total = stats.wins + stats.losses;
    const chart = chartHistory[activeAsset] || null;
    const payload = {
      attached: true,
      source: lastWsPrice ? "websocket" : "dom",
      asset: assetName(),
      assetId: activeAsset,
      price: activeFeed.lastPrice(),
      candles: activeFeed.series(),
      // v2.2: real broker candles (any timeframe) for the chart view.
      chartCandles: chart ? chart.candles : null,
      chartPeriod: chart ? chart.period : 60,
      signal: sig,
      wins: stats.wins,
      losses: stats.losses,
      pending: stats.pending,
      history: stats.history.slice(0, 40),
      winrate: total ? (stats.wins / total) * 100 : 0,
      accuracy: total ? (stats.wins / total) * 100 : 0,
      autoState: autoController ? autoController.getState() : null,
      strategy: currentStrategy,
      ts: Date.now(),
      quotex: {
        status: lastQuotexStatus,
        balance: lastBalance,
        instrumentsCount: lastInstruments.length,
        activeSymbol: lastWsSymbol || activeAsset,
        lastOrders: lastOrders.slice(0, 5),
      },
    };
    try { chrome.runtime.sendMessage({ type: "CYBER_STATE", payload }).catch(() => {}); } catch (_) {}
  }

  function ensureHud() {
    let el = document.getElementById("cyber-binary-hud");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cyber-binary-hud";
    el.innerHTML =
      '<div class="cb-hud-title">CYBER BINARY</div>' +
      '<div class="cb-hud-asset" id="cb-asset">—</div>' +
      '<div class="cb-hud-dir">SCAN</div>' +
      '<div class="cb-hud-meta">Waiting for ticks…</div>' +
      '<div class="cb-hud-row">' +
        '<button type="button" class="cb-hud-btn" id="cb-arm">ARM</button>' +
        '<button type="button" class="cb-hud-btn ghost" id="cb-open-dash">Dashboard</button>' +
      '</div>';
    (document.body || document.documentElement).appendChild(el);
    el.querySelector("#cb-open-dash").addEventListener("click", function () {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
    });
    el.querySelector("#cb-arm").addEventListener("click", function () {
      STORE.getSettings().then((s) => {
        const next = !s.armed;
        STORE.setSettings({ armed: next });
        if (autoController) autoController.setArmed(next);
        const btn = el.querySelector("#cb-arm");
        btn.textContent = next ? "ARMED" : "ARM";
        btn.classList.toggle("armed", next);
      });
    });
    return el;
  }

  function paintHud(sig) {
    const el = ensureHud();
    const dir = el.querySelector(".cb-hud-dir");
    const meta = el.querySelector(".cb-hud-meta");
    const asset = el.querySelector("#cb-asset");
    const d = sig && sig.ready ? sig.direction : "WARM";
    dir.textContent = d;
    el.dataset.dir = d;
    asset.textContent = (sig && sig.assetName) || assetName();
    const wr = stats.wins + stats.losses;
    const wrTxt = wr ? ((stats.wins / wr) * 100).toFixed(1) + "%" : "—";
    const qstat = lastQuotexStatus && lastQuotexStatus.state
      ? "· qx:" + lastQuotexStatus.state : "";
    const bal = lastBalance && lastBalance.balance != null
      ? "· bal " + Number(lastBalance.balance).toFixed(2) : "";
    meta.textContent =
      (sig && sig.reason ? sig.reason + " · " : "") +
      "WR " + wrTxt + " · " +
      stats.wins + "W / " + stats.losses + "L " + qstat + " " + bal + " · " +
      (sig && sig.regime ? "regime " + sig.regime + " · " : "") +
      activeFeed.series().length + " bars";
  }

  function ingest(price, assetOverride) {
    if (assetOverride && assetOverride !== activeAsset) {
      const f = createFeedFor(assetOverride);
      const ev = f.ingest(price, Date.now());
      if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
      return;
    }
    const ev = activeFeed.ingest(price, Date.now());
    if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
    if (!dashOpened && attached && ev) {
      dashOpened = true;
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
    }
  }

  function ensureHistorySubscription(det) {
    if (!det || !QUOTEX || !QUOTEX.subscribeHistory) return;
    const id = det.id;
    const at = historyRequestedAt[id] || 0;
    if (Date.now() - at < 30000) return; // at most one request / 30s per asset
    historyRequestedAt[id] = Date.now();
    try {
      window.postMessage({
        source: "CYBER_BINARY_CONTENT",
        kind: "subscribe",
        payload: { asset: id, period: 60 },
      }, "*");
    } catch (_) {}
  }

  function tick() {
    const det = syncActiveAsset();
    const ev = activeFeed.forceClose(Date.now());
    if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
    const p = findPrice();
    if (p) ingest(p, det && det.id);
    maybeSignal();
    ensureHistorySubscription(det || ASSETS.get(activeAsset));
  }

  function injectHook() {
    try {
      const url = chrome.runtime.getURL("src/page-hook.js");
      const s = document.createElement("script");
      s.src = url;
      s.onload = function () {
        s.remove();
        requestHookSync();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
  }

  function requestHookSync() {
    try {
      window.postMessage({ source: "CYBER_BINARY_CONTENT", kind: "sync_request", payload: {} }, "*");
    } catch (_) {}
  }

  /* -------- page-hook message router (v2.2: + snapshot/ws results) -------- */
  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "CYBER_BINARY_HOOK") return;
    const p = ev.data.payload || {};
    switch (ev.data.kind) {
      case "snapshot": {
        applyHookSnapshot(p);
        break;
      }
      case "tick": {
        if (p.price) {
          lastWsPrice = p.price;
          if (p.symbol) {
            lastWsSymbol = p.symbol;
            // The page is authoritative: a different live symbol clears any
            // manual pin so auto-detection follows the chart again.
            const detSym = ASSETS.ensureRegistered(p.symbol);
            if (manualAsset && detSym && detSym.id !== manualAsset) manualAsset = null;
          }
          const det = ASSETS.ensureRegistered(p.symbol);
          ingest(p.price, det && det.id);
        }
        break;
      }
      case "asset": {
        if (p.symbol) {
          lastWsSymbol = p.symbol;
          const det = ASSETS.ensureRegistered(p.symbol);
          if (manualAsset && det && det.id !== manualAsset) manualAsset = null;
          if (det && det.id !== activeAsset) {
            activeAsset = det.id;
            activeFeed = createFeedFor(activeAsset);
          }
        }
        break;
      }
      case "candle": {
        if (p && p.asset && Array.isArray(p.candles)) {
          ingestLiveCandles(p.asset, p.period, p.candles);
        }
        break;
      }
      case "balance": {
        lastBalance = p;
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_BALANCE", payload: p }).catch(() => {}); } catch (_) {}
        break;
      }
      case "instruments": {
        lastInstruments = p || [];
        for (const it of lastInstruments) {
          if (it && it.symbol) {
            try { ASSETS.registerQuotexAsset(it); } catch (_) {}
          }
        }
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_INSTRUMENTS", payload: lastInstruments }).catch(() => {}); } catch (_) {}
        break;
      }
      case "order": {
        lastOrders.unshift(p);
        if (lastOrders.length > 50) lastOrders.length = 50;
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_TRADE_RESULT", payload: p }).catch(() => {}); } catch (_) {}
        break;
      }
      case "quotex_status": {
        lastQuotexStatus = p || lastQuotexStatus;
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_STATUS", payload: lastQuotexStatus }).catch(() => {}); } catch (_) {}
        break;
      }
      case "adapter_status": {
        // Surface a once-only log for the dashboard.
        try { chrome.runtime.sendMessage({ type: "CYBER_QUOTEX_STATUS", payload: { state: p && p.loaded ? "adapter_loaded" : "fallback" } }).catch(() => {}); } catch (_) {}
        break;
      }
      case "ready": {
        requestHookSync();
        break;
      }
      case "ws_result": {
        if (p && p.requestId && pendingWs[p.requestId]) {
          try { pendingWs[p.requestId](p); } catch (_) {}
          delete pendingWs[p.requestId];
        }
        break;
      }
      case "url": break;
      case "open": break;
    }
  });

  function attach() {
    if (attached) {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
      return;
    }
    attached = true;
    loadStats();
    loadSettingsAndArmAuto();
    injectHook();
    ensureHud();
    pollTimer = setInterval(tick, 500);
    tick();
    setTimeout(requestHookSync, 1200); // hook may still be loading
  }

  /* -------- real platform trade placement (dom click + page-socket ws) -------- */
  async function placeTrade(args) {
    if (!QUOTEX) return { ok: false, error: "adapter missing" };
    const s = await STORE.getSettings();
    const stake = (args && args.stake) || s.stake || 1;
    const expiry = (args && args.expiry) || s.expiry || 1; // minutes
    const expirySec = Math.max(30, Math.round(expiry * 60));
    // Try DOM click first (always works if buttons are visible).
    const domResult = QUOTEX.placeTradeDom({
      dir: args.dir,
      amount: stake,
      expiry: expirySec,
    });
    if (domResult && domResult.ok) return Object.assign({ mode: "dom" }, domResult);
    // WS frame on the page's own socket (requested through the page-hook,
    // because the isolated world has no access to the page's WebSocket).
    if (args && args.mode === "ws") {
      const requestId = "cb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6);
      const res = await new Promise((resolve) => {
        pendingWs[requestId] = resolve;
        setTimeout(() => {
          if (pendingWs[requestId]) { delete pendingWs[requestId]; resolve({ ok: false, error: "ws timeout" }); }
        }, 4000);
        try {
          window.postMessage({
            source: "CYBER_BINARY_CONTENT",
            kind: "place_ws",
            payload: {
              requestId,
              asset: args.asset || lastWsSymbol || activeAsset,
              dir: args.dir,
              amount: stake,
              expiry: expirySec,
              isDemo: !!(lastBalance && lastBalance.isDemo),
              optionType: args.optionType,
            },
          }, "*");
        } catch (e) {
          if (pendingWs[requestId]) { delete pendingWs[requestId]; resolve({ ok: false, error: String(e) }); }
        }
      });
      return res || { ok: false, error: "ws request failed" };
    }
    return domResult;
  }

  chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
    if (msg && msg.type === "CYBER_ATTACH") {
      attach();
      sendResponse({ ok: true });
    }
    if (msg && msg.type === "CYBER_PING") {
      sendResponse({ ok: true, attached: attached, bars: activeFeed.series().length, asset: activeAsset });
    }
    if (msg && msg.type === "CYBER_SET_STRATEGY") {
      currentStrategy = msg.strategy || "confluence";
      STORE.setSettings({ strategy: currentStrategy });
      sendResponse({ ok: true, strategy: currentStrategy });
    }
    if (msg && msg.type === "CYBER_SET_ASSET") {
      const det = ASSETS.ensureRegistered(msg.asset) || ASSETS.get(msg.asset);
      if (det) {
        manualAsset = det.id;
        activeAsset = det.id;
        activeFeed = createFeedFor(activeAsset);
      }
      sendResponse({ ok: true, asset: det ? det.id : (msg.asset || activeAsset), manual: !!manualAsset });
    }
    if (msg && msg.type === "CYBER_DETECT_ASSET") {
      manualAsset = null; // explicit "Detect" re-enables auto-follow
      const det = detectAssetFromDom();
      const id = det ? det.id : (ASSETS.ensureRegistered(lastWsSymbol) ? ASSETS.get(lastWsSymbol).id : activeAsset);
      sendResponse({ ok: true, asset: id, name: det ? det.name : assetName() });
    }
    if (msg && msg.type === "CYBER_SET_AUTO") {
      STORE.setSettings({ autoMode: msg.mode, armed: !!msg.armed });
      if (autoController) {
        autoController.setMode(msg.mode);
        autoController.setArmed(!!msg.armed);
      }
      sendResponse({ ok: true });
    }
    if (msg && msg.type === "CYBER_FORCE_TRADE") {
      const series = activeFeed.series();
      const closed = series.length > 1 ? series.slice(0, -1) : series;
      const sig = self.CYBER_ENGINE.analyze(closed, { strategy: currentStrategy, lean: false });
      sig.asset = activeAsset;
      sig.assetName = assetName();
      sig.strategy = currentStrategy;
      placeTrade({
        dir: sig.direction,
        stake: msg.stake,
        expiry: msg.expiry,
        mode: msg.wsMode ? "ws" : "dom",
        asset: activeAsset,
      }).then((r) => sendResponse({ ok: true, result: r }));
      return true;
    }
    if (msg && msg.type === "CYBER_QUOTEX_SET_AUTH") {
      // The extension never reads the SSID itself; the page-hook already
      // captured it from the page's traffic. We just flip the ws mode flag.
      sendResponse({ ok: true, mode: "ws_ready" });
    }
  });

  if (/qxbroker|quotex/i.test(location.host)) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
    } else {
      attach();
    }
  }
})();
