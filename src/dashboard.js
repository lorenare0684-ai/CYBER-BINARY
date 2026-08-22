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

  // Active local feed (for the dashboard's own chart when live data is missing).
  const localFeed = FEED.createFeed({ tfMs: 60000, max: 400 });
  localFeed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD"), 240));

  let activeAsset = "EURUSD";
  let activeStrategy = "confluence";
  let lastKey = "";
  let liveFromExt = false;
  let lastExtTs = 0;
  let autoState = null;
  let settings = null;
  let btResults = null;

  function $(id) { return document.getElementById(id); }
  function $all(sel) { return document.querySelectorAll(sel); }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toFixed(1) + "%";
  }
  function fmtPx(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const x = Number(n);
    return x >= 20 ? x.toFixed(2) : x.toFixed(5);
  }
  function fmtTime(ts) {
    if (!ts) return "—";
    const d = new Date(ts);
    return d.toLocaleTimeString();
  }
  function fmtDate(ts) {
    if (!ts) return "—";
    return new Date(ts).toLocaleString();
  }

  function meter(label, value, min, max, side) {
    const span = max - min || 1;
    const pct = Math.max(0, Math.min(100, ((value - min) / span) * 100));
    const cls = side ? "bar " + side : "bar";
    return (
      '<div class="meter"><span>' + label + '</span>' +
      '<div class="' + cls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<span>' + (value == null || Number.isNaN(value) ? "—" : Number(value).toFixed(1)) + '</span></div>'
    );
  }

  function drawChart(canvas, candles, opts) {
    if (!canvas) return;
    const o = opts || {};
    const parent = canvas.parentElement;
    const w = Math.max(280, parent.clientWidth);
    const h = Math.max(140, Math.round(w * 0.34));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = o.bg || "#0c1422";
    ctx.fillRect(0, 0, w, h);
    if (!candles || candles.length < 2) return;

    if (o.equity) {
      // Equity curve: simple line
      const eq = candles;
      let lo = -Math.max(1, Math.abs(eq[0].equity || 0));
      let hi = Math.max(1, Math.abs(eq[0].equity || 0));
      for (let i = 0; i < eq.length; i++) {
        if (eq[i].equity < lo) lo = eq[i].equity;
        if (eq[i].equity > hi) hi = eq[i].equity;
      }
      const pad = (hi - lo) * 0.1 || 1;
      lo -= pad; hi += pad;
      const zeroY = h - ((0 - lo) / (hi - lo)) * (h - 16) - 8;
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath(); ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); ctx.stroke();
      ctx.strokeStyle = "#4aa3ff";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < eq.length; i++) {
        const x = 8 + (i / (eq.length - 1)) * (w - 16);
        const y = h - ((eq[i].equity - lo) / (hi - lo)) * (h - 16) - 8;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      // fill
      const grad = ctx.createLinearGradient(0, 0, 0, h);
      grad.addColorStop(0, "rgba(74,163,255,0.3)");
      grad.addColorStop(1, "rgba(74,163,255,0)");
      ctx.fillStyle = grad;
      ctx.lineTo(w - 8, h - 8);
      ctx.lineTo(8, h - 8);
      ctx.closePath();
      ctx.fill();
      return;
    }

    // Candle
    const view = candles.slice(-80);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < view.length; i++) {
      lo = Math.min(lo, view[i].low);
      hi = Math.max(hi, view[i].high);
    }
    const pad = (hi - lo) * 0.08 || 0.0001;
    lo -= pad; hi += pad;
    const bw = (w - 16) / view.length;
    for (let i = 0; i < view.length; i++) {
      const c = view[i];
      const x = 8 + i * bw + bw / 2;
      const yH = h - ((c.high - lo) / (hi - lo)) * (h - 16) - 8;
      const yL = h - ((c.low - lo) / (hi - lo)) * (h - 16) - 8;
      const yO = h - ((c.open - lo) / (hi - lo)) * (h - 16) - 8;
      const yC = h - ((c.close - lo) / (hi - lo)) * (h - 16) - 8;
      const up = c.close >= c.open;
      ctx.strokeStyle = up ? "#3dff9a" : "#ff5d7a";
      ctx.fillStyle = up ? "#3dff9a" : "#ff5d7a";
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - Math.max(1, bw * 0.32), top, Math.max(2, bw * 0.64), bh);
    }
  }

  /* ---------- tab routing ---------- */
  function activateTab(name) {
    $all(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $all(".tab-pane").forEach((p) => p.classList.toggle("active", p.dataset.pane === name));
    if (name === "assets") refreshAssetsTab();
    if (name === "settings") refreshSettingsTab();
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
      activeAsset = e.target.value;
      if (hasChrome) {
        chrome.runtime.sendMessage({ type: "CYBER_SET_ASSET", asset: activeAsset }).catch(() => {});
      } else {
        // Re-seed local demo feed for the new asset.
        const a = ASSETS.get(activeAsset);
        if (a) localFeed.setSeries(FEED.syntheticSeries(a, 240));
      }
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
  function renderLive(state) {
    $("link-state").textContent = state.attached
      ? "Live · " + (state.source || "chart")
      : "Demo feed";
    $("link-state").className = "pill " + (state.attached ? "ok" : "dim");

    if (state.asset) $("asset").textContent = state.asset;
    if (state.price != null) $("price").textContent = fmtPx(state.price);
    if (state.assetId) {
      activeAsset = state.assetId;
      const sel = $("asset-select");
      if (sel && sel.value !== activeAsset) sel.value = activeAsset;
    }
    if (state.strategy) {
      activeStrategy = state.strategy;
      const sel = $("strategy-select");
      if (sel && sel.value !== activeStrategy) sel.value = activeStrategy;
    }

    const sig = state.signal || {};
    const dir = sig.direction || "WAIT";
    $("dir").textContent = dir;
    $("hero").dataset.dir = dir;
    $("reason").textContent = sig.reason || "Collecting candles…";
    $("regime-row").textContent = "regime: " + (sig.regime || "—") + " · mtf bias: " + ((sig.metrics && sig.metrics.mtfBias) || 0) + "/" + ((sig.metrics && sig.metrics.mtfChecked) || 0);

    $("wins").textContent = String(state.wins || 0);
    $("losses").textContent = String(state.losses || 0);
    $("winrate").textContent = fmtPct(state.winrate);
    $("accuracy").textContent = fmtPct(state.accuracy);

    const m = sig.metrics;
    if (m) {
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
        ["ATR%", m.atrPct ? (m.atrPct * 100).toFixed(3) + "%" : "—"],
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
        ["Score", m.score != null ? m.score : "—"],
        ["Confidence", sig.confidence + "%"],
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
          return '<div class="reading ' + cls + '"><span>' + r[0] + '</span><b>' +
            (typeof r[1] === "number" ? (Math.abs(r[1]) < 0.001 ? r[1].toExponential(2) : r[1].toFixed(4)) : r[1]) +
            '</b></div>';
        }).join("");
    }

    const ul = $("history");
    if (ul) {
      ul.innerHTML = "";
      (state.history || []).forEach((h) => {
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="' + (h.won ? "win" : "loss") + '">' + (h.won ? "WIN" : "LOSS") + '</span>' +
          '<span class="meta">' + (h.dir || "") + " · " + (h.asset || "—") + " · conf " + (h.confidence || 0) + "% · " + fmtTime(h.at) + '</span>' +
          '<span class="' + (h.won ? "win" : "loss") + '">' + (h.pnl != null ? (h.pnl > 0 ? "+" : "") + h.pnl.toFixed(2) : "") + '</span>';
        ul.appendChild(li);
      });
    }

    if (state.candles && state.candles.length) drawChart($("chart"), state.candles);
    if (state.autoState) updateAutoUI(state.autoState);
  }

  /* ---------- local demo rendering (no extension) ---------- */
  function renderLocalTick() {
    const last = localFeed.lastPrice() || 1.0854;
    const ev = localFeed.ingest(FEED.demoTick(last), Date.now());
    const series = localFeed.series();
    const strat = STRAT.get(activeStrategy) || STRAT.defaults();
    const sig = ENG.analyze(series, { strategy: activeStrategy, params: strat.params, weights: strat.weights, lean: false });
    sig.asset = activeAsset;
    sig.assetName = (ASSETS.get(activeAsset) || {}).name || activeAsset;
    sig.strategy = activeStrategy;
    const det = ASSETS.get(activeAsset) || {};
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
    autoState = s || autoState || { mode: "off", armed: false, tradesToday: 0, tradesHour: 0, dailyPnl: 0, lastTrade: null };
    const mode = (autoState.mode || "off");
    $("auto-mode-label").textContent = mode.toUpperCase();
    $("auto-hero").dataset.dir = mode === "click" ? "CALL" : mode === "alerts" ? "WAIT" : "PUT";
    $("auto-reason").textContent = autoState.armed
      ? (mode === "click"
        ? "Auto-click ARMED — placing trades on qualifying signals."
        : mode === "alerts"
          ? "Alerts ARMED — will beep &amp; notify on qualifying signals."
          : "Mode is off but auto is armed. Pick alerts or click.")
      : "Auto-trade is off. Pick a mode and arm it.";
    $("trades-today").textContent = String(autoState.tradesToday || 0);
    $("trades-hour").textContent = String(autoState.tradesHour || 0);
    const pnl = autoState.dailyPnl || 0;
    $("daily-pnl").textContent = (pnl > 0 ? "+" : "") + pnl.toFixed(2);
    $("daily-pnl").className = pnl > 0 ? "win" : pnl < 0 ? "loss" : "";
    $("last-trade").textContent = autoState.lastTrade
      ? (autoState.lastTrade.dir + " " + (autoState.lastTrade.asset || "") + " · " + fmtTime(autoState.lastTrade.at))
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

  function appendAutoLog(entry) {
    const ul = $("auto-log");
    if (!ul) return;
    const li = document.createElement("li");
    const cls = entry.level === "trade" || entry.level === "alert" ? "win"
      : entry.level === "error" ? "loss" : "";
    li.innerHTML =
      '<span class="' + cls + '">' + (entry.level || "log").toUpperCase() + '</span>' +
      '<span class="meta">' + fmtTime(entry.at) + '</span>' +
      '<span>' + entry.msg + '</span>';
    ul.prepend(li);
    while (ul.children.length > 50) ul.removeChild(ul.lastChild);
  }

  function bindAutoTab() {
    const setSettings = (patch) => {
      STORE.setSettings(patch).then((s) => { settings = s; });
    };
    $("auto-mode").addEventListener("change", (e) => setSettings({ autoMode: e.target.value, armed: e.target.value !== "off" ? settings && settings.armed : false }));
    $("min-confidence").addEventListener("change", (e) => setSettings({ minConfidence: Number(e.target.value) || 0 }));
    $("stake").addEventListener("change", (e) => setSettings({ stake: Number(e.target.value) || 1 }));
    $("expiry").addEventListener("change", (e) => setSettings({ expiry: Number(e.target.value) || 3 }));
    $("max-hour").addEventListener("change", (e) => setSettings({ maxTradesPerHour: Number(e.target.value) || 0 }));
    $("max-day").addEventListener("change", (e) => setSettings({ maxTradesPerDay: Number(e.target.value) || 0 }));
    $("loss-cap").addEventListener("change", (e) => setSettings({ dailyLossCap: Number(e.target.value) || 0 }));
    $("profit-cap").addEventListener("change", (e) => setSettings({ dailyProfitCap: Number(e.target.value) || 0 }));
    $("cooldown").addEventListener("change", (e) => setSettings({ cooldownBars: Number(e.target.value) || 0 }));
    $("notify-sound").addEventListener("change", (e) => setSettings({ notifySound: e.target.checked }));
    $("notify-desktop").addEventListener("change", (e) => setSettings({ notifyDesktop: e.target.checked }));
    $("arm-btn").addEventListener("click", () => {
      const next = !settings.armed;
      setSettings({ armed: next });
      if (hasChrome) chrome.runtime.sendMessage({ type: "CYBER_SET_AUTO", mode: settings.autoMode, armed: next }).catch(() => {});
      else updateAutoUI(Object.assign({}, autoState, { armed: next }));
    });
    $("test-sound").addEventListener("click", () => AUTO.playBeep("CALL"));
  }

  function loadAutoSettings() {
    STORE.getSettings().then((s) => {
      settings = s;
      $("auto-mode").value = s.autoMode || "off";
      $("min-confidence").value = s.minConfidence || 65;
      $("stake").value = s.stake || 1;
      $("expiry").value = s.expiry || 3;
      $("max-hour").value = s.maxTradesPerHour || 12;
      $("max-day").value = s.maxTradesPerDay || 60;
      $("loss-cap").value = s.dailyLossCap || 30;
      $("profit-cap").value = s.dailyProfitCap || 0;
      $("cooldown").value = s.cooldownBars || 2;
      $("notify-sound").checked = s.notifySound !== false;
      $("notify-desktop").checked = !!s.notifyDesktop;
      activeStrategy = s.strategy || "confluence";
      const sel = $("strategy-select");
      if (sel) sel.value = activeStrategy;
    });
  }

  /* ---------- backtest tab ---------- */
  function runBacktest() {
    const days = Number($("bt-days").value) || 7;
    const horizon = Number($("bt-horizon").value) || 3;
    const minConf = Number($("bt-minconf").value) || 0;
    const kind = $("bt-kinds").value;
    const kinds = kind === "all" ? null : [kind];
    const o = { days, horizon, minConf, kinds, minBars: 150 };

    const btn = $("bt-run");
    btn.disabled = true;
    const origLabel = btn.textContent;
    btn.textContent = "Starting…";

    const useWorkers = WORKERS && WORKERS.runBrowser;
    const p = useWorkers
      ? WORKERS.runBrowser(o).catch((e) => { console.error(e); return { results: [] }; })
      : new Promise((resolve) => setTimeout(() => resolve(HIST.runMatrix(o)), 30));

    function tick(i, total) {
      if (total) btn.textContent = "Running " + i + " / " + total + "…";
    }
    if (useWorkers) o.onProgress = tick;

    p.then((r) => {
      btResults = r;
      paintBacktest(r, o);
    }).catch((e) => {
      console.error(e);
    }).then(() => {
      btn.disabled = false;
      btn.textContent = origLabel;
    });
  }

  function paintBacktest(matrix, opts) {
    const sum = HIST.summarize(matrix);
    $("bt-trades").textContent = String(sum && sum.trades || 0);
    $("bt-winrate").textContent = fmtPct(sum && sum.winrate);
    $("bt-pnl").textContent = String(sum && sum.pnl || 0);
    $("bt-dd").textContent = "—";

    // Aggregate equity across all runs
    const eq = [];
    let cum = 0;
    for (const r of matrix.results) {
      // Re-run to get equity? Use a quick representative.
    }
    // Better: re-run with one strategy per asset for equity.
    // For brevity, synthesize an equity curve from per-asset P&L counts.
    let running = 0;
    const seq = [];
    for (const r of matrix.results) {
      for (let i = 0; i < r.wins; i++) { running++; seq.push({ equity: running }); }
      for (let i = 0; i < r.losses; i++) { running--; seq.push({ equity: running }); }
    }
    drawChart($("bt-equity"), seq, { equity: true });

    // Per-strategy
    const stBody = $("bt-strategies").querySelector("tbody");
    stBody.innerHTML = "";
    for (const k of Object.keys(sum.byStrategy).sort((a, b) => sum.byStrategy[b].winrate - sum.byStrategy[a].winrate)) {
      const v = sum.byStrategy[k];
      const tr = document.createElement("tr");
      tr.innerHTML = "<td>" + k + "</td><td>" + v.total + "</td><td class='win'>" + v.wins + "</td><td class='loss'>" + v.losses + "</td><td>" + v.winrate.toFixed(1) + "%</td>";
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
      tr.innerHTML = "<td>" + (v.name || k) + "</td><td>" + t + "</td><td class='" + (wr >= 55 ? "win" : wr <= 45 ? "loss" : "") + "'>" + wr.toFixed(1) + "%</td><td>" + v.pnl + "</td><td>" + v.dd + "</td>";
      aBody.appendChild(tr);
    }

    // Regime breakdown (aggregate)
    const regBody = $("bt-regimes").querySelector("tbody");
    regBody.innerHTML = "";
    const regAgg = {};
    for (const r of matrix.results) {
      for (const reg of Object.keys(r.byRegime)) {
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
      tr.innerHTML = "<td>" + k + "</td><td>" + t + "</td><td class='" + (wr >= 55 ? "win" : wr <= 45 ? "loss" : "") + "'>" + wr.toFixed(1) + "%</td>";
      regBody.appendChild(tr);
    }

    // Calibration
    const calBody = $("bt-calib").querySelector("tbody");
    calBody.innerHTML = "";
    const calAgg = {};
    for (const r of matrix.results) {
      for (const c of r.calibration) {
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
    STORE.getStats().then((stats) => {
      const dir = $("hist-dir").value;
      const out = $("hist-outcome").value;
      const asset = $("hist-asset").value;
      const list = (stats.history || []).filter((h) => {
        if (dir !== "all" && h.dir !== dir) return false;
        if (out === "win" && !h.won) return false;
        if (out === "loss" && h.won) return false;
        if (asset !== "all" && h.asset !== asset) return false;
        return true;
      });
      const w = list.filter((h) => h.won).length;
      const l = list.length - w;
      $("hist-count").textContent = list.length;
      $("hist-wins").textContent = w;
      $("hist-losses").textContent = l;
      $("hist-wr").textContent = list.length ? ((w / list.length) * 100).toFixed(1) + "%" : "—";
      const ul = $("hist-list");
      ul.innerHTML = "";
      for (const h of list.slice(0, 100)) {
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="' + (h.won ? "win" : "loss") + '">' + (h.won ? "WIN" : "LOSS") + '</span>' +
          '<span class="meta">' + h.dir + " · " + (h.asset || "—") + " · conf " + (h.confidence || 0) + "% · " + (h.regime || "—") + " · " + fmtDate(h.at) + '</span>' +
          '<span class="' + (h.won ? "win" : "loss") + '">' + (h.pnl != null ? (h.pnl > 0 ? "+" : "") + h.pnl.toFixed(2) : "") + '</span>';
        ul.appendChild(li);
      }
    });
  }
  function bindHistoryTab() {
    $("hist-dir").addEventListener("change", refreshHistoryTab);
    $("hist-outcome").addEventListener("change", refreshHistoryTab);
    $("hist-asset").addEventListener("change", refreshHistoryTab);
    $("hist-export").addEventListener("click", () => {
      STORE.getStats().then((s) => {
        const rows = [["at", "asset", "dir", "won", "entry", "exit", "confidence", "regime", "strategy", "pnl"]];
        for (const h of (s.history || [])) {
          rows.push([new Date(h.at).toISOString(), h.asset, h.dir, h.won ? 1 : 0, h.entry, h.exit, h.confidence, h.regime, h.strategy, h.pnl]);
        }
        const csv = rows.map((r) => r.map((v) => v == null ? "" : String(v).replace(/"/g, '""')).map((v) => /[",\n]/.test(v) ? '"' + v + '"' : v).join(",")).join("\n");
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = "cyber-binary-history.csv"; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    });
    $("hist-clear").addEventListener("click", () => {
      if (!confirm("Clear all history and stats?")) return;
      STORE.reset().then(() => refreshHistoryTab());
    });
  }

  /* ---------- assets tab ---------- */
  function refreshAssetsTab() {
    const tb = $("asset-table").querySelector("tbody");
    tb.innerHTML = "";
    // Compute best per-asset strategy from the matrix if available.
    const bestMap = btResults ? HIST.bestPerAsset(btResults) : {};
    // Live stats
    STORE.getStats().then((stats) => {
      for (const a of ASSETS.list()) {
        const tr = document.createElement("tr");
        tr.className = "clickable";
        const live = stats.byAsset && stats.byAsset[a.id];
        const liveT = live ? live.w + live.l : 0;
        const liveWR = liveT ? ((live.w / liveT) * 100).toFixed(1) + "%" : "—";
        const best = bestMap[a.id];
        const histWR = best ? best.winrate.toFixed(1) + "%" : "—";
        tr.innerHTML =
          "<td>" + a.name + "</td>" +
          "<td>" + a.kind + "</td>" +
          "<td>" + a.session + "</td>" +
          "<td>" + (best ? best.strategy : "—") + "</td>" +
          "<td>" + histWR + "</td>" +
          "<td>" + liveWR + "</td>" +
          "<td>" + liveT + "</td>";
        tr.addEventListener("click", () => {
          activeAsset = a.id;
          const sel = $("asset-select");
          if (sel) sel.value = a.id;
          activateTab("live");
        });
        tb.appendChild(tr);
      }
    });
  }

  /* ---------- settings tab ---------- */
  function refreshSettingsTab() {
    if (!settings) return;
    $("set-calibration").checked = settings.calibration !== false;
  }
  function bindSettingsTab() {
    $("set-calibration").addEventListener("change", (e) => {
      STORE.setSettings({ calibration: e.target.checked });
    });
    $("reset-stats").addEventListener("click", () => {
      if (!confirm("Erase all stats, history, calibration, and candle cache?")) return;
      STORE.reset();
    });
  }

  /* ---------- auto message wiring ---------- */
  if (hasChrome) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "CYBER_STATE_PUSH" && msg.payload) {
        liveFromExt = true; lastExtTs = Date.now();
        renderLive(msg.payload);
      }
      if (msg && msg.type === "CYBER_AUTO_STATE" && msg.payload) {
        updateAutoUI(msg.payload);
      }
      if (msg && msg.type === "CYBER_AUTO_LOG" && msg.payload) {
        appendAutoLog(msg.payload);
      }
    });
    chrome.runtime.sendMessage({ type: "CYBER_GET_STATE" }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res && res.payload) {
        liveFromExt = true; lastExtTs = Date.now();
        renderLive(res.payload);
      }
    });
  }

  /* ---------- bootstrap ---------- */
  function scale() {
    const w = window.innerWidth;
    document.documentElement.style.fontSize = Math.max(12, Math.min(17, w / 32)) + "px";
    const series = localFeed.series();
    if (series.length) drawChart($("chart"), series);
    if (btResults) drawChart($("bt-equity"), [], { equity: true });
  }
  window.addEventListener("resize", scale);

  refreshSelectors();
  bindSelectors();
  bindAutoTab();
  bindBacktest();
  bindHistoryTab();
  bindSettingsTab();
  loadAutoSettings();
  scale();

  // Local demo loop
  localFeed.setSeries(FEED.syntheticSeries(ASSETS.get("EURUSD"), 240));
  renderLocalTick();
  setInterval(renderLocalTick, 1500);
})();
