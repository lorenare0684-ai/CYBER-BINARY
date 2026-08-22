/**
 * Auto-trade controller.
 *
 * Two modes:
 *   "alerts" — observe signals, log them, fire sound/desktop notifications,
 *              surface in dashboard. User clicks the trade manually.
 *   "click"  — actively click the visible Quotex CALL/PUT button on the
 *              page, with a stake and expiry. This is fragile (DOM-based)
 *              and gated by safety limits.
 *
 * Safety:
 *   - Off by default.
 *   - Requires explicit arming.
 *   - Daily loss cap kills auto-trade for the rest of the day.
 *   - Min confidence gate.
 *   - Per-hour / per-day trade caps.
 *   - Cooldown bars between trades (v2.3: enforced unconditionally — the old
 *     check read signal.metrics.closeTime which the engine never sets).
 *   - Per-signal dedup (v2.3): one action per (asset, closed bar, direction),
 *     so a signal never re-fires on the 500ms tick loop.
 *   - Hard minimum interval (default 5s, settings.minIntervalMs) even when
 *     cooldown is 0.
 *   - Per-asset "freeze" when an asset just lost.
 *
 * The module never reads the user's broker credentials or attempts to
 * access the broker backend. It only interacts with visible DOM elements
 * on the current chart page.
 */
(function (root) {
  "use strict";

  const STORE = root.CYBER_STORE;

  function safeStorage() { return STORE; }

  function makeId() {
    return "tx_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1e6).toString(36);
  }

  function startAuto(opts) {
    // opts: { onSignal(signal), onTrade(decision), onLog(msg), onState(state) }
    const ctx = {
      running: true,
      armed: false,
      mode: "off",
      lastTrade: null,    // { at, asset, dir, expired }
      lastAttemptAt: 0,   // last time a trade action was actually taken
      lastSignalKey: "",  // dedup: last (asset, bar, direction) processed
      tradesToday: 0,
      tradesHour: 0,
      hourStart: Date.now(),
      dayStart: Date.now(),
      dailyPnl: 0,
      frozenAssets: {},   // assetId → unfreezeAt
      log: [],
    };
    const cfg = (opts && opts.config) || {};
    const max = (opts && opts.maxLog) || 200;

    function pushLog(level, msg) {
      ctx.log.unshift({ at: Date.now(), level, msg });
      if (ctx.log.length > max) ctx.log.length = max;
      if (opts && opts.onLog) opts.onLog({ level, msg, at: Date.now() });
    }

    function snapshot() {
      return {
        running: ctx.running,
        armed: ctx.armed,
        mode: ctx.mode,
        tradesToday: ctx.tradesToday,
        tradesHour: ctx.tradesHour,
        dailyPnl: ctx.dailyPnl,
        lastTrade: ctx.lastTrade,
        lastAttemptAt: ctx.lastAttemptAt,
        lastSignalKey: ctx.lastSignalKey,
        frozenAssets: Object.assign({}, ctx.frozenAssets),
      };
    }

    function emitState() {
      if (opts && opts.onState) opts.onState(snapshot());
    }

    async function loadSettings() {
      try {
        return await safeStorage().getSettings();
      } catch (_) { return null; }
    }

    async function canTrade(signal) {
      const s = await loadSettings();
      if (!s) return { ok: false, reason: "Settings not loaded" };
      if (!ctx.armed) return { ok: false, reason: "Auto not armed" };
      if (ctx.mode === "off") return { ok: false, reason: "Mode off" };
      // Daily reset
      const now = Date.now();
      if (now - ctx.dayStart > 24 * 36e5) {
        ctx.dayStart = now; ctx.tradesToday = 0; ctx.dailyPnl = 0;
      }
      if (now - ctx.hourStart > 36e5) {
        ctx.hourStart = now; ctx.tradesHour = 0;
      }
      if (s.maxTradesPerDay && ctx.tradesToday >= s.maxTradesPerDay) {
        return { ok: false, reason: `Daily cap reached (${s.maxTradesPerDay})` };
      }
      if (s.maxTradesPerHour && ctx.tradesHour >= s.maxTradesPerHour) {
        return { ok: false, reason: `Hourly cap reached (${s.maxTradesPerHour})` };
      }
      if (s.dailyLossCap && ctx.dailyPnl <= -Math.abs(s.dailyLossCap)) {
        return { ok: false, reason: `Daily loss cap hit (${s.dailyLossCap})` };
      }
      if (s.dailyProfitCap && s.dailyProfitCap > 0 && ctx.dailyPnl >= s.dailyProfitCap) {
        return { ok: false, reason: `Daily profit cap reached` };
      }
      if ((signal.confidence || 0) < (s.minConfidence || 0)) {
        return { ok: false, reason: `Low confidence (${signal.confidence})` };
      }
      // Cooldown — enforced unconditionally (v2.3: the old check depended on
      // signal.metrics.closeTime which the engine never sets, so cooldown was
      // skipped entirely and auto mode spammed one trade per 500ms tick).
      if (ctx.lastTrade) {
        const mins = (Date.now() - ctx.lastTrade.at) / 60000;
        if (mins < (s.cooldownBars || 0)) {
          return { ok: false, reason: `Cooldown (${mins.toFixed(1)}m of ${s.cooldownBars}m)` };
        }
      }
      // Hard safety floor: never act more often than every 5 seconds, no
      // matter what the settings say (configurable via settings.minIntervalMs
      // for testing / expert tuning; default 5000).
      const minGap = (s.minIntervalMs != null && Number.isFinite(Number(s.minIntervalMs)))
        ? Math.max(1000, Number(s.minIntervalMs)) : 5000;
      if (ctx.lastAttemptAt && Date.now() - ctx.lastAttemptAt < minGap) {
        return { ok: false, reason: `Minimum interval (${(minGap / 1000).toFixed(0)}s)` };
      }
      // Asset freeze
      const asset = signal.asset;
      if (asset && ctx.frozenAssets[asset] && ctx.frozenAssets[asset] > now) {
        return { ok: false, reason: `Asset frozen until ${new Date(ctx.frozenAssets[asset]).toLocaleTimeString()}` };
      }
      return { ok: true, settings: s };
    }

    async function handleSignal(signal) {
      if (!ctx.running) return;
      if (!signal || !signal.ready) return;
      if (opts && opts.onSignal) opts.onSignal(signal);
      if (signal.direction === "WAIT") return;
      if (ctx.mode === "off" || !ctx.armed) return;

      // v2.3: per-signal dedup — one attempt per (asset, bar, direction).
      // handleSignal is called on every tick by content.js; without this the
      // controller placed/alerted on the SAME bar+direction repeatedly.
      // Only applies when a bar timestamp exists; otherwise the 5s minimum
      // interval in canTrade() still throttles.
      const barKey = signal.time || (signal.metrics && (signal.metrics.time || signal.metrics.closeTime)) || 0;
      if (barKey) {
        const sigKey = (signal.asset || "") + ":" + barKey + ":" + signal.direction;
        if (sigKey === ctx.lastSignalKey) return;
        ctx.lastSignalKey = sigKey;
      }

      const decision = await canTrade(signal);
      const log = {
        id: makeId(),
        at: Date.now(),
        dir: signal.direction,
        asset: signal.asset,
        confidence: signal.confidence,
        score: signal.score,
        regime: signal.regime,
        reason: signal.reason,
        ok: decision.ok,
        blockedReason: decision.reason,
        action: null,
      };

      if (!decision.ok) {
        // Release the dedup key so the next (new) bar gets a fresh chance,
        // but a NEW bar+direction WILL get evaluated (keys differ anyway).
        pushLog("skip", `Skip ${signal.direction} ${signal.asset || ""}: ${decision.reason}`);
        if (opts && opts.onTrade) opts.onTrade(log);
        return;
      }

      // Mode-specific action
      if (ctx.mode === "click" && decision.settings) {
        const result = await clickTrade({
          dir: signal.direction,
          stake: decision.settings.stake,
          expiry: decision.settings.expiry,
        });
        log.action = result;
        ctx.lastAttemptAt = Date.now();
        if (result && result.ok) {
          ctx.tradesToday++;
          ctx.tradesHour++;
          ctx.lastTrade = { at: Date.now(), asset: signal.asset, dir: signal.direction };
          pushLog("trade", `Trade placed: ${signal.direction} ${signal.asset || ""} conf=${signal.confidence}`);
        } else {
          pushLog("error", `Trade click failed: ${(result && result.error) || "unknown"}`);
        }
      } else if (ctx.mode === "alerts") {
        log.action = { kind: "alert" };
        ctx.lastAttemptAt = Date.now();
        if (decision.settings && decision.settings.notifySound) playBeep(signal.direction);
        if (decision.settings && decision.settings.notifyDesktop) notifyDesktop(signal);
        ctx.tradesToday++;
        ctx.tradesHour++;
        ctx.lastTrade = { at: Date.now(), asset: signal.asset, dir: signal.direction };
        pushLog("alert", `ALERT ${signal.direction} ${signal.asset || ""} conf=${signal.confidence}`);
      }

      if (opts && opts.onTrade) opts.onTrade(log);
      emitState();
    }

    function setMode(mode) {
      ctx.mode = mode;
      pushLog("info", `Mode set to ${mode}`);
      emitState();
    }
    function setArmed(b) {
      ctx.armed = !!b;
      pushLog(ctx.armed ? "info" : "warn", ctx.armed ? "Auto ARMED" : "Auto disarmed");
      emitState();
    }
    function stop() {
      ctx.running = false;
      ctx.armed = false;
      pushLog("warn", "Auto stopped");
      emitState();
    }
    function updateDailyPnl(delta) {
      ctx.dailyPnl += delta;
      emitState();
    }
    function freezeAsset(assetId, minutes) {
      ctx.frozenAssets[assetId] = Date.now() + (minutes || 15) * 60000;
      pushLog("info", `Asset ${assetId} frozen for ${minutes || 15}m`);
      emitState();
    }
    function unfreezeAsset(assetId) {
      delete ctx.frozenAssets[assetId];
      pushLog("info", `Asset ${assetId} unfrozen`);
      emitState();
    }
    function getLog() { return ctx.log.slice(); }
    function getState() { return snapshot(); }

    emitState();
    return {
      handleSignal,
      setMode,
      setArmed,
      stop,
      updateDailyPnl,
      freezeAsset,
      unfreezeAsset,
      getLog,
      getState,
    };
  }

  /* --- DOM helpers for click trade --- */
  function findTradeButton(dir) {
    // v2.1: prefer the quotex adapter (it has the canonical selectors).
    if (root.CYBER_QUOTEX) {
      const btn = dir === "CALL" ? root.CYBER_QUOTEX.findCallButton() : root.CYBER_QUOTEX.findPutButton();
      if (btn) return btn;
    }
    // Quotex is a SPA. The CALL/PUT button is near the stake/expiry panel.
    const sels = [
      `button[class*='call']`,
      `button[class*='put']`,
      `[class*='call-btn']`,
      `[class*='put-btn']`,
      `button[data-type='CALL']`,
      `button[data-type='PUT']`,
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        const t = (el.textContent || "").trim().toUpperCase();
        if (dir === "CALL" && (sel.includes("call") || t.startsWith("CALL") || t.includes("↑"))) return el;
        if (dir === "PUT" && (sel.includes("put") || t.startsWith("PUT") || t.includes("↓"))) return el;
      }
    }
    // Fallback: scan all buttons near stake panel
    const allBtns = document.querySelectorAll("button");
    for (const b of allBtns) {
      if (b.offsetParent === null) continue;
      const t = (b.textContent || "").trim().toUpperCase();
      if (dir === "CALL" && (t === "CALL" || t === "BUY" || t.includes("↑"))) return b;
      if (dir === "PUT" && (t === "PUT" || t === "SELL" || t.includes("↓"))) return b;
    }
    return null;
  }

  async function setStake(amount) {
    // v2.1: prefer the quotex adapter.
    if (root.CYBER_QUOTEX) {
      const r = root.CYBER_QUOTEX.setStake(amount);
      if (r) return true;
    }
    // Try to find the stake input and set its value, dispatch input event.
    const sels = [
      "input[class*='amount']",
      "input[class*='stake']",
      "input[class*='sum']",
      "input[aria-label*='amount' i]",
      "input[aria-label*='stake' i]",
      "input[type='number']",
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null) {
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(el, String(amount));
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        } catch (_) { /* ignore */ }
      }
    }
    return false;
  }

  async function clickTrade(args) {
    args = args || {};
    // v2.1: prefer the quotex adapter for a single end-to-end call.
    if (root.CYBER_QUOTEX && args.mode !== "ws") {
      const r = root.CYBER_QUOTEX.placeTrade({
        dir: args.dir,
        amount: args.stake,
        expiry: args.expiry ? Math.max(30, Math.round(args.expiry * 60)) : undefined,
      });
      if (r && r.ok) return r;
    }
    try {
      if (args.stake) await setStake(args.stake);
      const btn = findTradeButton(args.dir);
      if (!btn) return { ok: false, error: "Trade button not visible" };
      btn.click();
      return { ok: true, dir: args.dir, stake: args.stake, expiry: args.expiry, mode: "dom" };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  /* --- Alert helpers --- */
  function playBeep(dir) {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.type = "sine";
      o.frequency.value = dir === "CALL" ? 880 : 440;
      g.gain.setValueAtTime(0.001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.02);
      o.start();
      o.stop(ctx.currentTime + 0.15);
      setTimeout(() => ctx.close && ctx.close(), 250);
    } catch (_) { /* ignore */ }
  }

  function notifyDesktop(signal) {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "granted") {
        new Notification(`CYBER BINARY ${signal.direction}`, {
          body: `${signal.asset || ""} conf=${signal.confidence}% ${signal.reason || ""}`,
        });
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission();
      }
    } catch (_) { /* ignore */ }
  }

  root.CYBER_AUTO = { startAuto, clickTrade, setStake, playBeep, notifyDesktop, findTradeButton };
})(typeof self !== "undefined" ? self : globalThis);
