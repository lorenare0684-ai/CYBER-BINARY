"use strict";

(function () {
  const hasChrome = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
  const FEED = self.CYBER_FEED;
  const ENG = self.CYBER_ENGINE;
  const ASSETS = self.CYBER_ASSETS;
  const STRAT = self.CYBER_STRATEGIES;
  const STORE = self.CYBER_STORE;
  const HIST = self.CYBER_HIST;
  const WORKERS = self.CYBER_WORKERS;
  const AUTO = self.CYBER_AUTO;
  const QUOTEX = self.CYBER_QUOTEX || null;
  const AS = self.CYBER_ASSET_SELECTOR || null;

  /**
   * A library that failed to load used to surface as a cryptic
   * "STRAT is not defined" / "Cannot read properties of undefined" thrown from
   * deep inside an event handler, with nothing pointing at the <script> that
   * never ran. Check up front and name the culprit instead.
   */
  function fatalStartup(message) {
    try {
      const box = document.createElement("div");
      box.id = "startup-error";
      box.setAttribute("style",
        "position:fixed;left:0;right:0;top:0;z-index:9999;padding:14px 18px;" +
        "background:#3b0d12;border-bottom:1px solid #ff5c6c;color:#ffd9dd;" +
        "font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap");
      box.textContent = message;
      (document.body || document.documentElement).appendChild(box);
    } catch (_) {
      /* DOM not ready — the console error below still lands. */
    }
    throw new Error("CYBER BINARY dashboard could not start: " + message);
  }

  // WORKERS is intentionally absent: line ~1398 guards it
  // (`WORKERS && WORKERS.runBrowser`) and falls back to running the matrix
  // synchronously, so a missing workers.js must not abort the dashboard.
  // QUOTEX / AS are already `|| null` and optional by design.
  const missingLibs = [
    ["CYBER_FEED", FEED], ["CYBER_ENGINE", ENG], ["CYBER_ASSETS", ASSETS],
    ["CYBER_STRATEGIES", STRAT], ["CYBER_STORE", STORE], ["CYBER_HIST", HIST],
    ["CYBER_AUTO", AUTO],
  ].filter(([, lib]) => !lib).map(([name]) => name);

  if (missingLibs.length) {
    fatalStartup(
      "missing " + missingLibs.join(", ") + ".\n" +
      "dashboard.html loads these from src/lib/ — reload the unpacked extension " +
      "at chrome://extensions so every file is present, then reopen the dashboard."
    );
  }

  // Active local feed (for the dashboard's own chart when live data is missing).
  const localFeed = FEED.createFeed({ tfMs: 60000, max: 400 });
  localFeed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD"), 240));

  let activeAsset = "EURUSD";
  let activeStrategy = "auto_adaptive";
  let lastDetailsKey = "";
  let lastHistoryKey = "";
  let lastChartKey = "";
  let liveFromExt = false;
  let lastExtTs = 0;
  let autoState = null;
  let settings = null;
  let btResults = null;
  let btDataByAsset = null; // asset id -> "live" | "live+sim" | "sim" for the last run
  let lastChartCandles = null;
  let lastChartMeta = {};
  let currentAssetId = null; // asset on screen, for per-asset price precision
  let lastBtEquity = null;
  let qxStatus = { state: "idle" };
  let qxInstruments = [];
  let qxBalance = null;
  let qxOrders = [];
  let openOrders = [];
  let ongoingTimer = null;
  let lastPriceMap = Object.create(null);
  let lastOrderError = null;   // last broker-side order rejection {error, at}
  let pendingLiveState = null;
  let liveRenderQueued = false;
  let demoTimer = null;
  let resizeQueued = false;
  let activeTab = "live";
  let assetsRenderToken = 0;
  let historyRenderToken = 0;
  let lastTopAccFetchTs = 0;
  const recentAutoLogKeys = new Set();
  const recentAutoLogOrder = [];
  const liveCandlesByAsset = Object.create(null);
  let lastLiveBalance = null; // v2.6.9: { isDemo, balance, currency, at } from extension state

  function tfLabel(sec) {
    if (!sec) return "1m";
    sec = Number(sec) || 60;
    if (sec === 60) return "1m";
    if (sec % 60 === 0) return (sec / 60) + "m";
    return sec + "s";
  }

  /** Candle axis label. UTC by default — the broker chart is a UTC chart. */
  function axisTimeLabel(time, utc) {
    const d = new Date(Number(time));
    if (!Number.isFinite(d.getTime())) return "";
    const two = (n) => (n < 10 ? "0" + n : String(n));
    if (utc !== false) return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
    return two(d.getHours()) + ":" + two(d.getMinutes());
  }

  function $(id) { return document.getElementById(id); }
  function $all(sel) { return document.querySelectorAll(sel); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[ch]);
  }
  function finite(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback == null ? null : fallback);
  }
  function fmtMoney(value) {
    const n = finite(value, null);
    return n == null ? "" : (n > 0 ? "+" : "") + n.toFixed(2);
  }
  function isoTime(value) {
    if (value == null || value === "") return "";
    const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toISOString() : "";
  }
  function csvCell(value) {
    if (value == null) return "";
    let s = String(value);
    if (/^[=+\-@]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
    s = s.replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }

  function fmtPct(n) {
    const x = finite(n, null);
    return x == null ? "—" : x.toFixed(1) + "%";
  }
  // Decimal places for the asset currently on screen. The old rule keyed off
  // magnitude alone (>= 20 → 2 decimals), which truncated every JPY pair to
  // 115.01 while Quotex quotes 115.012 — dropping the digit that actually
  // decides a binary option. Prefer the catalog's per-asset `decimals`.
  function assetDecimals(assetId) {
    const id = assetId == null ? currentAssetId : assetId;
    if (id && self.CYBER_ASSETS && typeof self.CYBER_ASSETS.get === "function") {
      try {
        const a = self.CYBER_ASSETS.get(id);
        const d = a && Number(a.decimals);
        if (Number.isFinite(d) && d >= 0 && d <= 10) return Math.floor(d);
      } catch (_) {}
    }
    return null;
  }
  function fmtPx(n, assetId) {
    const x = finite(n, null);
    if (x == null) return "—";
    const d = assetDecimals(assetId);
    if (d != null) return x.toFixed(d);
    return Math.abs(x) >= 20 ? x.toFixed(2) : x.toFixed(5);
  }
  function fmtReading(n) {
    if (!Number.isFinite(n)) return "—";
    const magnitude = Math.abs(n);
    if (magnitude < 1e-12) return "0";
    const places = Math.max(4, Math.min(10, Math.ceil(-Math.log10(magnitude)) + 4));
    const fixed = n.toFixed(places);
    return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  }
  /**
   * v2.6.17: every timestamp the dashboard shows is a BROKER timestamp, and
   * Quotex is a UTC platform on a 24-hour clock — its charts, expiries and
   * price updates are all UTC and it does not adapt to the machine's zone.
   *
   * These two used to render with toLocaleTimeString()/toLocaleString(), i.e.
   * the machine's zone and locale. On a UTC+5:30 machine a 09:47 UTC entry
   * read "3:17:00 pm": every trade time, expiry, history row and automation
   * log line was offset from the platform (and in 12-hour form on an en-US
   * locale), so entries could not be matched against the Quotex candle they
   * belong to. The chart axis was already UTC — these are what still leaked.
   *
   * Fixed-width 24-hour UTC, explicitly suffixed so the basis is never in
   * doubt. Same reading as `axisTimeLabel()`, which draws the chart axis.
   */
  function two(n) { return n < 10 ? "0" + n : String(n); }
  /** 24-hour UTC clock without the suffix, for lines that state UTC once. */
  function fmtClock(ts) {
    if (ts == null || ts === "") return "—";
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return "—";
    return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds());
  }
  function fmtTime(ts) {
    const clock = fmtClock(ts);
    return clock === "—" ? "—" : clock + " UTC";
  }
  function fmtDate(ts) {
    if (ts == null || ts === "") return "—";
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return "—";
    return d.getUTCFullYear() + "-" + two(d.getUTCMonth() + 1) + "-" + two(d.getUTCDate()) +
      " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes()) + ":" + two(d.getUTCSeconds()) + " UTC";
  }
  function fmtDuration(minutes, entryTime, expiryTime) {
    let mins = Number(minutes);
    if (!Number.isFinite(mins) && entryTime != null && expiryTime != null) mins = (Number(expiryTime) - Number(entryTime)) / 60000;
    if (!Number.isFinite(mins) || mins <= 0) return "—";
    return (Math.round(mins * 10) / 10) + "m";
  }
  /**
   * v2.6.17: the strategy behind a row/signal, by label.
   *
   * Rows record the concrete strategy id; under auto_adaptive that is the
   * strategy the router PICKED, never the literal "auto_adaptive". Resolve it
   * to the preset's human label so the UI reads "Sniper 90+ Confluence"
   * rather than "sniper" — and never shows the router as if it were a
   * strategy that generated a signal.
   */
  function strategyLabel(id, fallbackLabel) {
    if (typeof fallbackLabel === "string" && fallbackLabel) return fallbackLabel;
    if (typeof id !== "string" || !id) return "";
    if (id === "auto_adaptive") return "";
    const preset = STRAT && typeof STRAT.get === "function" ? STRAT.get(id.slice(0, 64)) : null;
    return (preset && preset.label) || id;
  }

  /** The strategy that produced a signal payload, resolved to a label. */
  function signalStrategyLabel(sig, state) {
    if (!sig || typeof sig !== "object") sig = {};
    const label = strategyLabel(sig.selectedStrategy, sig.selectedStrategyLabel) ||
      strategyLabel(state && state.selectedStrategy, state && state.selectedStrategyLabel) ||
      strategyLabel(sig.strategy) ||
      strategyLabel(state && state.strategy);
    return label || "—";
  }

  function tradeOutcome(h) {
    if (!h || typeof h !== "object") return { label: "UNKNOWN", cls: "" };
    const hasWon = Object.prototype.hasOwnProperty.call(h, "won");
    if (h.draw === true || (hasWon && h.won === null)) return { label: "DRAW", cls: "" };
    if (h.won === true) return { label: "WIN", cls: "win" };
    if (h.won === false) return { label: "LOSS", cls: "loss" };
    return { label: "UNKNOWN", cls: "" };
  }
  function tradeTimeline(h, includeExit) {
    h = h || {};
    const entryTime = h.entryTime != null ? h.entryTime : h.at;
    const expiryTime = h.expiryTime != null ? h.expiryTime : h.expireAt;
    const exitTime = h.exitTime != null ? h.exitTime : (includeExit ? h.at : null);
    const entry = h.entryPrice != null ? h.entryPrice : h.entry;
    const exit = h.exitPrice != null ? h.exitPrice : h.exit;
    // One "UTC" for the whole line rather than three: these are broker clock
    // times on the same 24-hour UTC basis as the chart axis and Quotex itself.
    let text = "Entry " + fmtClock(entryTime) + " @ " + fmtPx(entry);
    text += " · Expiry " + fmtClock(expiryTime) + " (" + fmtDuration(h.expiryMinutes, entryTime, expiryTime) + ")";
    if (includeExit || exit != null) text += " · Exit " + fmtClock(exitTime) + " @ " + fmtPx(exit);
    return text + " UTC";
  }

  function meter(label, value, min, max, side) {
    const span = max - min || 1;
    const n = finite(value, null);
    const pct = n == null ? 0 : Math.max(0, Math.min(100, ((n - min) / span) * 100));
    const cls = side ? "bar " + side : "bar";
    return (
      '<div class="meter"><span>' + esc(label) + '</span>' +
      '<div class="' + cls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<span>' + (n == null ? "—" : n.toFixed(1)) + '</span></div>'
    );
  }

  // ===== Enhanced Charts v3 — delegates to CYBER_CHARTS =====
  const CHARTS = self.CYBER_CHARTS || null;

  function drawChart(canvas, candles, opts) {
    if (!canvas) return;
    opts = opts || {};
    // Equity mode still supported via dedicated function
    if (opts.equity) {
      if (CHARTS && CHARTS.drawEquityChart) {
        CHARTS.drawEquityChart(canvas, candles, { label: opts.equityLabel || "Equity", trades: opts.trades || null });
      } else {
        // fallback simple
        const parent = canvas.parentElement;
        const w = Math.max(180, Math.min(4096, (parent && parent.clientWidth) || 800));
        const h = 180;
        const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
        canvas.width = Math.floor(w*dpr); canvas.height = Math.floor(h*dpr);
        canvas.style.width=w+"px"; canvas.style.height=h+"px";
        const ctx=canvas.getContext("2d"); if(!ctx) return;
        ctx.setTransform(dpr,0,0,dpr,0,0); ctx.fillStyle="#0c1422"; ctx.fillRect(0,0,w,h);
        ctx.fillStyle="rgba(255,255,255,0.45)"; ctx.font="11px system-ui"; ctx.textAlign="center";
        ctx.fillText("Equity · " + (candles?candles.length:0) + " pts", w/2, h/2);
      }
      return;
    }
    if (CHARTS && CHARTS.drawMainChart) {
      // Merge toolbar state if available
      const toolbarState = CHARTS.getState ? CHARTS.getState(canvas) : null;
      const mergedOpts = Object.assign({}, opts);
      if (toolbarState) {
        // preserve decimals from opts if provided
        if (opts.decimals != null) toolbarState.decimals = opts.decimals;
      }
      // Auto-bind interactions once
      if (CHARTS.bindMainChartInteractions) {
        try { CHARTS.bindMainChartInteractions(canvas); } catch(_) {}
      }
      CHARTS.drawMainChart(canvas, candles, mergedOpts);
      // Update toolbar title/price badges if main chart
      try {
        if (canvas.id === "chart") {
          const titleEl = document.getElementById("chart-title");
          const priceEl = document.getElementById("chart-price-badge");
          const changeEl = document.getElementById("chart-change-badge");
          const infoRight = document.getElementById("chart-info-right");
          const titleEl2 = document.getElementById("chart-title");
          if (titleEl2) {
            const assetName = (typeof activeAsset !== "undefined" && activeAsset) ? activeAsset : (opts.label || "—");
            const tf = opts.timeframe || "1m";
            titleEl2.textContent = assetName + " · " + tf + (opts.timeBasis ? " · " + opts.timeBasis : "");
          }
          if (priceEl && Array.isArray(candles) && candles.length) {
            const last = candles[candles.length-1];
            if (last && last.close != null) {
              priceEl.textContent = (typeof fmtPx === "function" ? fmtPx(last.close) : String(last.close));
              const prev = candles.length>1 ? candles[candles.length-2].close : last.open;
              const isUp = last.close >= (last.open || prev);
              priceEl.className = "chart-price " + (isUp ? "up" : "down");
              if (changeEl) {
                const ch = prev ? ((last.close - prev)/prev*100) : 0;
                changeEl.textContent = (ch>=0?"+":"") + ch.toFixed(2) + "%";
                changeEl.className = "chart-change " + (ch>=0 ? "up" : "down");
              }
            }
          }
          if (infoRight) {
            const st = CHARTS.getState ? CHARTS.getState(canvas) : null;
            if (st && st._lastPlot) {
              infoRight.textContent = `${st._lastPlot.view.length} visible · ${st.visibleBars} window · ${st.scrollOffset>0?st.scrollOffset+" scrolled":"latest"}`;
            }
          }
        }
      } catch(_) {}
    } else {
      // Fallback: simple text
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle="#0c1422"; ctx.fillRect(0,0,canvas.width,canvas.height);
    }
  }

  /* ---------- tab routing ---------- */
  function activateTab(name) {
    if (typeof name !== "string" || !Array.from($all(".tab-pane")).some((p) => p.dataset.pane === name)) return;
    activeTab = name;
    if (name !== "assets") assetsRenderToken++;
    if (name !== "history") historyRenderToken++;
    $all(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $all(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
    if (name === "live") {
      setTimeout(() => {
        if (lastChartCandles && lastChartCandles.length) drawChart($("chart"), lastChartCandles, lastChartMeta);
        STORE.getStats().then(renderTopAccuracyTable).catch(() => {});
      }, 30);
    }
    if (name === "assets") refreshAssetsTab();
    if (name === "history") refreshHistoryTab();
    if (name === "settings") refreshSettingsTab();
    if (name === "instruments") refreshInstrumentsTab();
    if (name === "backtest") {
      setTimeout(() => {
        if (lastBtEquity) drawChart($("bt-equity"), lastBtEquity, { equity: true, equityLabel: "runs" });
      }, 30);
    }
  }
  $all(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));

  /* ---------- asset/strategy selectors ---------- */
  function selectAsset(assetId) {
    if (hasChrome) {
      const pill = $("link-state");
      if (pill) {
        pill.textContent = "Switching asset…";
        pill.className = "pill dim";
      }
      chrome.runtime.sendMessage({ type: "CYBER_SET_ASSET", asset: assetId }).then((response) => {
        if (response && response.ok) {
          activeAsset = response.asset || assetId;
          const sel = $("asset-select");
          if (sel) sel.value = activeAsset;
          if (pill) {
            if (response.wsConnected) {
              pill.textContent = response.message || ("Switched to " + (response.name || activeAsset));
              pill.className = "pill ok";
            } else {
              pill.textContent = response.message || "Open Quotex to receive live data";
              pill.className = "pill warn";
            }
          }
        } else {
          if (pill) {
            pill.textContent = response && response.error || "Asset switch failed";
            pill.className = "pill warn";
          }
        }
      }).catch(() => {
        if (pill) {
          pill.textContent = "Extension not responding";
          pill.className = "pill warn";
        }
      });
    } else {
      activeAsset = assetId;
      const sel = $("asset-select");
      if (sel) sel.value = activeAsset;
      const a = ASSETS.get(activeAsset);
      if (a) localFeed.setSeries(FEED.syntheticSeries(a, 240));
      renderLocalTick();
    }
  }

  function selectBestAsset() {
    if (!AS) return;
    STORE.getStats().then((stats) => {
      const best = AS.getBestAsset({
        stats,
        candlesByAsset: liveCandlesByAsset,
      });
      if (best) selectAsset(best.id);
    }).catch(() => {});
  }

  function refreshSelectors() {
    const sel = $("asset-select");
    if (sel) {
      sel.innerHTML = "";
      for (const a of ASSETS.list()) {
        const o = document.createElement("option");
        o.value = a.id; o.textContent = a.name;
        if (a.id === activeAsset) o.selected = true;
        sel.appendChild(o);
      }
    }
    const st = $("strategy-select");
    if (st) {
      st.innerHTML = "";
      for (const s of STRAT.list()) {
        const o = document.createElement("option");
        o.value = s.id; o.textContent = s.label;
        if (s.id === activeStrategy) o.selected = true;
        st.appendChild(o);
      }
    }
    const ha = $("hist-asset");
    if (ha) {
      ha.innerHTML = '<option value="all">All</option>';
      for (const a of ASSETS.list()) {
        const o = document.createElement("option");
        o.value = a.id; o.textContent = a.name;
        ha.appendChild(o);
      }
    }
  }

  function bindSelectors() {
    $("asset-select").addEventListener("change", (e) => {
      selectAsset(e.target.value);
    });
    $("strategy-select").addEventListener("change", (e) => {
      activeStrategy = e.target.value;
      if (hasChrome) {
        chrome.runtime.sendMessage({ type: "CYBER_SET_STRATEGY", strategy: activeStrategy }).catch(() => {});
      } else {
        renderLocalTick();
      }
    });
    $("refresh-asset").addEventListener("click", () => {
      if (hasChrome) chrome.runtime.sendMessage({ type: "CYBER_DETECT_ASSET" }).catch(() => {});
    });
    const bestBtn = $("select-best-asset");
    if (bestBtn) {
      bestBtn.addEventListener("click", selectBestAsset);
    }
  }

  /* ---------- live rendering ---------- */
  function jsonKey(value) {
    try { return JSON.stringify(value); } catch (_) { return ""; }
  }

  function normalizeOrderEvent(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !QUOTEX) return null;
    const kind = value.kind === "opened" || value.kind === "closed" ? value.kind : null;
    const source = value.data && typeof value.data === "object" && !Array.isArray(value.data) ? value.data : null;
    if (!kind || !source) return null;
    const data = kind === "opened" ? QUOTEX.parseOrderOpened(source) : QUOTEX.parseOrderClosed(source);
    return data ? { kind, data } : null;
  }

  function orderKey(order) {
    const d = order && order.data || {};
    const identity = d.id || d.requestId || "";
    const at = d.openTime || d.closeTime || "";
    return identity || at
      ? String(order && order.kind || "") + ":" + identity + ":" + at
      : String(order && order.kind || "") + ":" + jsonKey(d);
  }

  function mergeOrders(values) {
    const seen = new Set();
    const out = [];
    for (const value of Array.isArray(values) ? values : []) {
      const order = normalizeOrderEvent(value);
      if (!order) continue;
      const key = orderKey(order);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(order);
      if (out.length >= 50) break;
    }
    return out;
  }

  function chartStateKey(candles, period, markers) {
    if (!Array.isArray(candles)) return "";
    let hash = 2166136261;
    const mix = (value) => {
      const s = String(value == null ? "" : value);
      for (let i = 0; i < s.length; i++) hash = Math.imul(hash ^ s.charCodeAt(i), 16777619);
      hash = Math.imul(hash ^ 124, 16777619);
    };
    mix(period || 60);
    mix(candles.length);
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i] || {};
      mix(c.time); mix(c.open); mix(c.high); mix(c.low); mix(c.close);
    }
    const safeMarkers = Array.isArray(markers) ? markers : [];
    mix(safeMarkers.length);
    for (let i = 0; i < safeMarkers.length; i++) {
      const m = safeMarkers[i] || {};
      mix(m.time); mix(m.price); mix(m.dir);
    }
    return String(hash >>> 0) + "|" + candles.length + "|" + safeMarkers.length;
  }

  function renderTopAccuracyTable(stats) {
    if (!AS) return;
    const ranked = AS.rankAssets({
      stats: stats,
      candlesByAsset: liveCandlesByAsset,
      history: stats && stats.history,
      openOnly: false,
    });
    const top = ranked.slice(0, 5);
    const tb = $("top-accuracy-table") ? $("top-accuracy-table").querySelector("tbody") : null;
    if (!tb) return;
    tb.innerHTML = "";
    for (const item of top) {
      const tr = document.createElement("tr");
      const evCls = item.expectedValue > 0 ? "win" : "loss";
      const evTxt = (item.expectedValuePct > 0 ? "+" : "") + item.expectedValuePct + "%";
      // v2.7.4: quality metrics tooltip
      const volQ = item.volatilityQuality != null ? item.volatilityQuality : "—";
      const trendQ = item.trendStrength != null ? item.trendStrength : "—";
      const noiseQ = item.noiseQuality != null ? item.noiseQuality : "—";
      const sessQ = item.sessionQuality != null ? item.sessionQuality : "—";
      const qualityTip = "Volatility: " + volQ + "/100 · Trend: " + trendQ +
        "/100 · Noise: " + noiseQ + "/100 · Session: " + sessQ + "x";
      const accBadge = item.accuracyScore >= 75 ? "green"
        : item.accuracyScore >= 60 ? "blue" : "";
      tr.innerHTML =
        "<td># " + item.rank + "</td>" +
        "<td><strong>" + esc(item.name) + "</strong></td>" +
        "<td>" + item.payout + "%</td>" +
        "<td>" + item.winrate + "%</td>" +
        "<td class='" + evCls + "'>" + evTxt + "</td>" +
        "<td title='" + esc(qualityTip) + "'><span class='badge " + accBadge + "'>" + item.accuracyScore + " / 100</span></td>" +
        "<td>" + esc(item.recommendedStrategyLabel) + "</td>" +
        "<td><button type='button' class='arm-btn tiny' data-asset='" + item.id + "'>Select</button></td>";
      const btn = tr.querySelector("button");
      if (btn) {
        btn.addEventListener("click", () => selectAsset(item.id));
      }
      tb.appendChild(tr);
    }
  }

  function fmtTimeLeft(expiryMs) {
    const now = Date.now();
    const diff = Number(expiryMs) - now;
    if (!Number.isFinite(diff)) return "—";
    if (diff <= 0) return "expired";
    const s = Math.floor(diff / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function renderOngoingTrades(virtualPending) {
    const tables = [
      { tbody: $("ongoing-table") ? $("ongoing-table").querySelector("tbody") : null, empty: $("ongoing-empty"), count: $("ongoing-count"), full: true },
      { tbody: $("auto-ongoing-table") ? $("auto-ongoing-table").querySelector("tbody") : null, empty: $("auto-ongoing-empty"), count: $("auto-ongoing-count"), full: false },
    ];
    // Combine broker open orders + virtual pending for full view
    const virtualList = [];
    if (virtualPending && typeof virtualPending === 'object') {
      virtualList.push({
        asset: virtualPending.asset || "—",
        dir: virtualPending.dir || "—",
        direction: virtualPending.dir || "—",
        amount: null,
        openPrice: virtualPending.entry || virtualPending.entryPrice,
        expiryTime: virtualPending.expireAt || virtualPending.expiryTime,
        closeTime: virtualPending.expireAt || virtualPending.expiryTime,
        isVirtual: true,
      });
    }
    const all = openOrders.concat(virtualList);
    const count = all.length;
    for (const cfg of tables) {
      if (!cfg.tbody) continue;
      cfg.tbody.innerHTML = "";
      if (cfg.count) cfg.count.textContent = `${count} active`;
      if (cfg.empty) cfg.empty.style.display = count ? "none" : "block";
      for (const o of all.slice(0, 20)) {
        const tr = document.createElement("tr");
        const dirCls = o.direction === "CALL" || o.dir === "CALL" ? "win" : o.direction === "PUT" || o.dir === "PUT" ? "loss" : "";
        const asset = esc(o.asset || "—");
        const dir = esc(o.direction || o.dir || "—");
        const stake = o.isVirtual ? "VIRTUAL" : (finite(o.amount, null) != null ? esc(finite(o.amount, 0).toFixed(2)) + "$" : "—");
        const entry = o.openPrice ? esc(fmtPx(o.openPrice)) : "—";
        const currPrice = lastPriceMap[o.asset] || null;
        const curr = currPrice ? esc(fmtPx(currPrice)) : "—";
        let pnl = "—";
        let pnlCls = "";
        if (currPrice && o.openPrice && !o.isVirtual) {
          const isCall = (o.direction || o.dir) === "CALL";
          const winning = isCall ? currPrice > o.openPrice : currPrice < o.openPrice;
          const payout = 0.85;
          const est = winning ? `+${(o.amount * payout).toFixed(2)}$` : `-${Number(o.amount).toFixed(2)}$`;
          pnl = est;
          pnlCls = winning ? "win" : "loss";
        }
        const expiry = esc(fmtTime(o.expiryTime || o.closeTime));
        const timeLeft = esc(fmtTimeLeft(o.expiryTime || o.closeTime));
        const status = o.isVirtual ? "VIRTUAL PENDING" : "OPEN";
        const statusCls = o.isVirtual ? "" : "win";
        if (cfg.full) {
          tr.innerHTML = `<td><strong>${asset}</strong></td><td class="${dirCls}">${dir}</td><td>${stake}</td><td>${entry}</td><td>${curr}</td><td class="${pnlCls}">${pnl}</td><td>${expiry}</td><td>${timeLeft}</td><td class="${statusCls}">${status}</td>`;
        } else {
          tr.innerHTML = `<td><strong>${asset}</strong></td><td class="${dirCls}">${dir}</td><td>${stake}</td><td>${entry}</td><td>${expiry}</td><td>${timeLeft}</td><td class="${statusCls}">${status}</td>`;
        }
        cfg.tbody.appendChild(tr);
      }
    }
  }

  let lastVirtualPending = null;
  function ensureOngoingTimer() {
    if (ongoingTimer) return;
    ongoingTimer = setInterval(() => {
      if (openOrders.length || lastVirtualPending) renderOngoingTrades(lastVirtualPending);
    }, 1000);
  }

  function renderLive(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    if (state && state.quotex && typeof state.quotex === "object" && !Array.isArray(state.quotex)) {
      if (state.quotex.status && typeof state.quotex.status === "object" && !Array.isArray(state.quotex.status)) {
        qxStatus = {
          state: typeof state.quotex.status.state === "string" ? state.quotex.status.state.slice(0, 64) : "unknown",
          url: state.quotex.status.url == null ? null : String(state.quotex.status.url).slice(0, 256),
        };
      }
      if (state.quotex.balance) qxBalance = QUOTEX ? QUOTEX.parseBalance(state.quotex.balance) : null;
      if (Array.isArray(state.quotex.lastOrders)) {
        qxOrders = mergeOrders(state.quotex.lastOrders.concat(qxOrders));
      }
      if (Array.isArray(state.quotex.openOrders)) {
        openOrders = state.quotex.openOrders.slice(0, 50);
      }
      lastVirtualPending = state.pending && typeof state.pending === 'object' ? state.pending : null;
      ensureOngoingTimer();
      renderOngoingTrades(lastVirtualPending);
      // Track last price per asset for P&L estimation
      if (state.assetId && state.price != null) {
        lastPriceMap[state.assetId] = Number(state.price);
      }
      if (state.quotex && state.quotex.activeSymbol && state.price != null) {
        lastPriceMap[state.quotex.activeSymbol] = Number(state.price);
      }
    }
    paintQuotexPill();

    $("link-state").textContent = state.attached
      ? (state.primary === false ? "Secondary chart" : "Main · " + (state.source || "chart"))
      : "Demo feed";
    $("link-state").className = "pill " + (state.attached ? "ok" : "dim");

    // Track the on-screen asset before formatting any price, so fmtPx can use
    // that asset's real decimal precision (JPY pairs quote 3, not 2).
    if (typeof state.assetId === "string" && state.assetId) currentAssetId = state.assetId.slice(0, 96);
    else if (typeof state.asset === "string" && state.asset) currentAssetId = state.asset.slice(0, 96);

    if (state.asset) $("asset").textContent = state.asset;
    if (state.price != null) $("price").textContent = fmtPx(state.price);
    if (typeof state.assetId === "string" && state.assetId) {
      const stateAsset = ASSETS.get(state.assetId.slice(0, 96));
      if (stateAsset) {
        activeAsset = stateAsset.id;
        const sel = $("asset-select");
        if (sel && sel.value !== activeAsset) sel.value = activeAsset;
      }
    }
    if (typeof state.strategy === "string" && state.strategy && STRAT.get(state.strategy.slice(0, 64))) {
      activeStrategy = state.strategy.slice(0, 64);
      const sel = $("strategy-select");
      if (sel && sel.value !== activeStrategy) sel.value = activeStrategy;
    }
    if (Array.isArray(state.candles) && state.candles.length && state.source !== "demo") {
      // v2.6.8: demo candles are synthetic — caching them here would let the
      // asset ranker score assets on fake data. Live extension state only.
      liveCandlesByAsset[activeAsset] = state.candles.slice(-500);
    }

    // content.js nests the broker account under `quotex`; nothing has ever
    // written a top-level `balance`. Reading only the top level left
    // lastLiveBalance permanently null, so renderAccountLine()'s documented
    // fallback ("falls back to the extension state's last balance event")
    // could never fire and the line stayed on "waiting for a balance event".
    const balanceSource = (state.balance && typeof state.balance === "object")
      ? state.balance
      : (state.quotex && typeof state.quotex === "object" &&
         state.quotex.balance && typeof state.quotex.balance === "object"
        ? state.quotex.balance : null);
    if (balanceSource) {
      const b = balanceSource;
      lastLiveBalance = {
        isDemo: typeof b.isDemo === "boolean" ? b.isDemo : null,
        balance: Number(b.balance),
        currency: typeof b.currency === "string" ? b.currency : "USD",
        at: Date.now(),
      };
      renderAccountLine(lastLiveBalance);
    }
    const sig = state.signal && typeof state.signal === "object" ? state.signal : {};
    const history = Array.isArray(state.history) ? state.history.filter((h) => h && typeof h === "object").slice(0, 100) : [];
    const dir = sig.direction === "CALL" || sig.direction === "PUT" ? sig.direction : "WAIT";
    $("dir").textContent = dir;
    $("hero").dataset.dir = dir;
    $("reason").textContent = sig.reason || "Collecting candles…";
    const timing = $("signal-timing");
    if (timing) {
      const currentCall = (state.pending && typeof state.pending === "object" ? state.pending : null) || history[0] || {
        entryTime: sig.entryTime != null ? sig.entryTime : sig.time,
        entryPrice: sig.entryPrice != null ? sig.entryPrice : (sig.metrics && sig.metrics.close),
      };
      timing.textContent = tradeTimeline(currentCall, !!(currentCall.exit != null || currentCall.exitPrice != null));
    }
    // The live hero states the strategy that produced THIS signal. Under
    // auto_adaptive that is the concrete strategy the router picked, so the
    // trader can see which one is speaking without opening the cockpit card.
    const heroStrategy = signalStrategyLabel(sig, state);
    const routed = state.strategy === "auto_adaptive" ? " (auto)" : "";
    const noiseTxt = sig.noise && sig.noise.ready
      ? " · noise: " + Number(sig.noise.score).toFixed(2)
      : "";
    // v2.8: show dynamic expiry suggestion
    const exp = sig.suggestedExpiry != null ? Number(sig.suggestedExpiry) : null;
    const expTxt = exp != null && Number.isFinite(exp)
      ? ` · expiry: ${exp}m` + (sig.expiryReason ? ` (${String(sig.expiryReason).slice(0,120)})` : "") + (settings && settings.expiryMode === "adaptive" ? " [adaptive]" : " [fixed]")
      : "";
    $("regime-row").textContent = "strategy: " + heroStrategy + routed +
      " · regime: " + (sig.regime || "—") + " · session: " + (sig.session || state.session || "—") + noiseTxt +
      " · engine: 1m · mtf bias: " + ((sig.metrics && sig.metrics.mtfBias) || 0) + "/" + ((sig.metrics && sig.metrics.mtfChecked) || 0) + expTxt;

    // Auto-Adaptive Cockpit UI Update
    const adaptiveCard = $("adaptive-card");
    if (adaptiveCard) {
      const isAdaptive = activeStrategy === "auto_adaptive" || sig.adaptive === true;
      $("adaptive-regime-label").textContent = sig.regime ? sig.regime.toUpperCase() : "ANALYZING";
      const selStratObj = sig.selectedStrategy ? STRAT.get(sig.selectedStrategy) : null;
      $("adaptive-strategy-label").textContent = sig.selectedStrategyLabel || (selStratObj ? selStratObj.label : (isAdaptive ? "Auto-Adaptive Engine" : activeStrategy));
      $("adaptive-reason-text").textContent = sig.reason || "Evaluating optimal strategy for situation…";

      const fitnessContainer = $("fitness-meters");
      if (fitnessContainer && sig.strategyScores) {
        let fitnessHtml = "";
        const scores = sig.strategyScores;
        const sorted = Object.keys(scores).sort((a, b) => (scores[b].fitness || 0) - (scores[a].fitness || 0)).slice(0, 5);
        for (const stratId of sorted) {
          const item = scores[stratId];
          const isSelected = sig.selectedStrategy === stratId;
          const label = item.label || stratId;
          const fit = item.fitness || 0;
          const stratDir = item.direction === "PUT" ? "put" : item.direction === "CALL" ? "call" : "";
          const dirTxt = item.direction && item.direction !== "WAIT" ? " [" + item.direction + "]" : "";
          fitnessHtml += '<div class="meter small' + (isSelected ? ' selected' : '') + '"><span>' + esc(label) + dirTxt + '</span><div class="bar ' + stratDir + '"><i style="width:' + fit + '%"></i></div><span>' + fit + '/100</span></div>';
        }
        fitnessContainer.innerHTML = fitnessHtml;
      }
    }

    // Throttle stats fetch for high-accuracy asset table (at most once every 3s)
    const now = Date.now();
    if (now - lastTopAccFetchTs > 3000) {
      lastTopAccFetchTs = now;
      STORE.getStats().then(renderTopAccuracyTable).catch(() => {});
    }

    $("wins").textContent = String(Math.max(0, Math.floor(finite(state.wins, 0))));
    $("losses").textContent = String(Math.max(0, Math.floor(finite(state.losses, 0))));
    $("winrate").textContent = fmtPct(state.winrate);
    $("accuracy").textContent = fmtPct(state.accuracy);

    const m = sig.metrics && typeof sig.metrics === "object" ? sig.metrics : null;
    const detailsKey = jsonKey([dir, sig.confidence, sig.score, sig.regime, m]);
    if (detailsKey !== lastDetailsKey) {
      lastDetailsKey = detailsKey;
      if (!m) {
        $("meters").innerHTML = "";
        $("readings").innerHTML = "";
      } else {
        $("meters").innerHTML =
          meter("RSI", m.rsi, 0, 100, (m.rsi || 50) < 50 ? "put" : "call") +
          meter("Stoch", m.stochK, 0, 100, (m.stochK || 50) < 50 ? "put" : "call") +
          meter("ADX", m.adx, 0, 60, "call") +
          meter("Hurst", (m.hurst || 0.5) * 100, 0, 100, "call") +
          meter("MTF", m.mtfBias || 0, -2, 2, (m.mtfBias || 0) > 0 ? "call" : "put") +
          meter("Conf", sig.confidence || 0, 0, 100, dir === "CALL" ? "call" : dir === "PUT" ? "put" : "");

        const rows = [
          ["RSI", m.rsi],
          ["EMA fast", m.emaFast],
          ["EMA slow", m.emaSlow],
          ["MACD hist", m.macdHist],
          ["Stoch %K", m.stochK],
          ["Stoch %D", m.stochD],
          ["BB mid", m.bbMid],
          ["ATR%", finite(m.atrPct, null) != null ? (finite(m.atrPct, 0) * 100).toFixed(3) + "%" : "—"],
          ["ADX", m.adx],
          ["+DI", m.plusDI],
          ["-DI", m.minusDI],
          ["Supertrend", m.supertrend],
          ["SAR", m.psar],
          ["Donch ↑", m.donchUpper],
          ["Donch ↓", m.donchLower],
          ["Williams %R", m.williams],
          ["CCI", m.cci],
          ["Hurst", m.hurst],
          ["Momentum", m.momentum],
          ["CALL votes", m.callScore],
          ["PUT votes", m.putScore],
          ["Required score", m.requiredScore],
          ["Score", sig.score != null ? sig.score : "—"],
          ["Confidence", finite(sig.confidence, null) != null ? finite(sig.confidence, 0) + "%" : "—"],
          ["Regime", sig.regime],
        ];
        $("readings").innerHTML = rows
          .filter((r) => r[1] != null && r[1] !== "—")
          .map((r) => {
            let cls = "";
            if (typeof r[1] === "number") {
              if (r[0] === "MACD hist" || r[0] === "Momentum" || r[0] === "Score") {
                cls = r[1] > 0 ? "call" : r[1] < 0 ? "put" : "";
              }
              if (r[0] === "+DI" && r[1] > 30) cls = "call";
              if (r[0] === "-DI" && r[1] > 30) cls = "put";
            }
            const rendered = typeof r[1] === "number" ? fmtReading(r[1]) : r[1];
            return '<div class="reading ' + cls + '"><span>' + esc(r[0]) + '</span><b>' + esc(rendered) +
              '</b></div>';
          }).join("");
      }
    }

    const ul = $("history");
    const historyKey = jsonKey(history);
    if (ul && historyKey !== lastHistoryKey) {
      lastHistoryKey = historyKey;
      ul.innerHTML = "";
      history.forEach((h) => {
        const li = document.createElement("li");
        const outcome = tradeOutcome(h);
        li.innerHTML =
          '<span class="' + outcome.cls + '">' + outcome.label + '</span>' +
          '<span class="meta">' + esc(h.dir || "") + " · " + esc(h.asset || "—") + " · conf " + esc(finite(h.confidence, 0)) + "%" +
            " · " + esc(strategyLabel(h.strategy, h.strategyLabel) || "—") + "<br>" + esc(tradeTimeline(h, true)) + '</span>' +
          '<span class="' + outcome.cls + '">' + esc(fmtMoney(h.pnl)) + '</span>';
        ul.appendChild(li);
      });
    }

    const chartCandles = (Array.isArray(state.chartCandles) && state.chartCandles.length
      ? state.chartCandles : []).slice(-500);
    const markers = Array.isArray(state.markers) ? state.markers.slice(-600) : [];
    const nextChartKey = chartStateKey(chartCandles, state.chartPeriod, markers);
    if (nextChartKey !== lastChartKey) {
      lastChartKey = nextChartKey;
      lastChartCandles = chartCandles.slice(-500);
      lastChartMeta = { timeframe: tfLabel(state.chartPeriod || 60), markers, timeBasis: state.chartTimeBasis || "broker-utc" };
      drawChart($("chart"), lastChartCandles, lastChartMeta);
    }
    const demoBadge = $("chart-demo-badge");
    if (demoBadge && chartCandles.length) demoBadge.hidden = true;
    if (state.autoState) updateAutoUI(state.autoState);
  }

  function renderLocalTick() {
    if (liveFromExt && Date.now() - lastExtTs <= 15000) return;
    if (liveFromExt) {
      liveFromExt = false;
      qxStatus = { state: "disconnected" };
      const selected = ASSETS.get(activeAsset);
      if (selected) localFeed.setSeries(FEED.syntheticSeries(selected, 240));
      lastChartKey = "";
      paintQuotexPill();
    }
    const demoBadge = $("chart-demo-badge");
    if (demoBadge) demoBadge.hidden = false;
    const last = localFeed.lastPrice() || 1.0854;
    localFeed.ingest(FEED.demoTick(last), Date.now());
    const series = localFeed.series();
    const strat = STRAT.get(activeStrategy) || STRAT.defaults();
    const sig = ENG.analyze(series, { strategy: activeStrategy, params: strat.params, weights: strat.weights, lean: false });
    sig.asset = activeAsset;
    sig.assetName = (ASSETS.get(activeAsset) || {}).name || activeAsset;
    sig.strategy = activeStrategy;
    // v2.6.6: demo mode runs on a synthetic feed — showing its engine output
    // as a CALL/PUT signal would be false signal generation. Metrics stay
    // visible; the direction is held at WAIT with an honest reason.
    if (sig.direction !== "WAIT") {
      sig.gateReason = "demo";
      sig.direction = "WAIT";
      sig.ready = false;
    }
    sig.reason = "Demo mode — synthetic feed. Open the Quotex trade tab to capture real candles and generate live signals.";
    const det = ASSETS.get(activeAsset) || {};
    lastChartCandles = series.slice();
    lastChartMeta = { timeframe: "demo" };
    renderLive({
      attached: false,
      source: "demo",
      asset: det.name || activeAsset,
      assetId: activeAsset,
      price: localFeed.lastPrice(),
      candles: series,
      signal: sig,
      wins: 0, losses: 0,
      winrate: 0, accuracy: 0,
      history: [],
    });
  }

  /** v2.6.9: live/demo account readout with balance. Falls back to the
   * extension state's last balance event when the controller has none. */
  function renderAccountLine(account) {
    const el = $("auto-account");
    if (!el) return;
    let info = account;
    if (!info || (info.isDemo == null && info.balance == null)) {
      const b = lastLiveBalance;
      if (b) info = { isDemo: b.isDemo, balance: b.balance, currency: b.currency, at: b.at || 0 };
    }
    if (!info || (info.isDemo == null && (info.balance == null || !Number.isFinite(Number(info.balance))))) {
      el.className = "account-line";
      el.textContent = "Account: unknown — waiting for a balance event";
      return;
    }
    const mode = info.isDemo === false ? "LIVE" : info.isDemo === true ? "DEMO" : "unknown";
    const bal = Number.isFinite(Number(info.balance)) ? " · " + Number(info.balance).toFixed(2) + " " + (info.currency || "USD") : "";
    el.className = "account-line " + (info.isDemo === false ? "live" : "demo");
    el.textContent = "Account: " + mode + bal + (mode === "LIVE" ? " — real money at risk" : "");
  }

  function updateAutoUI(s) {
    const source = s && typeof s === "object" && !Array.isArray(s)
      ? s : (autoState || {});
    const mode = source.mode === "alerts" || source.mode === "click" ? source.mode : "off";
    const rawLastTrade = source.lastTrade && typeof source.lastTrade === "object" && !Array.isArray(source.lastTrade)
      ? source.lastTrade : null;
    autoState = {
      mode,
      armed: mode !== "off" && source.armed === true,
      tradesToday: Math.max(0, Math.min(100000, Math.floor(finite(source.tradesToday, 0)))),
      tradesHour: Math.max(0, Math.min(100000, Math.floor(finite(source.tradesHour, 0)))),
      dailyPnl: Math.max(-1000000000, Math.min(1000000000, finite(source.dailyPnl, 0))),
      lastTrade: rawLastTrade ? {
        dir: rawLastTrade.dir === "CALL" || rawLastTrade.dir === "PUT" ? rawLastTrade.dir : "",
        asset: typeof rawLastTrade.asset === "string" ? rawLastTrade.asset.slice(0, 96) : "",
        at: finite(rawLastTrade.at, 0),
        entryTime: finite(rawLastTrade.entryTime, 0),
        expiryTime: finite(rawLastTrade.expiryTime, 0),
        // This whitelist used to drop the strategy, so the Auto tab could
        // never name the strategy that placed the trade even once the
        // controller reported it.
        strategy: typeof rawLastTrade.strategy === "string" ? rawLastTrade.strategy.slice(0, 64) : "",
        strategyLabel: typeof rawLastTrade.strategyLabel === "string" ? rawLastTrade.strategyLabel.slice(0, 96) : "",
      } : null,
    };

    const modeSelect = $("auto-mode");
    if (modeSelect && document.activeElement !== modeSelect) {
      modeSelect.value = mode;
    }

    renderAccountLine(source.account || null);
    $("auto-mode-label").textContent = mode.toUpperCase();
    $("auto-hero").dataset.dir = mode === "click" ? "CALL" : mode === "alerts" ? "WAIT" : "PUT";
    $("auto-reason").textContent = autoState.armed
      ? (mode === "click"
        ? "Execution ARMED — broker-confirmed orders on qualifying signals."
        : mode === "alerts"
          ? "Alerts ARMED — will beep & notify on qualifying signals."
          : "Mode is off but auto is armed. Pick alerts or click.")
      : "Auto-trade is off. Pick a mode and arm it.";
    $("trades-today").textContent = String(autoState.tradesToday || 0);
    $("trades-hour").textContent = String(autoState.tradesHour || 0);
    const pnl = finite(autoState.dailyPnl, 0);
    $("daily-pnl").textContent = (pnl > 0 ? "+" : "") + pnl.toFixed(2);
    $("daily-pnl").className = pnl > 0 ? "win" : pnl < 0 ? "loss" : "";
    if (autoState.lastTrade) {
      const lastStrat = strategyLabel(autoState.lastTrade.strategy, autoState.lastTrade.strategyLabel);
      $("last-trade").textContent =
        autoState.lastTrade.dir + " " + (autoState.lastTrade.asset || "") +
        (lastStrat ? " · " + lastStrat : "") + " · " +
        fmtClock(autoState.lastTrade.entryTime || autoState.lastTrade.at) + " → " +
        fmtClock(autoState.lastTrade.expiryTime) + " UTC";
    } else {
      $("last-trade").textContent = "—";
    }

    const armBtn = $("arm-btn");
    if (armBtn) {
      armBtn.classList.toggle("armed", !!autoState.armed);
      armBtn.textContent = autoState.armed ? "DISARM AUTO" : "ARM AUTO";
    }

    const pill = $("auto-state");
    if (pill) {
      pill.textContent = autoState.armed ? "Armed · " + mode : "Auto " + mode;
      pill.className = "pill " + (autoState.armed ? (mode === "click" ? "warn" : "ok") : "dim");
    }
  }

  function paintQuotexPill() {
    const pill = $("quotex-state");
    if (!pill) return;
    const s = qxStatus || {};
    const state = s.state || "idle";
    let label = "Quotex · " + state;
    let cls = "pill ";
    if (state === "authenticated" || state === "open" || state === "connected" || state === "adapter_loaded") {
      cls += "ok"; label = "Quotex · live";
    } else if (state === "auth_error" || state === "error" || state === "closed" || state === "disconnected") {
      cls += "warn"; label = "Quotex · " + state;
    } else if (state === "fallback") {
      cls += "warn"; label = "Quotex · fallback";
    } else {
      cls += "dim";
    }
    // A broker-side order rejection stays visible for 60s so the real reason
    // is never hidden behind a generic "confirmation timeout" in the log.
    if (lastOrderError && Date.now() - lastOrderError.at <= 60000) {
      cls = "pill warn";
      label = "Quotex · order rejected";
      pill.title = lastOrderError.error;
    } else {
      pill.title = "";
    }
    pill.className = cls;
    pill.textContent = label;
  }

  function refreshInstrumentsTab() {
    if (!QUOTEX) return;
    const filter = ($("qx-filter").value || "").toUpperCase();
    const kind = $("qx-kind").value;
    const openOnly = $("qx-open-only").checked;

    const list = qxInstruments.slice();
    const filtered = list.filter((it) => {
      if (filter) {
        const hay = ((it.symbol || "") + " " + (it.name || "")).toUpperCase();
        if (hay.indexOf(filter) === -1) return false;
      }
      if (kind === "otc") {
        if (!it.isOtc) return false;
      } else if (kind !== "all") {
        if ((it.type || "").toLowerCase() !== kind) return false;
      }
      if (openOnly && !it.isOpen) return false;
      return true;
    });

    const counts = list.reduce((acc, it) => {
      if (it.isOpen) acc.open += 1;
      if (it.isOtc) acc.otc += 1;
      return acc;
    }, { open: 0, otc: 0 });
    $("qx-instr-count").textContent = String(list.length);
    $("qx-open-count").textContent = String(counts.open);
    $("qx-otc-count").textContent = String(counts.otc);
    const balanceValue = qxBalance ? finite(qxBalance.balance, null) : null;
    $("qx-balance").textContent = balanceValue != null
      ? balanceValue.toFixed(2) + (qxBalance.currency ? " " + qxBalance.currency : "")
      : "—";

    const hero = $("qx-conn");
    const heroReason = $("qx-conn-reason");
    if (hero) {
      const state = (qxStatus && qxStatus.state) || "idle";
      hero.textContent = state.toUpperCase();
      hero.dataset.dir = state === "authenticated" || state === "open" ? "CALL" : (state === "fallback" || state === "disconnected" || state === "auth_error" ? "PUT" : "WAIT");
    }
    if (heroReason) {
      const summary = list.length
        ? list.length + " instruments detected from the live platform feed."
        : "No instruments yet. Load a Quotex trade page to populate this tab.";
      heroReason.textContent = summary;
    }

    const tb = $("qx-instr-table").querySelector("tbody");
    tb.innerHTML = "";
    filtered.sort((a, b) => (b.payout || 0) - (a.payout || 0));
    for (const it of filtered.slice(0, 500)) {
      const tr = document.createElement("tr");
      tr.className = "clickable";
      const tfs = (it.timeframes || []).map((t) => QUOTEX.KNOWN_TIMEFRAMES[t] || t + "s").slice(0, 6).join(", ");
      tr.innerHTML =
        "<td><strong>" + esc(it.symbol || "—") + "</strong></td>" +
        "<td>" + esc(it.name || "—") + "</td>" +
        "<td>" + esc(it.type || "—") + "</td>" +
        "<td>" + (finite(it.payout, null) != null ? esc(finite(it.payout, 0)) + "%" : "—") + "</td>" +
        "<td>" + esc(tfs || "—") + "</td>" +
        "<td class='" + (it.isOpen ? "win" : "loss") + "'>" + (it.isOpen ? "OPEN" : "closed") + "</td>" +
        "<td><button type='button' class='arm-btn tiny'>Select</button></td>";

      const selectInstrument = () => {
        const canonical = it.id || it.symbol;
        selectAsset(canonical);
        activateTab("live");
      };
      const btn = tr.querySelector("button");
      if (btn) btn.addEventListener("click", (e) => { e.stopPropagation(); selectInstrument(); });
      tr.addEventListener("click", selectInstrument);
      tb.appendChild(tr);
    }

    const ol = $("qx-orders");
    if (ol) {
      ol.innerHTML = "";
      for (const o of qxOrders.slice(0, 20)) {
        const li = document.createElement("li");
        const data = o.data || {};
        const won = data.win === true;
        const lost = data.loss === true;
        const orderText = (data.dir || data.direction || "") + " · " + (data.asset || "—") + " · " +
          (data.amount != null ? data.amount + "$" : "") + " · " +
          (data.profit != null ? (Number(data.profit) > 0 ? "+" : "") + data.profit + "$" : "") +
          "\nEntry " + fmtTime(data.openTime) + " @ " + fmtPx(data.openPrice) +
          " · Expiry " + fmtTime(data.expiryTime != null ? data.expiryTime : data.closeTime) +
          (data.status === "CLOSED" ? " · Exit " + fmtTime(data.closeTime) + " @ " + fmtPx(data.closePrice) : "");
        li.innerHTML =
          '<span class="' + (won ? "win" : lost ? "loss" : "") + '">' + esc(String(o.kind || "order").toUpperCase()) + '</span>' +
          '<span class="meta">' + esc(orderText).replace("\n", "<br>") + '</span>';
        ol.appendChild(li);
      }
    }
  }

  function bindInstrumentsTab() {
    let filterTimer = null;
    const filter = $("qx-filter");
    if (filter) filter.addEventListener("input", () => {
      if (filterTimer) clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        filterTimer = null;
        if (activeTab === "instruments") refreshInstrumentsTab();
      }, 100);
    });
    for (const id of ["qx-kind", "qx-open-only"]) {
      const el = $(id);
      if (el) el.addEventListener("change", () => {
        if (activeTab === "instruments") refreshInstrumentsTab();
      });
    }
  }

  function appendAutoLog(entry) {
    const ul = $("auto-log");
    if (!ul) return;
    const at = finite(entry && entry.at, Date.now());
    const key = String(entry && entry.level || "") + "|" + String(entry && entry.msg || "") + "|" + Math.floor(at / 1000);
    if (recentAutoLogKeys.has(key)) return;
    recentAutoLogKeys.add(key);
    recentAutoLogOrder.push(key);
    while (recentAutoLogOrder.length > 100) recentAutoLogKeys.delete(recentAutoLogOrder.shift());
    const li = document.createElement("li");
    const cls = entry.level === "trade" || entry.level === "alert" ? "win"
      : entry.level === "error" ? "loss" : "";
    li.innerHTML =
      '<span class="' + cls + '">' + esc(String(entry.level || "log").toUpperCase()) + '</span>' +
      '<span class="meta">' + esc(fmtTime(entry.at)) + '</span>' +
      '<span>' + esc(entry.msg || "") + '</span>';
    ul.prepend(li);
    while (ul.children.length > 50) ul.removeChild(ul.lastChild);
  }

  function bindAutoTab() {
    const setSettings = (patch) => STORE.setSettings(patch).then((s) => {
      settings = s;
      return s;
    });
    $("auto-mode").addEventListener("change", (e) => {
      const mode = e.target.value;
      const update = hasChrome
        ? chrome.runtime.sendMessage({ type: "CYBER_SET_AUTO", mode, armed: false }).then((r) => {
          if (!r || !r.ok) throw new Error(r && r.error || "automation update failed");
          return STORE.getSettings();
        })
        : setSettings({ autoMode: mode, armed: false });
      update.then((s) => {
        settings = s;
        if (!hasChrome) updateAutoUI(Object.assign({}, autoState, { mode: s.autoMode, armed: false }));
      }).catch(() => {
        e.target.value = (settings && settings.autoMode) || "off";
      });
    });
    const bindNumberSetting = (id, key) => {
      const el = $(id);
      el.addEventListener("change", () => {
        const patch = { [key]: Number(el.value) };
        setSettings(patch).then((saved) => { el.value = saved[key]; }).catch(() => {
          if (settings && settings[key] != null) el.value = settings[key];
        });
      });
    };
    bindNumberSetting("min-confidence", "minConfidence");
    bindNumberSetting("stake", "stake");
    bindNumberSetting("expiry", "expiry");
    bindNumberSetting("adaptive-expiry-min", "adaptiveExpiryMin");
    bindNumberSetting("adaptive-expiry-max", "adaptiveExpiryMax");
    bindNumberSetting("max-hour", "maxTradesPerHour");
    bindNumberSetting("max-day", "maxTradesPerDay");
    bindNumberSetting("loss-cap", "dailyLossCap");
    bindNumberSetting("profit-cap", "dailyProfitCap");
    bindNumberSetting("cooldown", "cooldownBars");
    bindNumberSetting("stake-percent", "stakePercent");
    bindNumberSetting("min-balance", "minBalance");
    for (const pair of [["account-mode", "accountMode"], ["stake-mode", "stakeMode"], ["expiry-mode", "expiryMode"]]) {
      const el = $(pair[0]);
      if (!el) continue;
      el.addEventListener("change", () => {
        setSettings({ [pair[1]]: el.value }).then((saved) => {
          el.value = saved[pair[1]];
          // toggle fixed expiry input disabled state
          if (pair[0] === "expiry-mode") {
            const fixedEl = $("expiry");
            const minEl = $("adaptive-expiry-min");
            const maxEl = $("adaptive-expiry-max");
            if (fixedEl) fixedEl.disabled = saved.expiryMode === "adaptive";
            if (minEl) minEl.disabled = saved.expiryMode !== "adaptive";
            if (maxEl) maxEl.disabled = saved.expiryMode !== "adaptive";
          }
        }).catch(() => {});
      });
    }
    const bindBooleanSetting = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", () => {
        setSettings({ [key]: el.checked }).then((saved) => { el.checked = !!saved[key]; }).catch(() => {
          el.checked = !!(settings && settings[key]);
        });
      });
    };
    bindBooleanSetting("notify-sound", "notifySound");
    bindBooleanSetting("notify-desktop", "notifyDesktop");
    bindBooleanSetting("auto-high-accuracy", "autoHighAccuracy");

    let armPending = false;
    $("arm-btn").addEventListener("click", () => {
      if (armPending) return;
      const cur = settings && settings.armed;
      const mode = (settings && settings.autoMode) || "off";
      const next = mode !== "off" && !cur;
      armPending = true;
      const update = hasChrome
        ? chrome.runtime.sendMessage({ type: "CYBER_SET_AUTO", mode, armed: next }).then((r) => {
          if (!r || !r.ok) throw new Error(r && r.error || "arming failed");
          return STORE.getSettings();
        })
        : setSettings({ armed: next });
      update.then((s) => {
        settings = s;
        if (!hasChrome) updateAutoUI(Object.assign({}, autoState, { armed: s.armed }));
      }).catch(() => {
        if (next) setSettings({ armed: false }).catch(() => {});
      }).finally(() => { armPending = false; });
    });
    $("test-sound").addEventListener("click", () => AUTO.playBeep("CALL"));
  }

  function loadAutoSettings() {
    STORE.getSettings().then((s) => {
      settings = s;
      $("auto-mode").value = s.autoMode || "off";
      $("min-confidence").value = s.minConfidence != null ? s.minConfidence : 65;
      $("stake").value = s.stake != null ? s.stake : 1;
      $("expiry").value = s.expiry != null ? s.expiry : 3;
      if ($("expiry-mode")) $("expiry-mode").value = s.expiryMode === "fixed" ? "fixed" : "adaptive";
      if ($("adaptive-expiry-min")) $("adaptive-expiry-min").value = s.adaptiveExpiryMin != null ? s.adaptiveExpiryMin : 1;
      if ($("adaptive-expiry-max")) $("adaptive-expiry-max").value = s.adaptiveExpiryMax != null ? s.adaptiveExpiryMax : 5;
      const isAdaptive = s.expiryMode !== "fixed";
      if ($("expiry")) $("expiry").disabled = isAdaptive;
      if ($("adaptive-expiry-min")) $("adaptive-expiry-min").disabled = !isAdaptive;
      if ($("adaptive-expiry-max")) $("adaptive-expiry-max").disabled = !isAdaptive;
      $("max-hour").value = s.maxTradesPerHour != null ? s.maxTradesPerHour : 12;
      $("max-day").value = s.maxTradesPerDay != null ? s.maxTradesPerDay : 60;
      $("loss-cap").value = s.dailyLossCap != null ? s.dailyLossCap : 30;
      $("profit-cap").value = s.dailyProfitCap != null ? s.dailyProfitCap : 0;
      $("cooldown").value = s.cooldownBars != null ? s.cooldownBars : 2;
      $("account-mode").value = s.accountMode === "live" || s.accountMode === "any" ? s.accountMode : "demo";
      $("stake-mode").value = s.stakeMode === "percent" ? "percent" : "fixed";
      $("stake-percent").value = s.stakePercent != null ? s.stakePercent : 1;
      $("min-balance").value = s.minBalance != null ? s.minBalance : 0;
      $("notify-sound").checked = s.notifySound !== false;
      $("notify-desktop").checked = !!s.notifyDesktop;
      if ($("auto-high-accuracy")) $("auto-high-accuracy").checked = s.autoHighAccuracy !== false;
      if ($("set-auto-high-accuracy")) $("set-auto-high-accuracy").checked = s.autoHighAccuracy !== false;
      activeStrategy = STRAT.get(s.strategy) ? s.strategy : "auto_adaptive";
      const sel = $("strategy-select");
      if (sel) sel.value = activeStrategy;
    });
  }

  /* ---------- backtest tab (v2.9 improved) ---------- */
  let btWalkResults = null;
  let btMonteResults = null;
  let btAllTrades = [];

  function drawEquityWithDrawdown(canvas, equity) {
    const CH = self.CYBER_CHARTS || null;
    if (CH && CH.drawEquityChart) {
      // Try to pass trades if available
      const trades = (typeof btAllTrades !== "undefined" && btAllTrades) ? btAllTrades : null;
      CH.drawEquityChart(canvas, equity, { trades });
      return;
    }
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(180, Math.min(4096, (parent && parent.clientWidth) || window.innerWidth || 800));
    const priceH = Math.max(120, Math.round(w * 0.26));
    const ddH = Math.max(40, Math.round(w * 0.08));
    const timeAxisH = 18;
    const h = priceH + ddH + timeAxisH + 12;
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio) || 1));
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c1422";
    ctx.fillRect(0, 0, w, h);
    if (!Array.isArray(equity) || equity.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No equity data — run backtest first", w/2, h/2);
      return;
    }
    const eq = equity.filter(e => e && Number.isFinite(e.equity));
    if (eq.length < 2) return;
    let lo = Infinity, hi = -Infinity, maxDD = 0;
    for (const e of eq) {
      if (e.equity < lo) lo = e.equity;
      if (e.equity > hi) hi = e.equity;
      if (Number.isFinite(e.drawdown) && e.drawdown > maxDD) maxDD = e.drawdown;
    }
    const pad = (hi - lo) * 0.1 || 1;
    lo -= pad; hi += pad;
    if (maxDD < 0.1) maxDD = 1;
    const yEq = (v) => priceH - ((v - lo) / (hi - lo)) * (priceH - 16) - 8;
    const yDD = (v) => priceH + 8 + ddH - (v / maxDD) * (ddH - 8) - 4;
    const xFor = (i) => 8 + (i / (eq.length - 1)) * (w - 16);
    const zeroY = yEq(0);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
    ctx.strokeStyle = "#4aa3ff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < eq.length; i++) {
      const x = xFor(i), y = yEq(eq[i].equity);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const grad = ctx.createLinearGradient(0, 0, 0, priceH);
    grad.addColorStop(0, "rgba(74,163,255,0.3)");
    grad.addColorStop(1, "rgba(74,163,255,0)");
    ctx.fillStyle = grad;
    ctx.lineTo(w - 8, priceH - 8);
    ctx.lineTo(8, priceH - 8);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "rgba(255,93,122,0.25)";
    ctx.beginPath();
    ctx.moveTo(xFor(0), yDD(0));
    for (let i = 0; i < eq.length; i++) {
      ctx.lineTo(xFor(i), yDD(eq[i].drawdown || 0));
    }
    ctx.lineTo(xFor(eq.length-1), yDD(0));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,93,122,0.6)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i < eq.length; i++) {
      const x = xFor(i), y = yDD(eq[i].drawdown || 0);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("Equity · " + eq.length + " pts · P&L " + eq[eq.length-1].equity.toFixed(2) + " · MaxDD " + maxDD.toFixed(2), 8, 12);
    ctx.fillText("Drawdown", 8, priceH + 16);
  }

  function runBacktest(isWalkForward) {
    const rawDays = Number($("bt-days").value);
    const rawHorizon = Number($("bt-horizon").value);
    const rawMinConf = Number($("bt-minconf").value);
    const rawPayout = Number($("bt-payout") ? $("bt-payout").value : 85);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(60, Math.floor(rawDays))) : 7;
    const horizon = Number.isFinite(rawHorizon) ? Math.max(0.5, Math.min(60, rawHorizon)) : 3;
    const minConf = Number.isFinite(rawMinConf) ? Math.max(0, Math.min(100, rawMinConf)) : 0;
    const payoutPct = Number.isFinite(rawPayout) ? Math.max(0, Math.min(200, rawPayout)) : 85;
    const payout = payoutPct / 100;
    const useAdaptive = $("bt-adaptive") ? $("bt-adaptive").checked : false;
    const kind = $("bt-kinds").value;
    const kinds = kind === "all" ? null : [kind];

    // Build payout map from live instruments if available
    const payoutByAsset = Object.create(null);
    if (qxInstruments && qxInstruments.length) {
      for (const it of qxInstruments) {
        if (!it || !it.symbol || !it.id) continue;
        const p = Number(it.payout);
        if (Number.isFinite(p) && p > 0) {
          const norm = p > 1 ? p / 100 : p;
          payoutByAsset[it.id] = norm;
          payoutByAsset[it.symbol] = norm;
        }
      }
    }

    const o = {
      days, horizon, minConf, kinds, minBars: 50,
      payout, payoutByAsset, useAdaptiveExpiry: useAdaptive,
      adaptiveExpiryMin: settings && settings.adaptiveExpiryMin ? settings.adaptiveExpiryMin : 1,
      adaptiveExpiryMax: settings && settings.adaptiveExpiryMax ? settings.adaptiveExpiryMax : 5,
    };

    const btn = isWalkForward ? $("bt-walk") : $("bt-run");
    if (!btn) return;
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Loading Quotex candles…";

    function tick(progress) {
      const i = progress && typeof progress === "object" ? progress.i : progress;
      const n = progress && typeof progress === "object" ? progress.total : 0;
      if (n) btn.textContent = (isWalkForward ? "Walk-Forward " : "Backtest ") + i + " / " + n + "…";
    }

    const assetPool = ASSETS.list().filter((a) => !kinds || kinds.some((kindName) =>
      typeof ASSETS.matchesKind === "function" ? ASSETS.matchesKind(a, kindName) : a.kind === kindName)).slice(0, 256);
    const minNeeded = Math.max(40, 50 + Math.ceil(horizon) + 1);

    const nudgeHistory = () => {
      if (!hasChrome) return Promise.resolve(true);
      return chrome.runtime.sendMessage({ type: "CYBER_REQUEST_HISTORY", limit: 5000, allTimeframes: true })
        .then((response) => {
          if (!response || !response.ok) throw new Error((response && response.error) || "history request failed");
          return true;
        });
    };
    const seedProbe = nudgeHistory().catch(() => false);

    const readLiveRows = () => STORE.load().then((snapshot) => {
      const storedByAsset = snapshot && snapshot.candles && typeof snapshot.candles === "object" ? snapshot.candles : {};
      return assetPool.map((a) => {
        const stored = storedByAsset[a.id];
        const immediate = liveCandlesByAsset[a.id];
        const storedBars = Array.isArray(stored) ? stored : [];
        const immediateBars = Array.isArray(immediate) ? immediate : [];
        return { asset: a, bars: immediateBars.length > storedBars.length ? immediateBars : storedBars };
      });
    }).catch(() => assetPool.map((a) => ({
      asset: a,
      bars: Array.isArray(liveCandlesByAsset[a.id]) ? liveCandlesByAsset[a.id] : [],
    })));

    const waitForLiveRows = async () => {
      const deadline = Date.now() + 5000;
      let rows = await readLiveRows();
      while (!rows.some((row) => Array.isArray(row.bars) && row.bars.length >= minNeeded) && Date.now() < deadline) {
        const secondsLeft = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        const bestBars = rows.reduce((m, r) => Math.max(m, Array.isArray(r.bars) ? r.bars.length : 0), 0);
        btn.textContent = "Waiting candles… " + bestBars + "/" + minNeeded + " (" + secondsLeft + "s)";
        await new Promise((resolve) => setTimeout(resolve, 400));
        rows = await readLiveRows();
      }
      return rows;
    };

    const loadLiveCache = seedProbe.then(waitForLiveRows).then((rows) => {
      const cachedByAsset = Object.create(null);
      rows.forEach((row) => {
        const bars = Array.isArray(row.bars) ? row.bars : [];
        if (bars.length >= minNeeded) cachedByAsset[row.asset.id] = bars;
      });
      const minutes = days * 24 * 60;
      btDataByAsset = Object.create(null);
      for (const a of assetPool) {
        const bars = cachedByAsset[a.id];
        btDataByAsset[a.id] = !Array.isArray(bars) || !bars.length ? "sim"
          : bars.length >= minutes ? "live" : "live+sim";
      }
      o.assets = assetPool;
      o.cachedByAsset = cachedByAsset;
      o.onProgress = tick;
      const useWorkers = WORKERS && WORKERS.runBrowser;
      return useWorkers ? WORKERS.runBrowser(o)
        : new Promise((resolve, reject) => setTimeout(() => {
          try { resolve(HIST.runMatrix(o)); } catch (e) { reject(e); }
        }, 30));
    });

    loadLiveCache.then((r) => {
      btResults = r;
      if (isWalkForward) {
        // For walk-forward, we need to run WF per asset? We'll aggregate first asset's WF as demo
        // Actually run walk-forward on combined series of best asset or first with live data
        runWalkForwardAnalysis(o);
      } else {
        paintBacktest(r, o);
      }
    }).catch((e) => {
      const message = String(e && e.message || e || "Backtest failed");
      const failure = { results: [], count: 0, error: message };
      btResults = failure;
      paintBacktest(failure, o);
      const body = $("bt-assets") && $("bt-assets").querySelector("tbody");
      if (body) body.innerHTML = "<tr><td colspan='8'>" + esc(message) + "</td></tr>";
      console.error(e);
    }).then(() => {
      btn.disabled = false;
      btn.textContent = origLabel;
    });
  }

  function runWalkForwardAnalysis(opts) {
    // Walk-forward on the active asset's live candles for detailed view
    const active = ASSETS.get(activeAsset) || ASSETS.list()[0];
    if (!active) return;
    const cached = btDataByAsset && btDataByAsset[active.id] !== "sim" && liveCandlesByAsset[active.id] ? liveCandlesByAsset[active.id] : null;
    let series = null;
    if (HIST && HIST.getSeries) {
      series = HIST.getSeries(active, { days: opts.days, cachedByAsset: opts.cachedByAsset });
    }
    if (!series || series.length < 400) {
      // fallback to first asset with enough data
      const pool = ASSETS.list();
      for (const a of pool) {
        if (liveCandlesByAsset[a.id] && liveCandlesByAsset[a.id].length >= 400) {
          series = liveCandlesByAsset[a.id];
          break;
        }
      }
    }
    if (!series || series.length < 400) {
      const body = $("bt-walk-table") && $("bt-walk-table").querySelector("tbody");
      if (body) body.innerHTML = "<tr><td colspan='8'>Need at least 400 candles for walk-forward — open Quotex to cache live data</td></tr>";
      return;
    }
    try {
      const wf = ENG.walkForward(series, {
        strategy: activeStrategy || "auto_adaptive",
        horizon: opts.horizon, minConf: opts.minConf, payout: opts.payout,
        useAdaptiveExpiry: opts.useAdaptiveExpiry, folds: 5,
      });
      btWalkResults = wf;
      paintWalkForward(wf);
      activateBtTab("walk");
    } catch (e) {
      console.error("walkForward failed", e);
    }
  }

  function runMonteCarloAnalysis() {
    if (!btResults || !btResults.results || !btResults.results.length) {
      alert("Run backtest first to generate trades for Monte Carlo");
      return;
    }
    // Collect all trades from results
    const allTrades = [];
    for (const r of btResults.results) {
      if (r.trades && Array.isArray(r.trades)) {
        for (const t of r.trades) allTrades.push(t);
      } else if (r.equity && r.equity.length) {
        // synthesize from equity diff
      }
    }
    // If no detailed trades, use aggregated pnl series
    let tradesForMC = allTrades;
    if (tradesForMC.length < 10) {
      // Build from equity curve
      const seq = [];
      let prev = 0;
      for (const r of btResults.results.slice(0, 50)) {
        const pnl = Number(r.pnlWithPayout != null ? r.pnlWithPayout : r.pnl) || 0;
        const t = Number(r.total) || 1;
        const avg = t ? pnl / t : 0;
        for (let i = 0; i < Math.min(t, 20); i++) seq.push({ pnlPayout: avg });
      }
      tradesForMC = seq;
    }
    if (tradesForMC.length < 10) {
      alert("Not enough trades for Monte Carlo — need at least 10");
      return;
    }
    try {
      const mc = ENG.monteCarlo(tradesForMC, { sims: 1000 });
      btMonteResults = mc;
      paintMonteCarlo(mc);
      activateBtTab("monte");
    } catch (e) {
      console.error("monteCarlo failed", e);
    }
  }

  function paintWalkForward(wf) {
    if (!wf || wf.error) {
      const body = $("bt-walk-table") && $("bt-walk-table").querySelector("tbody");
      if (body) body.innerHTML = "<tr><td colspan='8'>" + esc(wf && wf.error || "Walk-forward failed") + "</td></tr>";
      return;
    }
    const body = $("bt-walk-table") && $("bt-walk-table").querySelector("tbody");
    if (!body) return;
    body.innerHTML = "";
    for (const f of wf.folds) {
      const tr = document.createElement("tr");
      const testWR = f.test.winrate || 0;
      const cls = testWR >= 55 ? "win" : testWR <= 45 ? "loss" : "";
      tr.innerHTML = "<td>" + f.fold + "</td>" +
        "<td>" + fmtPct(f.train.winrate) + "</td>" +
        "<td>" + (Number(f.train.pnl)||0).toFixed(2) + "</td>" +
        "<td class='" + cls + "'>" + fmtPct(f.test.winrate) + "</td>" +
        "<td>" + (Number(f.test.pnl)||0).toFixed(2) + "</td>" +
        "<td>" + (Number(f.test.profitFactor)||0).toFixed(2) + "</td>" +
        "<td>" + (Number(f.test.expectedValue)||0).toFixed(1) + "%</td>" +
        "<td>" + (Number(f.test.sharpe)||0).toFixed(2) + "</td>";
      body.appendChild(tr);
    }
    if ($("bt-walk-wr")) $("bt-walk-wr").textContent = fmtPct(wf.combined.winrate);
    if ($("bt-walk-pnl")) $("bt-walk-pnl").textContent = (wf.combined.pnl||0).toFixed(2);
    if ($("bt-walk-avg")) $("bt-walk-avg").textContent = fmtPct(wf.combined.avgWinrate);
    if ($("bt-walk-cons")) $("bt-walk-cons").textContent = fmtPct(wf.combined.consistency);
  }

  function paintMonteCarlo(mc) {
    if (!mc || mc.error) return;
    if ($("bt-monte-avg")) $("bt-monte-avg").textContent = (mc.avgPnL||0).toFixed(2);
    if ($("bt-monte-median")) $("bt-monte-median").textContent = (mc.median && mc.median.finalPnL || 0).toFixed(2);
    if ($("bt-monte-p5")) $("bt-monte-p5").textContent = (mc.p5 && mc.p5.finalPnL || 0).toFixed(2);
    if ($("bt-monte-p95")) $("bt-monte-p95").textContent = (mc.p95 && mc.p95.finalPnL || 0).toFixed(2);
    if ($("bt-monte-pos")) $("bt-monte-pos").textContent = fmtPct(mc.positiveRate);
    if ($("bt-monte-dd")) $("bt-monte-dd").textContent = (mc.avgDD||0).toFixed(2);

    // Draw distribution via enhanced library
    const canvas = $("bt-monte-chart");
    if (!canvas) return;
    const CH = self.CYBER_CHARTS || null;
    if (CH && CH.drawMonteCarloChart) {
      CH.drawMonteCarloChart(canvas, mc.results, {});
    } else {
      // fallback simple
      const w = Math.max(180, Math.min(4096, (canvas.parentElement && canvas.parentElement.clientWidth) || 800));
      const h = Math.max(120, Math.round(w * 0.22));
      const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0,0,w,h);
      ctx.fillStyle = "#0c1422";
      ctx.fillRect(0,0,w,h);
      const vals = mc.results.map(r=>r.finalPnL).sort((a,b)=>a-b);
      const lo = vals[0], hi = vals[vals.length-1];
      const range = hi - lo || 1;
      const bins = 40;
      const counts = new Array(bins).fill(0);
      for (const v of vals) {
        const idx = Math.min(bins-1, Math.max(0, Math.floor((v - lo)/range * bins)));
        counts[idx]++;
      }
      const maxC = Math.max(...counts) || 1;
      const padL = 40, padR = 10, padT = 10, padB = 20;
      const plotW = w - padL - padR, plotH = h - padT - padB;
      ctx.fillStyle = "rgba(74,163,255,0.6)";
      for (let i = 0; i < bins; i++) {
        const x = padL + (i / bins) * plotW;
        const bw = plotW / bins * 0.8;
        const bh = (counts[i] / maxC) * plotH;
        ctx.fillRect(x, padT + plotH - bh, bw, bh);
      }
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(lo.toFixed(1), padL, h - 2);
      ctx.fillText(hi.toFixed(1), padL + plotW, h - 2);
      ctx.textAlign = "left";
      ctx.fillText("P&L distribution (" + mc.simulations + " sims)", 8, 12);
    }
  }

  function activateBtTab(name) {
    const panes = document.querySelectorAll(".bt-pane");
    panes.forEach(p => {
      p.style.display = p.dataset.btPane === name ? "block" : "none";
      p.classList.toggle("active", p.dataset.btPane === name);
    });
    const tabs = document.querySelectorAll("[data-bt-tab]");
    tabs.forEach(t => t.classList.toggle("active", t.dataset.btTab === name));
  }

  function paintBacktest(matrix, opts) {
    matrix = matrix && Array.isArray(matrix.results) ? matrix : { results: [] };
    const sum = HIST.summarize(matrix) || {
      trades: 0, winrate: 0, pnl: 0, pnlWithPayout: 0, expectedValue: 0,
      byStrategy: {}, byKind: {}, byRegime: {},
    };
    $("bt-trades").textContent = String(sum.trades || 0);
    $("bt-winrate").textContent = fmtPct(sum && sum.winrate);
    if ($("bt-ev")) $("bt-ev").textContent = sum.expectedValue != null ? sum.expectedValue.toFixed(1) + "%" : "—";
    $("bt-pnl").textContent = sum.pnlWithPayout != null ? sum.pnlWithPayout.toFixed(2) : (sum.pnl != null ? String(sum.pnl) : "—");
    if ($("bt-pf")) $("bt-pf").textContent = sum.avgProfitFactor != null ? sum.avgProfitFactor.toFixed(2) : "—";
    const maxDrawdown = finite(sum && sum.maxDrawdown, null);
    $("bt-dd").textContent = maxDrawdown == null ? "—" : maxDrawdown.toFixed(2);
    if ($("bt-sharpe")) $("bt-sharpe").textContent = sum.avgSharpe != null ? sum.avgSharpe.toFixed(2) : "—";
    if ($("bt-recovery")) {
      const rec = sum.trades ? (sum.pnlWithPayout || sum.pnl || 0) / (maxDrawdown || 1) : 0;
      $("bt-recovery").textContent = Number.isFinite(rec) ? rec.toFixed(2) : "—";
    }
    if ($("bt-kelly")) {
      const wr = sum.winrate || 0;
      const p = wr / 100, q = 1 - p, b = (opts && opts.payout) || 0.85;
      const kelly = b > 0 ? (p - q / b) * 100 : 0;
      $("bt-kelly").textContent = kelly.toFixed(1) + "%";
    }
    if ($("bt-exposure")) {
      // exposure from avg of results
      const totalBars = opts.days * 24 * 60;
      const exp = totalBars ? (sum.trades / (totalBars * (sum.assets || 1))) * 100 : 0;
      $("bt-exposure").textContent = exp.toFixed(1) + "%";
    }

    // Equity curve: aggregate all trades sorted by time if available, else by results order
    let allEquity = [];
    let running = 0;
    const allTradesFlat = [];
    for (const r of matrix.results) {
      if (r.equity && r.equity.length) {
        // equity already has pnlWithPayout progression per result, but we need combined
      }
      if (r.trades && Array.isArray(r.trades)) {
        for (const t of r.trades) allTradesFlat.push(t);
      }
    }
    // Sort trades by entryTime if available
    allTradesFlat.sort((a,b) => (a.entryTime||0) - (b.entryTime||0));
    btAllTrades = allTradesFlat.slice(-500);
    let eqPeak = -Infinity;
    for (let i = 0; i < allTradesFlat.length; i++) {
      const t = allTradesFlat[i];
      running += Number(t.pnlPayout != null ? t.pnlPayout : t.pnl) || 0;
      if (running > eqPeak) eqPeak = running;
      allEquity.push({ equity: running, drawdown: eqPeak - running, time: t.entryTime, i });
    }
    if (allEquity.length < 2) {
      // fallback to per-result pnl aggregation
      running = 0;
      allEquity = [{ equity: 0, drawdown: 0 }];
      for (const r of matrix.results.slice(0, 2000)) {
        running += finite(r && (r.pnlWithPayout != null ? r.pnlWithPayout : r.pnl), 0);
        const dd = allEquity.length ? Math.max(0, allEquity[allEquity.length-1].equity - running) : 0;
        allEquity.push({ equity: running, drawdown: 0 });
      }
    }
    lastBtEquity = matrix.error ? null : allEquity;
    if (matrix.error) {
      drawChart($("bt-equity"), [], { emptyMessage: "No genuine Quotex history — see status below." });
    } else {
      drawEquityWithDrawdown($("bt-equity"), allEquity);
    }

    // Per-strategy sorted by EV
    const stBody = $("bt-strategies") ? $("bt-strategies").querySelector("tbody") : null;
    if (stBody) {
      stBody.innerHTML = "";
      const sortedStrat = Object.keys(sum.byStrategy).sort((a,b) => {
        const av = sum.byStrategy[a], bv = sum.byStrategy[b];
        const aEV = av.pnl != null ? av.pnl : av.winrate;
        const bEV = bv.pnl != null ? bv.pnl : bv.winrate;
        return bEV - aEV;
      });
      for (const k of sortedStrat) {
        const v = sum.byStrategy[k];
        const ev = v.total ? (v.winrate/100 * (opts.payout||0.85) - (1-v.winrate/100))*100 : 0;
        const pf = v.wins && v.losses ? (v.wins * (opts.payout||0.85)) / v.losses : (v.wins ? 99 : 0);
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(k) + "</td>" +
          "<td>" + finite(v.total,0) + "</td>" +
          "<td class='" + (v.winrate>=55?"win":v.winrate<=45?"loss":"") + "'>" + finite(v.winrate,0).toFixed(1) + "%</td>" +
          "<td class='" + (ev>0?"win":"loss") + "'>" + ev.toFixed(1) + "%</td>" +
          "<td>" + (Number.isFinite(pf)?pf.toFixed(2):"—") + "</td>" +
          "<td>—</td>" +
          "<td>" + finite(v.pnl,0).toFixed(2) + "</td>";
        stBody.appendChild(tr);
      }
    }

    // Per-asset
    const aBody = $("bt-assets") ? $("bt-assets").querySelector("tbody") : null;
    if (aBody) {
      aBody.innerHTML = "";
      const perAsset = {};
      for (const r of matrix.results) {
        if (!perAsset[r.asset]) perAsset[r.asset] = { wins: 0, losses: 0, pnl: 0, pnlPayout: 0, dd: 0, name: r.name, pf: 0, ev: 0 };
        perAsset[r.asset].wins += r.wins;
        perAsset[r.asset].losses += r.losses;
        perAsset[r.asset].pnl += Number(r.pnl)||0;
        perAsset[r.asset].pnlPayout += Number(r.pnlWithPayout != null ? r.pnlWithPayout : r.pnl)||0;
        if (r.maxDrawdown > perAsset[r.asset].dd) perAsset[r.asset].dd = r.maxDrawdown;
        if (r.profitFactor) perAsset[r.asset].pf = r.profitFactor;
        if (r.expectedValue) perAsset[r.asset].ev = r.expectedValue;
      }
      const sourceLabel = { live: "Live", "live+sim": "Live+Sim", sim: "Sim" };
      const sortedAssets = Object.keys(perAsset).sort((a,b) => perAsset[b].pnlPayout - perAsset[a].pnlPayout);
      for (const k of sortedAssets.slice(0, 100)) {
        const v = perAsset[k];
        const t = v.wins + v.losses;
        const wr = t ? (v.wins / t) * 100 : 0;
        const ev = t ? (wr/100 * (opts.payout||0.85) - (1-wr/100))*100 : 0;
        const pf = v.losses ? (v.wins * (opts.payout||0.85)) / v.losses : (v.wins ? 99 : 0);
        const source = btDataByAsset && btDataByAsset[k] ? sourceLabel[btDataByAsset[k]] || "Sim" : "—";
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(v.name || k) + "</td>" +
          "<td>" + t + "</td>" +
          "<td class='" + (wr>=55?"win":wr<=45?"loss":"") + "'>" + wr.toFixed(1) + "%</td>" +
          "<td class='" + (ev>0?"win":"loss") + "'>" + ev.toFixed(1) + "%</td>" +
          "<td>" + v.pnlPayout.toFixed(2) + "</td>" +
          "<td>" + (Number.isFinite(pf)?pf.toFixed(2):"—") + "</td>" +
          "<td>" + finite(v.dd,0).toFixed(2) + "</td>" +
          "<td>" + source + "</td>";
        aBody.appendChild(tr);
      }
    }

    // Regime breakdown
    const regBody = $("bt-regimes") ? $("bt-regimes").querySelector("tbody") : null;
    if (regBody) {
      regBody.innerHTML = "";
      const regAgg = sum.byRegime || {};
      for (const k of Object.keys(regAgg).sort((a,b) => (regAgg[b].wins + regAgg[b].losses) - (regAgg[a].wins + regAgg[a].losses))) {
        const v = regAgg[k];
        const t = v.wins + v.losses;
        const wr = t ? (v.wins / t) * 100 : 0;
        const ev = t ? (wr/100 * (opts.payout||0.85) - (1-wr/100))*100 : 0;
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(k) + "</td><td>" + t + "</td>" +
          "<td class='" + (wr>=55?"win":wr<=45?"loss":"") + "'>" + wr.toFixed(1) + "%</td>" +
          "<td class='" + (ev>0?"win":"loss") + "'>" + ev.toFixed(1) + "%</td>" +
          "<td>" + (Number(v.pnl)||0).toFixed(2) + "</td>";
        regBody.appendChild(tr);
      }
    }

    // Expiry breakdown
    const expBody = $("bt-expiry") ? $("bt-expiry").querySelector("tbody") : null;
    if (expBody) {
      expBody.innerHTML = "";
      const expAgg = {};
      for (const r of matrix.results) {
        if (!r.byExpiry) continue;
        for (const ek of Object.keys(r.byExpiry)) {
          if (!expAgg[ek]) expAgg[ek] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
          expAgg[ek].wins += r.byExpiry[ek].wins||0;
          expAgg[ek].losses += r.byExpiry[ek].losses||0;
          expAgg[ek].draws += r.byExpiry[ek].draws||0;
          expAgg[ek].pnl += r.byExpiry[ek].pnl||0;
        }
      }
      for (const k of Object.keys(expAgg).sort((a,b) => Number(a)-Number(b))) {
        const v = expAgg[k];
        const t = v.wins + v.losses;
        const wr = t ? (v.wins / t) * 100 : 0;
        const ev = t ? (wr/100 * (opts.payout||0.85) - (1-wr/100))*100 : 0;
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(k) + "m</td><td>" + t + "</td>" +
          "<td class='" + (wr>=55?"win":wr<=45?"loss":"") + "'>" + wr.toFixed(1) + "%</td>" +
          "<td class='" + (ev>0?"win":"loss") + "'>" + ev.toFixed(1) + "%</td>" +
          "<td>" + (Number(v.pnl)||0).toFixed(2) + "</td>";
        expBody.appendChild(tr);
      }
    }

    // Confidence calibration
    const calBody = $("bt-calib") ? $("bt-calib").querySelector("tbody") : null;
    if (calBody) {
      calBody.innerHTML = "";
      const calAgg = {};
      for (const r of matrix.results) {
        for (const c of (r.calibration || [])) {
          if (!calAgg[c.bucket]) calAgg[c.bucket] = { w: 0, l: 0, pnl: 0 };
          calAgg[c.bucket].w += c.wins;
          calAgg[c.bucket].l += c.losses;
          calAgg[c.bucket].pnl += (c.wins * (opts.payout||0.85) - c.losses);
        }
      }
      for (const b of Object.keys(calAgg).map(Number).sort((a,b) => a-b)) {
        const v = calAgg[b];
        const t = v.w + v.l;
        const wr = t ? (v.w / t) * 100 : 0;
        const ev = t ? (wr/100 * (opts.payout||0.85) - (1-wr/100))*100 : 0;
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + b + "%</td><td>" + t + "</td>" +
          "<td class='" + (wr>=b?"win":"loss") + "'>" + wr.toFixed(1) + "%</td>" +
          "<td class='" + (ev>0?"win":"loss") + "'>" + ev.toFixed(1) + "%</td>";
        calBody.appendChild(tr);
      }
    }

    // Hourly
    const hourBody = $("bt-hours") ? $("bt-hours").querySelector("tbody") : null;
    if (hourBody) {
      hourBody.innerHTML = "";
      const hourAgg = {};
      for (const r of matrix.results) {
        if (!r.byHour) continue;
        for (const hk of Object.keys(r.byHour)) {
          if (!hourAgg[hk]) hourAgg[hk] = { wins: 0, losses: 0, draws: 0, pnl: 0 };
          hourAgg[hk].wins += r.byHour[hk].wins||0;
          hourAgg[hk].losses += r.byHour[hk].losses||0;
          hourAgg[hk].draws += r.byHour[hk].draws||0;
          hourAgg[hk].pnl += r.byHour[hk].pnl||0;
        }
      }
      for (const hk of Object.keys(hourAgg).map(Number).sort((a,b) => a-b)) {
        const v = hourAgg[hk];
        const t = v.wins + v.losses;
        const wr = t ? (v.wins / t) * 100 : 0;
        const ev = t ? (wr/100 * (opts.payout||0.85) - (1-wr/100))*100 : 0;
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + hk + ":00 UTC</td><td>" + t + "</td>" +
          "<td class='" + (wr>=55?"win":wr<=45?"loss":"") + "'>" + wr.toFixed(1) + "%</td>" +
          "<td class='" + (ev>0?"win":"loss") + "'>" + ev.toFixed(1) + "%</td>" +
          "<td>" + (Number(v.pnl)||0).toFixed(2) + "</td>";
        hourBody.appendChild(tr);
      }
    }

    // Trade log
    const tradesBody = $("bt-trades-table") ? $("bt-trades-table").querySelector("tbody") : null;
    if (tradesBody) {
      tradesBody.innerHTML = "";
      const trades = btAllTrades.slice(-200).reverse();
      for (let idx = 0; idx < trades.length; idx++) {
        const t = trades[idx];
        const outcome = t.draw ? "DRAW" : t.won ? "WIN" : "LOSS";
        const cls = t.draw ? "" : t.won ? "win" : "loss";
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + (idx+1) + "</td>" +
          "<td>" + esc(fmtTime(t.entryTime)) + "</td>" +
          "<td>" + esc(t.asset || activeAsset || "—") + "</td>" +
          "<td class='" + cls + "'>" + esc(t.dir || "") + "</td>" +
          "<td>" + esc(fmtPx(t.entry)) + "</td>" +
          "<td>" + esc(fmtPx(t.exit)) + "</td>" +
          "<td>" + (t.priceChangePct != null ? t.priceChangePct.toFixed(3) + "%" : "—") + "</td>" +
          "<td>" + (t.confidence||0) + "%</td>" +
          "<td>" + esc(t.regime||"—") + "</td>" +
          "<td>" + (t.expiryMinutes||"—") + "m</td>" +
          "<td class='" + cls + "'>" + outcome + "</td>" +
          "<td class='" + cls + "'>" + (Number(t.pnlPayout != null ? t.pnlPayout : t.pnl)||0).toFixed(2) + "</td>";
        tradesBody.appendChild(tr);
      }
    }

    // Heatmap
    const heatmapEl = $("bt-heatmap");
    if (heatmapEl && matrix.results.length) {
      const assets = [...new Set(matrix.results.map(r=>r.asset))].slice(0, 20);
      const strats = [...new Set(matrix.results.map(r=>r.strategy))];
      let html = "<table class='table tight'><thead><tr><th>Asset\\Strategy</th>";
      for (const s of strats) html += "<th>" + esc(s.slice(0,12)) + "</th>";
      html += "</tr></thead><tbody>";
      for (const a of assets) {
        html += "<tr><td><strong>" + esc(a) + "</strong></td>";
        for (const s of strats) {
          const found = matrix.results.find(r=>r.asset===a && r.strategy===s);
          const wr = found ? found.winrate : 0;
          const bg = wr >= 60 ? "background:rgba(61,255,154,0.25)" : wr >= 50 ? "background:rgba(255,196,87,0.2)" : wr ? "background:rgba(255,93,122,0.2)" : "";
          const cls = wr >= 55 ? "win" : wr <= 45 && wr ? "loss" : "";
          html += "<td class='" + cls + "' style='" + bg + "'>" + (found ? wr.toFixed(1)+"%" : "—") + "</td>";
        }
        html += "</tr>";
      }
      html += "</tbody></table>";
      heatmapEl.innerHTML = html;
    }

    const sourcesEl = $("bt-sources");
    if (sourcesEl) {
      if (matrix.error) {
        sourcesEl.textContent = "";
      } else {
        const perAsset = {};
        for (const r of matrix.results) if (!perAsset[r.asset]) perAsset[r.asset] = true;
        const counts = { live: 0, "live+sim": 0, sim: 0 };
        for (const k of Object.keys(perAsset)) {
          if (btDataByAsset && btDataByAsset[k] && counts[btDataByAsset[k]] != null) counts[btDataByAsset[k]]++;
        }
        const covered = Object.keys(perAsset).length;
        sourcesEl.textContent = "Covered " + covered + " assets — " + counts.live + " live, " + counts["live+sim"] + " live+sim, " + counts.sim + " sim. Payout " + (opts.payout*100).toFixed(0) + "% · Horizon " + opts.horizon + "m · " + (opts.useAdaptiveExpiry ? "Adaptive expiry" : "Fixed expiry") + ". EV = WR×payout − LR. PF = gross profit / gross loss. Sharpe = mean/std. Kelly = optimal stake %.";
      }
    }
  }

  function bindBacktest() {
    // Sub-tab switching
    const btTabs = document.querySelectorAll("[data-bt-tab]");
    btTabs.forEach(btn => {
      btn.addEventListener("click", () => activateBtTab(btn.dataset.btTab));
    });

    $("bt-run").addEventListener("click", () => runBacktest(false));
    const walkBtn = $("bt-walk");
    if (walkBtn) walkBtn.addEventListener("click", () => runBacktest(true));
    const monteBtn = $("bt-monte");
    if (monteBtn) monteBtn.addEventListener("click", runMonteCarloAnalysis);

    const exportBtn = $("bt-export");
    if (exportBtn) exportBtn.addEventListener("click", () => {
      const origLabel = exportBtn.textContent;
      STORE.load().then((snapshot) => {
        const candles = snapshot && snapshot.candles && typeof snapshot.candles === "object" && !Array.isArray(snapshot.candles) ? snapshot.candles : {};
        const assets = Object.keys(candles).filter((k) => Array.isArray(candles[k]) && candles[k].length);
        const bars = assets.reduce((n, k) => n + candles[k].length, 0);
        const payload = {
          exportedAt: new Date().toISOString(),
          source: "CYBER BINARY cached live Quotex 1m candles",
          totalAssets: assets.length,
          totalBars: bars,
          candles,
        };
        const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "cyber-binary-candles-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16) + ".json";
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        exportBtn.textContent = assets.length ? "Exported " + assets.length + " assets / " + bars + " bars" : "No live cache — open Quotex first";
        setTimeout(() => { exportBtn.textContent = origLabel; }, 3000);
      }).catch(() => {
        exportBtn.textContent = "Export failed";
        setTimeout(() => { exportBtn.textContent = origLabel; }, 3000);
      });
    });

    const exportTradesBtn = $("bt-export-trades");
    if (exportTradesBtn) exportTradesBtn.addEventListener("click", () => {
      if (!btAllTrades || !btAllTrades.length) {
        exportTradesBtn.textContent = "No trades — run backtest first";
        setTimeout(() => { exportTradesBtn.textContent = "Export trades"; }, 2000);
        return;
      }
      const rows = [["time_utc","asset","dir","entry","exit","change_pct","confidence","regime","strategy","expiry_m","result","pnl","pnl_payout"]];
      for (const t of btAllTrades) {
        rows.push([
          isoTime(t.entryTime), t.asset||activeAsset, t.dir, t.entry, t.exit,
          t.priceChangePct, t.confidence, t.regime, t.selectedStrategy, t.expiryMinutes,
          t.draw ? "DRAW" : t.won ? "WIN" : "LOSS", t.pnl, t.pnlPayout
        ]);
      }
      const csv = rows.map(r => r.map(csvCell).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "cyber-binary-backtest-trades-" + new Date().toISOString().slice(0,10) + ".csv"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }



    /* ---------- history tab ---------- */
  function refreshHistoryTab() {
    const token = ++historyRenderToken;
    STORE.getStats().then((stats) => {
      if (token !== historyRenderToken || activeTab !== "history") return;
      const dir = $("hist-dir").value;
      const out = $("hist-outcome").value;
      const asset = $("hist-asset").value;
      const list = (stats.history || []).filter((h) => {
        if (dir !== "all" && h.dir !== dir) return false;
        if (out === "win" && h.won !== true) return false;
        if (out === "loss" && h.won !== false) return false;
        if (asset !== "all" && h.asset !== asset) return false;
        return true;
      });
      const w = list.filter((h) => h.won === true).length;
      const l = list.filter((h) => h.won === false).length;
      $("hist-count").textContent = list.length;
      $("hist-wins").textContent = w;
      $("hist-losses").textContent = l;
      $("hist-wr").textContent = w + l ? ((w / (w + l)) * 100).toFixed(1) + "%" : "—";
      const ul = $("hist-list");
      ul.innerHTML = "";
      for (const h of list.slice(0, 100)) {
        const li = document.createElement("li");
        const outcome = tradeOutcome(h);
        li.innerHTML =
          '<span class="' + outcome.cls + '">' + outcome.label + '</span>' +
          '<span class="meta">' + esc(h.dir || "") + " · " + esc(h.asset || "—") + " · conf " + esc(finite(h.confidence, 0)) + "% · " + esc(h.regime || "—") +
            " · " + esc(strategyLabel(h.strategy, h.strategyLabel) || "—") + "<br>" + esc(tradeTimeline(h, true)) + '</span>' +
          '<span class="' + outcome.cls + '">' + esc(fmtMoney(h.pnl)) + '</span>';
        ul.appendChild(li);
      }
    }).catch(() => {});
  }
  function bindHistoryTab() {
    $("hist-dir").addEventListener("change", refreshHistoryTab);
    $("hist-outcome").addEventListener("change", refreshHistoryTab);
    $("hist-asset").addEventListener("change", refreshHistoryTab);
    $("hist-export").addEventListener("click", () => {
      STORE.getStats().then((s) => {
        const dir = $("hist-dir").value;
        const out = $("hist-outcome").value;
        const asset = $("hist-asset").value;
        const list = (s.history || []).filter((h) => {
          if (dir !== "all" && h.dir !== dir) return false;
          if (out === "win" && h.won !== true) return false;
          if (out === "loss" && h.won !== false) return false;
          if (asset !== "all" && h.asset !== asset) return false;
          return true;
        });

        const rows = [["entry_time", "expiry_time", "exit_time", "expiry_minutes", "asset", "dir", "outcome", "won", "entry_price", "exit_price", "confidence", "regime", "strategy", "pnl"]];
        for (const h of list) {
          const entryTime = h.entryTime != null ? h.entryTime : h.at;
          const outcome = tradeOutcome(h).label;
          rows.push([
            isoTime(entryTime),
            isoTime(h.expiryTime),
            isoTime(h.exitTime),
            h.expiryMinutes,
            h.asset, h.dir,
            outcome,
            outcome === "DRAW" || outcome === "UNKNOWN" ? "" : outcome === "WIN" ? 1 : 0,
            h.entryPrice != null ? h.entryPrice : h.entry,
            h.exitPrice != null ? h.exitPrice : h.exit,
            h.confidence, h.regime, h.strategy, h.pnl,
          ]);
        }
        const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "cyber-binary-history.csv"; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    });
    $("hist-clear").addEventListener("click", () => {
      if (!confirm("Clear all history and stats?")) return;
      STORE.resetStats().then(() => refreshHistoryTab()).catch(() => {});
    });
  }

  /* ---------- assets tab ---------- */
  function refreshAssetsTab() {
    const token = ++assetsRenderToken;
    const tb = $("asset-table").querySelector("tbody");
    if (!tb) return;
    tb.innerHTML = "";
    const filterText = ($("asset-search-filter") ? $("asset-search-filter").value : "").toUpperCase();
    const highAccOnly = $("asset-high-acc-only") ? $("asset-high-acc-only").checked : false;

    STORE.getStats().then((stats) => {
      if (token !== assetsRenderToken || activeTab !== "assets") return;
      const ranked = AS ? AS.rankAssets({
        stats: stats,
        candlesByAsset: liveCandlesByAsset,
        history: stats && stats.history,
        minAccuracy: highAccOnly ? 60 : 0,
      }) : ASSETS.list().map((a) => ({
        id: a.id, name: a.name, kind: a.kind, payout: 85, winrate: 60, expectedValue: 0.11, expectedValuePct: 11, accuracyScore: 65, recommendedStrategyLabel: "Confluence", trades: 0, wins: 0, losses: 0,
      }));

      for (const item of ranked) {
        if (filterText) {
          const hay = ((item.name || "") + " " + (item.id || "")).toUpperCase();
          if (hay.indexOf(filterText) === -1) continue;
        }
        if (highAccOnly && item.expectedValue <= 0) continue;

        const tr = document.createElement("tr");
        tr.className = "clickable";
        const evCls = item.expectedValue > 0 ? "win" : "loss";
        const evTxt = (item.expectedValuePct > 0 ? "+" : "") + item.expectedValuePct + "%";

        tr.innerHTML =
          "<td><strong>" + esc(item.name) + "</strong></td>" +
          "<td>" + esc(item.kind) + "</td>" +
          "<td>" + item.payout + "%</td>" +
          "<td><span class='badge " + (item.accuracyScore >= 70 ? 'green' : 'blue') + "'>" + item.accuracyScore + " / 100</span></td>" +
          "<td class='" + evCls + "'>" + evTxt + "</td>" +
          "<td>" + esc(item.recommendedStrategyLabel) + "</td>" +
          "<td>" + item.winrate + "%</td>" +
          "<td>" + (item.trades ? item.wins + "W/" + item.losses + "L" : "—") + "</td>" +
          "<td><button type='button' class='arm-btn tiny'>Switch</button></td>";

        const btn = tr.querySelector("button");
        if (btn) {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            selectAsset(item.id);
            activateTab("live");
          });
        }
        tr.addEventListener("click", () => {
          selectAsset(item.id);
          activateTab("live");
        });
        tb.appendChild(tr);
      }
    }).catch(() => {});
  }

  function bindAssetsTab() {
    const search = $("asset-search-filter");
    if (search) {
      search.addEventListener("input", () => {
        if (activeTab === "assets") refreshAssetsTab();
      });
    }
    const accOnly = $("asset-high-acc-only");
    if (accOnly) {
      accOnly.addEventListener("change", () => {
        if (activeTab === "assets") refreshAssetsTab();
      });
    }
  }

  /* ---------- settings tab ---------- */
  function refreshSettingsTab() {
    if (!settings) return;
    $("set-calibration").checked = settings.calibration !== false;
    if ($("set-auto-adaptive")) {
      $("set-auto-adaptive").checked = settings.strategy === "auto_adaptive";
    }
    if ($("set-auto-high-accuracy")) {
      $("set-auto-high-accuracy").checked = settings.autoHighAccuracy !== false;
    }
  }
  function bindSettingsTab() {
    $("set-calibration").addEventListener("change", (e) => {
      STORE.setSettings({ calibration: e.target.checked }).then((s) => { settings = s; }).catch(() => {
        e.target.checked = !!(settings && settings.calibration);
      });
    });
    if ($("set-auto-adaptive")) {
      $("set-auto-adaptive").addEventListener("change", (e) => {
        const targetStrategy = e.target.checked ? "auto_adaptive" : "confluence";
        STORE.setSettings({ strategy: targetStrategy }).then((s) => {
          settings = s;
          activeStrategy = targetStrategy;
          const sel = $("strategy-select");
          if (sel) sel.value = targetStrategy;
        }).catch(() => {});
      });
    }
    if ($("set-auto-high-accuracy")) {
      $("set-auto-high-accuracy").addEventListener("change", (e) => {
        const checked = e.target.checked;
        STORE.setSettings({ autoHighAccuracy: checked }).then((s) => {
          settings = s;
          if ($("auto-high-accuracy")) $("auto-high-accuracy").checked = checked;
        }).catch(() => {});
      });
    }
    $("reset-stats").addEventListener("click", () => {
      if (!confirm("Erase all stats, history, calibration, and candle cache?")) return;
      STORE.resetAnalytics().then(() => {
        refreshHistoryTab();
        refreshSettingsTab();
      }).catch(() => {});
    });
  }

  /* ---------- auto message wiring ---------- */
  function scheduleLiveRender(state) {
    pendingLiveState = state;
    if (liveRenderQueued) return;
    liveRenderQueued = true;
    const run = () => {
      liveRenderQueued = false;
      const next = pendingLiveState;
      pendingLiveState = null;
      if (next) renderLive(next);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  if (hasChrome) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "CYBER_STATE_PUSH" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        liveFromExt = true; lastExtTs = Date.now();
        scheduleLiveRender(msg.payload);
      }
      if (msg && msg.type === "CYBER_AUTO_STATE" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        updateAutoUI(msg.payload);
      }
      if (msg && msg.type === "CYBER_AUTO_LOG" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        appendAutoLog(msg.payload);
      }
      if (msg && msg.type === "CYBER_QUOTEX_STATUS" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        qxStatus = {
          state: typeof msg.payload.state === "string" ? msg.payload.state.slice(0, 64) : "unknown",
          url: msg.payload.url == null ? null : String(msg.payload.url).slice(0, 256),
        };
        paintQuotexPill();
        if (activeTab === "instruments") refreshInstrumentsTab();
      }
      if (msg && msg.type === "CYBER_QUOTEX_INSTRUMENTS" && Array.isArray(msg.payload)) {
        qxInstruments = QUOTEX ? QUOTEX.parseInstruments(msg.payload).slice(0, 2000) : [];
        for (const it of qxInstruments) {
          if (it && it.symbol) {
            try { ASSETS.registerQuotexAsset(it); } catch (_) {}
          }
        }
        refreshSelectors();
        if (activeTab === "instruments") refreshInstrumentsTab();
      }
      if (msg && msg.type === "CYBER_QUOTEX_BALANCE" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        qxBalance = QUOTEX ? QUOTEX.parseBalance(msg.payload) : null;
        if (activeTab === "instruments") refreshInstrumentsTab();
      }
      if (msg && msg.type === "CYBER_QUOTEX_TRADE_RESULT" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        qxOrders = mergeOrders([msg.payload].concat(qxOrders));
        if (activeTab === "instruments") refreshInstrumentsTab();
      }
      if (msg && msg.type === "CYBER_QUOTEX_TRADE_ERROR" && msg.payload &&
          typeof msg.payload === "object" && !Array.isArray(msg.payload)) {
        // The broker rejected an order the extension sent. Show the real
        // reason instead of a generic confirmation timeout.
        lastOrderError = {
          error: String(msg.payload.error || "broker rejected the order").slice(0, 240),
          at: Date.now(),
        };
        paintQuotexPill();
      }
    });
    chrome.runtime.sendMessage({ type: "CYBER_GET_STATE" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.payload) {
        liveFromExt = true; lastExtTs = Date.now();
        scheduleLiveRender(res.payload);
      }
    });
  }

  /* ---------- bootstrap ---------- */

  /* ---------- pro chart toolbar ---------- */
  function bindProChartToolbar() {
    const CH = self.CYBER_CHARTS || null;
    if (!CH) return;
    const canvas = $("chart");
    if (!canvas) return;
    const state = CH.getState ? CH.getState(canvas) : null;
    if (!state) return;

    // Chart type buttons
    document.querySelectorAll("[data-chart-type]").forEach(btn => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.chartType;
        if (!type) return;
        state.chartType = type;
        document.querySelectorAll("[data-chart-type]").forEach(b => b.classList.toggle("active", b===btn));
        if (state._lastNormalized) CH.drawMainChart(canvas, state._lastNormalized, {});
      });
    });

    const bindCheck = (id, key) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener("change", () => {
        state[key] = el.checked;
        if (state._lastNormalized) CH.drawMainChart(canvas, state._lastNormalized, {});
      });
    };
    bindCheck("chart-ema", "showEMA");
    bindCheck("chart-bb", "showBB");
    bindCheck("chart-vol", "showVolume");
    bindCheck("chart-macd", "showMACD");
    bindCheck("chart-rsi", "showRSI");

    const resetBtn = $("chart-reset");
    if (resetBtn) resetBtn.addEventListener("click", () => {
      state.visibleBars = 120;
      state.scrollOffset = 0;
      state.crosshair = null;
      if (state._lastNormalized) CH.drawMainChart(canvas, state._lastNormalized, {});
    });

    const exportBtn = $("chart-export");
    if (exportBtn) exportBtn.addEventListener("click", () => {
      if (CH.exportCanvasPNG) CH.exportCanvasPNG(canvas, "cyber-binary-" + (activeAsset||"chart") + "-" + new Date().toISOString().slice(0,10) + ".png");
    });

    const fsBtn = $("chart-fullscreen");
    const wrap = $("main-chart-wrap");
    if (fsBtn && wrap) {
      fsBtn.addEventListener("click", () => {
        const isFs = wrap.classList.contains("fullscreen");
        if (isFs) {
          wrap.classList.remove("fullscreen");
          fsBtn.textContent = "⛶";
          if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
        } else {
          wrap.classList.add("fullscreen");
          fsBtn.textContent = "✕";
          // try native fullscreen
          if (wrap.requestFullscreen) wrap.requestFullscreen().catch(()=>{});
        }
        setTimeout(() => {
          if (state._lastNormalized) CH.drawMainChart(canvas, state._lastNormalized, {});
        }, 100);
      });
      document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement) {
          wrap.classList.remove("fullscreen");
          if (fsBtn) fsBtn.textContent = "⛶";
          setTimeout(() => { if (state._lastNormalized) CH.drawMainChart(canvas, state._lastNormalized, {}); }, 100);
        }
      });
    }

    // Equity export
    const eqExport = $("bt-equity-export");
    if (eqExport) eqExport.addEventListener("click", () => {
      const c = $("bt-equity");
      if (c && CH.exportCanvasPNG) CH.exportCanvasPNG(c, "cyber-binary-equity-" + new Date().toISOString().slice(0,10) + ".png");
    });
    const eqFs = $("bt-equity-fullscreen");
    const eqWrap = $("bt-equity-wrap");
    if (eqFs && eqWrap) {
      eqFs.addEventListener("click", () => {
        const isFs = eqWrap.classList.contains("fullscreen");
        if (isFs) { eqWrap.classList.remove("fullscreen"); eqFs.textContent="⛶"; if (document.exitFullscreen) document.exitFullscreen().catch(()=>{}); }
        else { eqWrap.classList.add("fullscreen"); eqFs.textContent="✕"; if (eqWrap.requestFullscreen) eqWrap.requestFullscreen().catch(()=>{}); }
      });
    }

    const monteExport = $("bt-monte-export");
    if (monteExport) monteExport.addEventListener("click", () => {
      const c = $("bt-monte-chart");
      if (c && CH.exportCanvasPNG) CH.exportCanvasPNG(c, "cyber-binary-monte-" + new Date().toISOString().slice(0,10) + ".png");
    });
  }

  function scale() {
    const w = window.innerWidth;
    document.documentElement.style.fontSize = Math.max(12, Math.min(17, w / 32)) + "px";
    if (lastChartCandles && lastChartCandles.length) drawChart($("chart"), lastChartCandles, lastChartMeta);
    if (lastBtEquity) drawChart($("bt-equity"), lastBtEquity, { equity: true, equityLabel: "runs" });
  }
  window.addEventListener("resize", () => {
    if (resizeQueued) return;
    resizeQueued = true;
    const run = () => { resizeQueued = false; scale(); };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }, { passive: true });

  // Show the build that actually loaded. A stale unpacked-extension directory
  // (files copied by hand, or an older folder left loaded in Chrome) otherwise
  // looks identical to a current one, and any error it throws gets blamed on
  // the code in the repo instead of the copy on disk.
  function paintBuildStamp() {
    const kicker = $("app-kicker");
    if (!kicker) return;
    let version = "";
    try {
      if (hasChrome && chrome.runtime && typeof chrome.runtime.getManifest === "function") {
        const m = chrome.runtime.getManifest();
        version = m && m.version ? String(m.version).slice(0, 32) : "";
      }
    } catch (_) { /* not in an extension context */ }
    const label = "Auto-Adaptive Engine & High-Accuracy Assets" + (version ? " · v" + version : "");
    kicker.textContent = label;
    if (version) kicker.title = "Loaded extension build v" + version;
  }

  refreshSelectors();
  bindSelectors();
  bindAutoTab();
  bindInstrumentsTab();
  bindBacktest();
  bindHistoryTab();
  bindAssetsTab();
  bindSettingsTab();
  bindProChartToolbar();
  loadAutoSettings();
  scale();
  paintBuildStamp();
  paintQuotexPill();
  if (activeTab === "instruments") refreshInstrumentsTab();

  // Local demo loop
  localFeed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD"), 240));
  renderLocalTick();
  demoTimer = setInterval(renderLocalTick, 1500);
})();
