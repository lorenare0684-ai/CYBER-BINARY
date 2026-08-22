"use strict";

(function () {
  if (window.__CYBER_BINARY__) return;
  window.__CYBER_BINARY__ = true;

  const TF_MS = 60000;
  const MAX_CANDLES = 400;
  const PRICE_RE = /(?:\d{1,6}[.,]\d{2,6})/;

  /** @type {{time:number,open:number,high:number,low:number,close:number}[]} */
  let candles = [];
  let current = null;
  let lastPrice = null;
  let lastSignalKey = "";
  let attached = false;
  let dashOpened = false;
  let observer = null;
  let pollTimer = null;

  const stats = {
    wins: 0,
    losses: 0,
    pending: /** @type {null|{dir:string,entry:number,expireAt:number}} */ (null),
    history: /** @type {any[]} */ ([]),
  };

  function parsePrice(text) {
    if (!text) return null;
    const m = String(text).replace(/\s/g, "").match(PRICE_RE);
    if (!m) return null;
    const n = parseFloat(m[0].replace(",", "."));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  function findPrice() {
    const selectors = [
      "[class*='current-price']",
      "[class*='currentPrice']",
      "[class*='chart-price']",
      "[class*='asset-price']",
      "[class*='price-info']",
      ".value__val",
      "[data-test*='price']",
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const p = el && parsePrice(el.textContent);
      if (p) return p;
    }
    const nodes = document.querySelectorAll("span, div, strong");
    let best = null;
    for (const el of nodes) {
      if (el.children.length > 2) continue;
      const t = (el.textContent || "").trim();
      if (t.length > 16) continue;
      const p = parsePrice(t);
      if (!p) continue;
      const cls = (el.className || "").toString().toLowerCase();
      if (cls.includes("price") || cls.includes("quote") || cls.includes("rate")) {
        best = p;
        break;
      }
    }
    return best;
  }

  function assetName() {
    const sels = [
      "[class*='asset'] [class*='name']",
      "[class*='pair']",
      "[class*='asset-select']",
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.textContent && el.textContent.trim().length < 40) {
        return el.textContent.trim().replace(/\s+/g, " ");
      }
    }
    return "Quotex chart";
  }

  function bucketTime(ts) {
    return Math.floor(ts / TF_MS) * TF_MS;
  }

  function ingest(price, ts) {
    if (!Number.isFinite(price)) return;
    lastPrice = price;
    const t = bucketTime(ts);
    if (!current || current.time !== t) {
      if (current) {
        candles.push(current);
        if (candles.length > MAX_CANDLES) candles = candles.slice(-MAX_CANDLES);
        settlePending(current.close, current.time);
      }
      current = { time: t, open: price, high: price, low: price, close: price };
    } else {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
    }
  }

  function settlePending(close, time) {
    const p = stats.pending;
    if (!p) return;
    if (time < p.expireAt) return;
    const won =
      (p.dir === "CALL" && close > p.entry) || (p.dir === "PUT" && close < p.entry);
    if (won) stats.wins++;
    else stats.losses++;
    stats.history.unshift({
      dir: p.dir,
      won,
      entry: p.entry,
      exit: close,
      at: time,
    });
    if (stats.history.length > 80) stats.history.pop();
    stats.pending = null;
    persistStats();
  }

  function persistStats() {
    chrome.storage.local.set({
      cyberStats: {
        wins: stats.wins,
        losses: stats.losses,
        history: stats.history.slice(0, 40),
      },
    });
  }

  function loadStats() {
    chrome.storage.local.get("cyberStats", (d) => {
      const s = d && d.cyberStats;
      if (!s) return;
      stats.wins = s.wins || 0;
      stats.losses = s.losses || 0;
      stats.history = Array.isArray(s.history) ? s.history : [];
    });
  }

  function series() {
    const out = candles.slice();
    if (current) out.push(current);
    return out;
  }

  function maybeSignal() {
    const sig = self.CYBER_ENGINE.analyze(series());
    paintHud(sig);
    pushState(sig);

    if (!sig.ready || sig.direction === "WAIT") return;
    if (stats.pending) return;
    const closed = candles[candles.length - 1];
    if (!closed) return;
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
      asset: assetName(),
      price: lastPrice,
      candles: series().length,
      signal: sig,
      wins: stats.wins,
      losses: stats.losses,
      pending: stats.pending,
      history: stats.history.slice(0, 20),
      winrate: total ? (stats.wins / total) * 100 : 0,
      accuracy: total ? (stats.wins / total) * 100 : 0,
      ts: Date.now(),
    };
    chrome.runtime.sendMessage({ type: "CYBER_STATE", payload }).catch(() => {});
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
    document.documentElement.appendChild(el);
    el.querySelector("#cb-open-dash").addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
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
      "L";
  }

  function tick() {
    const p = findPrice();
    if (p) {
      ingest(p, Date.now());
      if (!dashOpened && attached) {
        dashOpened = true;
        chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
      }
    }
    maybeSignal();
  }

  function attach() {
    if (attached) {
      chrome.runtime.sendMessage({ type: "CYBER_OPEN_DASH" }).catch(() => {});
      return;
    }
    attached = true;
    loadStats();
    ensureHud();
    observer = new MutationObserver(() => {});
    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    pollTimer = setInterval(tick, 400);
    tick();
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg && msg.type === "CYBER_ATTACH") {
      attach();
      sendResponse({ ok: true });
    }
  });

  if (/qxbroker|quotex/i.test(location.host)) {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      attach();
    } else {
      document.addEventListener("DOMContentLoaded", attach, { once: true });
    }
  }
})();
