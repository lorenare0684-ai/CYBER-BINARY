/**
 * CYBER BINARY v3.0 — money management: Martingale.
 *
 * Pure functions, no side effects, fully unit-testable in Node.
 *
 * Model
 * -----
 *   step 0   → stake = base
 *   step n   → stake = base × multiplierⁿ          (n = consecutive losses)
 *   win      → series resets to step 0
 *   loss     → step + 1 until maxSteps is exhausted, then the series
 *              resets to base (classic "stop the progression" behaviour —
 *              it never keeps doubling past the configured depth).
 *
 * Safety nets (all enforced here, not by callers):
 *   - broker minimum stake ($1) and a hard $100k ceiling;
 *   - balance check: a planned stake above the available balance is refused;
 *   - optional series-risk cap: cumulative loss of the current series +
 *     planned stake may not exceed `seriesCapPct` % of the balance;
 *   - maxSteps hard-clamped to 10 (multiplier 2 ⇒ 1024× base is the most
 *     any configuration can ever demand, and only if the balance allows).
 *
 * The manager never places trades; it only answers "what stake next?" and
 * "how does the series progress after this result?".
 */
(function (root) {
  "use strict";

  const MIN_STAKE = 1;        // Quotex minimum stake
  const MAX_STAKE = 100000;   // hard ceiling regardless of configuration
  const MAX_DEPTH = 10;       // maximum configurable progression depth

  function numberValue(value) {
    if (value == null || typeof value === "boolean" ||
        (typeof value === "string" && !value.trim())) return null;
    try {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    } catch (_) { return null; }
  }

  function normalizeConfig(cfg) {
    const c = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
    let multiplier = numberValue(c.multiplier);
    multiplier = multiplier != null ? Math.min(10, Math.max(1.1, multiplier)) : 2;
    let maxSteps = Math.floor(numberValue(c.maxSteps) != null ? numberValue(c.maxSteps) : 4);
    maxSteps = Math.max(1, Math.min(MAX_DEPTH, maxSteps));
    let seriesCapPct = numberValue(c.seriesCapPct);
    seriesCapPct = seriesCapPct != null && seriesCapPct > 0 ? Math.min(100, seriesCapPct) : 0;
    return {
      enabled: !!c.enabled,
      multiplier,
      maxSteps,
      seriesCapPct,
    };
  }

  function defaultState() {
    return { step: 0, seriesPnl: 0 };
  }

  function normalizeState(state) {
    const s = state && typeof state === "object" && !Array.isArray(state) ? state : {};
    let step = Math.floor(numberValue(s.step) != null ? numberValue(s.step) : 0);
    step = Math.max(0, Math.min(MAX_DEPTH, step));
    let seriesPnl = numberValue(s.seriesPnl);
    seriesPnl = seriesPnl != null ? Math.max(-1e9, Math.min(1e9, seriesPnl)) : 0;
    return { step, seriesPnl };
  }

  function stakeForStep(base, multiplier, step) {
    const raw = base * Math.pow(multiplier, Math.max(0, step));
    return Math.round(raw * 100) / 100;
  }

  /**
   * Plan the next stake.
   * Returns { ok, stake, step, reason }:
   *   ok=false → the progression cannot be funded right now; the caller
   *   must skip the trade (never silently downgrade the stake — a
   *   half-funded martingale step is how accounts die).
   */
  function planNext(config, state, baseStake, balance) {
    const cfg = normalizeConfig(config);
    const st = normalizeState(state);
    const base = numberValue(baseStake);
    if (base == null || base <= 0) {
      return { ok: false, stake: null, step: st.step, reason: "base stake is not positive" };
    }
    if (!cfg.enabled) {
      const flat = Math.max(MIN_STAKE, Math.round(base * 100) / 100);
      return { ok: flat <= MAX_STAKE, stake: flat, step: 0, reason: flat <= MAX_STAKE ? "" : "stake above the hard ceiling" };
    }
    const bal = numberValue(balance);
    const stake = stakeForStep(Math.max(MIN_STAKE, base), cfg.multiplier, st.step);
    if (stake > MAX_STAKE) {
      return { ok: false, stake: null, step: st.step, reason: "martingale stake above the hard ceiling ($" + MAX_STAKE.toLocaleString("en-US") + ")" };
    }
    if (bal != null && bal > 0 && stake > bal) {
      return { ok: false, stake: null, step: st.step, reason: "martingale stake $" + stake.toFixed(2) + " exceeds balance $" + bal.toFixed(2) };
    }
    if (cfg.seriesCapPct > 0 && bal != null && bal > 0) {
      const seriesLoss = st.seriesPnl < 0 ? -st.seriesPnl : 0;
      const allowed = bal * cfg.seriesCapPct / 100;
      if (seriesLoss + stake > allowed) {
        return { ok: false, stake: null, step: st.step, reason: "series risk cap reached (" + cfg.seriesCapPct + "% of balance)" };
      }
    }
    return { ok: true, stake, step: st.step, reason: "" };
  }

  /**
   * Advance the series after a settled trade.
   *   won  → reset to step 0, series closed.
   *   loss → step+1; once the progression depth is exhausted the series
   *          resets to base (returns maxStepsReached=true so the caller
   *          can log/pause — doubling past the configured depth is never
   *          an option).
   */
  function settle(config, state, won, pnl) {
    const cfg = normalizeConfig(config);
    const st = normalizeState(state);
    if (!cfg.enabled) return Object.assign(defaultState(), { maxStepsReached: false });
    const delta = numberValue(pnl) != null ? numberValue(pnl) : 0;
    if (won) return Object.assign(defaultState(), { maxStepsReached: false });
    const nextStep = st.step + 1;
    if (nextStep > cfg.maxSteps) {
      return Object.assign(defaultState(), { maxStepsReached: true });
    }
    return { step: nextStep, seriesPnl: st.seriesPnl + delta, maxStepsReached: false };
  }

  /**
   * Full progression table (for the dashboard): stake and cumulative risk
   * at every step, so the user sees exactly what a losing streak costs
   * BEFORE enabling the system.
   */
  function projection(config, baseStake) {
    const cfg = normalizeConfig(config);
    const base = numberValue(baseStake);
    const rows = [];
    if (!cfg.enabled || base == null || base <= 0) return rows;
    let cumulative = 0;
    for (let step = 0; step <= cfg.maxSteps; step++) {
      const stake = stakeForStep(Math.max(MIN_STAKE, base), cfg.multiplier, step);
      cumulative = Math.round((cumulative + stake) * 100) / 100;
      rows.push({ step, stake, cumulativeRisk: cumulative });
    }
    return rows;
  }

  root.CYBER_MONEY = {
    MIN_STAKE,
    MAX_STAKE,
    MAX_DEPTH,
    normalizeConfig,
    defaultState,
    normalizeState,
    stakeForStep,
    planNext,
    settle,
    projection,
  };
})(typeof self !== "undefined" ? self : globalThis);
