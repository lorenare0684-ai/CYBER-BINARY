"use strict";

(function () {
  if (window.__CYBER_BINARY__) return;
  window.__CYBER_BINARY__ = true;

  const TF_MS = 60000;
  const PRICE_RE = /(?:\d{1,6}[.,]\d{2,6})/;
  const feed = self.CYBER_FEED.createFeed({ tfMs: TF_MS, max: 400 });

  let lastSignalKey = "";
  let attached = false;
  let dashOpened = false;
  let pollTimer = null;
  let lastWsPrice = null;

  const stats = {
    wins: 0,
    losses: 0,
    pending: null,
    history: [],
  };

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
    const sels = [
      "[class*='current-symbol']",
      "[class*='asset-select']",
      "[class*='pair-name']",
      "[class*='assets-list'] [class*='active']",
      "header [class*='asset']",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      const t = el && visibleText(el);
      if (t && t.length < 48) return t;
    }
    return document.title.replace(/[-|].*$/, "").trim() || "Quotex";
  }

  function settlePending(close, time) {
    const p = stats.pending;
    if (!p || time < p.expireAt) return;
    const won =
      (p.dir === "CALL" && close > p.entry) || (p.dir === "PUT" && close < p.entry);
    if (won) stats.wins += 1;
    else stats.losses += 1;
    stats.history.unshift({
      dir: p.dir,
      won: won,
      entry: p.entry,
      exit: close,
      at: time,
    });
    if (stats.history.length > 80) stats.history.length = 80;
    stats.pending = null;
    persistStats();
  }

  function persistStats() {
    try {
      chrome.storage.local.set({
        cyberStats: {
          wins: stats.wins,
          losses: stats.losses,
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
        stats.history = Array.isArray(s.history) ? s.history : [];
      });
    } catch (_) {}
  }

  function maybeSignal() {
    const series = feed.series();
    const sig = self.CYBER_ENGINE.analyze(series);
    paintHud(sig);
    pushState(sig);

    if (!sig.ready || sig.direction === "WAIT") return;
    if (stats.pending) return;
    if (series.length < 2) return;
    const closed = series[series.length - 2];
    const key = closed.time + ":" + sig.direction;
    if (key === lastSignalKey) return;
    lastSignalKey = key;
    stats.pending = {
      dir: sig.direction,
      entry: closed.close,
      expireAt: closed.time + 3 * TF_MS,
    };
  }

  function pushState(sig) {
    const total = stats.wins + stats.losses;
    const payload = {
      attached: true,
      source: lastWsPrice ? "websocket" : "dom",
      asset: assetName(),
      price: feed.lastPrice(),
      candles: feed.series(),
      signal: sig,
      wins: stats.wins,
      losses: stats.losses,
      pending: stats.pending,
      history: stats.history.slice(0, 20),
      winrate: total ? (stats.wins / total) * 100 : 0,
      accuracy: total ? (stats.wins / total) * 100 : 0,
      ts: Date.now(),
    };
    try {
      chrome.runtime.sendMessage({ type: "CYBER_STATE", payload }).catch(function () {});
    } catch (_) {}
  }

  function ensureHud() {
    let el = document.getElementById("cyber-binary-hud");
    if (el) return el;
    el = document.createElement("div");
    el.id = "cyber-binary-hud";
    el.innerHTML =
      '<div class="cb-hud-title">CYBER BINARY</div>' +
      '<div class="cb-hud-dir">SCAN</div>' +
      '<div class="cb-hud-meta">Waiting for ticks…</div>' +
      '<button type="button" class="cb-hud-btn" id="cb-open-dash">Open dashboard</button>';
    (document.body || document.documentElement).appendChild(el);
    el.querySelector("#cb-open-dash").addEventListener("click", function () {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(function () {});
    });
    return el;
  }

  function paintHud(sig) {
    const el = ensureHud();
    const dir = el.querySelector(".cb-hud-dir");
    const meta = el.querySelector(".cb-hud-meta");
    const d = sig && sig.ready ? sig.direction : "WARM";
    dir.textContent = d;
    el.dataset.dir = d;
    const wr = stats.wins + stats.losses;
    const wrTxt = wr ? ((stats.wins / wr) * 100).toFixed(1) + "%" : "—";
    meta.textContent =
      (sig && sig.reason ? sig.reason + " · " : "") +
      "WR " +
      wrTxt +
      " · " +
      stats.wins +
      "W / " +
      stats.losses +
      "L · " +
      feed.series().length +
      " bars";
  }

  function ingest(price) {
    const ev = feed.ingest(price, Date.now());
    if (ev && ev.closed) settlePending(ev.closed.close, ev.closed.time);
    if (!dashOpened && attached && ev) {
      dashOpened = true;
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(function () {});
    }
  }

  function tick() {
    const p = findPrice();
    if (p) ingest(p);
    maybeSignal();
  }

  function injectHook() {
    try {
      const url = chrome.runtime.getURL("src/page-hook.js");
      const s = document.createElement("script");
      s.src = url;
      s.onload = function () {
        s.remove();
      };
      (document.head || document.documentElement).appendChild(s);
    } catch (_) {}
  }

  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "CYBER_BINARY_HOOK") return;
    if (ev.data.kind === "tick" && ev.data.payload && ev.data.payload.price) {
      lastWsPrice = ev.data.payload.price;
      ingest(lastWsPrice);
    }
  });

  function attach() {
    if (attached) {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(function () {});
      return;
    }
    attached = true;
    loadStats();
    injectHook();
    ensureHud();
    pollTimer = setInterval(tick, 350);
    tick();
  }

  chrome.runtime.onMessage.addListener(function (msg, _s, sendResponse) {
    if (msg && msg.type === "CYBER_ATTACH") {
      attach();
      sendResponse({ ok: true });
    }
    if (msg && msg.type === "CYBER_PING") {
      sendResponse({ ok: true, attached: attached, bars: feed.series().length });
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
