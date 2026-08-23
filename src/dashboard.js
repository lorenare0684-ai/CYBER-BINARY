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

  // Active local feed (for the dashboard's own chart when live data is missing).
  const localFeed = FEED.createFeed({ tfMs: 60000, max: 400 });
  localFeed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD"), 240));

  let activeAsset = "EURUSD";
  let activeStrategy = "confluence";
  let lastDetailsKey = "";
  let lastHistoryKey = "";
  let lastChartKey = "";
  let liveFromExt = false;
  let lastExtTs = 0;
  let autoState = null;
  let settings = null;
  let btResults = null;
  // Last rendered chart state (used by `scale()` on resize).
  let lastChartCandles = null;
  let lastChartMeta = {};
  let lastBtEquity = null;
  // v2.1: live Quotex state
  let qxStatus = { state: "idle" };
  let qxInstruments = [];
  let qxBalance = null;
  let qxOrders = [];
  let pendingLiveState = null;
  let liveRenderQueued = false;
  let demoTimer = null;
  let resizeQueued = false;
  let activeTab = "live";
  let assetsRenderToken = 0;
  let historyRenderToken = 0;
  const recentAutoLogKeys = new Set();
  const recentAutoLogOrder = [];
  // Genuine 1m candles received in the latest live state. Backtests can use
  // these immediately instead of racing the asynchronous storage persistence.
  const liveCandlesByAsset = Object.create(null);

  function tfLabel(sec) {
    if (!sec) return "1m";
    sec = Number(sec) || 60;
    if (sec === 60) return "1m";
    if (sec % 60 === 0) return (sec / 60) + "m";
    return sec + "s";
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
    // Prevent spreadsheet formula execution from broker-controlled labels.
    if (/^[=+\-@]/.test(s) && !/^-?\d+(?:\.\d+)?$/.test(s)) s = "'" + s;
    s = s.replace(/"/g, '""');
    return /[",\n]/.test(s) ? '"' + s + '"' : s;
  }

  function fmtPct(n) {
    const x = finite(n, null);
    return x == null ? "—" : x.toFixed(1) + "%";
  }
  function fmtPx(n) {
    const x = finite(n, null);
    if (x == null) return "—";
    return Math.abs(x) >= 20 ? x.toFixed(2) : x.toFixed(5);
  }
  function fmtReading(n) {
    if (!Number.isFinite(n)) return "—";
    const magnitude = Math.abs(n);
    if (magnitude < 1e-12) return "0";
    // Keep small MACD/ATR-style values readable as ordinary decimals instead
    // of exposing implementation-looking notation such as -5.304e-5.
    const places = Math.max(4, Math.min(10, Math.ceil(-Math.log10(magnitude)) + 4));
    const fixed = n.toFixed(places);
    return fixed.includes(".") ? fixed.replace(/0+$/, "").replace(/\.$/, "") : fixed;
  }
  function fmtTime(ts) {
    if (ts == null || ts === "") return "—";
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleTimeString() : "—";
  }
  function fmtDate(ts) {
    if (ts == null || ts === "") return "—";
    const d = new Date(ts);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : "—";
  }
  function fmtDuration(minutes, entryTime, expiryTime) {
    let mins = Number(minutes);
    if (!Number.isFinite(mins) && entryTime != null && expiryTime != null) mins = (Number(expiryTime) - Number(entryTime)) / 60000;
    if (!Number.isFinite(mins) || mins <= 0) return "—";
    return (Math.round(mins * 10) / 10) + "m";
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
    let text = "Entry " + fmtTime(entryTime) + " @ " + fmtPx(entry);
    text += " · Expiry " + fmtTime(expiryTime) + " (" + fmtDuration(h.expiryMinutes, entryTime, expiryTime) + ")";
    if (includeExit || exit != null) text += " · Exit " + fmtTime(exitTime) + " @ " + fmtPx(exit);
    return text;
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

  function drawChart(canvas, candles, opts) {
    if (!canvas) return;
    const o = opts || {};
    const parent = canvas.parentElement;
    const parentWidth = finite(parent && parent.clientWidth, 0);
    const viewportWidth = finite(window.innerWidth, 480);
    const w = Math.max(180, Math.min(4096, parentWidth || viewportWidth));
    const useMacd = o.macd !== false;
    const priceH = Math.max(92, Math.round(w * 0.24));
    const macdH = useMacd ? Math.max(52, Math.round(w * 0.14)) : 0;
    const timeAxisH = 18;
    const h = priceH + macdH + timeAxisH;
    const rawDpr = finite(window.devicePixelRatio, 1);
    // Two physical pixels per CSS pixel are visually sharp while avoiding
    // huge 4× backing buffers that made every live redraw expensive.
    const dpr = Math.max(1, Math.min(2, rawDpr));
    const pixelW = Math.floor(w * dpr), pixelH = Math.floor(h * dpr);
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    if (canvas.style.width !== w + "px") canvas.style.width = w + "px";
    if (canvas.style.height !== h + "px") canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = o.bg || "#0c1422";
    ctx.fillRect(0, 0, w, h);
    if (!Array.isArray(candles) || candles.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(o.emptyMessage || "Waiting for candles…", w / 2, h / 2);
      return;
    }
    if (o.equity) {
      // Equity curve: simple line
      const eq = candles.map((point) => ({ equity: finite(point && point.equity, null) }))
        .filter((point) => point.equity != null);
      if (eq.length < 2) {
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for valid equity data…", w / 2, h / 2);
        return;
      }
      let eqLo = -Math.max(1, Math.abs(eq[0].equity));
      let eqHi = Math.max(1, Math.abs(eq[0].equity || 0));
      for (let i = 0; i < eq.length; i++) {
        if (eq[i].equity < eqLo) eqLo = eq[i].equity;
        if (eq[i].equity > eqHi) eqHi = eq[i].equity;
      }
      const pad = (eqHi - eqLo) * 0.1 || 1;
      eqLo -= pad; eqHi += pad;
      const zeroY = priceH - ((0 - eqLo) / (eqHi - eqLo)) * (priceH - 16) - 8;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
      ctx.strokeStyle = "#4aa3ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < eq.length; i++) {
        const x = 8 + (i / (eq.length - 1)) * (w - 16);
        const y = priceH - ((eq[i].equity - eqLo) / (eqHi - eqLo)) * (priceH - 16) - 8;
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
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillText("Equity · " + eq.length + " " + (o.equityLabel || "points"), 8, 12);
      return;
    }
    // Chart util: y-map for the price pane.
    const padL = 8, padR = 54;
    const plotW = w - padL - padR;
    // Broker batches can arrive newest-first, overlap, or briefly contain an
    // incomplete malformed row. Normalize again at the render boundary so
    // candle order/wicks are always correct even during incremental updates.
    const byTime = new Map();
    for (const raw of candles) {
      if (!raw) continue;
      let time = Number(raw.time);
      const open = Number(raw.open), close = Number(raw.close);
      if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(close) ||
          open <= 0 || close <= 0 || open > 1e100 || close > 1e100) continue;
      while (Math.abs(time) >= 1e14) time /= 1000;
      if (Math.abs(time) < 1e11) time *= 1000;
      time = Math.floor(time);
      if (!Number.isFinite(time) || time <= 0 || time > 8640000000000000) continue;
      const rawHigh = Number(raw.high), rawLow = Number(raw.low);
      const validHigh = Number.isFinite(rawHigh) && rawHigh > 0 && rawHigh <= 1e100 ? rawHigh : open;
      const validLow = Number.isFinite(rawLow) && rawLow > 0 && rawLow <= 1e100 ? rawLow : close;
      const high = Math.max(validHigh, validLow, open, close);
      const low = Math.min(validHigh, validLow, open, close);
      const rawVolume = Number(raw.volume);
      byTime.set(time, { time, open, high, low, close, volume: Number.isFinite(rawVolume) && rawVolume >= 0 ? Math.min(Number.MAX_VALUE, rawVolume) : 0 });
    }
    const normalized = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
    const requestedBars = Math.floor(Number(o.bars));
    const barCount = Number.isFinite(requestedBars) && requestedBars >= 2 ? Math.min(500, requestedBars) : 100;
    const view = normalized.slice(-barCount);
    if (view.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for valid broker candles…", w / 2, h / 2);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < view.length; i++) {
      lo = Math.min(lo, view[i].low);
      hi = Math.max(hi, view[i].high);
    }
    const pad = (hi - lo) * 0.08 || 0.0001;
    lo -= pad; hi += pad;
    const yPrice = (p) => priceH - ((p - lo) / (hi - lo)) * (priceH - 10) - 5;
    const bw = plotW / view.length;
    const xFor = (i) => padL + (i + 0.5) * bw;

    // Grid + right-side price axis
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.fillStyle = "rgba(255,255,255,0.5)";
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.lineWidth = 1;
    const rows = 4;
    for (let g = 0; g <= rows; g++) {
      const p = lo + ((hi - lo) * g) / rows;
      const y = yPrice(p);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
      ctx.fillText(fmtPx(p), w - padR + 6, y + 3);
    }

    // Candles + EMA overlays
    let emaFast = null, emaSlow = null;
    if (self.CYBER_TA) {
      const closes = view.map((c) => c.close);
      emaFast = self.CYBER_TA.ema(closes, 8);
      emaSlow = self.CYBER_TA.ema(closes, 21);
    }
    for (let i = 0; i < view.length; i++) {
      const c = view[i];
      const x = xFor(i);
      const yH = yPrice(c.high), yL = yPrice(c.low);
      const yO = yPrice(c.open), yC = yPrice(c.close);
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? "#3dff9a" : "#ff5d7a";
      ctx.fillStyle = up ? "#3dff9a" : "#ff5d7a";
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - Math.max(1, bw * 0.32), top, Math.max(2, bw * 0.64), bh);
    }
    const drawLine = (arr, color) => {
      if (!arr) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] == null) continue;
        const x = xFor(i), y = yPrice(arr[i]);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.lineWidth = 1;
    };
    drawLine(emaFast, "rgba(77,163,255,0.85)");
    drawLine(emaSlow, "rgba(255,196,87,0.85)");

    // v2.3.3: non-repainting signal arrows. Anchors are fixed (bar time +
    // price); each arrow is drawn at its anchor's bar slot, so it never
    // moves as later candles arrive.
    if (Array.isArray(o.markers) && o.markers.length) {
      for (let mi = 0; mi < o.markers.length; mi++) {
        const mk = o.markers[mi];
        if (!mk || mk.time == null || mk.price == null || (mk.dir !== "CALL" && mk.dir !== "PUT")) continue;
        let markerTime = Number(mk.time), markerPrice = Number(mk.price);
        if (!Number.isFinite(markerTime) || !Number.isFinite(markerPrice) || markerPrice <= 0 || markerPrice > 1e100) continue;
        while (Math.abs(markerTime) >= 1e14) markerTime /= 1000;
        if (Math.abs(markerTime) < 1e11) markerTime *= 1000;
        markerTime = Math.floor(markerTime);
        if (markerTime <= 0 || markerTime > 8640000000000000) continue;
        // find the bar index for this marker's time (times are ascending)
        let idx = -1;
        let lo2 = 0, hi2 = view.length - 1;
        while (lo2 <= hi2) {
          const mid = (lo2 + hi2) >> 1;
          if (view[mid].time === markerTime) { idx = mid; break; }
          if (view[mid].time < markerTime) lo2 = mid + 1; else hi2 = mid - 1;
        }
        if (idx < 0) {
          const insertion = lo2;
          const left = insertion > 0 ? insertion - 1 : -1;
          const right = insertion < view.length ? insertion : -1;
          if (left >= 0 && right >= 0) idx = markerTime - view[left].time <= view[right].time - markerTime ? left : right;
          else idx = left >= 0 ? left : right;
          const typicalGap = view.length > 1 ? Math.max(1, view[view.length - 1].time - view[view.length - 2].time) : 60000;
          if (idx < 0 || Math.abs(view[idx].time - markerTime) > typicalGap) continue;
        }
        const mx = xFor(idx);
        const my = yPrice(markerPrice);
        if (!Number.isFinite(my) || my < -12 || my > priceH + 12) continue;
        const s = 7;
        ctx.fillStyle = mk.dir === "PUT" ? "#ff5d7a" : "#3dff9a";
        ctx.beginPath();
        if (mk.dir === "PUT") {
          ctx.moveTo(mx, my - 5);
          ctx.lineTo(mx - s, my - 5 - s);
          ctx.lineTo(mx + s, my - 5 - s);
        } else {
          ctx.moveTo(mx, my + 5);
          ctx.lineTo(mx - s, my + 5 + s);
          ctx.lineTo(mx + s, my + 5 + s);
        }
        ctx.closePath();
        ctx.fill();
      }
    }

    // Last price line + tag
    const lastC = view[view.length - 1].close;
    const lastY = yPrice(lastC);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.beginPath(); ctx.moveTo(padL, lastY); ctx.lineTo(padL + plotW, lastY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastC >= view[0].open ? "#3dff9a" : "#ff5d7a";
    ctx.fillRect(w - padR - 42, lastY - 8, 44, 15);
    ctx.fillStyle = "#0c1422";
    ctx.font = "bold 9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(fmtPx(lastC), w - padR - 20, lastY + 3);
    ctx.textAlign = "left";

    // Time axis (approx labels)
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.beginPath(); ctx.moveTo(padL, priceH + 0.5); ctx.lineTo(padL + plotW, priceH + 0.5); ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.font = "9px system-ui, sans-serif";
    const labelEvery = Math.max(1, Math.floor(view.length / 6));
    for (let i = 0; i < view.length; i += labelEvery) {
      const d = new Date(view[i].time);
      const lbl = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      ctx.fillText(lbl, xFor(i), priceH + 12);
    }

    // MACD subplot (histogram + MACD + signal) — matches the broker chart
    if (useMacd && self.CYBER_TA) {
      const m = self.CYBER_TA.macd(view.map((c) => c.close), 12, 26, 9);
      let mMax = 1e-9;
      for (let i = 0; i < m.hist.length; i++) {
        for (const v of [m.hist[i], m.line[i], m.signal[i]]) {
          if (v != null && Math.abs(v) > mMax) mMax = Math.abs(v);
        }
      }
      const y0 = priceH + 4 + macdH / 2;
      const yMacd = (v) => y0 - ((v || 0) / mMax) * (macdH / 2 - 5);
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL + plotW, y0); ctx.stroke();
      const mw = plotW / view.length;
      for (let i = 0; i < m.hist.length; i++) {
        if (m.hist[i] == null) continue;
        const x = xFor(i);
        const v = m.hist[i];
        ctx.fillStyle = v >= 0 ? "rgba(61,255,154,0.85)" : "rgba(255,93,122,0.85)";
        ctx.fillRect(x - Math.max(1, mw * 0.28), Math.min(y0, yMacd(v)), Math.max(2, mw * 0.56), Math.max(1, Math.abs(y0 - yMacd(v))));
      }
      // MACD line/signal plot in the SUBPLOT coordinate space, never the price
      // pane's y-scale (that was the "MACD stuck at the bottom" glitch).
      const drawMacdLine = (arr, color) => {
        if (!arr) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < arr.length; i++) {
          if (arr[i] == null) continue;
          const x = xFor(i);
          const y = yMacd(arr[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.lineWidth = 1;
      };
      drawMacdLine(m.line, "#4aa3ff");
      drawMacdLine(m.signal, "#ffc457");
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.fillText("MACD 12/26/9", padL + 4, priceH + 14);
    }

    // Watermark-ish label
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillText("CYBER BINARY · " + (o.label || o.timeframe || "1m") + " · " + view.length + " bars", padL + 4, 12);
  }

  /* ---------- tab routing ---------- */
  function activateTab(name) {
    if (typeof name !== "string" || !Array.from($all(".tab-pane")).some((p) => p.dataset.pane === name)) return;
    activeTab = name;
    if (name !== "assets") assetsRenderToken++;
    if (name !== "history") historyRenderToken++;
    $all(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $all(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
    if (name === "assets") refreshAssetsTab();
    if (name === "history") refreshHistoryTab();
    if (name === "settings") refreshSettingsTab();
    if (name === "instruments") refreshInstrumentsTab();
    if (name === "backtest") {} // lazy
  }
  $all(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));

  /* ---------- asset/strategy selectors ---------- */
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
      const requested = e.target.value;
      const previous = activeAsset;
      if (hasChrome) {
        chrome.runtime.sendMessage({ type: "CYBER_SET_ASSET", asset: requested }).then((response) => {
          if (!response || !response.ok) {
            e.target.value = previous;
            const pill = $("link-state");
            if (pill) {
              pill.textContent = response && response.error || "Select the asset on Quotex first";
              pill.className = "pill warn";
            }
            return;
          }
          activeAsset = response.asset || requested;
          e.target.value = activeAsset;
        }).catch(() => { e.target.value = previous; });
        return;
      }
      activeAsset = requested;
      // Re-seed local demo feed for the new asset.
      const a = ASSETS.get(activeAsset);
      if (a) localFeed.setSeries(FEED.syntheticSeries(a, 240));
      renderLocalTick();
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
    // Incremental FNV-1a avoids repeatedly concatenating a very large key
    // string (candles + markers) on every live-state push.
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

  function renderLive(state) {
    if (!state || typeof state !== "object" || Array.isArray(state)) return;
    // v2.1: surface the platform state if the content script attached it.
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
    }
    paintQuotexPill();

    $("link-state").textContent = state.attached
      ? (state.primary === false ? "Secondary chart" : "Main · " + (state.source || "chart"))
      : "Demo feed";
    $("link-state").className = "pill " + (state.attached ? "ok" : "dim");

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
    if (state.realHistoryReady === true && Array.isArray(state.candles) && state.candles.length) {
      // Keep only the bounded payload from the authoritative selected tab.
      // The content script marks this true only after genuine 1m broker OHLC
      // has replaced the synthetic warm-up feed.
      liveCandlesByAsset[activeAsset] = state.candles.slice(-500);
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
    $("regime-row").textContent = "regime: " + (sig.regime || "—") + " · mtf bias: " + ((sig.metrics && sig.metrics.mtfBias) || 0) + "/" + ((sig.metrics && sig.metrics.mtfChecked) || 0);

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
          '<span class="meta">' + esc(h.dir || "") + " · " + esc(h.asset || "—") + " · conf " + esc(finite(h.confidence, 0)) + "%<br>" + esc(tradeTimeline(h, true)) + '</span>' +
          '<span class="' + outcome.cls + '">' + esc(fmtMoney(h.pnl)) + '</span>';
        ul.appendChild(li);
      });
    }

    // v2.2: prefer the broker's own history for the chart; fall back to the
    // engine's 1m series. Real data replaces the synthetic seed, so the
    // chart matches the platform chart (same candles, EMA + MACD subplot).
    const chartCandles = (Array.isArray(state.chartCandles) && state.chartCandles.length
      ? state.chartCandles : (Array.isArray(state.candles) ? state.candles : [])).slice(-500);
    const markers = Array.isArray(state.markers) ? state.markers.slice(-600) : [];
    const nextChartKey = chartStateKey(chartCandles, state.chartPeriod, markers);
    if (nextChartKey !== lastChartKey) {
      lastChartKey = nextChartKey;
      lastChartCandles = chartCandles.slice(-500);
      lastChartMeta = { timeframe: tfLabel(state.chartPeriod || 60), markers };
      drawChart($("chart"), lastChartCandles, lastChartMeta);
    }
    if (state.autoState) updateAutoUI(state.autoState);
  }

  /* ---------- local demo rendering (no extension) ---------- */
  function renderLocalTick() {
    // v2.2: never let the demo loop overwrite live extension state — this was
    // the "shows demo, flickers to live" bug. Once a live state arrives the
    // demo loop becomes a no-op for the rest of the session.
    // Content sends an unchanged-state heartbeat every 10s; allow jitter so
    // the demo loop cannot flicker over a healthy but quiet live chart.
    if (liveFromExt && Date.now() - lastExtTs <= 15000) return;
    if (liveFromExt) {
      // The selected tab stopped publishing (closed, navigated, or extension
      // reloaded). Do not leave a permanently frozen "live" dashboard.
      liveFromExt = false;
      qxStatus = { state: "disconnected" };
      const selected = ASSETS.get(activeAsset);
      if (selected) localFeed.setSeries(FEED.syntheticSeries(selected, 240));
      lastChartKey = "";
      paintQuotexPill();
    }
    const last = localFeed.lastPrice() || 1.0854;
    localFeed.ingest(FEED.demoTick(last), Date.now());
    const series = localFeed.series();
    const strat = STRAT.get(activeStrategy) || STRAT.defaults();
    const sig = ENG.analyze(series, { strategy: activeStrategy, params: strat.params, weights: strat.weights, lean: false });
    sig.asset = activeAsset;
    sig.assetName = (ASSETS.get(activeAsset) || {}).name || activeAsset;
    sig.strategy = activeStrategy;
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

  /* ---------- auto tab ---------- */
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
      } : null,
    };
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
    $("last-trade").textContent = autoState.lastTrade
      ? (autoState.lastTrade.dir + " " + (autoState.lastTrade.asset || "") + " · " +
        fmtTime(autoState.lastTrade.entryTime || autoState.lastTrade.at) + " → " + fmtTime(autoState.lastTrade.expiryTime))
      : "—";

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

  /* ---------- v2.1: Quotex status pill + instruments tab ---------- */
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
      const tfs = (it.timeframes || []).map((t) => QUOTEX.KNOWN_TIMEFRAMES[t] || t + "s").slice(0, 6).join(", ");
      tr.innerHTML =
        "<td>" + esc(it.symbol || "—") + "</td>" +
        "<td>" + esc(it.name || "—") + "</td>" +
        "<td>" + esc(it.type || "—") + "</td>" +
        "<td>" + (finite(it.payout, null) != null ? esc(finite(it.payout, 0)) + "%" : "—") + "</td>" +
        "<td>" + esc(tfs || "—") + "</td>" +
        "<td class='" + (it.isOpen ? "win" : "loss") + "'>" + (it.isOpen ? "OPEN" : "closed") + "</td>";
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
      // A mode change, especially alerts → click, requires a fresh explicit
      // ARM gesture. Never carry an armed state into a more powerful mode.
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
        // Restore the last persisted value when no selected Quotex tab can
        // accept the mode change.
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
    bindNumberSetting("max-hour", "maxTradesPerHour");
    bindNumberSetting("max-day", "maxTradesPerDay");
    bindNumberSetting("loss-cap", "dailyLossCap");
    bindNumberSetting("profit-cap", "dailyProfitCap");
    bindNumberSetting("cooldown", "cooldownBars");
    const bindBooleanSetting = (id, key) => {
      const el = $(id);
      el.addEventListener("change", () => {
        setSettings({ [key]: el.checked }).then((saved) => { el.checked = !!saved[key]; }).catch(() => {
          el.checked = !!(settings && settings[key]);
        });
      });
    };
    bindBooleanSetting("notify-sound", "notifySound");
    bindBooleanSetting("notify-desktop", "notifyDesktop");
    let armPending = false;
    $("arm-btn").addEventListener("click", () => {
      if (armPending) return;
      // v2.3.2: settings loads async — clicking ARM before it resolves used
      // to throw on `settings.armed` (null deref) and the arm never happened.
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
        // A failed arm must leave persisted safety state disarmed.
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
      $("max-hour").value = s.maxTradesPerHour != null ? s.maxTradesPerHour : 12;
      $("max-day").value = s.maxTradesPerDay != null ? s.maxTradesPerDay : 60;
      $("loss-cap").value = s.dailyLossCap != null ? s.dailyLossCap : 30;
      $("profit-cap").value = s.dailyProfitCap != null ? s.dailyProfitCap : 0;
      $("cooldown").value = s.cooldownBars != null ? s.cooldownBars : 2;
      $("notify-sound").checked = s.notifySound !== false;
      $("notify-desktop").checked = !!s.notifyDesktop;
      activeStrategy = STRAT.get(s.strategy) ? s.strategy : "confluence";
      const sel = $("strategy-select");
      if (sel) sel.value = activeStrategy;
    });
  }

  /* ---------- backtest tab ---------- */
  function runBacktest() {
    const rawDays = Number($("bt-days").value);
    const rawHorizon = Number($("bt-horizon").value);
    const rawMinConf = Number($("bt-minconf").value);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(31, Math.floor(rawDays))) : 7;
    const horizon = Number.isFinite(rawHorizon) ? Math.max(1, Math.min(60, Math.floor(rawHorizon))) : 3;
    const minConf = Number.isFinite(rawMinConf) ? Math.max(0, Math.min(100, rawMinConf)) : 0;
    const kind = $("bt-kinds").value;
    const kinds = kind === "all" ? null : [kind];
    // Lean backtests warm up at 50 bars. Requiring 155 cached bars here made a
    // normal 100-bar Quotex history response look like "no data".
    const o = { days, horizon, minConf, kinds, minBars: 50, liveOnly: true, requireLive: true };

    const btn = $("bt-run");
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Loading Quotex candles…";

    function tick(progress, total) {
      const i = progress && typeof progress === "object" ? progress.i : progress;
      const n = progress && typeof progress === "object" ? progress.total : total;
      if (n) btn.textContent = "Running live-feed backtest " + i + " / " + n + "…";
    }

    const assetPool = ASSETS.list().filter((a) => !kinds || kinds.some((kindName) =>
      typeof ASSETS.matchesKind === "function" ? ASSETS.matchesKind(a, kindName) : a.kind === kindName)).slice(0, 256);
    const minNeeded = Math.max(40, 50 + horizon + 1);
    // Ask the selected Quotex tab for broker history immediately instead of
    // assuming its periodic subscription has completed. Poll the genuine
    // live/storage sources briefly because socket delivery and persistence are
    // asynchronous and a fixed 1.2-second delay routinely raced them.
    const requestFreshHistory = hasChrome
      ? chrome.runtime.sendMessage({ type: "CYBER_REQUEST_HISTORY", limit: 5000 })
          .then((response) => {
            if (!response || !response.ok) throw new Error(response && response.error || "The selected Quotex tab could not request history.");
            return response;
          })
      : Promise.resolve({ ok: true });

    const readLiveRows = () => STORE.load().then((snapshot) => {
      const storedByAsset = snapshot && snapshot.candles && typeof snapshot.candles === "object"
        ? snapshot.candles : {};
      return assetPool.map((a) => {
        const stored = storedByAsset[a.id];
        const immediate = liveCandlesByAsset[a.id];
        const storedBars = Array.isArray(stored) ? stored : [];
        const immediateBars = Array.isArray(immediate) ? immediate : [];
        // Prefer whichever genuine source is longer. A live-state payload can
        // arrive before chrome.storage.local has completed its cross-context
        // write, which previously made a populated chart report no candles.
        return { asset: a, bars: immediateBars.length > storedBars.length ? immediateBars : storedBars };
      });
    }).catch(() => assetPool.map((a) => ({
      asset: a,
      bars: Array.isArray(liveCandlesByAsset[a.id]) ? liveCandlesByAsset[a.id] : [],
    })));

    const waitForLiveRows = async () => {
      const deadline = Date.now() + 10000;
      let rows = await readLiveRows();
      while (!rows.some((row) => Array.isArray(row.bars) && row.bars.length >= minNeeded) && Date.now() < deadline) {
        const secondsLeft = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
        btn.textContent = "Waiting for broker candles… " + secondsLeft + "s";
        await new Promise((resolve) => setTimeout(resolve, 500));
        rows = await readLiveRows();
      }
      return rows;
    };

    const loadLiveCache = requestFreshHistory.then(waitForLiveRows).then((rows) => {
      const cachedByAsset = Object.create(null);
      const liveAssets = [];
      rows.forEach((row) => {
        const bars = Array.isArray(row.bars) ? row.bars : [];
        if (bars.length >= minNeeded) {
          cachedByAsset[row.asset.id] = bars;
          liveAssets.push(row.asset);
        }
      });
      if (!liveAssets.length) {
        return { results: [], count: 0, liveOnly: true, error: "No genuine one-minute Quotex history arrived within 10 seconds. Keep the selected trade chart open and connected, then retry; at least " + minNeeded + " bars are required." };
      }
      o.assets = liveAssets;
      o.cachedByAsset = cachedByAsset;
      o.onProgress = tick;
      const useWorkers = WORKERS && WORKERS.runBrowser;
      return useWorkers
        ? WORKERS.runBrowser(o)
        : new Promise((resolve, reject) => setTimeout(() => {
          try { resolve(HIST.runMatrix(o)); } catch (e) { reject(e); }
        }, 30));
    });

    loadLiveCache.then((r) => {
      btResults = r;
      paintBacktest(r, o);
      if (r && r.error) {
        const body = $("bt-assets") && $("bt-assets").querySelector("tbody");
        if (body) body.innerHTML = "<tr><td colspan='5'>" + esc(r.error) + "</td></tr>";
      }
    }).catch((e) => {
      const message = String(e && e.message || e || "Backtest failed");
      const failure = { results: [], count: 0, liveOnly: true, error: message };
      btResults = failure;
      paintBacktest(failure, o);
      const body = $("bt-assets") && $("bt-assets").querySelector("tbody");
      if (body) body.innerHTML = "<tr><td colspan='5'>" + esc(message) + "</td></tr>";
      console.error(e);
    }).then(() => {
      btn.disabled = false;
      btn.textContent = origLabel;
    });
  }

  function paintBacktest(matrix, opts) {
    matrix = matrix && Array.isArray(matrix.results) ? matrix : { results: [] };
    const sum = HIST.summarize(matrix) || {
      trades: 0, winrate: 0, pnl: 0, byStrategy: {}, byKind: {},
    };
    $("bt-trades").textContent = String(sum.trades || 0);
    $("bt-winrate").textContent = fmtPct(sum && sum.winrate);
    $("bt-pnl").textContent = String(sum && sum.pnl || 0);
    const maxDrawdown = finite(sum && sum.maxDrawdown, null);
    $("bt-dd").textContent = maxDrawdown == null ? "—" : maxDrawdown.toFixed(2);

    // The matrix does not retain trade chronology, so never fabricate it by
    // grouping every win before every loss. Plot one bounded cumulative point
    // per completed asset/strategy run instead (also avoids allocating one DOM
    // object per backtest trade on large matrices).
    let running = 0;
    const seq = [{ equity: 0 }];
    for (const r of matrix.results.slice(0, 2000)) {
      running += finite(r && r.pnl, 0);
      seq.push({ equity: running });
    }
    lastBtEquity = matrix.error ? null : seq;
    drawChart($("bt-equity"), matrix.error ? [] : seq, {
      equity: true,
      equityLabel: "runs",
      emptyMessage: matrix.error ? "No genuine Quotex history received — see status below." : undefined,
    });

    // Per-strategy
    const stBody = $("bt-strategies").querySelector("tbody");
    stBody.innerHTML = "";
    for (const k of Object.keys(sum.byStrategy).sort((a, b) => sum.byStrategy[b].winrate - sum.byStrategy[a].winrate)) {
      const v = sum.byStrategy[k];
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(k) + "</td><td>" + finite(v.total, 0) + "</td><td class='win'>" + finite(v.wins, 0) + "</td><td class='loss'>" + finite(v.losses, 0) + "</td><td>" + finite(v.winrate, 0).toFixed(1) + "%</td>";
      stBody.appendChild(tr);
    }

    // Per-asset
    const aBody = $("bt-assets").querySelector("tbody");
    aBody.innerHTML = "";
    const perAsset = {};
    for (const r of matrix.results) {
      if (!perAsset[r.asset]) perAsset[r.asset] = { wins: 0, losses: 0, pnl: 0, dd: 0, name: r.name };
      perAsset[r.asset].wins += r.wins;
      perAsset[r.asset].losses += r.losses;
      perAsset[r.asset].pnl += r.pnl;
      if (r.maxDrawdown > perAsset[r.asset].dd) perAsset[r.asset].dd = r.maxDrawdown;
    }
    for (const k of Object.keys(perAsset).sort((a, b) => perAsset[b].pnl - perAsset[a].pnl)) {
      const v = perAsset[k];
      const t = v.wins + v.losses;
      const wr = t ? (v.wins / t) * 100 : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(v.name || k) + "</td><td>" + t + "</td><td class='" + (wr >= 55 ? "win" : wr <= 45 ? "loss" : "") + "'>" + wr.toFixed(1) + "%</td><td>" + finite(v.pnl, 0) + "</td><td>" + finite(v.dd, 0) + "</td>";
      aBody.appendChild(tr);
    }

    // Regime breakdown (aggregate)
    const regBody = $("bt-regimes").querySelector("tbody");
    regBody.innerHTML = "";
    const regAgg = {};
    for (const r of matrix.results) {
      for (const reg of Object.keys(r.byRegime || {})) {
        if (!regAgg[reg]) regAgg[reg] = { wins: 0, losses: 0 };
        regAgg[reg].wins += r.byRegime[reg].wins;
        regAgg[reg].losses += r.byRegime[reg].losses;
      }
    }
    for (const k of Object.keys(regAgg).sort((a, b) => (regAgg[b].wins + regAgg[b].losses) - (regAgg[a].wins + regAgg[a].losses))) {
      const v = regAgg[k];
      const t = v.wins + v.losses;
      const wr = t ? (v.wins / t) * 100 : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + esc(k) + "</td><td>" + t + "</td><td class='" + (wr >= 55 ? "win" : wr <= 45 ? "loss" : "") + "'>" + wr.toFixed(1) + "%</td>";
      regBody.appendChild(tr);
    }

    // Calibration
    const calBody = $("bt-calib").querySelector("tbody");
    calBody.innerHTML = "";
    const calAgg = {};
    for (const r of matrix.results) {
      for (const c of (r.calibration || [])) {
        if (!calAgg[c.bucket]) calAgg[c.bucket] = { w: 0, l: 0 };
        calAgg[c.bucket].w += c.wins;
        calAgg[c.bucket].l += c.losses;
      }
    }
    for (const b of Object.keys(calAgg).map(Number).sort((a, b) => a - b)) {
      const v = calAgg[b];
      const t = v.w + v.l;
      const wr = t ? (v.w / t) * 100 : 0;
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + b + "%</td><td>" + t + "</td><td class='" + (wr >= b ? "win" : "loss") + "'>" + wr.toFixed(1) + "%</td>";
      calBody.appendChild(tr);
    }
  }

  function bindBacktest() {
    $("bt-run").addEventListener("click", runBacktest);
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
          '<span class="meta">' + esc(h.dir || "") + " · " + esc(h.asset || "—") + " · conf " + esc(finite(h.confidence, 0)) + "% · " + esc(h.regime || "—") + "<br>" + esc(tradeTimeline(h, true)) + '</span>' +
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
        const rows = [["entry_time", "expiry_time", "exit_time", "expiry_minutes", "asset", "dir", "outcome", "won", "entry_price", "exit_price", "confidence", "regime", "strategy", "pnl"]];
        for (const h of (s.history || [])) {
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
    tb.innerHTML = "";
    // Compute best per-asset strategy from the matrix if available.
    const bestMap = btResults ? HIST.bestPerAsset(btResults) : {};
    // Live stats
    STORE.getStats().then((stats) => {
      if (token !== assetsRenderToken || activeTab !== "assets") return;
      for (const a of ASSETS.list()) {
        const tr = document.createElement("tr");
        tr.className = "clickable";
        const live = stats.byAsset && stats.byAsset[a.id];
        const liveT = live ? live.w + live.l : 0;
        const liveWR = liveT ? ((live.w / liveT) * 100).toFixed(1) + "%" : "—";
        const best = bestMap[a.id];
        const histWR = best ? best.winrate.toFixed(1) + "%" : "—";
        tr.innerHTML =
          "<td>" + esc(a.name) + "</td>" +
          "<td>" + esc(a.kind) + "</td>" +
          "<td>" + esc(a.session) + "</td>" +
          "<td>" + esc(best ? best.strategy : "—") + "</td>" +
          "<td>" + histWR + "</td>" +
          "<td>" + liveWR + "</td>" +
          "<td>" + liveT + "</td>";
        tr.addEventListener("click", () => {
          if (hasChrome) {
            chrome.runtime.sendMessage({ type: "CYBER_SET_ASSET", asset: a.id }).then((response) => {
              if (response && response.ok) {
                activeAsset = response.asset || a.id;
                const sel = $("asset-select");
                if (sel) sel.value = activeAsset;
                activateTab("live");
              } else {
                const pill = $("link-state");
                if (pill) {
                  pill.textContent = response && response.error || "Select the asset on Quotex first";
                  pill.className = "pill warn";
                }
                activateTab("live");
              }
            }).catch(() => {});
            return;
          }
          activeAsset = a.id;
          const sel = $("asset-select");
          if (sel) sel.value = a.id;
          localFeed.setSeries(FEED.syntheticSeries(a, 240));
          activateTab("live");
        });
        tb.appendChild(tr);
      }
    }).catch(() => {});
  }

  /* ---------- settings tab ---------- */
  function refreshSettingsTab() {
    if (!settings) return;
    $("set-calibration").checked = settings.calibration !== false;
  }
  function bindSettingsTab() {
    $("set-calibration").addEventListener("change", (e) => {
      STORE.setSettings({ calibration: e.target.checked }).then((s) => { settings = s; }).catch(() => {
        e.target.checked = !!(settings && settings.calibration);
      });
    });
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
        // Register them with the assets catalog so detection works on the page too.
        for (const it of qxInstruments) {
          if (it && it.symbol) {
            try { ASSETS.registerQuotexAsset(it); } catch (_) {}
          }
        }
        refreshSelectors(); // v2.2: broker assets appear in the dropdown immediately
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
  function scale() {
    const w = window.innerWidth;
    document.documentElement.style.fontSize = Math.max(12, Math.min(17, w / 32)) + "px";
    // Redraw whatever was last rendered (live chart or demo chart), never a
    // stale local feed over live state.
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

  refreshSelectors();
  bindSelectors();
  bindAutoTab();
  bindInstrumentsTab();
  bindBacktest();
  bindHistoryTab();
  bindSettingsTab();
  loadAutoSettings();
  scale();
  paintQuotexPill();
  if (activeTab === "instruments") refreshInstrumentsTab();

  // Local demo loop
  localFeed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD"), 240));
  renderLocalTick();
  demoTimer = setInterval(renderLocalTick, 1500);
})();
