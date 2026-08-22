"use strict";

function $(id) {
  return document.getElementById(id);
}

function fmtPct(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(1) + "%";
}

function fmtPx(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toFixed(5);
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
    (value == null ? "—" : Number(value).toFixed(1)) +
    "</span></div>"
  );
}

function render(state) {
  if (!state) return;
  $("link-state").textContent = state.attached ? "Live on chart" : "Idle";
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
  (state.history || []).forEach((h) => {
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
}

function scale() {
  const w = window.innerWidth;
  document.documentElement.style.fontSize = Math.max(12, Math.min(18, w / 28)) + "px";
}

window.addEventListener("resize", scale);
scale();

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "CYBER_STATE_PUSH") render(msg.payload);
});

chrome.runtime.sendMessage({ type: "CYBER_GET_STATE" }, (res) => {
  if (chrome.runtime.lastError) return;
  if (res && res.payload) render(res.payload);
});

chrome.storage.local.get("cyberStats", (d) => {
  const s = d && d.cyberStats;
  if (!s) return;
  const total = (s.wins || 0) + (s.losses || 0);
  render({
    attached: false,
    wins: s.wins || 0,
    losses: s.losses || 0,
    history: s.history || [],
    winrate: total ? (s.wins / total) * 100 : 0,
    accuracy: total ? (s.wins / total) * 100 : 0,
    signal: { direction: "WAIT", reason: "Restored last session stats" },
  });
});
