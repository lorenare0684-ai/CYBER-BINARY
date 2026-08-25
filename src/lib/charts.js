/**
 * CYBER CHARTS v4 — Deep integration with trading engine
 * Vanilla canvas, high-DPI, interactive, regime/session/order overlays
 */
(function (root) {
  "use strict";

  const TA = root.CYBER_TA || null;

  function finite(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback == null ? null : fallback;
  }

  function fmtPx(n, decimals) {
    const x = finite(n, null);
    if (x == null) return "—";
    if (decimals != null && Number.isFinite(decimals)) return x.toFixed(decimals);
    return Math.abs(x) >= 20 ? x.toFixed(2) : x.toFixed(5);
  }

  function axisTimeLabel(time, utc) {
    const d = new Date(Number(time));
    if (!Number.isFinite(d.getTime())) return "";
    const two = (n) => (n < 10 ? "0" + n : String(n));
    if (utc !== false) return two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
    return two(d.getHours()) + ":" + two(d.getMinutes());
  }

  function axisDateLabel(time, utc) {
    const d = new Date(Number(time));
    if (!Number.isFinite(d.getTime())) return "";
    const two = (n) => (n < 10 ? "0" + n : String(n));
    if (utc !== false) return two(d.getUTCDate()) + "/" + two(d.getUTCMonth()+1) + " " + two(d.getUTCHours()) + ":" + two(d.getUTCMinutes());
    return two(d.getMonth()+1) + "/" + two(d.getDate()) + " " + two(d.getHours()) + ":" + two(d.getMinutes());
  }

  function fmtDuration(ms) {
    if (!Number.isFinite(ms)) return "—";
    const s = Math.floor(ms/1000);
    const m = Math.floor(s/60);
    const sec = s%60;
    if (m>0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  const REGIME_COLORS = {
    trending: "rgba(61,255,154,0.06)",
    uptrend: "rgba(61,255,154,0.07)",
    downtrend: "rgba(255,93,122,0.06)",
    ranging: "rgba(255,196,87,0.06)",
    volatile: "rgba(255,93,122,0.08)",
    choppy: "rgba(255,196,87,0.08)",
    breakout: "rgba(127,245,255,0.06)",
    squeeze: "rgba(180,120,255,0.06)",
  };

  const SESSION_COLORS = {
    london: "rgba(0,229,255,0.03)",
    newyork: "rgba(255,196,87,0.03)",
    overlap: "rgba(61,255,154,0.04)",
    tokyo: "rgba(180,120,255,0.03)",
    sydney: "rgba(255,93,122,0.02)",
  };

  const chartStates = new Map();

  function getState(canvas) {
    if (!canvas) return null;
    let s = chartStates.get(canvas);
    if (!s) {
      s = {
        visibleBars: 120,
        scrollOffset: 0,
        chartType: "candle",
        showVolume: true,
        showEMA: true,
        showBB: false,
        showRSI: false,
        showMACD: true,
        showOrders: true,
        showRegime: true,
        showLevels: true,
        crosshair: null,
        isDragging: false,
        dragStartX: 0,
        dragStartOffset: 0,
        hoverIdx: -1,
        tooltipEl: null,
        decimals: null,
        lastSignal: null,
        lastRegime: null,
        lastSession: null,
        highlightedTradeId: null,
      };
      chartStates.set(canvas, s);
    }
    return s;
  }

  function ensureTooltip(canvas) {
    const state = getState(canvas);
    if (state.tooltipEl && document.body.contains(state.tooltipEl)) return state.tooltipEl;
    const tip = document.createElement("div");
    tip.className = "chart-tooltip";
    tip.style.cssText = "position:absolute;pointer-events:none;z-index:10000;display:none;min-width:200px;max-width:300px;background:rgba(7,17,31,0.97);border:1px solid rgba(0,229,255,0.28);border-radius:12px;padding:12px 14px;font:11px/1.45 ui-monospace,monospace;color:#e8eefc;box-shadow:0 12px 40px rgba(0,0,0,0.6),0 0 0 1px rgba(0,229,255,0.1);backdrop-filter:blur(16px);";
    document.body.appendChild(tip);
    state.tooltipEl = tip;
    return tip;
  }

  function heikinAshi(candles) {
    const out = [];
    let haOpen = null, haClose = null;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const close = (c.open + c.high + c.low + c.close) / 4;
      if (i === 0) haOpen = (c.open + c.close) / 2;
      else haOpen = (haOpen + haClose) / 2;
      haClose = close;
      const high = Math.max(c.high, haOpen, haClose);
      const low = Math.min(c.low, haOpen, haClose);
      out.push({ time: c.time, open: haOpen, high, low, close: haClose, volume: c.volume || 0, orig: c });
    }
    return out;
  }

  function computeIndicators(view) {
    if (!view || view.length < 2) return {};
    const closes = view.map(c => c.close);
    const highs = view.map(c => c.high);
    const lows = view.map(c => c.low);
    const volumes = view.map(c => c.volume || 0);
    const res = {};
    if (TA) {
      try {
        res.ema8 = TA.ema(closes, 8);
        res.ema21 = TA.ema(closes, 21);
        res.ema50 = TA.ema(closes, 50);
        res.bb = TA.bollinger(closes, 20, 2);
        res.rsi = TA.rsi(closes, 14);
        res.macd = TA.macd(closes, 12, 26, 9);
        res.atr = TA.atr(highs, lows, closes, 14);
        res.volumeSma = TA.sma(volumes, 20);
        res.supertrend = TA.supertrend(highs, lows, closes, 10, 3);
        res.psar = TA.psar(highs, lows, { step: 0.02, max: 0.2 });
        res.donchian = TA.donchian(highs, lows, 20);
        res.stoch = TA.stochastic(highs, lows, closes, 14, 3);
        res.adx = TA.adx(highs, lows, closes, 14);
      } catch (e) {}
    }
    return res;
  }

  function niceTicks(min, max, count) {
    count = count || 5;
    const range = max - min;
    if (range <= 0) return [min];
    const rough = range / count;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / pow10;
    let step;
    if (norm < 1.5) step = pow10;
    else if (norm < 3.5) step = 2 * pow10;
    else if (norm < 7.5) step = 5 * pow10;
    else step = 10 * pow10;
    const start = Math.floor(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + step*0.5; v += step) {
      if (v >= min - step*0.5 && v <= max + step*0.5) ticks.push(v);
    }
    return ticks;
  }

  function drawRegimeBackground(ctx, view, xFor, priceH, padL, plotW, opts) {
    const state = opts._state;
    if (!state || !state.showRegime) return;
    // Regime comes from signal or opts.regimeTimeline (array of {idx, regime})
    // For simplicity, if opts.regime is single value, shade whole background lightly
    // If opts.regimeTimeline provided, shade per segment
    const regime = opts.regime || (opts.signal && opts.signal.regime);
    if (regime && REGIME_COLORS[regime.toLowerCase()]) {
      ctx.fillStyle = REGIME_COLORS[regime.toLowerCase()];
      ctx.fillRect(padL, 0, plotW, priceH);
    }
    if (Array.isArray(opts.regimeTimeline) && opts.regimeTimeline.length) {
      for (let i=0;i<opts.regimeTimeline.length;i++) {
        const seg = opts.regimeTimeline[i];
        if (!seg || seg.idx==null) continue;
        const color = REGIME_COLORS[(seg.regime||"").toLowerCase()] || "rgba(255,255,255,0.02)";
        const x = xFor(seg.idx);
        const nextX = i+1<opts.regimeTimeline.length ? xFor(opts.regimeTimeline[i+1].idx) : padL+plotW;
        ctx.fillStyle = color;
        ctx.fillRect(x, 0, nextX-x, priceH);
      }
    }
  }

  function drawOrderLines(ctx, view, xFor, yPrice, priceH, padL, plotW, opts) {
    const state = opts._state;
    if (!state || !state.showOrders) return;
    const orders = opts.openOrders || [];
    const pending = opts.pending;
    const allOrders = [];
    if (pending && typeof pending === "object") {
      allOrders.push({ ...pending, isPending: true, isVirtual: true });
    }
    for (const o of orders) {
      if (o && o.openPrice) allOrders.push(o);
    }
    for (const order of allOrders.slice(0, 12)) {
      const entry = Number(order.openPrice || order.entry || order.entryPrice);
      if (!Number.isFinite(entry)) continue;
      const y = yPrice(entry);
      if (y < -20 || y > priceH+20) continue;
      const isCall = (order.direction || order.dir) === "CALL";
      const isPending = order.isPending || order.isVirtual;
      ctx.strokeStyle = isPending ? (isCall ? "rgba(61,255,154,0.5)" : "rgba(255,93,122,0.5)") : (isCall ? "rgba(61,255,154,0.85)" : "rgba(255,93,122,0.85)");
      ctx.setLineDash(isPending ? [6,4] : [0,0]);
      ctx.lineWidth = isPending ? 1 : 1.2;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      // Label
      const label = `${order.asset||""} ${order.direction||order.dir||""} @ ${fmtPx(entry, state.decimals)}`;
      ctx.fillStyle = isCall ? "rgba(61,255,154,0.95)" : "rgba(255,93,122,0.95)";
      ctx.font = "bold 9px ui-monospace, monospace";
      const tw = ctx.measureText(label).width + 10;
      ctx.fillRect(padL, y-12, tw, 13);
      ctx.fillStyle = "#0a1420";
      ctx.fillText(label, padL+5, y-3);
      // Expiry line if available
      const expiry = Number(order.expiryTime || order.closeTime || order.expireAt);
      if (Number.isFinite(expiry) && expiry>0) {
        // Find x for expiry time
        let expiryIdx = -1;
        for (let i=0;i<view.length;i++) {
          if (view[i].time >= expiry) { expiryIdx=i; break; }
        }
        if (expiryIdx>=0) {
          const ex = xFor(expiryIdx);
          ctx.strokeStyle = "rgba(255,196,87,0.5)";
          ctx.setLineDash([4,4]);
          ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, priceH); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = "rgba(255,196,87,0.9)";
          ctx.fillRect(ex-18, 2, 36, 12);
          ctx.fillStyle = "#0a1420";
          ctx.font = "8px ui-monospace, monospace";
          ctx.textAlign = "center";
          ctx.fillText("EXP", ex, 10);
          ctx.textAlign = "left";
        }
      }
    }
  }

  function drawLevels(ctx, view, xFor, yPrice, priceH, opts) {
    const state = opts._state;
    if (!state || !state.showLevels) return;
    const ind = opts._indicators || {};
    // Supertrend
    if (ind.supertrend && ind.supertrend.st) {
      ctx.strokeStyle = "rgba(127,245,255,0.5)";
      ctx.lineWidth = 1;
      ctx.beginPath(); let started=false;
      for (let i=0;i<view.length;i++) {
        const v = ind.supertrend.st[i];
        if (v==null) continue;
        const x=xFor(i), y=yPrice(v);
        if (!started) { ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
    // PSAR dots
    if (ind.psar) {
      for (let i=0;i<view.length;i++) {
        const v = ind.psar[i];
        if (v==null) continue;
        const x=xFor(i), y=yPrice(v);
        if (y<-10 || y>priceH+10) continue;
        ctx.fillStyle = "rgba(255,196,87,0.8)";
        ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI*2); ctx.fill();
      }
    }
    // Donchian
    if (ind.donchian) {
      const drawLine = (arr, color) => {
        if (!arr) return;
        ctx.strokeStyle=color; ctx.lineWidth=1; ctx.setLineDash([3,3]); ctx.beginPath(); let s=false;
        for (let i=0;i<arr.length;i++){ if(arr[i]==null) continue; const x=xFor(i), y=yPrice(arr[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
        ctx.stroke(); ctx.setLineDash([]);
      };
      drawLine(ind.donchian.upper, "rgba(255,255,255,0.18)");
      drawLine(ind.donchian.lower, "rgba(255,255,255,0.18)");
    }
  }

  function drawMainChart(canvas, rawCandles, opts) {
    if (!canvas) return;
    opts = opts || {};
    const state = getState(canvas);
    if (opts.chartType) state.chartType = opts.chartType;
    if (typeof opts.showVolume === "boolean") state.showVolume = opts.showVolume;
    if (typeof opts.showEMA === "boolean") state.showEMA = opts.showEMA;
    if (typeof opts.showBB === "boolean") state.showBB = opts.showBB;
    if (typeof opts.showRSI === "boolean") state.showRSI = opts.showRSI;
    if (typeof opts.showMACD === "boolean") state.showMACD = opts.showMACD;
    if (typeof opts.showOrders === "boolean") state.showOrders = opts.showOrders;
    if (typeof opts.showRegime === "boolean") state.showRegime = opts.showRegime;
    if (typeof opts.showLevels === "boolean") state.showLevels = opts.showLevels;
    if (opts.decimals != null) state.decimals = opts.decimals;
    if (opts.visibleBars) state.visibleBars = opts.visibleBars;
    if (opts.signal) state.lastSignal = opts.signal;
    if (opts.regime) state.lastRegime = opts.regime;
    if (opts.session) state.lastSession = opts.session;

    const parent = canvas.parentElement;
    const parentWidth = finite(parent && parent.clientWidth, 0);
    const viewportWidth = finite(window.innerWidth, 480);
    const w = Math.max(320, Math.min(4096, parentWidth || viewportWidth || 800));
    const dpr = Math.max(1, Math.min(2, finite(window.devicePixelRatio, 1)));

    const showVol = state.showVolume;
    const showMacd = state.showMACD;
    const showRsi = state.showRSI;
    const volH = showVol ? Math.max(36, Math.round(w * 0.07)) : 0;
    const macdH = showMacd ? Math.max(56, Math.round(w * 0.13)) : 0;
    const rsiH = showRsi ? Math.max(48, Math.round(w * 0.11)) : 0;
    const timeAxisH = 22;
    const priceH = Math.max(180, Math.round(w * 0.36));
    const totalH = priceH + volH + macdH + rsiH + timeAxisH + (showVol||showMacd||showRsi ? 12 : 0);

    const pixelW = Math.floor(w * dpr), pixelH = Math.floor(totalH * dpr);
    if (canvas.width !== pixelW) canvas.width = pixelW;
    if (canvas.height !== pixelH) canvas.height = pixelH;
    if (canvas.style.width !== w + "px") canvas.style.width = w + "px";
    if (canvas.style.height !== totalH + "px") canvas.style.height = totalH + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, totalH);

    const bgGrad = ctx.createLinearGradient(0, 0, 0, totalH);
    bgGrad.addColorStop(0, opts.bgTop || "#0c1422");
    bgGrad.addColorStop(1, opts.bgBottom || "#0a1220");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, totalH);

    if (!Array.isArray(rawCandles) || rawCandles.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(opts.emptyMessage || "Waiting for candles…", w/2, totalH/2);
      return;
    }

    const byTime = new Map();
    for (const raw of rawCandles) {
      if (!raw) continue;
      let time = Number(raw.time);
      const open = Number(raw.open), close = Number(raw.close);
      if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(close) || open <= 0 || close <= 0) continue;
      while (Math.abs(time) >= 1e14) time /= 1000;
      if (Math.abs(time) < 1e11) time *= 1000;
      time = Math.floor(time);
      if (!Number.isFinite(time) || time <= 0) continue;
      const rawHigh = Number(raw.high), rawLow = Number(raw.low);
      const validHigh = Number.isFinite(rawHigh) && rawHigh > 0 ? rawHigh : open;
      const validLow = Number.isFinite(rawLow) && rawLow > 0 ? rawLow : close;
      const high = Math.max(validHigh, validLow, open, close);
      const low = Math.min(validHigh, validLow, open, close);
      const vol = Number(raw.volume);
      byTime.set(time, { time, open, high, low, close, volume: Number.isFinite(vol) && vol >=0 ? vol : 0 });
    }
    let normalized = Array.from(byTime.values()).sort((a,b)=>a.time-b.time);
    if (normalized.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Waiting for valid broker candles…", w/2, totalH/2);
      return;
    }

    let displayCandles = normalized;
    if (state.chartType === "heikin") displayCandles = heikinAshi(normalized);

    const totalBars = displayCandles.length;
    let visBars = Math.max(20, Math.min(500, Math.floor(state.visibleBars)));
    let scroll = Math.max(0, Math.min(totalBars - 10, Math.floor(state.scrollOffset)));
    const startIdx = Math.max(0, totalBars - visBars - scroll);
    const endIdx = Math.min(totalBars, startIdx + visBars);
    const view = displayCandles.slice(startIdx, endIdx);
    if (view.length < 2) return;

    const indicators = computeIndicators(view);

    let lo = Infinity, hi = -Infinity;
    for (const c of view) { lo = Math.min(lo, c.low); hi = Math.max(hi, c.high); }
    if (state.showEMA && indicators.ema50) {
      for (const v of indicators.ema50) { if (v!=null) { lo=Math.min(lo,v); hi=Math.max(hi,v);} }
    }
    if (state.showBB && indicators.bb) {
      for (let i=0;i<view.length;i++) {
        if (indicators.bb.upper[i]!=null) { lo=Math.min(lo, indicators.bb.upper[i], indicators.bb.lower[i]); hi=Math.max(hi, indicators.bb.upper[i], indicators.bb.lower[i]); }
      }
    }
    // Include order entry prices in range
    if (state.showOrders && opts.openOrders) {
      for (const o of opts.openOrders) {
        const ep = Number(o.openPrice || o.entry);
        if (Number.isFinite(ep)) { lo=Math.min(lo, ep); hi=Math.max(hi, ep); }
      }
    }
    if (opts.pending) {
      const ep = Number(opts.pending.entry || opts.pending.openPrice);
      if (Number.isFinite(ep)) { lo=Math.min(lo, ep); hi=Math.max(hi, ep); }
    }
    const pad = (hi - lo) * 0.14 || hi*0.001 || 0.0001;
    lo -= pad; hi += pad;

    const padL = 8, padR = 68;
    const plotW = w - padL - padR;
    const bw = plotW / view.length;
    const candleBodyW = Math.max(1, Math.min(13, bw * 0.70));
    const wickW = Math.max(1, bw * 0.13);

    function yPrice(p) { return priceH - ((p - lo)/(hi - lo)) * (priceH - 20) - 10; }
    function xFor(i) { return padL + (i + 0.5) * bw; }

    // Regime background
    drawRegimeBackground(ctx, view, xFor, priceH, padL, plotW, { ...opts, _state: state, _indicators: indicators });

    // Grid
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    const priceTicks = niceTicks(lo, hi, 6);
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "right";
    for (const p of priceTicks) {
      const y = yPrice(p);
      if (y < 8 || y > priceH - 4) continue;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+plotW, y); ctx.stroke();
      ctx.fillStyle = "rgba(180,200,230,0.55)";
      ctx.fillText(fmtPx(p, state.decimals), w - 4, y + 3);
    }

    // Bollinger
    if (state.showBB && indicators.bb) {
      const bb = indicators.bb;
      ctx.fillStyle = "rgba(74,163,255,0.08)";
      ctx.beginPath(); let started=false;
      for (let i=0;i<view.length;i++) {
        if (bb.upper[i]==null || bb.lower[i]==null) continue;
        const x=xFor(i), yu=yPrice(bb.upper[i]);
        if (!started) { ctx.moveTo(x, yu); started=true; } else ctx.lineTo(x, yu);
      }
      for (let i=view.length-1;i>=0;i--) {
        if (bb.upper[i]==null || bb.lower[i]==null) continue;
        const x=xFor(i), yl=yPrice(bb.lower[i]);
        ctx.lineTo(x, yl);
      }
      if (started) { ctx.closePath(); ctx.fill(); }
      const drawBBL = (arr, color, width) => {
        ctx.strokeStyle=color; ctx.lineWidth=width; ctx.beginPath(); let s=false;
        for (let i=0;i<arr.length;i++){ if(arr[i]==null) continue; const x=xFor(i), y=yPrice(arr[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
        ctx.stroke();
      };
      drawBBL(bb.upper, "rgba(74,163,255,0.35)", 1);
      drawBBL(bb.mid, "rgba(74,163,255,0.55)", 1);
      drawBBL(bb.lower, "rgba(74,163,255,0.35)", 1);
      ctx.lineWidth=1;
    }

    // EMA
    if (state.showEMA) {
      const drawEMA = (arr, color, width) => {
        if (!arr) return;
        ctx.strokeStyle=color; ctx.lineWidth=width; ctx.beginPath(); let started=false;
        for (let i=0;i<arr.length;i++){ if(arr[i]==null) continue; const x=xFor(i), y=yPrice(arr[i]); if(!started){ctx.moveTo(x,y); started=true;} else ctx.lineTo(x,y); }
        ctx.stroke();
      };
      drawEMA(indicators.ema8, "rgba(77,255,255,0.9)", 1.3);
      drawEMA(indicators.ema21, "rgba(255,196,87,0.95)", 1.3);
      drawEMA(indicators.ema50, "rgba(180,120,255,0.75)", 1);
      ctx.lineWidth=1;
    }

    // Levels (Supertrend, PSAR, Donchian)
    drawLevels(ctx, view, xFor, yPrice, priceH, { ...opts, _state: state, _indicators: indicators });

    // Candles / Line / Area
    if (state.chartType === "line" || state.chartType === "area") {
      ctx.strokeStyle = "#4aa3ff"; ctx.lineWidth=1.8; ctx.beginPath();
      for (let i=0;i<view.length;i++){ const x=xFor(i), y=yPrice(view[i].close); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
      ctx.stroke();
      if (state.chartType === "area") {
        const grad=ctx.createLinearGradient(0,0,0,priceH);
        grad.addColorStop(0, "rgba(74,163,255,0.35)"); grad.addColorStop(1, "rgba(74,163,255,0)");
        ctx.fillStyle=grad; ctx.lineTo(xFor(view.length-1), priceH); ctx.lineTo(xFor(0), priceH); ctx.closePath(); ctx.fill();
      }
      ctx.lineWidth=1;
    } else {
      for (let i=0;i<view.length;i++){
        const c=view[i]; const x=xFor(i);
        const yH=yPrice(c.high), yL=yPrice(c.low), yO=yPrice(c.open), yC=yPrice(c.close);
        const up=c.close>=c.open;
        const bodyColor=up?"#3dff9a":"#ff5d7a";
        const wickColor=up?"rgba(61,255,154,0.85)":"rgba(255,93,122,0.85)";
        ctx.strokeStyle=wickColor; ctx.lineWidth=wickW; ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
        ctx.fillStyle=bodyColor;
        const top=Math.min(yO,yC); const bh=Math.max(1, Math.abs(yC-yO));
        if (state.chartType==="heikin") ctx.globalAlpha=0.9;
        // Highlight hovered candle
        if (state.hoverIdx===i) {
          ctx.fillStyle = up ? "rgba(61,255,154,1)" : "rgba(255,93,122,1)";
          ctx.shadowColor = bodyColor; ctx.shadowBlur = 8;
        }
        ctx.fillRect(x - candleBodyW/2, top, candleBodyW, bh);
        ctx.shadowBlur=0; ctx.globalAlpha=1;
        ctx.strokeStyle=bodyColor; ctx.lineWidth=0.7; ctx.strokeRect(x - candleBodyW/2, top, candleBodyW, bh);
      }
    }

    // Open orders & pending lines
    drawOrderLines(ctx, view, xFor, yPrice, priceH, padL, plotW, { ...opts, _state: state });

    // Markers (CALL/PUT signals)
    if (Array.isArray(opts.markers) && opts.markers.length) {
      for (let mi=0; mi<opts.markers.length; mi++) {
        const mk=opts.markers[mi];
        if (!mk || mk.time==null || mk.price==null || (mk.dir!=="CALL" && mk.dir!=="PUT")) continue;
        let mTime=Number(mk.time), mPrice=Number(mk.price);
        if (!Number.isFinite(mTime) || !Number.isFinite(mPrice) || mPrice<=0) continue;
        while (Math.abs(mTime)>=1e14) mTime/=1000;
        if (Math.abs(mTime)<1e11) mTime*=1000;
        mTime=Math.floor(mTime);
        let idx=-1; let lo2=0, hi2=normalized.length-1;
        while (lo2<=hi2){ const mid=(lo2+hi2)>>1; if(normalized[mid].time===mTime){idx=mid; break;} if(normalized[mid].time < mTime) lo2=mid+1; else hi2=mid-1; }
        if (idx<0){
          const ins=lo2; const left=ins>0?ins-1:-1; const right=ins<normalized.length?ins:-1;
          if (left>=0 && right>=0) idx = mTime - normalized[left].time <= normalized[right].time - mTime ? left : right;
          else idx = left>=0?left:right;
          if (idx<0) continue;
          const gap=normalized.length>1 ? Math.max(1, normalized[normalized.length-1].time - normalized[normalized.length-2].time) : 60000;
          if (Math.abs(normalized[idx].time - mTime) > gap*2.5) continue;
        }
        const viewIdx=idx - startIdx;
        if (viewIdx<0 || viewIdx>=view.length) continue;
        const mx=xFor(viewIdx), my=yPrice(mPrice);
        if (!Number.isFinite(my) || my<-20 || my>priceH+20) continue;
        const isPut=mk.dir==="PUT";
        // Outer glow
        ctx.fillStyle = isPut ? "rgba(255,93,122,0.25)" : "rgba(61,255,154,0.25)";
        ctx.beginPath(); ctx.arc(mx, my, 14, 0, Math.PI*2); ctx.fill();
        ctx.fillStyle=isPut?"#ff5d7a":"#3dff9a";
        ctx.strokeStyle="rgba(0,0,0,0.7)"; ctx.lineWidth=1;
        const s=9;
        ctx.beginPath();
        if (isPut){ ctx.moveTo(mx, my-12); ctx.lineTo(mx-s, my-12-s*1.3); ctx.lineTo(mx+s, my-12-s*1.3); }
        else { ctx.moveTo(mx, my+12); ctx.lineTo(mx-s, my+12+s*1.3); ctx.lineTo(mx+s, my+12+s*1.3); }
        ctx.closePath(); ctx.fill(); ctx.stroke();
        if (mk.confidence!=null){
          ctx.fillStyle=isPut?"rgba(255,93,122,0.98)":"rgba(61,255,154,0.98)";
          ctx.font="bold 9px ui-monospace, monospace"; ctx.textAlign="center";
          const label=Math.round(mk.confidence)+"%";
          const bx=mx, by=isPut?my-12-s*1.3-14:my+12+s*1.3+4;
          const tw=ctx.measureText(label).width+8;
          // rounded rect
          const rx=bx-tw/2, ry=by, rw=tw, rh=13, r=3;
          ctx.beginPath(); ctx.moveTo(rx+r, ry); ctx.lineTo(rx+rw-r, ry); ctx.quadraticCurveTo(rx+rw, ry, rx+rw, ry+r); ctx.lineTo(rx+rw, ry+rh-r); ctx.quadraticCurveTo(rx+rw, ry+rh, rx+rw-r, ry+rh); ctx.lineTo(rx+r, ry+rh); ctx.quadraticCurveTo(rx, ry+rh, rx, ry+rh-r); ctx.lineTo(rx, ry+r); ctx.quadraticCurveTo(rx, ry, rx+r, ry); ctx.closePath(); ctx.fill();
          ctx.fillStyle="#0a1420"; ctx.fillText(label, bx, by+9);
        }
      }
    }

    // History trades (recent calls) as small dots at entry
    if (Array.isArray(opts.history) && opts.history.length) {
      for (let hi2=0; hi2<Math.min(opts.history.length, 30); hi2++) {
        const h=opts.history[hi2];
        if (!h || h.entryTime==null || h.entry==null) continue;
        let et=Number(h.entryTime); if (!Number.isFinite(et)) continue;
        while (Math.abs(et)>=1e14) et/=1000; if (Math.abs(et)<1e11) et*=1000; et=Math.floor(et);
        let idx=-1; let lo2=0, hi3=normalized.length-1;
        while (lo2<=hi3){ const mid=(lo2+hi3)>>1; if(normalized[mid].time===et){idx=mid; break;} if(normalized[mid].time < et) lo2=mid+1; else hi3=mid-1; }
        if (idx<0) continue;
        const viewIdx=idx - startIdx; if (viewIdx<0 || viewIdx>=view.length) continue;
        const mx=xFor(viewIdx); const my=yPrice(Number(h.entry));
        if (!Number.isFinite(my)) continue;
        const won = h.won===true ? "#3dff9a" : h.won===false ? "#ff5d7a" : "rgba(255,255,255,0.5)";
        ctx.fillStyle=won; ctx.globalAlpha=0.9;
        ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI*2); ctx.fill();
        ctx.globalAlpha=1;
      }
    }

    // Signal expiry suggestion line
    if (opts.signal && opts.signal.suggestedExpiry!=null && opts.signal.entryTime!=null) {
      const entryT=Number(opts.signal.entryTime);
      const expMin=Number(opts.signal.suggestedExpiry);
      if (Number.isFinite(entryT) && Number.isFinite(expMin) && expMin>0) {
        let expiryT = entryT;
        while (Math.abs(expiryT)>=1e14) expiryT/=1000;
        if (Math.abs(expiryT)<1e11) expiryT*=1000;
        expiryT = Math.floor(expiryT) + expMin*60000;
        let expiryIdx=-1;
        for (let i=0;i<view.length;i++){ if(view[i].time >= expiryT){ expiryIdx=i; break; } }
        if (expiryIdx>=0) {
          const ex=xFor(expiryIdx);
          ctx.strokeStyle="rgba(127,245,255,0.45)"; ctx.setLineDash([5,5]); ctx.lineWidth=1.2;
          ctx.beginPath(); ctx.moveTo(ex, 0); ctx.lineTo(ex, priceH); ctx.stroke();
          ctx.setLineDash([]); ctx.lineWidth=1;
          ctx.fillStyle="rgba(127,245,255,0.9)"; ctx.fillRect(ex-28, priceH-18, 56, 14);
          ctx.fillStyle="#0a1420"; ctx.font="bold 8px ui-monospace, monospace"; ctx.textAlign="center";
          ctx.fillText(expMin+"m EXP", ex, priceH-8); ctx.textAlign="left";
        }
      }
    }

    // Current price line
    const lastC=view[view.length-1];
    if (lastC){
      const lastY=yPrice(lastC.close);
      ctx.setLineDash([5,4]); ctx.strokeStyle="rgba(255,255,255,0.28)"; ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(padL, lastY); ctx.lineTo(padL+plotW, lastY); ctx.stroke(); ctx.setLineDash([]);
      const isUp=lastC.close>=lastC.open;
      ctx.fillStyle=isUp?"#3dff9a":"#ff5d7a";
      const labelW=68, labelH=20, labelX=w-padR+2;
      ctx.fillRect(labelX, lastY-labelH/2, labelW-4, labelH);
      ctx.beginPath(); ctx.moveTo(labelX, lastY-6); ctx.lineTo(labelX, lastY+6); ctx.lineTo(labelX-6, lastY); ctx.closePath(); ctx.fill();
      ctx.fillStyle="#0c1422"; ctx.font="bold 11px ui-monospace, monospace"; ctx.textAlign="center";
      ctx.fillText(fmtPx(lastC.close, state.decimals), labelX+(labelW-4)/2, lastY+4);
    }

    // Volume
    let curY=priceH;
    if (showVol){
      curY+=6; const volTop=curY, volBottom=curY+volH;
      ctx.fillStyle="rgba(255,255,255,0.02)"; ctx.fillRect(padL, volTop, plotW, volH);
      ctx.strokeStyle="rgba(255,255,255,0.05)"; ctx.beginPath(); ctx.moveTo(padL, volTop); ctx.lineTo(padL+plotW, volTop); ctx.stroke();
      let maxVol=0; for(const c of view) if(c.volume>maxVol) maxVol=c.volume; if(maxVol<=0) maxVol=1;
      for(let i=0;i<view.length;i++){
        const c=view[i]; const x=xFor(i); const h=(c.volume/maxVol)*(volH-4); const y=volBottom-h;
        const up=c.close>=c.open;
        const isHighlighted = state.hoverIdx===i;
        ctx.fillStyle=up ? (isHighlighted?"rgba(61,255,154,0.95)":"rgba(61,255,154,0.6)") : (isHighlighted?"rgba(255,93,122,0.95)":"rgba(255,93,122,0.6)");
        ctx.fillRect(x-candleBodyW/2, y, candleBodyW, h);
      }
      ctx.fillStyle="rgba(255,255,255,0.5)"; ctx.font="9px system-ui, sans-serif"; ctx.textAlign="left";
      ctx.fillText("VOL", padL+4, volTop+11);
      curY=volBottom;
    }

    // MACD
    if (showMacd && indicators.macd){
      curY+=6; const macdTop=curY, macdBottom=curY+macdH;
      ctx.fillStyle="rgba(255,255,255,0.02)"; ctx.fillRect(padL, macdTop, plotW, macdH);
      ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.beginPath(); ctx.moveTo(padL, macdTop); ctx.lineTo(padL+plotW, macdTop); ctx.stroke();
      const m=indicators.macd; let mMax=1e-9;
      for(let i=0;i<m.hist.length;i++){ for(const v of [m.hist[i], m.line[i], m.signal[i]]) if(v!=null && Math.abs(v)>mMax) mMax=Math.abs(v); }
      const y0=macdTop+macdH/2; const yMacd=(v)=>y0 - ((v||0)/mMax)*(macdH/2-6);
      ctx.strokeStyle="rgba(255,255,255,0.12)"; ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL+plotW, y0); ctx.stroke();
      for(let i=0;i<m.hist.length;i++){
        if(m.hist[i]==null) continue; const x=xFor(i); const v=m.hist[i];
        ctx.fillStyle=v>=0?"rgba(61,255,154,0.9)":"rgba(255,93,122,0.9)";
        const y=yMacd(v); ctx.fillRect(x-Math.max(1,bw*0.28), Math.min(y0,y), Math.max(1.5,bw*0.56), Math.max(1,Math.abs(y0-y)));
      }
      const drawM=(arr,color)=>{
        ctx.strokeStyle=color; ctx.lineWidth=1.3; ctx.beginPath(); let s=false;
        for(let i=0;i<arr.length;i++){ if(arr[i]==null) continue; const x=xFor(i), y=yMacd(arr[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
        ctx.stroke(); ctx.lineWidth=1;
      };
      drawM(m.line, "#4aa3ff"); drawM(m.signal, "#ffc457");
      ctx.fillStyle="rgba(255,255,255,0.5)"; ctx.font="9px system-ui, sans-serif"; ctx.textAlign="left";
      ctx.fillText("MACD 12/26/9", padL+4, macdTop+12);
      curY=macdBottom;
    }

    // RSI
    if (showRsi && indicators.rsi){
      curY+=6; const rsiTop=curY, rsiBottom=curY+rsiH;
      ctx.fillStyle="rgba(255,255,255,0.02)"; ctx.fillRect(padL, rsiTop, plotW, rsiH);
      ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.beginPath(); ctx.moveTo(padL, rsiTop); ctx.lineTo(padL+plotW, rsiTop); ctx.stroke();
      const yRsi=(v)=>rsiBottom - (v/100)*(rsiH-8) -4;
      ctx.strokeStyle="rgba(255,255,255,0.1)"; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(padL, yRsi(70)); ctx.lineTo(padL+plotW, yRsi(70)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, yRsi(30)); ctx.lineTo(padL+plotW, yRsi(30)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle="#a78bfa"; ctx.lineWidth=1.3; ctx.beginPath(); let s=false;
      for(let i=0;i<indicators.rsi.length;i++){ if(indicators.rsi[i]==null) continue; const x=xFor(i), y=yRsi(indicators.rsi[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
      ctx.stroke(); ctx.lineWidth=1;
      ctx.fillStyle="rgba(255,255,255,0.5)"; ctx.font="9px system-ui, sans-serif"; ctx.textAlign="left";
      ctx.fillText("RSI 14", padL+4, rsiTop+12);
      curY=rsiBottom;
    }

    // Time axis
    const timeTop=totalH-timeAxisH;
    ctx.fillStyle="rgba(10,18,32,0.92)"; ctx.fillRect(0, timeTop, w, timeAxisH);
    ctx.strokeStyle="rgba(255,255,255,0.08)"; ctx.beginPath(); ctx.moveTo(padL, timeTop); ctx.lineTo(padL+plotW, timeTop); ctx.stroke();
    ctx.fillStyle="rgba(180,200,230,0.65)"; ctx.font="9px ui-monospace, monospace"; ctx.textAlign="center";
    const labelEvery=Math.max(1, Math.floor(view.length/7));
    const useUtc=opts.timeBasis!=="local";
    for(let i=0;i<view.length;i+=labelEvery){
      const x=xFor(i);
      const label=view.length>100 && i%(labelEvery*2)===0 ? axisDateLabel(view[i].time, useUtc) : axisTimeLabel(view[i].time, useUtc);
      ctx.fillText(label, x, timeTop+13);
    }

    // Info header
    ctx.fillStyle="rgba(255,255,255,0.42)"; ctx.font="10px ui-monospace, monospace"; ctx.textAlign="left";
    const tfLabel=opts.timeframe||"1m"; const countLabel=view.length+"/"+totalBars+" bars"; const lastLabel=view.length?axisTimeLabel(view[view.length-1].time, useUtc)+" UTC":"";
    let headerText = (opts.label||"CYBER BINARY") + " · " + tfLabel + " · " + countLabel + (lastLabel?" · last "+lastLabel:"");
    if (opts.signal && opts.signal.regime) headerText += " · " + opts.signal.regime.toUpperCase();
    if (opts.signal && opts.signal.session) headerText += " · " + opts.signal.session.toUpperCase();
    if (opts.signal && opts.signal.confidence!=null) headerText += " · CONF " + Math.round(opts.signal.confidence)+"%";
    ctx.fillText(headerText, padL+6, 14);

    // Legend
    let legendX=padL+Math.min(320, plotW*0.45);
    const legendY=14;
    ctx.font="9px ui-monospace, monospace";
    if (state.showEMA){
      ctx.fillStyle="rgba(77,255,255,0.9)"; ctx.fillText("EMA8", legendX, legendY); legendX+=38;
      ctx.fillStyle="rgba(255,196,87,0.9)"; ctx.fillText("EMA21", legendX, legendY); legendX+=42;
      ctx.fillStyle="rgba(180,120,255,0.8)"; ctx.fillText("EMA50", legendX, legendY); legendX+=42;
    }
    if (state.showBB){ ctx.fillStyle="rgba(74,163,255,0.7)"; ctx.fillText("BB 20/2", legendX, legendY); legendX+=48; }
    if (state.showLevels){ ctx.fillStyle="rgba(127,245,255,0.6)"; ctx.fillText("ST", legendX, legendY); legendX+=24; ctx.fillStyle="rgba(255,196,87,0.7)"; ctx.fillText("SAR", legendX, legendY); legendX+=28; }
    if (state.showOrders && (opts.openOrders && opts.openOrders.length)) { ctx.fillStyle="rgba(61,255,154,0.8)"; ctx.fillText("ORDERS "+opts.openOrders.length, legendX, legendY); }

    // Crosshair
    if (state.crosshair && state.crosshair.idx>=0 && state.crosshair.idx < view.length){
      const idx=state.crosshair.idx; const x=xFor(idx); const c=view[idx]; const y=yPrice(c.close);
      ctx.strokeStyle="rgba(255,255,255,0.2)"; ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, timeTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle="#ffffff"; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle=c.close>=c.open?"#3dff9a":"#ff5d7a"; ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI*2); ctx.fill();
    }

    state._lastView=view; state._lastStartIdx=startIdx;
    state._lastPlot={ padL, padR, plotW, priceH, totalH, timeTop, yPrice, xFor, lo, hi, view };
    state._lastIndicators=indicators; state._lastNormalized=normalized;
    state._lastOpts=opts;
  }

  function bindMainChartInteractions(canvas) {
    if (!canvas) return;
    const state=getState(canvas);
    if (state._bound) return;
    state._bound=true;

    const getMousePos=(e)=>{
      const rect=canvas.getBoundingClientRect();
      const x=(e.clientX-rect.left), y=(e.clientY-rect.top);
      return { x, y, rect };
    };

    const updateCrosshair=(e)=>{
      const pos=getMousePos(e);
      const plot=state._lastPlot;
      if (!plot){ return; }
      const { padL, plotW, view, xFor, yPrice }=plot;
      if (pos.x < padL || pos.x > padL+plotW || pos.y > plot.timeTop){
        state.crosshair=null; state.hoverIdx=-1;
        const tip=state.tooltipEl; if(tip) tip.style.display="none";
        canvas.style.cursor="default";
        if(state._lastNormalized) drawMainChart(canvas, state._lastNormalized, state._lastOpts||{});
        // Update indicator legend
        const legendEl=document.getElementById("chart-indicator-legend");
        if (legendEl) legendEl.textContent="";
        return;
      }
      const relX=pos.x-padL;
      const idx=Math.min(view.length-1, Math.max(0, Math.floor(relX/(plotW/view.length))));
      state.hoverIdx=idx;
      state.crosshair={ idx, x:xFor(idx), y:yPrice(view[idx].close) };
      canvas.style.cursor="crosshair";

      const tip=ensureTooltip(canvas);
      const c=view[idx];
      const ind=state._lastIndicators||{};
      const ema8=ind.ema8 && ind.ema8[idx]!=null ? ind.ema8[idx].toFixed(5) : "—";
      const ema21=ind.ema21 && ind.ema21[idx]!=null ? ind.ema21[idx].toFixed(5) : "—";
      const ema50=ind.ema50 && ind.ema50[idx]!=null ? ind.ema50[idx].toFixed(5) : "—";
      const rsi=ind.rsi && ind.rsi[idx]!=null ? ind.rsi[idx].toFixed(1) : "—";
      const stochK=ind.stoch && ind.stoch.k && ind.stoch.k[idx]!=null ? ind.stoch.k[idx].toFixed(1) : "—";
      const adx=ind.adx && ind.adx.adx && ind.adx.adx[idx]!=null ? ind.adx.adx[idx].toFixed(1) : "—";
      const atr=ind.atr && ind.atr[idx]!=null ? ind.atr[idx].toFixed(5) : "—";
      const vol=c.volume ? c.volume.toFixed(0) : "—";
      const change=((c.close-c.open)/c.open*100).toFixed(3);
      const timeStr=new Date(c.time).toISOString().replace("T"," ").slice(0,19)+" UTC";
      const sig=state.lastSignal;
      const regime=state.lastRegime || (sig && sig.regime) || "—";
      const session=state.lastSession || (sig && sig.session) || "—";
      const conf=sig && sig.confidence!=null ? sig.confidence+"%" : "—";
      const dir=sig && sig.direction ? sig.direction : "—";

      tip.innerHTML=`
        <div style="display:flex;justify-content:space-between;margin-bottom:8px;align-items:center">
          <strong style="color:#7ff5ff;font-size:11px">${timeStr}</strong>
          <span style="color:${c.close>=c.open?'#3dff9a':'#ff5d7a'};font-weight:700">${change}%</span>
        </div>
        <div style="display:grid;grid-template-columns:auto auto;gap:3px 14px;margin-bottom:8px">
          <span style="color:#8aa0c8">O</span><span>${fmtPx(c.open, state.decimals)}</span>
          <span style="color:#8aa0c8">H</span><span>${fmtPx(c.high, state.decimals)}</span>
          <span style="color:#8aa0c8">L</span><span>${fmtPx(c.low, state.decimals)}</span>
          <span style="color:#8aa0c8">C</span><span style="color:${c.close>=c.open?'#3dff9a':'#ff5d7a'};font-weight:700">${fmtPx(c.close, state.decimals)}</span>
          <span style="color:#8aa0c8">V</span><span>${vol}</span>
          <span style="color:#8aa0c8">ATR</span><span>${atr}</span>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;margin-bottom:6px;display:grid;grid-template-columns:auto auto;gap:3px 14px">
          <span style="color:#8aa0c8">EMA8</span><span style="color:#4df">${ema8}</span>
          <span style="color:#8aa0c8">EMA21</span><span style="color:#ffc457">${ema21}</span>
          <span style="color:#8aa0c8">EMA50</span><span style="color:#b78cff">${ema50}</span>
          <span style="color:#8aa0c8">RSI</span><span style="color:${Number(rsi)>70?'#ff5d7a':Number(rsi)<30?'#3dff9a':'#e8eefc'}">${rsi}</span>
          <span style="color:#8aa0c8">Stoch</span><span>${stochK}</span>
          <span style="color:#8aa0c8">ADX</span><span>${adx}</span>
        </div>
        <div style="border-top:1px solid rgba(255,255,255,0.08);padding-top:6px;display:grid;grid-template-columns:auto auto;gap:2px 14px;font-size:10px">
          <span style="color:#8aa0c8">Regime</span><span style="color:#7ff5ff">${regime}</span>
          <span style="color:#8aa0c8">Session</span><span>${session}</span>
          <span style="color:#8aa0c8">Signal</span><span style="color:${dir==='CALL'?'#3dff9a':dir==='PUT'?'#ff5d7a':'#8aa0c8'}">${dir} ${conf}</span>
        </div>
      `;
      tip.style.display="block";
      const tipW=280, tipH=260;
      let left=pos.rect.left + pos.x + 16, top=pos.rect.top + pos.y - 100;
      if (left+tipW > window.innerWidth-8) left=pos.rect.left + pos.x - tipW - 16;
      if (top+tipH > window.innerHeight-8) top=window.innerHeight - tipH - 8;
      if (top<8) top=8;
      tip.style.left=left+"px"; tip.style.top=top+"px";

      // Update indicator legend bar below chart
      const legendEl=document.getElementById("chart-indicator-legend");
      if (legendEl){
        legendEl.innerHTML = `<span style="color:#4df">EMA8 ${ema8}</span> · <span style="color:#ffc457">EMA21 ${ema21}</span> · <span style="color:#b78cff">EMA50 ${ema50}</span> · <span>RSI ${rsi}</span> · <span>Stoch ${stochK}</span> · <span>ADX ${adx}</span> · <span>ATR ${atr}</span>`;
      }

      requestAnimationFrame(()=>{ if(state._lastNormalized) drawMainChart(canvas, state._lastNormalized, state._lastOpts||{}); });
    };

    canvas.addEventListener("mousemove", updateCrosshair);
    canvas.addEventListener("mouseleave", ()=>{
      state.crosshair=null; state.hoverIdx=-1;
      const tip=state.tooltipEl; if(tip) tip.style.display="none";
      canvas.style.cursor="default";
      const legendEl=document.getElementById("chart-indicator-legend");
      if (legendEl) legendEl.textContent="";
      if(state._lastNormalized) drawMainChart(canvas, state._lastNormalized, state._lastOpts||{});
    });

    canvas.addEventListener("wheel", (e)=>{
      e.preventDefault();
      const delta=Math.sign(e.deltaY);
      let newBars=state.visibleBars + delta*10;
      newBars=Math.max(20, Math.min(600, newBars));
      state.visibleBars=newBars;
      if(state._lastNormalized) drawMainChart(canvas, state._lastNormalized, state._lastOpts||{});
    }, { passive:false });

    canvas.addEventListener("mousedown", (e)=>{
      state.isDragging=true; state.dragStartX=e.clientX; state.dragStartOffset=state.scrollOffset;
      canvas.style.cursor="grabbing";
    });
    window.addEventListener("mouseup", ()=>{
      if(state.isDragging){ state.isDragging=false; canvas.style.cursor="crosshair"; }
    });
    window.addEventListener("mousemove", (e)=>{
      if(!state.isDragging) return;
      const dx=e.clientX-state.dragStartX;
      const plotW=state._lastPlot ? state._lastPlot.plotW : 600;
      const viewLen=state._lastPlot ? state._lastPlot.view.length : 100;
      const barsPerPx=viewLen/plotW;
      const deltaBars=-dx*barsPerPx;
      let newOffset=state.dragStartOffset + deltaBars;
      const totalBars=state._lastNormalized ? state._lastNormalized.length : 500;
      newOffset=Math.max(0, Math.min(totalBars-10, newOffset));
      state.scrollOffset=newOffset;
      if(state._lastNormalized) drawMainChart(canvas, state._lastNormalized, state._lastOpts||{});
    });

    // Double click to reset
    canvas.addEventListener("dblclick", ()=>{
      state.visibleBars=120; state.scrollOffset=0; state.crosshair=null;
      if(state._lastNormalized) drawMainChart(canvas, state._lastNormalized, state._lastOpts||{});
    });
  }

  // --- Equity enhanced with trade integration ---
  function drawEquityChart(canvas, equity, opts) {
    if (!canvas) return;
    opts=opts||{};
    const parent=canvas.parentElement;
    const w=Math.max(320, Math.min(4096, (parent && parent.clientWidth)||800));
    const priceH=Math.max(150, Math.round(w*0.30));
    const ddH=Math.max(52, Math.round(w*0.10));
    const timeAxisH=20;
    const totalH=priceH+ddH+timeAxisH+18;
    const dpr=Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
    canvas.width=Math.floor(w*dpr); canvas.height=Math.floor(totalH*dpr);
    canvas.style.width=w+"px"; canvas.style.height=totalH+"px";
    const ctx=canvas.getContext("2d"); if(!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,totalH);
    const bg=ctx.createLinearGradient(0,0,0,totalH); bg.addColorStop(0,"#0c1422"); bg.addColorStop(1,"#0a1220");
    ctx.fillStyle=bg; ctx.fillRect(0,0,w,totalH);

    if (!Array.isArray(equity) || equity.length<2){
      ctx.fillStyle="rgba(255,255,255,0.5)"; ctx.font="12px system-ui, sans-serif"; ctx.textAlign="center";
      ctx.fillText("No equity data — run backtest first", w/2, totalH/2); return;
    }
    const eq=equity.filter(e=>e && Number.isFinite(e.equity));
    if (eq.length<2) return;
    let lo=Infinity, hi=-Infinity, maxDD=0, peak=-Infinity, finalPnL=0;
    for(const e of eq){ if(e.equity<lo) lo=e.equity; if(e.equity>hi) hi=e.equity; if(Number.isFinite(e.drawdown) && e.drawdown>maxDD) maxDD=e.drawdown; if(e.equity>peak) peak=e.equity; }
    finalPnL=eq[eq.length-1].equity;
    const pad=(hi-lo)*0.14||1; lo-=pad; hi+=pad; if(maxDD<0.1) maxDD=Math.max(1, Math.abs(lo)*0.05);
    function yEq(v){ return priceH - ((v-lo)/(hi-lo))*(priceH-28) -14; }
    function yDD(v){ return priceH+14 + ddH - (v/maxDD)*(ddH-12) -8; }
    function xFor(i){ return 14 + (i/(eq.length-1))*(w-28); }

    // Grid
    ctx.strokeStyle="rgba(255,255,255,0.06)"; const ticks=niceTicks(lo,hi,6);
    ctx.font="10px ui-monospace, monospace"; ctx.textAlign="right";
    for(const t of ticks){ const y=yEq(t); if(y<12||y>priceH-4) continue; ctx.beginPath(); ctx.moveTo(14,y); ctx.lineTo(w-14,y); ctx.stroke(); ctx.fillStyle="rgba(180,200,230,0.5)"; ctx.fillText(t.toFixed(2), w-4, y+3); }
    if(lo<0 && hi>0){ const zy=yEq(0); ctx.strokeStyle="rgba(255,255,255,0.14)"; ctx.setLineDash([4,3]); ctx.beginPath(); ctx.moveTo(14,zy); ctx.lineTo(w-14,zy); ctx.stroke(); ctx.setLineDash([]); }

    // Area
    const grad=ctx.createLinearGradient(0,0,0,priceH);
    grad.addColorStop(0,"rgba(74,163,255,0.32)"); grad.addColorStop(0.6,"rgba(74,163,255,0.08)"); grad.addColorStop(1,"rgba(74,163,255,0)");
    ctx.fillStyle=grad; ctx.beginPath();
    for(let i=0;i<eq.length;i++){ const x=xFor(i), y=yEq(eq[i].equity); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.lineTo(xFor(eq.length-1), priceH); ctx.lineTo(xFor(0), priceH); ctx.closePath(); ctx.fill();

    // Line
    ctx.strokeStyle="#4aa3ff"; ctx.lineWidth=2; ctx.beginPath();
    for(let i=0;i<eq.length;i++){ const x=xFor(i), y=yEq(eq[i].equity); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke(); ctx.lineWidth=1;

    // Peak
    if(peak>lo){ const py=yEq(peak); ctx.strokeStyle="rgba(61,255,154,0.35)"; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.moveTo(14,py); ctx.lineTo(w-14,py); ctx.stroke(); ctx.setLineDash([]); }

    // Trades
    const state=getState(canvas);
    const trades=opts.trades||[];
    for(let i=0;i<Math.min(trades.length, eq.length);i++){
      const t=trades[i]; if(!t) continue;
      const x=xFor(i), y=yEq(eq[i].equity);
      const isHighlighted = state.highlightedTradeId!=null && (t.id===state.highlightedTradeId || i===state.highlightedTradeId);
      if (isHighlighted){
        ctx.fillStyle="rgba(255,255,255,0.9)"; ctx.beginPath(); ctx.arc(x,y,7,0,Math.PI*2); ctx.fill();
      }
      if(t.won){ ctx.fillStyle="#3dff9a"; ctx.beginPath(); ctx.arc(x,y, isHighlighted?5:3,0,Math.PI*2); ctx.fill(); }
      else if(t.won===false){ ctx.fillStyle="#ff5d7a"; ctx.beginPath(); ctx.arc(x,y, isHighlighted?5:3,0,Math.PI*2); ctx.fill(); }
    }

    // Drawdown
    const ddTop=priceH+10;
    ctx.fillStyle="rgba(255,255,255,0.02)"; ctx.fillRect(14, ddTop, w-28, ddH);
    ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.strokeRect(14, ddTop, w-28, ddH);
    ctx.fillStyle="rgba(255,93,122,0.22)"; ctx.beginPath(); ctx.moveTo(xFor(0), yDD(0));
    for(let i=0;i<eq.length;i++) ctx.lineTo(xFor(i), yDD(eq[i].drawdown||0));
    ctx.lineTo(xFor(eq.length-1), yDD(0)); ctx.closePath(); ctx.fill();
    ctx.strokeStyle="rgba(255,93,122,0.7)"; ctx.lineWidth=1.2; ctx.beginPath();
    for(let i=0;i<eq.length;i++){ const x=xFor(i), y=yDD(eq[i].drawdown||0); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke();

    // Labels
    ctx.fillStyle="rgba(255,255,255,0.6)"; ctx.font="11px ui-monospace, monospace"; ctx.textAlign="left";
    ctx.fillText(`Equity · ${eq.length} pts · P&L ${finalPnL.toFixed(2)} · Peak ${peak.toFixed(2)} · MaxDD ${maxDD.toFixed(2)}`, 14, 16);
    ctx.fillStyle="rgba(255,93,122,0.8)"; ctx.font="10px ui-monospace, monospace"; ctx.fillText(`Drawdown`, 14, ddTop+14);
    ctx.fillStyle="rgba(180,200,230,0.5)"; ctx.textAlign="right"; ctx.fillText(maxDD.toFixed(2), w-16, ddTop+14); ctx.fillText("0", w-16, ddTop+ddH-4);
    const lastY=yEq(finalPnL);
    ctx.fillStyle=finalPnL>=0?"#3dff9a":"#ff5d7a"; ctx.fillRect(w-74, lastY-10, 60, 20);
    ctx.fillStyle="#0c1422"; ctx.font="bold 11px ui-monospace, monospace"; ctx.textAlign="center"; ctx.fillText(finalPnL.toFixed(2), w-44, lastY+4);

    // Store for interaction
    state._lastEquity=eq; state._lastTrades=trades; state._lastPlot={ xFor, yEq, w, priceH, totalH };
  }

  function drawMonteCarloChart(canvas, mcResults, opts) {
    if (!canvas) return;
    opts=opts||{};
    const parent=canvas.parentElement;
    const w=Math.max(320, Math.min(4096, (parent && parent.clientWidth)||800));
    const h=Math.max(170, Math.round(w*0.30));
    const dpr=Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
    canvas.width=Math.floor(w*dpr); canvas.height=Math.floor(h*dpr);
    canvas.style.width=w+"px"; canvas.style.height=h+"px";
    const ctx=canvas.getContext("2d"); if(!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    ctx.fillStyle="#0c1422"; ctx.fillRect(0,0,w,h);

    if (!mcResults || !Array.isArray(mcResults) || mcResults.length<5){
      ctx.fillStyle="rgba(255,255,255,0.45)"; ctx.font="11px system-ui, sans-serif"; ctx.textAlign="center";
      ctx.fillText("Run Monte Carlo to see distribution", w/2, h/2); return;
    }
    const vals=mcResults.map(r=>r.finalPnL).sort((a,b)=>a-b);
    const lo=vals[0], hi=vals[vals.length-1]; const range=hi-lo||1;
    const bins=50; const counts=new Array(bins).fill(0);
    for(const v of vals){ const idx=Math.min(bins-1, Math.max(0, Math.floor((v-lo)/range*bins))); counts[idx]++; }
    const maxC=Math.max(...counts)||1;
    const padL=54, padR=18, padT=28, padB=32;
    const plotW=w-padL-padR, plotH=h-padT-padB;

    ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.beginPath();
    for(let i=0;i<=4;i++){ const y=padT + (i/4)*plotH; ctx.moveTo(padL, y); ctx.lineTo(padL+plotW, y); }
    ctx.stroke();

    for(let i=0;i<bins;i++){
      const x=padL + (i/bins)*plotW; const bw=plotW/bins*0.78; const bh=(counts[i]/maxC)*plotH; const y=padT+plotH-bh;
      const grad=ctx.createLinearGradient(0,y,0,y+bh); grad.addColorStop(0,"rgba(74,163,255,0.95)"); grad.addColorStop(1,"rgba(74,163,255,0.2)");
      ctx.fillStyle=grad; ctx.beginPath(); const r=2.5;
      ctx.moveTo(x, y+bh); ctx.lineTo(x, y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.lineTo(x+bw-r,y); ctx.quadraticCurveTo(x+bw,y,x+bw,y+r); ctx.lineTo(x+bw,y+bh); ctx.closePath(); ctx.fill();
    }

    function percentile(p){ const idx=Math.floor((p/100)*vals.length); return vals[Math.min(vals.length-1, Math.max(0, idx))]; }
    const p5=percentile(5), p25=percentile(25), p50=percentile(50), p75=percentile(75), p95=percentile(95);
    const markers=[{v:p5,label:"5%",color:"#ff5d7a"}, {v:p25,label:"25%",color:"rgba(255,93,122,0.6)"}, {v:p50,label:"MED",color:"#7ff5ff"}, {v:p75,label:"75%",color:"rgba(61,255,154,0.6)"}, {v:p95,label:"95%",color:"#3dff9a"}];
    for(const m of markers){
      const x=padL + ((m.v-lo)/range)*plotW;
      ctx.strokeStyle=m.color; ctx.setLineDash(m.label==="MED"?[0,0]:[4,3]); ctx.lineWidth=m.label==="MED"?1.5:1;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT+plotH); ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth=1;
      ctx.fillStyle=m.color; ctx.font=m.label==="MED"?"bold 10px ui-monospace, monospace":"9px ui-monospace, monospace"; ctx.textAlign="center";
      ctx.fillText(m.label, x, padT-6); ctx.font="9px ui-monospace, monospace"; ctx.fillText(m.v.toFixed(1), x, padT+plotH+14);
    }

    ctx.fillStyle="rgba(255,255,255,0.55)"; ctx.font="10px ui-monospace, monospace"; ctx.textAlign="left";
    ctx.fillText(lo.toFixed(1), padL, h-4); ctx.textAlign="right"; ctx.fillText(hi.toFixed(1), padL+plotW, h-4);
    ctx.textAlign="left"; ctx.fillText(`Monte Carlo · ${vals.length} sims · [${lo.toFixed(1)} → ${hi.toFixed(1)}] · Med ${p50.toFixed(1)} · 5% ${p5.toFixed(1)} · 95% ${p95.toFixed(1)}`, 12, 16);
  }

  // Performance timeline chart (winrate over time)
  function drawPerformanceChart(canvas, history, opts) {
    if (!canvas) return;
    opts=opts||{};
    const parent=canvas.parentElement;
    const w=Math.max(300, Math.min(4096, (parent && parent.clientWidth)||600));
    const h=Math.max(120, Math.round(w*0.22));
    const dpr=Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
    canvas.width=Math.floor(w*dpr); canvas.height=Math.floor(h*dpr);
    canvas.style.width=w+"px"; canvas.style.height=h+"px";
    const ctx=canvas.getContext("2d"); if(!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.clearRect(0,0,w,h);
    ctx.fillStyle="#0c1422"; ctx.fillRect(0,0,w,h);

    if (!Array.isArray(history) || history.length<5){
      ctx.fillStyle="rgba(255,255,255,0.45)"; ctx.font="11px system-ui"; ctx.textAlign="center";
      ctx.fillText("Not enough history for performance chart", w/2, h/2); return;
    }
    const sorted=[...history].sort((a,b)=>(a.at||a.entryTime||0)-(b.at||b.entryTime||0)).slice(-100);
    const wins=[]; let cum=0, wcnt=0;
    for(let i=0;i<sorted.length;i++){ const h2=sorted[i]; if(h2.won===true) wcnt++; const total=i+1; const wr=total? (wcnt/total*100):0; wins.push({ x:i, wr, cum: (cum+= (h2.pnl|| (h2.won?1:-1))) }); }
    const maxCum=Math.max(...wins.map(p=>p.cum),1), minCum=Math.min(...wins.map(p=>p.cum),0);
    const padL=40, padR=40, padT=20, padB=20; const plotW=w-padL-padR, plotH=h-padT-padB;
    function xFor(i){ return padL + (i/(wins.length-1))*plotW; }
    function yWr(v){ return padT + plotH - (v/100)*plotH; }
    function yCum(v){ const range=maxCum-minCum||1; return padT + plotH - ((v-minCum)/range)*plotH; }

    // Grid
    ctx.strokeStyle="rgba(255,255,255,0.06)"; ctx.beginPath();
    for(let v=0;v<=100;v+=25){ const y=yWr(v); ctx.moveTo(padL,y); ctx.lineTo(padL+plotW,y); }
    ctx.stroke();

    // Winrate line
    ctx.strokeStyle="#7ff5ff"; ctx.lineWidth=1.5; ctx.beginPath();
    for(let i=0;i<wins.length;i++){ const x=xFor(i), y=yWr(wins[i].wr); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke();

    // Cum P&L area
    const grad=ctx.createLinearGradient(0,padT,0,padT+plotH); grad.addColorStop(0,"rgba(61,255,154,0.25)"); grad.addColorStop(1,"rgba(61,255,154,0)");
    ctx.fillStyle=grad; ctx.beginPath();
    for(let i=0;i<wins.length;i++){ const x=xFor(i), y=yCum(wins[i].cum); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.lineTo(xFor(wins.length-1), padT+plotH); ctx.lineTo(xFor(0), padT+plotH); ctx.closePath(); ctx.fill();
    ctx.strokeStyle="#3dff9a"; ctx.lineWidth=1.2; ctx.beginPath();
    for(let i=0;i<wins.length;i++){ const x=xFor(i), y=yCum(wins[i].cum); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke();

    ctx.fillStyle="rgba(255,255,255,0.5)"; ctx.font="9px ui-monospace, monospace"; ctx.textAlign="left";
    ctx.fillText(`Winrate ${wins[wins.length-1].wr.toFixed(1)}% · Cum ${wins[wins.length-1].cum.toFixed(2)} · ${wins.length} trades`, padL, 12);
    ctx.fillStyle="rgba(127,245,255,0.7)"; ctx.fillText("WR%", padL, padT+10);
    ctx.fillStyle="rgba(61,255,154,0.7)"; ctx.textAlign="right"; ctx.fillText("Cum P&L", padL+plotW, padT+10); ctx.textAlign="left";
  }

  function exportCanvasPNG(canvas, filename) {
    if (!canvas) return;
    try {
      const url=canvas.toDataURL("image/png");
      const a=document.createElement("a"); a.href=url; a.download=filename||"chart-"+new Date().toISOString().slice(0,10)+".png"; a.click();
    } catch(e){}
  }

  function highlightEquityTrade(canvas, tradeId) {
    const state=getState(canvas);
    if (!state) return;
    state.highlightedTradeId=tradeId;
    if (state._lastEquity) drawEquityChart(canvas, state._lastEquity, { trades: state._lastTrades });
  }

  root.CYBER_CHARTS = {
    drawMainChart,
    bindMainChartInteractions,
    drawEquityChart,
    drawMonteCarloChart,
    drawPerformanceChart,
    exportCanvasPNG,
    getState,
    ensureTooltip,
    highlightEquityTrade,
  };
})(typeof self !== "undefined" ? self : globalThis);
