"use strict";

(function () {
  if (window.__CYBER_BINARY__) return;
  window.__CYBER_BINARY__ = true;

  const TF_MS = 60000;
  const PRICE_RE = /(?:\d{1,6}[.,]\d{2,6})/;
  const ASSETS = self.CYBER_ASSETS;
  const STORE = self.CYBER_STORE;
  const AUTO = self.CYBER_AUTO;
  const STRAT = self.CYBER_STRATEGIES;

  // Per-asset feeds + state (in case the user switches assets without reloading).
  const feeds = Object.create(null);    // assetId -> feed
  const series = Object.create(null);   // assetId -> array
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

  const stats = {
    wins: 0,
    losses: 0,
    pending: null,
    history: [],
    byStrategy: {},
    byAsset: {},
    byRegime: {},
  };

  function createFeedFor(assetId) {
    if (feeds[assetId]) return feeds[assetId];
    const f = self.CYBER_FEED.createFeed({ tfMs: TF_MS, max: 400 });
    feeds[assetId] = f;
    // Seed with synthetic history so the engine is ready quickly.
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

  /* -------- automatic asset detection -------- */
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
    // Title fallback
    const titleAsset = ASSETS.detect(document.title);
    if (titleAsset) return titleAsset;
    // URL fallback
    const urlAsset = ASSETS.detect(location.href);
    if (urlAsset) return urlAsset;
    // WS symbol fallback
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
        onSignal: function (sig) { /* forwarded via pushState */ },
        onTrade: function (decision) {
          try {
            chrome.runtime.sendMessage({ type: "CYBER_AUTO_DECISION", payload: decision }).catch(() => {});
          } catch (_) {}
        },
        onLog: function (entry) {
          try {
            chrome.runtime.sendMessage({ type: "CYBER_AUTO_LOG", payload: entry }).catch(() => {});
          } catch (_) {}
        },
        onState: function (state) {
          try {
            chrome.runtime.sendMessage({ type: "CYBER_AUTO_STATE", payload: state }).catch(() => {});
          } catch (_) {}
        },
      });
      autoController.setMode(s.autoMode || "off");
      autoController.setArmed(!!s.armed);
    }
    return s;
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
    };
    try {
      chrome.runtime.sendMessage({ type: "CYBER_STATE", payload }).catch(() => {});
    } catch (_) {}
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
    meta.textContent =
      (sig && sig.reason ? sig.reason + " · " : "") +
      "WR " + wrTxt + " · " +
      stats.wins + "W / " + stats.losses + "L · " +
      (sig && sig.regime ? "regime " + sig.regime + " · " : "") +
      activeFeed.series().length + " bars";
  }

  function ingest(price, assetOverride) {
    if (assetOverride && assetOverride !== activeAsset) {
      // Re-route to the right feed if we just learned the asset.
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
    // Refresh active asset before ingesting a tick.
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

  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "CYBER_BINARY_HOOK") return;
    const p = ev.data.payload || {};
    if (ev.data.kind === "tick" && p.price) {
      lastWsPrice = p.price;
      // Route to the active asset's feed.
      ingest(p.price);
    } else if (ev.data.kind === "asset" && p.symbol) {
      lastWsSymbol = p.symbol;
      const det = ASSETS.detect(p.symbol);
      if (det && det.id !== activeAsset) {
        activeAsset = det.id;
        activeFeed = createFeedFor(activeAsset);
      }
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
      AUTO.clickTrade({ dir: sig.direction, stake: msg.stake, expiry: msg.expiry }).then((r) => {
        sendResponse({ ok: true, result: r });
      });
      return true;
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
