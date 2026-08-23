/**
 * Auto-trade controller.
 *
 * Two modes:
 *   "alerts" — observe signals, log them, fire sound/desktop notifications,
 *              surface in dashboard. User clicks the trade manually.
 *   "click"  — execute CALL/PUT through a caller-supplied confirmed placement
 *              path (the extension uses its page socket first and a strict
 *              DOM fallback that still waits for broker confirmation).
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

  function numberValue(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    try {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function startAuto(opts) {
    // opts: { onSignal(signal), onTrade(decision), onLog(msg), onState(state) }
    const ctx = {
      running: true,
      armed: false,
      mode: "off",
      lastTrade: null,    // { at, asset, dir, expired }
      lastAttemptAt: 0,   // last time a trade action was actually taken
      lastSignalKey: "",  // most recent (asset, bar, direction) processed
      processedSignals: Object.create(null), // bounded dedup across direction/asset churn
      processedOrder: [],
      settledOrders: Object.create(null),
      settledOrderQueue: [],
      inFlight: false,     // at most one placement/confirmation at a time
      tradesToday: 0,
      tradesHour: 0,
      hourStart: Date.now(),
      dayStart: Date.now(),
      hourKey: new Date().toISOString().slice(0, 13),
      dayKey: new Date().toISOString().slice(0, 10),
      dailyPnl: 0,
      frozenAssets: Object.create(null), // assetId → unfreezeAt
      account: { isDemo: null, balance: null, currency: null, at: 0 }, // v2.6.9 live/demo detection
      log: [],
    };
    const rawMax = numberValue(opts && opts.maxLog);
    const requestedMax = rawMax == null ? null : Math.floor(rawMax);
    const max = requestedMax != null ? Math.max(1, Math.min(2000, requestedMax)) : 200;

    function toMs(value, fallback) {
      let n = numberValue(value);
      if (n == null || n <= 0) return fallback || 0;
      while (n >= 1e14) n /= 1000;
      if (n < 1e11) n *= 1000;
      return Number.isSafeInteger(Math.floor(n)) ? Math.floor(n) : (fallback || 0);
    }

    function safeMapKey(value, maxLength) {
      try {
        const key = String(value == null ? "" : value)
          .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, maxLength || 96);
        return key && !Object.prototype.hasOwnProperty.call(Object.prototype, key) ? key : "";
      } catch (_) { return ""; }
    }

    const hydratePromise = (async () => {
      try {
        const store = safeStorage();
        if (!store || typeof store.getAutomation !== "function") return;
        const saved = await store.getAutomation();
        if (!saved || typeof saved !== "object") return;
        const savedToday = numberValue(saved.tradesToday);
        const savedHour = numberValue(saved.tradesHour);
        ctx.tradesToday = Math.min(100000, Math.max(0, Math.floor(savedToday == null ? 0 : savedToday)));
        ctx.tradesHour = Math.min(100000, Math.max(0, Math.floor(savedHour == null ? 0 : savedHour)));
        const savedPnl = numberValue(saved.dailyPnl);
        ctx.dailyPnl = savedPnl != null ? Math.max(-1000000000, Math.min(1000000000, savedPnl)) : 0;
        ctx.dayStart = toMs(saved.dayStart, ctx.dayStart);
        ctx.hourStart = toMs(saved.hourStart, ctx.hourStart);
        ctx.dayKey = typeof saved.dayKey === "string" && saved.dayKey ? saved.dayKey : ctx.dayKey;
        ctx.hourKey = typeof saved.hourKey === "string" && saved.hourKey ? saved.hourKey : ctx.hourKey;
        if (saved.lastTrade && typeof saved.lastTrade === "object" && !Array.isArray(saved.lastTrade)) {
          ctx.lastTrade = Object.assign({}, saved.lastTrade);
          ctx.lastTrade.at = toMs(saved.lastTrade.at || saved.lastTrade.entryTime, 0);
          ctx.lastTrade.entryTime = toMs(saved.lastTrade.entryTime || saved.lastTrade.at, ctx.lastTrade.at);
          ctx.lastTrade.expiryTime = toMs(saved.lastTrade.expiryTime, 0);
        }
        ctx.lastAttemptAt = toMs(saved.lastAttemptAt, 0);
        const recent = Array.isArray(saved.recentSignalKeys) ? saved.recentSignalKeys.slice(-100) : [];
        if (typeof saved.lastSignalKey === "string" && saved.lastSignalKey) recent.push(saved.lastSignalKey);
        for (const rawKey of recent.slice(-100)) {
          if (typeof rawKey !== "string" || !rawKey || ctx.processedSignals[rawKey]) continue;
          const key = rawKey.slice(0, 256);
          ctx.processedSignals[key] = true;
          ctx.processedOrder.push(key);
          ctx.lastSignalKey = key;
        }
        const closedIds = Array.isArray(saved.recentClosedOrderIds) ? saved.recentClosedOrderIds : [];
        for (const rawId of closedIds.slice(-500)) {
          if (typeof rawId !== "string") continue;
          const id = safeMapKey(rawId, 256);
          if (!id || ctx.settledOrders[id]) continue;
          ctx.settledOrders[id] = true;
          ctx.settledOrderQueue.push(id);
        }
        const frozen = saved.frozenAssets && typeof saved.frozenAssets === "object" && !Array.isArray(saved.frozenAssets)
          ? saved.frozenAssets : {};
        const now = Date.now();
        for (const rawId of Object.keys(frozen).slice(-500)) {
          const id = safeMapKey(rawId, 96);
          const until = toMs(frozen[rawId], 0);
          if (id && until > now && until <= now + 7 * 86400000) ctx.frozenAssets[id] = until;
        }
      } catch (_) {}
    })();

    function persistSafety() {
      try {
        const store = safeStorage();
        if (!store || typeof store.setAutomation !== "function") return Promise.resolve(false);
        return Promise.resolve(store.setAutomation({
          tradesToday: ctx.tradesToday, tradesHour: ctx.tradesHour,
          dailyPnl: ctx.dailyPnl, dayStart: ctx.dayStart, hourStart: ctx.hourStart,
          dayKey: ctx.dayKey, hourKey: ctx.hourKey,
          lastTrade: ctx.lastTrade, lastAttemptAt: ctx.lastAttemptAt,
          lastSignalKey: ctx.lastSignalKey,
          recentSignalKeys: ctx.processedOrder.slice(-100),
          recentClosedOrderIds: ctx.settledOrderQueue.slice(-500),
          frozenAssets: Object.assign({}, ctx.frozenAssets),
        })).then(() => true, () => false);
      } catch (_) { return Promise.resolve(false); }
    }

    function safeCallback(name, value) {
      try {
        if (opts && typeof opts[name] === "function") opts[name](value);
      } catch (_) { /* consumer callbacks must never break the safety lock */ }
    }

    function pushLog(level, msg) {
      ctx.log.unshift({ at: Date.now(), level, msg });
      if (ctx.log.length > max) ctx.log.length = max;
      safeCallback("onLog", { level, msg, at: Date.now() });
    }

    /** v2.6.9: feed the controller the broker's account info (from balance
     * events). isDemo true/false is authoritative; null means unknown and
     * the account-mode gate stays closed for safety. */
    function setAccountInfo(info) {
      if (!info || typeof info !== "object") return;
      const bal = numberValue(info.balance);
      const isDemo = typeof info.isDemo === "boolean" ? info.isDemo : null;
      const currency = typeof info.currency === "string" && info.currency.trim()
        ? info.currency.trim().slice(0, 16) : ctx.account.currency;
      ctx.account = {
        isDemo,
        balance: bal != null && bal >= 0 && bal <= 1e15 ? bal : ctx.account.balance,
        currency,
        at: Date.now(),
      };
      emitState();
    }

    function snapshot() {
      return {
        running: ctx.running,
        account: Object.assign({}, ctx.account),
        armed: ctx.armed,
        mode: ctx.mode,
        tradesToday: ctx.tradesToday,
        tradesHour: ctx.tradesHour,
        dailyPnl: ctx.dailyPnl,
        lastTrade: ctx.lastTrade ? Object.assign({}, ctx.lastTrade) : null,
        lastAttemptAt: ctx.lastAttemptAt,
        lastSignalKey: ctx.lastSignalKey,
        inFlight: ctx.inFlight,
        frozenAssets: Object.assign({}, ctx.frozenAssets),
      };
    }

    function emitState() {
      safeCallback("onState", snapshot());
    }

    async function loadSettings() {
      try {
        return await safeStorage().getSettings();
      } catch (_) { return null; }
    }

    async function canTrade(signal) {
      await hydratePromise;
      let s = await loadSettings();
      if (!s) return { ok: false, reason: "Settings not loaded" };
      if (!ctx.armed) return { ok: false, reason: "Auto not armed" };
      if (ctx.mode === "off") return { ok: false, reason: "Mode off" };
      // Reset on UTC calendar boundaries as well as elapsed-time fallback.
      // A rolling 24-hour window left "today" counters carrying into a new day.
      const now = Date.now();
      const nowDate = new Date(now);
      const dayKey = nowDate.toISOString().slice(0, 10);
      const hourKey = nowDate.toISOString().slice(0, 13);
      let resetCounters = false;
      if (dayKey !== ctx.dayKey || now - ctx.dayStart >= 24 * 36e5) {
        ctx.dayKey = dayKey; ctx.dayStart = now; ctx.tradesToday = 0; ctx.dailyPnl = 0;
        resetCounters = true;
      }
      if (hourKey !== ctx.hourKey || now - ctx.hourStart >= 36e5) {
        ctx.hourKey = hourKey; ctx.hourStart = now; ctx.tradesHour = 0;
        resetCounters = true;
      }
      if (resetCounters) persistSafety();
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
      // v2.6.9: account-mode gate. Default is "demo" — the safest posture:
      // auto-trade refuses to touch a LIVE balance unless the user
      // explicitly switched accountMode to "live"/"any", and refuses to
      // guess when no balance event has identified the account yet.
      const accountMode = s.accountMode === "live" || s.accountMode === "any" ? s.accountMode : "demo";
      if (accountMode !== "any") {
        if (ctx.account.isDemo == null) {
          return { ok: false, reason: "Account mode unknown (no balance event yet) — set Account to Any to override" };
        }
        if (accountMode === "demo" && ctx.account.isDemo === false) {
          return { ok: false, reason: "Demo-only mode: connected account is LIVE (switch Account to Live/Any to trade it)" };
        }
        if (accountMode === "live" && ctx.account.isDemo === true) {
          return { ok: false, reason: "Live-only mode: connected account is DEMO" };
        }
      }
      // v2.6.9: minimum-balance stop (0 disables). Only enforced when the
      // balance is actually known.
      const minBalance = numberValue(s.minBalance);
      if (minBalance != null && minBalance > 0 && ctx.account.balance != null &&
          ctx.account.balance < minBalance) {
        return { ok: false, reason: `Balance below minimum (${ctx.account.balance.toFixed(2)} < ${minBalance})` };
      }
      const confidence = numberValue(signal.confidence);
      if (confidence == null || confidence < 0 || confidence > 100) {
        return { ok: false, reason: "Invalid signal confidence" };
      }
      if (confidence < (s.minConfidence || 0)) {
        return { ok: false, reason: `Low confidence (${confidence})` };
      }
      if (s.autoHighAccuracy && root.CYBER_ASSET_SELECTOR && signal.asset) {
        try {
          const evalRes = root.CYBER_ASSET_SELECTOR.evaluateAsset(
            { id: signal.asset },
            { stats: await safeStorage().getStats() }
          );
          if (evalRes && evalRes.expectedValue < 0) {
            return { ok: false, reason: `Filtered by High-Accuracy Asset Gate (${signal.asset} EV: ${evalRes.expectedValuePct}%)` };
          }
        } catch (_) {}
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
      const rawMinGap = numberValue(s.minIntervalMs);
      const minGap = rawMinGap != null ? Math.max(1000, Math.min(3600000, rawMinGap)) : 5000;
      if (ctx.lastAttemptAt && Date.now() - ctx.lastAttemptAt < minGap) {
        return { ok: false, reason: `Minimum interval (${(minGap / 1000).toFixed(0)}s)` };
      }
      // Asset freeze
      const asset = safeMapKey(signal.asset, 96);
      if (asset && ctx.frozenAssets[asset]) {
        if (ctx.frozenAssets[asset] > now) {
          return { ok: false, reason: `Asset frozen until ${new Date(ctx.frozenAssets[asset]).toLocaleTimeString()}` };
        }
        delete ctx.frozenAssets[asset];
        persistSafety();
      }
      // v2.6.9: percent-of-balance staking. Replaces the fixed stake with a
      // live balance slice when stakeMode is "percent" and the balance is
      // known; clamped to [1, balance] so rounding can never exceed funds.
      if (s.stakeMode === "percent") {
        const pct = Math.max(0.1, Math.min(10, numberValue(s.stakePercent) || 1));
        if (ctx.account.balance == null || !(ctx.account.balance > 0)) {
          return { ok: false, reason: "Percent staking needs a detected balance (no balance event yet)" };
        }
        const computed = Math.max(1, Math.min(ctx.account.balance, ctx.account.balance * pct / 100));
        s = Object.assign({}, s, { stake: Math.round(computed * 100) / 100 });
      }
      return { ok: true, settings: s };
    }

    async function handleSignal(signal) {
      if (!ctx.running) return;
      if (!signal || !signal.ready) return;
      safeCallback("onSignal", signal);
      if (signal.direction !== "CALL" && signal.direction !== "PUT") return;
      const assetLabel = safeMapKey(signal.asset, 96) || "UNKNOWN";
      if (ctx.mode === "off" || !ctx.armed) return;
      // Never mutate/persist zero-initialized counters before the prior safety
      // ledger has loaded. Re-check controls after the await because the user
      // may disarm or another signal may enter flight in the meantime.
      await hydratePromise;
      if (!ctx.running || ctx.mode === "off" || !ctx.armed || ctx.inFlight) return;

      // One controller-wide placement may be pending at a time. This closes
      // the async race where several assets/bars entered canTrade() before the
      // first click had updated lastAttemptAt.

      // One attempt per asset + closed bar, retained in a bounded set rather
      // than comparing only with the immediately previous direction. If a
      // noisy producer flips CALL→PUT on one bar, it still cannot place twice.
      const rawBarKey = signal.time || (signal.metrics && (signal.metrics.time || signal.metrics.closeTime)) || 0;
      const barKey = toMs(rawBarKey, 0);
      if (!barKey) {
        const reason = "Signal has no valid closed-bar timestamp";
        pushLog("skip", `Skip ${signal.direction} ${assetLabel}: ${reason}`);
        safeCallback("onTrade", {
          id: makeId(), at: Date.now(), dir: signal.direction, asset: signal.asset,
          confidence: signal.confidence, ok: false, blockedReason: reason, action: null,
        });
        return;
      }
      const signalAge = Date.now() - barKey;
      if (signalAge < -60000 || signalAge > 10 * 60000) {
        const reason = "Signal is stale or future-dated";
        pushLog("skip", `Skip ${signal.direction} ${assetLabel}: ${reason}`);
        safeCallback("onTrade", {
          id: makeId(), at: Date.now(), dir: signal.direction, asset: signal.asset,
          confidence: signal.confidence, ok: false, blockedReason: reason, action: null,
        });
        return;
      }
      const assetKey = assetLabel;
      const sigKey = assetKey + ":" + barKey;
      if (ctx.processedSignals[sigKey]) return;
      ctx.processedSignals[sigKey] = true;
      ctx.processedOrder.push(sigKey);
      ctx.lastSignalKey = sigKey;
      while (ctx.processedOrder.length > 500) {
        delete ctx.processedSignals[ctx.processedOrder.shift()];
      }
      // Persist before the async eligibility/placement path so a tab reload
      // cannot replay the same closed bar after a failed or delayed attempt.
      // Acquire the controller-wide lock before awaiting storage; otherwise a
      // different asset/bar can race through while this commit is pending.
      ctx.inFlight = true;
      emitState();
      let log = null;
      try {
        const persisted = await persistSafety();
        if (!persisted) {
          const reason = "Safety ledger could not be persisted";
          log = {
            id: makeId(), at: Date.now(), dir: signal.direction, asset: signal.asset,
            confidence: signal.confidence, ok: false, blockedReason: reason, action: null,
          };
          pushLog("error", `Skip ${signal.direction} ${assetLabel}: ${reason}`);
          safeCallback("onTrade", log);
          return;
        }
        const decision = await canTrade(signal);
        log = {
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
          pushLog("skip", `Skip ${signal.direction} ${assetLabel}: ${decision.reason}`);
          safeCallback("onTrade", log);
          return;
        }

        // Mode-specific action. In the extension, content.js supplies an
      // executeTrade callback that uses the page socket first and waits for a
      // broker order-open confirmation. Unconfirmed standalone clicks are
      // deliberately not an automation path.
      if (ctx.mode === "click" && decision.settings) {
        const rawExpiry = numberValue(decision.settings.expiry);
        const expiryMin = rawExpiry != null && rawExpiry > 0 ? Math.max(0.5, Math.min(1440, rawExpiry)) : 1;
        const hasConfirmedExecutor = !!(opts && typeof opts.executeTrade === "function");
        let result = null;
        ctx.lastAttemptAt = Date.now();
        // Persist the attempt timestamp before touching the broker. If this
        // write fails, a reload could otherwise bypass the minimum interval
        // with a different bar even though this order was sent.
        const attemptPersisted = await persistSafety();
        if (!attemptPersisted) {
          result = { ok: false, confirmed: false, error: "attempt safety state could not be persisted" };
        } else if (!hasConfirmedExecutor) {
          result = { ok: false, confirmed: false, error: "confirmed placement executor is required" };
        } else try {
          result = await opts.executeTrade({
            dir: signal.direction,
            asset: signal.asset,
            stake: decision.settings.stake,
            expiry: expiryMin,
            entryPrice: signal.entryPrice != null ? signal.entryPrice : (signal.metrics && signal.metrics.close),
            entryTime: signal.entryTime || signal.time || Date.now(),
          });
        } catch (e) {
          result = { ok: false, confirmed: false, error: String(e && e.message || e) };
        }
        log.action = result;
        log.expiryMinutes = expiryMin;
        const rawEntryPrice = signal.entryPrice != null ? signal.entryPrice : (signal.metrics && signal.metrics.close);
        const entryPrice = numberValue(rawEntryPrice);
        log.entryPrice = entryPrice != null && entryPrice > 0 && entryPrice <= 1e15 ? entryPrice : null;
        log.entryTime = toMs(signal.entryTime || signal.time, log.at);
        log.expiryTime = toMs(result && result.expiryTime, log.entryTime + expiryMin * 60000);
        // Extension executors must explicitly report a correlated broker
        // confirmation. `{ok:true}` only means a frame/click was attempted.
        const accepted = !!(result && result.ok && result.confirmed === true);
        log.ok = accepted;
        log.blockedReason = accepted ? null
          : ((result && result.error) || "broker did not acknowledge the order");
        if (accepted) {
          ctx.tradesToday = Math.min(100000, ctx.tradesToday + 1);
          ctx.tradesHour = Math.min(100000, ctx.tradesHour + 1);
          const openTime = toMs(result.openTime, log.entryTime);
          const rawResultExpiry = toMs(result.expiryTime, log.expiryTime);
          const resultExpiry = Math.max(openTime, Math.min(openTime + 86460000, rawResultExpiry));
          const resultPrice = numberValue(result.openPrice);
          ctx.lastTrade = {
            at: openTime,
            entryTime: openTime,
            expiryTime: resultExpiry,
            entryPrice: resultPrice != null && resultPrice > 0 && resultPrice <= 1e15 ? resultPrice : log.entryPrice,
            asset: safeMapKey(signal.asset, 96) || "UNKNOWN",
            dir: signal.direction,
            id: safeMapKey(result.id, 128) || null,
            confirmed: true,
          };
          // The broker confirmation is authoritative even if local persistence
          // fails, but await and retry the post-confirm ledger so caps and the
          // last-trade cooldown survive a service-worker/tab restart.
          let confirmedPersisted = await persistSafety();
          if (!confirmedPersisted) confirmedPersisted = await persistSafety();
          log.safetyPersisted = confirmedPersisted;
          pushLog(confirmedPersisted ? "trade" : "error",
            `Trade confirmed: ${signal.direction} ${assetLabel} · expiry ${expiryMin}m · conf=${signal.confidence}` +
            (confirmedPersisted ? "" : " · local safety ledger unavailable"));
        } else {
          pushLog("error", `Trade not confirmed: ${(result && result.error) || "broker did not acknowledge the order"}`);
        }
      } else if (ctx.mode === "alerts") {
        const rawExpiry = numberValue(decision.settings && decision.settings.expiry);
        const expiryMin = rawExpiry != null && rawExpiry > 0 ? Math.max(0.5, Math.min(1440, rawExpiry)) : 1;
        log.action = { kind: "alert", ok: true };
        log.entryTime = toMs(signal.entryTime || signal.time, Date.now());
        const rawEntryPrice = signal.entryPrice != null ? signal.entryPrice : (signal.metrics && signal.metrics.close);
        const entryPrice = numberValue(rawEntryPrice);
        log.entryPrice = entryPrice != null && entryPrice > 0 && entryPrice <= 1e15 ? entryPrice : null;
        log.expiryMinutes = expiryMin;
        log.expiryTime = log.entryTime + expiryMin * 60000;
        ctx.lastAttemptAt = Date.now();
        const alertAttemptPersisted = await persistSafety();
        if (!alertAttemptPersisted) {
          log.ok = false;
          log.action = { kind: "alert", ok: false };
          log.blockedReason = "attempt safety state could not be persisted";
          pushLog("error", "Alert suppressed: attempt safety state could not be persisted");
        } else {
          if (decision.settings && decision.settings.notifySound) playBeep(signal.direction);
          if (decision.settings && decision.settings.notifyDesktop) {
            if (opts && typeof opts.notifyDesktop === "function") safeCallback("notifyDesktop", signal);
            else notifyDesktop(signal);
          }
          ctx.tradesToday = Math.min(100000, ctx.tradesToday + 1);
          ctx.tradesHour = Math.min(100000, ctx.tradesHour + 1);
          ctx.lastTrade = {
            at: log.entryTime, entryTime: log.entryTime, expiryTime: log.expiryTime,
            entryPrice: log.entryPrice, asset: assetLabel, dir: signal.direction,
          };
          let alertPersisted = await persistSafety();
          if (!alertPersisted) alertPersisted = await persistSafety();
          log.safetyPersisted = alertPersisted;
          pushLog(alertPersisted ? "alert" : "error",
            `ALERT ${signal.direction} ${assetLabel} · expiry ${expiryMin}m · conf=${signal.confidence}` +
            (alertPersisted ? "" : " · local safety ledger unavailable"));
        }
      }

        safeCallback("onTrade", log);
      } catch (e) {
        const error = String(e && e.message || e || "automation failure");
        pushLog("error", `Automation failure: ${error}`);
        if (log) {
          log.ok = false;
          log.blockedReason = error;
        }
        safeCallback("onTrade", log || {
          id: makeId(), at: Date.now(), dir: signal.direction, asset: signal.asset,
          confidence: signal.confidence, ok: false, blockedReason: error, action: null,
        });
      } finally {
        ctx.inFlight = false;
        emitState();
      }
    }

    function setMode(mode) {
      ctx.mode = mode === "alerts" || mode === "click" ? mode : "off";
      if (ctx.mode === "off") ctx.armed = false;
      pushLog("info", `Mode set to ${ctx.mode}`);
      emitState();
    }
    function setArmed(b) {
      ctx.armed = !!b && ctx.mode !== "off";
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
      const n = numberValue(delta);
      if (n == null || Math.abs(n) > 1000000000) return Promise.resolve(false);
      // A close event can arrive immediately after startup. Apply it only
      // after restoring the previous ledger, otherwise zero+delta could
      // overwrite an already accumulated daily P&L value.
      return hydratePromise.then(async () => {
        ctx.dailyPnl = Math.max(-1000000000, Math.min(1000000000, ctx.dailyPnl + n));
        const persisted = await persistSafety();
        emitState();
        return persisted;
      }).catch(() => false);
    }
    function settleOrder(orderId, delta, assetId) {
      const id = safeMapKey(orderId, 256);
      const n = numberValue(delta);
      if (!id || n == null || Math.abs(n) > 1000000000) return Promise.resolve(false);
      return hydratePromise.then(async () => {
        if (ctx.settledOrders[id]) return false;
        ctx.settledOrders[id] = true;
        ctx.settledOrderQueue.push(id);
        while (ctx.settledOrderQueue.length > 500) delete ctx.settledOrders[ctx.settledOrderQueue.shift()];
        ctx.dailyPnl = Math.max(-1000000000, Math.min(1000000000, ctx.dailyPnl + n));
        if (n < 0) {
          const asset = safeMapKey(assetId, 96);
          if (asset) ctx.frozenAssets[asset] = Date.now() + 15 * 60000;
        }
        const persisted = await persistSafety();
        emitState();
        return persisted;
      }).catch(() => false);
    }

    function freezeAsset(assetId, minutes) {
      const id = safeMapKey(assetId, 96);
      if (!id) return false;
      const requested = numberValue(minutes);
      const duration = requested != null && requested >= 0
        ? Math.min(10080, requested) : 15;
      if (duration === 0) return unfreezeAsset(id);
      ctx.frozenAssets[id] = Date.now() + duration * 60000;
      const persisted = persistSafety();
      pushLog("info", `Asset ${id} frozen for ${duration}m`);
      emitState();
      return persisted;
    }
    function unfreezeAsset(assetId) {
      const id = safeMapKey(assetId, 96);
      if (!id) return false;
      delete ctx.frozenAssets[id];
      const persisted = persistSafety();
      pushLog("info", `Asset ${id} unfrozen`);
      emitState();
      return persisted;
    }
    function getLog() { return ctx.log.map((entry) => Object.assign({}, entry)); }
    function getState() { return snapshot(); }

    emitState();
    hydratePromise.then(emitState).catch(() => {});
    return {
      handleSignal,
      setAccountInfo,
      setMode,
      setArmed,
      stop,
      updateDailyPnl,
      settleOrder,
      freezeAsset,
      unfreezeAsset,
      getLog,
      getState,
    };
  }

  /* --- DOM helpers for click trade --- */
  function findTradeButton(dir) {
    const q = root.CYBER_QUOTEX;
    if (!q || (dir !== "CALL" && dir !== "PUT")) return null;
    return dir === "CALL" ? q.findCallButton() : q.findPutButton();
  }

  async function setStake(amount) {
    const q = root.CYBER_QUOTEX;
    if (!q || typeof q.setStake !== "function") return false;
    return q.setStake(amount) === true;
  }

  async function clickTrade(args) {
    args = args || {};
    let direction;
    try { direction = String(args.dir || "").toUpperCase(); } catch (_) { direction = ""; }
    if (direction !== "CALL" && direction !== "PUT") return { ok: false, error: "invalid direction" };
    const stake = args.stake == null ? null : numberValue(args.stake);
    if (args.stake != null && (stake == null || stake <= 0)) {
      return { ok: false, error: "stake must be positive" };
    }
    const expiry = args.expiry == null ? null : numberValue(args.expiry);
    if (args.expiry != null && (expiry == null || expiry < 0.5)) {
      return { ok: false, error: "expiry must be at least 0.5 minutes" };
    }
    if (args.mode === "ws") {
      return { ok: false, error: "WebSocket placement requires a caller-owned authenticated socket" };
    }
    const q = root.CYBER_QUOTEX;
    if (!q || typeof q.placeTrade !== "function") {
      return { ok: false, error: "validated Quotex adapter is required" };
    }
    try {
      const r = q.placeTrade({
        dir: direction,
        amount: stake == null ? args.stake : stake,
        expirySec: expiry != null ? Math.max(30, Math.round(expiry * 60)) : undefined,
      });
      // Never bypass the adapter's expiry/button validation with a second,
      // broader click attempt. A validation failure is a safe failure.
      return r || { ok: false, error: "validated Quotex placement failed" };
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
      // `assetLabel` is local to handleSignal(); derive the display label from
      // the signal here. Referencing the out-of-scope name threw a silent
      // ReferenceError before `new Notification`, so granted-permission desktop
      // alerts never fired.
      const asset = String(signal && signal.asset != null ? signal.asset : "")
        .replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 64);
      if (Notification.permission === "granted") {
        new Notification(`CYBER BINARY ${signal.direction}`, {
          body: `${asset} conf=${signal.confidence}% ${signal.reason || ""}`,
        });
      } else if (Notification.permission !== "denied") {
        Notification.requestPermission();
      }
    } catch (_) { /* ignore */ }
  }

  root.CYBER_AUTO = { startAuto, clickTrade, setStake, playBeep, notifyDesktop, findTradeButton };
})(typeof self !== "undefined" ? self : globalThis);
