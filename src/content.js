"use strict";

/**
 * CYBER BINARY v2.1 — content script.
 *
 * Runs in the page's ISOLATED world. Reads the live state the page-hook
 * pushes via window.postMessage, keeps one feed per detected asset, runs
 * the confluence engine, and bridges results to the popup dashboard.
 *
 * Wires:
 *   - the real-time feed (candles + ticks) from the Quotex page,
 *   - the live balance and detected instruments list,
 *   - the auto-trade controller (alerts / click / off),
 *   - a `placeTrade` round-trip that uses the adapter to click CALL/PUT
 *     (or send an `orders/open` frame on the page's own socket).
 */
(function () {
  if (window.__CYBER_BINARY__) return;
  window.__CYBER_BINARY__ = true;

  const TF_MS = 60000;
  const PRICE_RE = /(?:\d{1,6}[.,]\d{2,6})/;
  const ASSETS = self.CYBER_ASSETS;
  const STORE = self.CYBER_STORE;
  const AUTO = self.CYBER_AUTO;
  const STRAT = self.CYBER_STRATEGIES;
  const QUOTEX = self.CYBER_QUOTEX || null;

  // Per-asset feeds + state.
  const feeds = Object.create(null);
  const series = Object.create(null);
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
  let lastQuotexStatus = { state: "idle" };
  let lastInstruments = [];
  let lastBalance = null;
  let lastOrders = [];

  const stats = {
    wins: 0, losses: 0, pending: null, history: [],
    byStrategy: {}, byAsset: {}, byRegime: {},
  };

  function createFeedFor(assetId) {
    if (feeds[assetId]) return feeds[assetId];
    const f = self.CYBER_FEED.createFeed({ tfMs: TF_MS, max: 400 });
    feeds[assetId] = f;
    f.setSeries(self.CYBER_FEED.syntheticSeries(ASSETS.get(assetId) || { id: assetId, basePrice: 1.0, vol: 0.0001, jumpRate: 0.005, decimals: 5 }, 120));
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

  /* -------- automatic asset detection (v2.1: prefer adapter instrument list) -------- */
  function detectAssetFromDom() {
    const sels = [
      "[class*='current-symbol']",
      "[class*='asset-select']",
      "[class*='pair-name']",
      "[class*='symbol']",
      "[class*='asset'] [class*='name']",
      "[class*='trading-pair']",
      "header [class*='active']",
    ];
    for (const s of sels) {
      const els = document.querySelectorAll(s);
      for (const el of els) {
        const t = visibleText(el);
        if (t && t.length >= 3 && t.length < 48) {
          const det = ASSETS.detect(t);
          if (det) return det;
        }
      }
    }
    const titleAsset = ASSETS.detect(document.title);
    if (titleAsset) return titleAsset;
    const urlAsset = ASSETS.detect(location.href);
    if (urlAsset) return urlAsset;
    if (lastWsSymbol) {
      const det = ASSETS.detect(lastWsSymbol);
      if (det) return det;
    }
    return null;
  }

  function syncActiveAsset() {
    const detected = detectAssetFromDom() || ASSETS.get(activeAsset) || ASSETS.get("EURUSD");
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
        if (p && p > 0.01 && p < 1e7) return p;
      }
    }
    const nodes = document.querySelectorAll("span, div, strong, b");
    for (const el of nodes) {
      if (el.children.length > 1) continue;
      const t = visibleText(el);
      if (t.length < 3 || t.length > 18) continue;
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

  /* -------- v2.1: real-candle ingest from the page WS -------- */
  function ingestLiveCandles(asset, period, candles) {
    if (!asset || !Array.isArray(candles) || !candles.length) return;
    const det = ASSETS.detect(asset) || ASSETS.get(asset);
    if (!det) return;
    const feed = createFeedFor(det.id);
    for (const c of candles) {
      if (!c || typeof c.time !== "number") continue;
      const ev = feed.ingestCandle(c);
      if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
    }
    if (det.id !== activeAsset) {
      activeAsset = det.id;
      activeFeed = feed;
    }
  }

  async function maybeSignal() {
    const asset = syncActiveAsset();
    const a = activeFeed.series();
    const strat = STRAT.get(currentStrategy) || STRAT.defaults();
    const sig = self.CYBER_ENGINE.analyze(a, { strategy: currentStrategy, params: strat.params, weights: strat.weights, lean: false });
    sig.asset = asset ? asset.id : activeAsset;
    sig.assetName = asset ? asset.name : activeAsset;
    sig.strategy = currentStrategy;
    paintHud(sig);
    pushState(sig);

    if (autoController) {
      try { autoController.handleSignal(sig); } catch (_) {}
    }

    if (!sig.ready || sig.direction === "WAIT") return;
    if (stats.pending) return;
    if (a.length < 2) return;
    const closed = a[a.length - 2];
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
    const payload = {
      attached: true,
      source: lastWsPrice ? "websocket" : "dom",
      asset: assetName(),
      assetId: activeAsset,
      price: activeFeed.lastPrice(),
      candles: activeFeed.series(),
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
      // v2.1: real platform state
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

  function tick() {
    syncActiveAsset();
    const p = findPrice();
    if (p) ingest(p);
    maybeSignal();
  }

  function injectHook() {
    try {
      const url = chrome.runtime.getURL("src/page-hook.js");
      const s = document.createElement("script");
      s.src = url;
      s.onload = function () { s.remove(); };
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
  }

  /* -------- v2.1: page-hook message router -------- */
  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "CYBER_BINARY_HOOK") return;
    const p = ev.data.payload || {};
    switch (ev.data.kind) {
      case "tick": {
        if (p.price) {
          lastWsPrice = p.price;
          if (p.symbol) lastWsSymbol = p.symbol;
          ingest(p.price, p.symbol && (ASSETS.detect(p.symbol) || {}).id);
        }
        break;
      }
      case "asset": {
        if (p.symbol) {
          lastWsSymbol = p.symbol;
          const det = ASSETS.detect(p.symbol);
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
      case "ready": break;
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
  }

  /* -------- v2.1: real platform trade placement -------- */
  async function placeTrade(args) {
    if (!QUOTEX) return { ok: false, error: "adapter missing" };
    const s = await STORE.getSettings();
    const stake = (args && args.stake) || s.stake || 1;
    const expiry = (args && args.expiry) || s.expiry || 1; // minutes
    const expirySec = Math.max(30, Math.round(expiry * 60));
    const ws = (window.__cyber && window.__cyber.handle && window.__cyber.handle.lastWs) || null;
    // Try DOM click first (always works if buttons are visible).
    const domResult = QUOTEX.placeTradeDom({
      dir: args.dir,
      amount: stake,
      expiry: expirySec,
    });
    if (domResult && domResult.ok) return Object.assign({ mode: "dom" }, domResult);
    // Fall back to ws frame if user opted in via `args.mode === "ws"`.
    if (args && args.mode === "ws" && ws) {
      return QUOTEX.placeTradeWs(ws, {
        asset: (args.asset || lastWsSymbol || activeAsset),
        dir: args.dir,
        amount: stake,
        expiry: expirySec,
        isDemo: !!(lastBalance && lastBalance.isDemo),
      });
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
      const sig = self.CYBER_ENGINE.analyze(series, { strategy: currentStrategy, lean: false });
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
      // v2.1: explicit user request to use the page's WS for direct orders.
      // The extension never reads the SSID itself; the page-hook already
      // captured it from the page's traffic. Here we just flip a flag the
      // next `placeTrade` will honor when `mode: "ws"` is passed.
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
