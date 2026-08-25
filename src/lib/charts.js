/**
 * CYBER CHARTS v3 — Enhanced charting for dashboard
 * Vanilla canvas, no dependencies, high-DPI, interactive
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

  // --- State per canvas ---
  const chartStates = new Map(); // canvas -> state

  function getState(canvas) {
    if (!canvas) return null;
    let s = chartStates.get(canvas);
    if (!s) {
      s = {
        visibleBars: 120,
        scrollOffset: 0, // 0 = most recent at right, positive = scroll left
        chartType: "candle", // candle | line | heikin | area
        showVolume: true,
        showEMA: true,
        showBB: false,
        showRSI: false,
        showMACD: true,
        crosshair: null, // {x,y, idx, price}
        isDragging: false,
        dragStartX: 0,
        dragStartOffset: 0,
        hoverIdx: -1,
        tooltipEl: null,
        emaFast: 8,
        emaSlow: 21,
        ema50: 50,
        bbPeriod: 20,
        bbMult: 2,
        rsiPeriod: 14,
        decimals: null,
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
    tip.style.cssText = "position:absolute;pointer-events:none;z-index:10;display:none;min-width:180px;max-width:260px;background:rgba(7,17,31,0.96);border:1px solid rgba(0,229,255,0.25);border-radius:10px;padding:10px 12px;font:11px/1.4 ui-monospace,monospace;color:#e8eefc;box-shadow:0 8px 32px rgba(0,0,0,0.5),0 0 0 1px rgba(0,229,255,0.08);backdrop-filter:blur(12px);";
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
      if (i === 0) {
        haOpen = (c.open + c.close) / 2;
      } else {
        haOpen = (haOpen + haClose) / 2;
      }
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

  // Main chart drawing
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
    if (opts.decimals != null) state.decimals = opts.decimals;
    if (opts.visibleBars) state.visibleBars = opts.visibleBars;

    const parent = canvas.parentElement;
    const parentWidth = finite(parent && parent.clientWidth, 0);
    const viewportWidth = finite(window.innerWidth, 480);
    const w = Math.max(320, Math.min(4096, parentWidth || viewportWidth || 800));
    const dpr = Math.max(1, Math.min(2, finite(window.devicePixelRatio, 1)));

    // Layout heights
    const showVol = state.showVolume;
    const showMacd = state.showMACD;
    const showRsi = state.showRSI;
    const volH = showVol ? Math.max(36, Math.round(w * 0.07)) : 0;
    const macdH = showMacd ? Math.max(56, Math.round(w * 0.13)) : 0;
    const rsiH = showRsi ? Math.max(48, Math.round(w * 0.11)) : 0;
    const timeAxisH = 22;
    const priceH = Math.max(160, Math.round(w * 0.32));
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

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, totalH);
    bgGrad.addColorStop(0, opts.bgTop || "#0c1422");
    bgGrad.addColorStop(1, opts.bgBottom || "#0a1220");
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, totalH);

    // Normalize candles
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

    // Apply chart type transform
    let displayCandles = normalized;
    if (state.chartType === "heikin") {
      displayCandles = heikinAshi(normalized);
    }

    // Visible window logic
    const totalBars = displayCandles.length;
    let visBars = Math.max(20, Math.min(500, Math.floor(state.visibleBars)));
    let scroll = Math.max(0, Math.min(totalBars - 10, Math.floor(state.scrollOffset)));
    // Ensure at least visBars visible
    const startIdx = Math.max(0, totalBars - visBars - scroll);
    const endIdx = Math.min(totalBars, startIdx + visBars);
    const view = displayCandles.slice(startIdx, endIdx);
    if (view.length < 2) return;

    const indicators = computeIndicators(view);

    // Price range
    let lo = Infinity, hi = -Infinity;
    for (const c of view) {
      lo = Math.min(lo, c.low);
      hi = Math.max(hi, c.high);
    }
    // Include EMA and BB in range if visible
    if (state.showEMA && indicators.ema50) {
      for (const v of indicators.ema50) { if (v!=null) { lo=Math.min(lo,v); hi=Math.max(hi,v);} }
    }
    if (state.showBB && indicators.bb) {
      for (let i=0;i<view.length;i++) {
        if (indicators.bb.upper[i]!=null) { lo=Math.min(lo, indicators.bb.upper[i], indicators.bb.lower[i]); hi=Math.max(hi, indicators.bb.upper[i], indicators.bb.lower[i]); }
      }
    }
    const pad = (hi - lo) * 0.12 || hi*0.001 || 0.0001;
    lo -= pad; hi += pad;

    const padL = 8, padR = 68;
    const plotW = w - padL - padR;
    const bw = plotW / view.length;
    const candleBodyW = Math.max(1, Math.min(12, bw * 0.68));
    const wickW = Math.max(1, bw * 0.12);

    function yPrice(p) { return priceH - ((p - lo)/(hi - lo)) * (priceH - 20) - 10; }
    function xFor(i) { return padL + (i + 0.5) * bw; }

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

    // Bollinger Bands
    if (state.showBB && indicators.bb) {
      const bb = indicators.bb;
      // Fill between upper/lower
      ctx.fillStyle = "rgba(74,163,255,0.08)";
      ctx.beginPath();
      let started = false;
      for (let i=0;i<view.length;i++) {
        if (bb.upper[i]==null || bb.lower[i]==null) continue;
        const x = xFor(i), yu = yPrice(bb.upper[i]);
        if (!started) { ctx.moveTo(x, yu); started=true; } else ctx.lineTo(x, yu);
      }
      for (let i=view.length-1;i>=0;i--) {
        if (bb.upper[i]==null || bb.lower[i]==null) continue;
        const x = xFor(i), yl = yPrice(bb.lower[i]);
        ctx.lineTo(x, yl);
      }
      if (started) { ctx.closePath(); ctx.fill(); }
      // Lines
      const drawBBL = (arr, color, width) => {
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); let s=false;
        for (let i=0;i<arr.length;i++) { if (arr[i]==null) continue; const x=xFor(i), y=yPrice(arr[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
        ctx.stroke();
      };
      drawBBL(bb.upper, "rgba(74,163,255,0.35)", 1);
      drawBBL(bb.mid, "rgba(74,163,255,0.55)", 1);
      drawBBL(bb.lower, "rgba(74,163,255,0.35)", 1);
      ctx.lineWidth = 1;
    }

    // EMA lines
    if (state.showEMA) {
      const drawEMA = (arr, color, width) => {
        if (!arr) return;
        ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); let started=false;
        for (let i=0;i<arr.length;i++) { if (arr[i]==null) continue; const x=xFor(i), y=yPrice(arr[i]); if(!started){ctx.moveTo(x,y); started=true;} else ctx.lineTo(x,y); }
        ctx.stroke();
      };
      drawEMA(indicators.ema8, "rgba(77,255,255,0.85)", 1.2);
      drawEMA(indicators.ema21, "rgba(255,196,87,0.9)", 1.2);
      drawEMA(indicators.ema50, "rgba(180,120,255,0.7)", 1);
      ctx.lineWidth = 1;
    }

    // Candles / Line / Area
    if (state.chartType === "line" || state.chartType === "area") {
      // Close line
      ctx.strokeStyle = "#4aa3ff";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i=0;i<view.length;i++) {
        const x=xFor(i), y=yPrice(view[i].close);
        if (i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
      if (state.chartType === "area") {
        const grad = ctx.createLinearGradient(0,0,0,priceH);
        grad.addColorStop(0, "rgba(74,163,255,0.35)");
        grad.addColorStop(1, "rgba(74,163,255,0)");
        ctx.fillStyle = grad;
        ctx.lineTo(xFor(view.length-1), priceH);
        ctx.lineTo(xFor(0), priceH);
        ctx.closePath(); ctx.fill();
      }
      ctx.lineWidth = 1;
    } else {
      // Candle
      for (let i=0;i<view.length;i++) {
        const c = view[i];
        const x = xFor(i);
        const yH = yPrice(c.high), yL = yPrice(c.low);
        const yO = yPrice(c.open), yC = yPrice(c.close);
        const up = c.close >= c.open;
        const bodyColor = up ? "#3dff9a" : "#ff5d7a";
        const wickColor = up ? "rgba(61,255,154,0.8)" : "rgba(255,93,122,0.8)";
        // Wick
        ctx.strokeStyle = wickColor;
        ctx.lineWidth = wickW;
        ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke();
        // Body
        ctx.fillStyle = bodyColor;
        const top = Math.min(yO, yC);
        const bh = Math.max(1, Math.abs(yC - yO));
        // For hollow? Use fill with alpha for heikin
        if (state.chartType === "heikin") {
          ctx.globalAlpha = 0.85;
        }
        ctx.fillRect(x - candleBodyW/2, top, candleBodyW, bh);
        ctx.globalAlpha = 1;
        // Border
        ctx.strokeStyle = bodyColor;
        ctx.lineWidth = 0.6;
        ctx.strokeRect(x - candleBodyW/2, top, candleBodyW, bh);
      }
    }

    // Markers (CALL/PUT signals)
    if (Array.isArray(opts.markers) && opts.markers.length) {
      for (let mi=0; mi<opts.markers.length; mi++) {
        const mk = opts.markers[mi];
        if (!mk || mk.time==null || mk.price==null || (mk.dir!=="CALL" && mk.dir!=="PUT")) continue;
        let mTime = Number(mk.time); let mPrice = Number(mk.price);
        if (!Number.isFinite(mTime) || !Number.isFinite(mPrice) || mPrice<=0) continue;
        while (Math.abs(mTime)>=1e14) mTime/=1000;
        if (Math.abs(mTime)<1e11) mTime*=1000;
        mTime=Math.floor(mTime);
        // Find nearest index in normalized (original time base)
        let idx = -1;
        // binary search in normalized
        let lo2=0, hi2=normalized.length-1;
        while (lo2<=hi2) { const mid=(lo2+hi2)>>1; if (normalized[mid].time===mTime){ idx=mid; break; } if (normalized[mid].time < mTime) lo2=mid+1; else hi2=mid-1; }
        if (idx<0) {
          const insertion=lo2;
          const left=insertion>0?insertion-1:-1;
          const right=insertion<normalized.length?insertion:-1;
          if (left>=0 && right>=0) idx = mTime - normalized[left].time <= normalized[right].time - mTime ? left : right;
          else idx = left>=0?left:right;
          if (idx<0) continue;
          const gap = normalized.length>1 ? Math.max(1, normalized[normalized.length-1].time - normalized[normalized.length-2].time) : 60000;
          if (Math.abs(normalized[idx].time - mTime) > gap*2) continue;
        }
        // Map to view index
        const viewIdx = idx - startIdx;
        if (viewIdx<0 || viewIdx>=view.length) continue;
        const mx = xFor(viewIdx);
        const my = yPrice(mPrice);
        if (!Number.isFinite(my) || my < -20 || my > priceH+20) continue;
        const isPut = mk.dir==="PUT";
        ctx.fillStyle = isPut ? "#ff5d7a" : "#3dff9a";
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.lineWidth = 1;
        const s=8;
        ctx.beginPath();
        if (isPut) {
          ctx.moveTo(mx, my-10);
          ctx.lineTo(mx-s, my-10-s*1.2);
          ctx.lineTo(mx+s, my-10-s*1.2);
        } else {
          ctx.moveTo(mx, my+10);
          ctx.lineTo(mx-s, my+10+s*1.2);
          ctx.lineTo(mx+s, my+10+s*1.2);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Confidence badge
        if (mk.confidence!=null) {
          ctx.fillStyle = isPut ? "rgba(255,93,122,0.95)" : "rgba(61,255,154,0.95)";
          ctx.font = "bold 8px ui-monospace, monospace";
          ctx.textAlign = "center";
          const label = Math.round(mk.confidence) + "%";
          const bx = mx, by = isPut ? my-10-s*1.2-12 : my+10+s*1.2+4;
          const tw = ctx.measureText(label).width + 6;
          ctx.fillRect(bx - tw/2, by, tw, 11);
          ctx.fillStyle = "#0a1420";
          ctx.fillText(label, bx, by+8);
        }
      }
    }

    // Current price line
    const lastC = view[view.length-1];
    if (lastC) {
      const lastY = yPrice(lastC.close);
      ctx.setLineDash([5,4]);
      ctx.strokeStyle = "rgba(255,255,255,0.28)";
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, lastY); ctx.lineTo(padL+plotW, lastY); ctx.stroke();
      ctx.setLineDash([]);
      // Price label on right axis
      const isUp = lastC.close >= lastC.open;
      ctx.fillStyle = isUp ? "#3dff9a" : "#ff5d7a";
      const labelW = 62, labelH = 18;
      const labelX = w - padR + 4;
      ctx.fillRect(labelX, lastY - labelH/2, labelW-6, labelH);
      // Triangle pointer
      ctx.beginPath();
      ctx.moveTo(labelX, lastY - 5);
      ctx.lineTo(labelX, lastY + 5);
      ctx.lineTo(labelX - 5, lastY);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#0c1422";
      ctx.font = "bold 10px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.fillText(fmtPx(lastC.close, state.decimals), labelX + (labelW-6)/2, lastY+3);
    }

    // Volume panel
    let curY = priceH;
    if (showVol) {
      curY += 6;
      const volTop = curY;
      const volBottom = curY + volH;
      // Background
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(padL, volTop, plotW, volH);
      // Grid
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.beginPath(); ctx.moveTo(padL, volTop); ctx.lineTo(padL+plotW, volTop); ctx.stroke();
      // Volume bars
      let maxVol = 0;
      for (const c of view) if (c.volume > maxVol) maxVol = c.volume;
      if (maxVol <=0) maxVol = 1;
      for (let i=0;i<view.length;i++) {
        const c = view[i];
        const x = xFor(i);
        const h = (c.volume / maxVol) * (volH - 4);
        const y = volBottom - h;
        const up = c.close >= c.open;
        ctx.fillStyle = up ? "rgba(61,255,154,0.6)" : "rgba(255,93,122,0.6)";
        ctx.fillRect(x - candleBodyW/2, y, candleBodyW, h);
      }
      // Label
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.fillText("VOL", padL+4, volTop+10);
      curY = volBottom;
    }

    // MACD panel
    if (showMacd && indicators.macd) {
      curY += 6;
      const macdTop = curY;
      const macdBottom = curY + macdH;
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(padL, macdTop, plotW, macdH);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath(); ctx.moveTo(padL, macdTop); ctx.lineTo(padL+plotW, macdTop); ctx.stroke();
      const m = indicators.macd;
      let mMax = 1e-9;
      for (let i=0;i<m.hist.length;i++) {
        for (const v of [m.hist[i], m.line[i], m.signal[i]]) if (v!=null && Math.abs(v)>mMax) mMax=Math.abs(v);
      }
      const y0 = macdTop + macdH/2;
      const yMacd = (v) => y0 - ((v||0)/mMax) * (macdH/2 - 6);
      // Zero line
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.beginPath(); ctx.moveTo(padL, y0); ctx.lineTo(padL+plotW, y0); ctx.stroke();
      // Histogram
      for (let i=0;i<m.hist.length;i++) {
        if (m.hist[i]==null) continue;
        const x=xFor(i);
        const v=m.hist[i];
        ctx.fillStyle = v>=0 ? "rgba(61,255,154,0.85)" : "rgba(255,93,122,0.85)";
        const y = yMacd(v);
        ctx.fillRect(x - Math.max(1, bw*0.28), Math.min(y0, y), Math.max(1.5, bw*0.56), Math.max(1, Math.abs(y0-y)));
      }
      const drawM = (arr, color) => {
        ctx.strokeStyle=color; ctx.lineWidth=1.2; ctx.beginPath(); let s=false;
        for (let i=0;i<arr.length;i++){ if(arr[i]==null) continue; const x=xFor(i), y=yMacd(arr[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
        ctx.stroke(); ctx.lineWidth=1;
      };
      drawM(m.line, "#4aa3ff");
      drawM(m.signal, "#ffc457");
      ctx.fillStyle="rgba(255,255,255,0.45)"; ctx.font="9px system-ui, sans-serif"; ctx.textAlign="left";
      ctx.fillText("MACD 12/26/9", padL+4, macdTop+12);
      curY = macdBottom;
    }

    // RSI panel
    if (showRsi && indicators.rsi) {
      curY += 6;
      const rsiTop = curY;
      const rsiBottom = curY + rsiH;
      ctx.fillStyle = "rgba(255,255,255,0.02)";
      ctx.fillRect(padL, rsiTop, plotW, rsiH);
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.beginPath(); ctx.moveTo(padL, rsiTop); ctx.lineTo(padL+plotW, rsiTop); ctx.stroke();
      // 70/30 lines
      const yRsi = (v) => rsiBottom - (v/100)*(rsiH-8) -4;
      ctx.strokeStyle="rgba(255,255,255,0.1)"; ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(padL, yRsi(70)); ctx.lineTo(padL+plotW, yRsi(70)); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, yRsi(30)); ctx.lineTo(padL+plotW, yRsi(30)); ctx.stroke();
      ctx.setLineDash([]);
      // RSI line
      ctx.strokeStyle="#a78bfa"; ctx.lineWidth=1.2; ctx.beginPath(); let s=false;
      for (let i=0;i<indicators.rsi.length;i++){ if(indicators.rsi[i]==null) continue; const x=xFor(i), y=yRsi(indicators.rsi[i]); if(!s){ctx.moveTo(x,y); s=true;} else ctx.lineTo(x,y); }
      ctx.stroke(); ctx.lineWidth=1;
      ctx.fillStyle="rgba(255,255,255,0.45)"; ctx.font="9px system-ui, sans-serif"; ctx.textAlign="left";
      ctx.fillText("RSI 14", padL+4, rsiTop+12);
      curY = rsiBottom;
    }

    // Time axis
    const timeTop = totalH - timeAxisH;
    ctx.fillStyle = "rgba(10,18,32,0.9)";
    ctx.fillRect(0, timeTop, w, timeAxisH);
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.beginPath(); ctx.moveTo(padL, timeTop); ctx.lineTo(padL+plotW, timeTop); ctx.stroke();
    ctx.fillStyle = "rgba(180,200,230,0.6)";
    ctx.font = "9px ui-monospace, monospace";
    ctx.textAlign = "center";
    const labelEvery = Math.max(1, Math.floor(view.length/7));
    const useUtc = opts.timeBasis !== "local";
    for (let i=0;i<view.length;i+=labelEvery) {
      const x = xFor(i);
      const label = view.length>100 && i% (labelEvery*2)===0 ? axisDateLabel(view[i].time, useUtc) : axisTimeLabel(view[i].time, useUtc);
      ctx.fillText(label, x, timeTop+13);
    }

    // Info header
    ctx.fillStyle = "rgba(255,255,255,0.38)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "left";
    const tfLabel = opts.timeframe || "1m";
    const countLabel = view.length + "/" + totalBars + " bars";
    const lastLabel = view.length ? axisTimeLabel(view[view.length-1].time, useUtc) + " UTC" : "";
    ctx.fillText((opts.label || "CYBER BINARY") + " · " + tfLabel + " · " + countLabel + (lastLabel ? " · last " + lastLabel : ""), padL+6, 14);

    // Legend for EMAs/BB
    let legendX = padL + 160;
    const legendY = 14;
    ctx.font = "9px ui-monospace, monospace";
    if (state.showEMA) {
      ctx.fillStyle = "rgba(77,255,255,0.9)"; ctx.fillText("EMA8", legendX, legendY); legendX+=38;
      ctx.fillStyle = "rgba(255,196,87,0.9)"; ctx.fillText("EMA21", legendX, legendY); legendX+=42;
      ctx.fillStyle = "rgba(180,120,255,0.8)"; ctx.fillText("EMA50", legendX, legendY); legendX+=42;
    }
    if (state.showBB) {
      ctx.fillStyle = "rgba(74,163,255,0.7)"; ctx.fillText("BB 20/2", legendX, legendY); legendX+=50;
    }

    // Crosshair
    if (state.crosshair && state.crosshair.idx>=0 && state.crosshair.idx < view.length) {
      const idx = state.crosshair.idx;
      const x = xFor(idx);
      const c = view[idx];
      const y = yPrice(c.close);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, timeTop); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+plotW, y); ctx.stroke();
      ctx.setLineDash([]);
      // Dot at close
      ctx.fillStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = c.close>=c.open ? "#3dff9a" : "#ff5d7a";
      ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI*2); ctx.fill();
    }

    // Store view for interaction
    state._lastView = view;
    state._lastStartIdx = startIdx;
    state._lastPlot = { padL, padR, plotW, priceH, totalH, timeTop, yPrice, xFor, lo, hi, view };
    state._lastIndicators = indicators;
    state._lastNormalized = normalized;
  }

  function bindMainChartInteractions(canvas) {
    if (!canvas) return;
    const state = getState(canvas);
    if (state._bound) return;
    state._bound = true;

    const getMousePos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width / (window.devicePixelRatio||1);
      const scaleY = canvas.height / rect.height / (window.devicePixelRatio||1);
      // We use CSS pixels for interaction
      const x = (e.clientX - rect.left);
      const y = (e.clientY - rect.top);
      return { x, y, rect };
    };

    const updateCrosshair = (e) => {
      const pos = getMousePos(e);
      const plot = state._lastPlot;
      if (!plot) return;
      const { padL, plotW, priceH, view, xFor, yPrice } = plot;
      if (pos.x < padL || pos.x > padL+plotW || pos.y > plot.timeTop) {
        state.crosshair = null;
        state.hoverIdx = -1;
        const tip = state.tooltipEl;
        if (tip) tip.style.display = "none";
        canvas.style.cursor = "default";
        drawMainChart(canvas, state._lastNormalized || [], {}); // redraw without crosshair? We'll just redraw with same data via stored?
        // Actually we need to trigger a redraw via dashboard.js - but we can just redraw using last normalized
        if (state._lastNormalized) {
          // Use last opts from canvas? We store last raw in state
          // We'll call drawMainChart with last raw to refresh
          // This is a bit hacky but works for tooltip hide
        }
        return;
      }
      const relX = pos.x - padL;
      const idx = Math.min(view.length-1, Math.max(0, Math.floor(relX / (plotW / view.length))));
      state.hoverIdx = idx;
      state.crosshair = { idx, x: xFor(idx), y: yPrice(view[idx].close) };
      canvas.style.cursor = "crosshair";

      // Tooltip
      const tip = ensureTooltip(canvas);
      const c = view[idx];
      const ind = state._lastIndicators || {};
      const ema8 = ind.ema8 && ind.ema8[idx]!=null ? ind.ema8[idx].toFixed(5) : "—";
      const ema21 = ind.ema21 && ind.ema21[idx]!=null ? ind.ema21[idx].toFixed(5) : "—";
      const rsi = ind.rsi && ind.rsi[idx]!=null ? ind.rsi[idx].toFixed(1) : "—";
      const vol = c.volume ? c.volume.toFixed(0) : "—";
      const change = ((c.close - c.open)/c.open*100).toFixed(3);
      const timeStr = new Date(c.time).toISOString().replace("T"," ").slice(0,19) + " UTC";
      tip.innerHTML = `
        <div style="display:flex;justify-content:space-between;margin-bottom:6px"><strong style="color:#7ff5ff">${timeStr}</strong><span style="color:${c.close>=c.open?'#3dff9a':'#ff5d7a'}">${change}%</span></div>
        <div style="display:grid;grid-template-columns:auto auto;gap:2px 12px">
          <span style="color:#8aa0c8">O</span><span>${fmtPx(c.open, state.decimals)}</span>
          <span style="color:#8aa0c8">H</span><span>${fmtPx(c.high, state.decimals)}</span>
          <span style="color:#8aa0c8">L</span><span>${fmtPx(c.low, state.decimals)}</span>
          <span style="color:#8aa0c8">C</span><span style="color:${c.close>=c.open?'#3dff9a':'#ff5d7a'}">${fmtPx(c.close, state.decimals)}</span>
          <span style="color:#8aa0c8">V</span><span>${vol}</span>
          <span style="color:#8aa0c8">EMA8</span><span>${ema8}</span>
          <span style="color:#8aa0c8">EMA21</span><span>${ema21}</span>
          <span style="color:#8aa0c8">RSI</span><span>${rsi}</span>
        </div>
      `;
      tip.style.display = "block";
      // Position tooltip near mouse, avoid overflow
      const tipW = 220, tipH = 160;
      let left = pos.rect ? pos.rect.left + pos.x + 14 : e.clientX + 14;
      let top = pos.rect ? pos.rect.top + pos.y - 80 : e.clientY - 80;
      if (left + tipW > window.innerWidth - 8) left = (pos.rect ? pos.rect.left + pos.x : e.clientX) - tipW - 14;
      if (top + tipH > window.innerHeight - 8) top = window.innerHeight - tipH - 8;
      if (top < 8) top = 8;
      tip.style.left = left + "px";
      tip.style.top = top + "px";

      // Redraw with crosshair
      // We need to redraw - use stored normalized
      if (state._lastNormalized) {
        // prevent recursion infinite loop: we call drawMainChart which will use same state but not trigger tooltip again
        // We'll directly call internal draw without rebinding
        // To avoid flicker, we call drawMainChart but it will overwrite crosshair? We set crosshair before, so it will draw
        const raw = state._lastNormalized;
        // We need to pass empty opts to keep state
        // But drawMainChart will recompute view - that's okay
        // To avoid infinite loop, we skip tooltip creation inside draw
        requestAnimationFrame(() => {
          if (state._lastNormalized) {
            drawMainChart(canvas, state._lastNormalized, {});
          }
        });
      }
    };

    canvas.addEventListener("mousemove", updateCrosshair);
    canvas.addEventListener("mouseleave", () => {
      state.crosshair = null;
      state.hoverIdx = -1;
      const tip = state.tooltipEl;
      if (tip) tip.style.display = "none";
      canvas.style.cursor = "default";
      if (state._lastNormalized) drawMainChart(canvas, state._lastNormalized, {});
    });

    // Wheel zoom
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      let newBars = state.visibleBars + delta * 8;
      newBars = Math.max(20, Math.min(500, newBars));
      state.visibleBars = newBars;
      if (state._lastNormalized) drawMainChart(canvas, state._lastNormalized, {});
    }, { passive: false });

    // Drag pan
    canvas.addEventListener("mousedown", (e) => {
      state.isDragging = true;
      state.dragStartX = e.clientX;
      state.dragStartOffset = state.scrollOffset;
      canvas.style.cursor = "grabbing";
    });
    window.addEventListener("mouseup", () => {
      if (state.isDragging) {
        state.isDragging = false;
        canvas.style.cursor = "crosshair";
      }
    });
    window.addEventListener("mousemove", (e) => {
      if (!state.isDragging) return;
      const dx = e.clientX - state.dragStartX;
      const plotW = state._lastPlot ? state._lastPlot.plotW : 600;
      const viewLen = state._lastPlot ? state._lastPlot.view.length : 100;
      const barsPerPx = viewLen / plotW;
      const deltaBars = -dx * barsPerPx;
      let newOffset = state.dragStartOffset + deltaBars;
      const totalBars = state._lastNormalized ? state._lastNormalized.length : 500;
      newOffset = Math.max(0, Math.min(totalBars - 10, newOffset));
      state.scrollOffset = newOffset;
      if (state._lastNormalized) drawMainChart(canvas, state._lastNormalized, {});
    });
  }

  // --- Equity chart enhanced ---
  function drawEquityChart(canvas, equity, opts) {
    if (!canvas) return;
    opts = opts || {};
    const parent = canvas.parentElement;
    const w = Math.max(320, Math.min(4096, (parent && parent.clientWidth) || 800));
    const priceH = Math.max(140, Math.round(w * 0.28));
    const ddH = Math.max(48, Math.round(w * 0.09));
    const timeAxisH = 18;
    const totalH = priceH + ddH + timeAxisH + 16;
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
    canvas.width = Math.floor(w*dpr);
    canvas.height = Math.floor(totalH*dpr);
    canvas.style.width = w+"px";
    canvas.style.height = totalH+"px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,totalH);
    const bg = ctx.createLinearGradient(0,0,0,totalH);
    bg.addColorStop(0, "#0c1422");
    bg.addColorStop(1, "#0a1220");
    ctx.fillStyle = bg;
    ctx.fillRect(0,0,w,totalH);

    if (!Array.isArray(equity) || equity.length < 2) {
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No equity data — run backtest first", w/2, totalH/2);
      return;
    }
    const eq = equity.filter(e=>e && Number.isFinite(e.equity));
    if (eq.length<2) return;
    let lo=Infinity, hi=-Infinity, maxDD=0, peak=-Infinity, finalPnL=0;
    for (const e of eq) {
      if (e.equity < lo) lo=e.equity;
      if (e.equity > hi) hi=e.equity;
      if (Number.isFinite(e.drawdown) && e.drawdown > maxDD) maxDD=e.drawdown;
      if (e.equity > peak) peak=e.equity;
    }
    finalPnL = eq[eq.length-1].equity;
    const pad = (hi-lo)*0.12 || 1;
    lo-=pad; hi+=pad;
    if (maxDD < 0.1) maxDD = Math.max(1, Math.abs(lo)*0.05);

    function yEq(v){ return priceH - ((v-lo)/(hi-lo))*(priceH-24) -12; }
    function yDD(v){ return priceH+12 + ddH - (v/maxDD)*(ddH-10) -6; }
    function xFor(i){ return 12 + (i/(eq.length-1))*(w-24); }

    // Grid
    ctx.strokeStyle="rgba(255,255,255,0.06)";
    const ticks = niceTicks(lo, hi, 5);
    ctx.font="10px ui-monospace, monospace";
    ctx.textAlign="right";
    for (const t of ticks) {
      const y=yEq(t);
      if (y<10 || y>priceH-2) continue;
      ctx.beginPath(); ctx.moveTo(12, y); ctx.lineTo(w-12, y); ctx.stroke();
      ctx.fillStyle="rgba(180,200,230,0.5)";
      ctx.fillText(t.toFixed(2), w-4, y+3);
    }
    // Zero line
    if (lo<0 && hi>0) {
      const zy=yEq(0);
      ctx.strokeStyle="rgba(255,255,255,0.14)";
      ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(12, zy); ctx.lineTo(w-12, zy); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Equity area gradient
    const grad = ctx.createLinearGradient(0,0,0,priceH);
    grad.addColorStop(0, "rgba(74,163,255,0.32)");
    grad.addColorStop(0.6, "rgba(74,163,255,0.08)");
    grad.addColorStop(1, "rgba(74,163,255,0)");
    ctx.fillStyle=grad;
    ctx.beginPath();
    for (let i=0;i<eq.length;i++){ const x=xFor(i), y=yEq(eq[i].equity); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.lineTo(xFor(eq.length-1), priceH);
    ctx.lineTo(xFor(0), priceH);
    ctx.closePath(); ctx.fill();

    // Equity line
    ctx.strokeStyle="#4aa3ff";
    ctx.lineWidth=1.8;
    ctx.beginPath();
    for (let i=0;i<eq.length;i++){ const x=xFor(i), y=yEq(eq[i].equity); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke();
    ctx.lineWidth=1;

    // Peak line
    if (peak>lo) {
      const py=yEq(peak);
      ctx.strokeStyle="rgba(61,255,154,0.35)";
      ctx.setLineDash([3,3]);
      ctx.beginPath(); ctx.moveTo(12, py); ctx.lineTo(w-12, py); ctx.stroke();
      ctx.setLineDash([]);
    }

    // Trade markers if available in equity (with won/loss)
    if (opts.trades && Array.isArray(opts.trades)) {
      const trades = opts.trades;
      // trades sorted same as equity? Assume equity index corresponds
      for (let i=0;i<Math.min(trades.length, eq.length);i++) {
        const t = trades[i];
        if (!t) continue;
        const x=xFor(i);
        const y=yEq(eq[i].equity);
        if (t.won) {
          ctx.fillStyle="#3dff9a";
          ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI*2); ctx.fill();
        } else if (t.won===false) {
          ctx.fillStyle="#ff5d7a";
          ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI*2); ctx.fill();
        }
      }
    }

    // Drawdown panel
    const ddTop = priceH+8;
    ctx.fillStyle="rgba(255,255,255,0.02)";
    ctx.fillRect(12, ddTop, w-24, ddH);
    ctx.strokeStyle="rgba(255,255,255,0.06)";
    ctx.strokeRect(12, ddTop, w-24, ddH);

    // Drawdown area
    ctx.fillStyle="rgba(255,93,122,0.22)";
    ctx.beginPath();
    ctx.moveTo(xFor(0), yDD(0));
    for (let i=0;i<eq.length;i++) ctx.lineTo(xFor(i), yDD(eq[i].drawdown||0));
    ctx.lineTo(xFor(eq.length-1), yDD(0));
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle="rgba(255,93,122,0.65)";
    ctx.lineWidth=1;
    ctx.beginPath();
    for (let i=0;i<eq.length;i++){ const x=xFor(i), y=yDD(eq[i].drawdown||0); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); }
    ctx.stroke();

    // Labels
    ctx.fillStyle="rgba(255,255,255,0.55)";
    ctx.font="10px ui-monospace, monospace";
    ctx.textAlign="left";
    ctx.fillText(`Equity · ${eq.length} pts · P&L ${finalPnL.toFixed(2)} · Peak ${peak.toFixed(2)} · MaxDD ${maxDD.toFixed(2)}`, 12, 14);
    ctx.fillStyle="rgba(255,93,122,0.7)";
    ctx.fillText(`Drawdown`, 12, ddTop+12);
    ctx.fillStyle="rgba(180,200,230,0.5)";
    ctx.textAlign="right";
    ctx.fillText(maxDD.toFixed(2), w-14, ddTop+12);
    ctx.fillText("0", w-14, ddTop+ddH-4);

    // Final value label
    const lastY = yEq(finalPnL);
    ctx.fillStyle = finalPnL>=0 ? "#3dff9a" : "#ff5d7a";
    ctx.fillRect(w-68, lastY-9, 56, 18);
    ctx.fillStyle="#0c1422";
    ctx.font="bold 10px ui-monospace, monospace";
    ctx.textAlign="center";
    ctx.fillText(finalPnL.toFixed(2), w-40, lastY+3);
  }

  // --- Monte Carlo enhanced ---
  function drawMonteCarloChart(canvas, mcResults, opts) {
    if (!canvas) return;
    opts = opts || {};
    const parent = canvas.parentElement;
    const w = Math.max(320, Math.min(4096, (parent && parent.clientWidth) || 800));
    const h = Math.max(160, Math.round(w * 0.28));
    const dpr = Math.max(1, Math.min(2, Number(window.devicePixelRatio)||1));
    canvas.width = Math.floor(w*dpr);
    canvas.height = Math.floor(h*dpr);
    canvas.style.width=w+"px";
    canvas.style.height=h+"px";
    const ctx=canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);
    ctx.fillStyle="#0c1422";
    ctx.fillRect(0,0,w,h);

    if (!mcResults || !Array.isArray(mcResults) || mcResults.length<5) {
      ctx.fillStyle="rgba(255,255,255,0.45)";
      ctx.font="11px system-ui, sans-serif";
      ctx.textAlign="center";
      ctx.fillText("Run Monte Carlo to see distribution", w/2, h/2);
      return;
    }
    const vals = mcResults.map(r=>r.finalPnL).sort((a,b)=>a-b);
    const lo=vals[0], hi=vals[vals.length-1];
    const range=hi-lo||1;
    const bins=50;
    const counts=new Array(bins).fill(0);
    for (const v of vals){ const idx=Math.min(bins-1, Math.max(0, Math.floor((v-lo)/range*bins))); counts[idx]++; }
    const maxC=Math.max(...counts)||1;
    const padL=50, padR=16, padT=24, padB=28;
    const plotW=w-padL-padR, plotH=h-padT-padB;

    // Grid
    ctx.strokeStyle="rgba(255,255,255,0.06)";
    ctx.beginPath();
    for (let i=0;i<=4;i++){ const y=padT + (i/4)*plotH; ctx.moveTo(padL, y); ctx.lineTo(padL+plotW, y); }
    ctx.stroke();

    // Bars with gradient
    for (let i=0;i<bins;i++){
      const x=padL + (i/bins)*plotW;
      const bw=plotW/bins*0.78;
      const bh=(counts[i]/maxC)*plotH;
      const y=padT+plotH-bh;
      const grad=ctx.createLinearGradient(0,y,0,y+bh);
      grad.addColorStop(0, "rgba(74,163,255,0.9)");
      grad.addColorStop(1, "rgba(74,163,255,0.25)");
      ctx.fillStyle=grad;
      // rounded top
      ctx.beginPath();
      const r=2;
      ctx.moveTo(x, y+bh);
      ctx.lineTo(x, y+r);
      ctx.quadraticCurveTo(x, y, x+r, y);
      ctx.lineTo(x+bw-r, y);
      ctx.quadraticCurveTo(x+bw, y, x+bw, y+r);
      ctx.lineTo(x+bw, y+bh);
      ctx.closePath();
      ctx.fill();
    }

    // Percentile lines
    function percentile(p){
      const idx=Math.floor((p/100)*vals.length);
      return vals[Math.min(vals.length-1, Math.max(0, idx))];
    }
    const p5=percentile(5), p25=percentile(25), p50=percentile(50), p75=percentile(75), p95=percentile(95);
    const markers=[
      { v:p5, label:"5%", color:"#ff5d7a" },
      { v:p50, label:"Med", color:"#7ff5ff" },
      { v:p95, label:"95%", color:"#3dff9a" },
    ];
    for (const m of markers){
      const x=padL + ((m.v-lo)/range)*plotW;
      ctx.strokeStyle=m.color;
      ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT+plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=m.color;
      ctx.font="bold 9px ui-monospace, monospace";
      ctx.textAlign="center";
      ctx.fillText(m.label, x, padT-4);
      ctx.font="9px ui-monospace, monospace";
      ctx.fillText(m.v.toFixed(1), x, padT+plotH+12);
    }

    // Axis labels
    ctx.fillStyle="rgba(255,255,255,0.5)";
    ctx.font="9px ui-monospace, monospace";
    ctx.textAlign="left";
    ctx.fillText(lo.toFixed(1), padL, h-4);
    ctx.textAlign="right";
    ctx.fillText(hi.toFixed(1), padL+plotW, h-4);
    ctx.textAlign="left";
    ctx.fillText(`Monte Carlo · ${vals.length} sims · range [${lo.toFixed(1)} → ${hi.toFixed(1)}]`, 12, 14);
  }

  // Export PNG
  function exportCanvasPNG(canvas, filename) {
    if (!canvas) return;
    try {
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || "chart-" + new Date().toISOString().slice(0,10) + ".png";
      a.click();
    } catch (e) {}
  }

  root.CYBER_CHARTS = {
    drawMainChart,
    bindMainChartInteractions,
    drawEquityChart,
    drawMonteCarloChart,
    exportCanvasPNG,
    getState,
    ensureTooltip,
  };
})(typeof self !== "undefined" ? self : globalThis);
