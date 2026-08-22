"use strict";

(function () {
  const hasChrome = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id;
  const feed = self.CYBER_FEED.createFeed({ tfMs: 60000, max: 240 });
  const stats = { wins: 0, losses: 0, pending: null, history: [] };
  let lastKey = "";
  let liveFromExt = false;
  let lastExtTs = 0;

  function $(id) {
    return document.getElementById(id);
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toFixed(1) + "%";
  }

  function fmtPx(n) {
    if (n == null || Number.isNaN(n)) return "—";
    const x = Number(n);
    return x >= 20 ? x.toFixed(2) : x.toFixed(5);
  }

  function meter(label, value, min, max) {
    const span = max - min || 1;
    const pct = Math.max(0, Math.min(100, ((value - min) / span) * 100));
    return (
      '<div class="meter"><span>' +
      label +
      '</span><div class="bar"><i style="width:' +
      pct.toFixed(1) +
      '%"></i></div><span>' +
      (value == null || Number.isNaN(value) ? "—" : Number(value).toFixed(1)) +
      "</span></div>"
    );
  }

  function drawChart(candles) {
    const canvas = $("chart");
    if (!canvas) return;
    const parent = canvas.parentElement;
    const w = Math.max(280, parent.clientWidth);
    const h = Math.max(160, Math.round(w * 0.34));
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0c1422";
    ctx.fillRect(0, 0, w, h);
    if (!candles || candles.length < 2) return;

    const view = candles.slice(-80);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < view.length; i++) {
      lo = Math.min(lo, view[i].low);
      hi = Math.max(hi, view[i].high);
    }
    const pad = (hi - lo) * 0.08 || 0.0001;
    lo -= pad;
    hi += pad;
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
      ctx.beginPath();
      ctx.moveTo(x, yH);
      ctx.lineTo(x, yL);
      ctx.stroke();
      const top = Math.min(yO, yC);
      const bh = Math.max(1, Math.abs(yC - yO));
      ctx.fillRect(x - Math.max(1, bw * 0.32), top, Math.max(2, bw * 0.64), bh);
    }
  }

  function render(state) {
    if (!state) return;
    $("link-state").textContent = state.attached
      ? "Live · " + (state.source || "chart")
      : "Demo feed";
    $("link-state").className = "pill " + (state.attached ? "ok" : "dim");
    $("asset").textContent = state.asset || "—";
    $("price").textContent = fmtPx(state.price);

    const sig = state.signal || {};
    const dir = sig.direction || "WAIT";
    $("dir").textContent = dir;
    $("hero").dataset.dir = dir;
    $("reason").textContent = sig.reason || "Collecting candles…";

    $("wins").textContent = String(state.wins || 0);
    $("losses").textContent = String(state.losses || 0);
    $("winrate").textContent = fmtPct(state.winrate);
    $("accuracy").textContent = fmtPct(state.accuracy);

    const m = sig.metrics;
    if (m) {
      $("meters").innerHTML =
        meter("RSI", m.rsi, 0, 100) +
        meter("Stoch", m.stochK, 0, 100) +
        meter("Conf", sig.confidence || 0, 0, 100);
    }

    const ul = $("history");
    ul.innerHTML = "";
    (state.history || []).forEach(function (h) {
      const li = document.createElement("li");
      li.innerHTML =
        "<span>" +
        h.dir +
        "</span><span class=\"" +
        (h.won ? "win" : "loss") +
        "\">" +
        (h.won ? "WIN" : "LOSS") +
        "</span>";
      ul.appendChild(li);
    });

    if (state.candles && state.candles.length) drawChart(state.candles);
  }

  function settle(closed) {
    const p = stats.pending;
    if (!p || !closed || closed.time < p.expireAt) return;
    const won =
      (p.dir === "CALL" && closed.close > p.entry) ||
      (p.dir === "PUT" && closed.close < p.entry);
    if (won) stats.wins += 1;
    else stats.losses += 1;
    stats.history.unshift({ dir: p.dir, won: won, entry: p.entry, exit: closed.close, at: closed.time });
    if (stats.history.length > 40) stats.history.pop();
    stats.pending = null;
  }

  function localStep() {
    if (liveFromExt && Date.now() - lastExtTs < 4000) return;
    liveFromExt = false;
    const last = feed.lastPrice() || 1.0854;
    const ev = feed.ingest(self.CYBER_FEED.demoTick(last), Date.now());
    if (ev && ev.closed) settle(ev.closed);
    const series = feed.series();
    const sig = self.CYBER_ENGINE.analyze(series);
    if (sig.ready && sig.direction !== "WAIT" && !stats.pending && series.length > 2) {
      const closed = series[series.length - 2];
      const key = closed.time + ":" + sig.direction;
      if (key !== lastKey) {
        lastKey = key;
        stats.pending = { dir: sig.direction, entry: closed.close, expireAt: closed.time + 180000 };
      }
    }
    const total = stats.wins + stats.losses;
    render({
      attached: false,
      source: "demo",
      asset: "EURUSD · demo",
      price: feed.lastPrice(),
      candles: series,
      signal: sig,
      wins: stats.wins,
      losses: stats.losses,
      pending: stats.pending,
      history: stats.history.slice(0, 12),
      winrate: total ? (stats.wins / total) * 100 : 0,
      accuracy: total ? (stats.wins / total) * 100 : 0,
    });
  }

  function scale() {
    const w = window.innerWidth;
    document.documentElement.style.fontSize = Math.max(12, Math.min(18, w / 28)) + "px";
    const series = feed.series();
    if (series.length) drawChart(series);
  }

  window.addEventListener("resize", scale);
  scale();
  feed.seedHistory(120, 1.0854);
  localStep();
  setInterval(localStep, 700);

  if (hasChrome) {
    chrome.runtime.onMessage.addListener(function (msg) {
      if (msg && msg.type === "CYBER_STATE_PUSH" && msg.payload) {
        liveFromExt = true;
        lastExtTs = Date.now();
        render(msg.payload);
      }
    });
    chrome.runtime.sendMessage({ type: "CYBER_GET_STATE" }, function (res) {
      if (chrome.runtime.lastError) return;
      if (res && res.payload) {
        liveFromExt = true;
        lastExtTs = Date.now();
        render(res.payload);
      }
    });
  }
})();
