# CYBER BINARY v2.4.0 — 500-instance bug audit

Status: **500 / 500 concrete bug instances fixed and regression-checked**.

The count is deliberately capped at 500. A repeated defect is counted separately only when it was a distinct reachable call site or state transition (for example, unsafe numeric conversion in order amount and unsafe conversion in order expiry are separate input paths). Cosmetic changes and tests alone are not counted.

## Count ledger

| Audit area / milestone | Instances | Cumulative |
|---|---:|---:|
| Initial repository-wide UI, protocol, chart, automation, and lifecycle pass | 199 | 199 |
| Storage schema, serialization, retention, statistics, and lifecycle sanitation | 75 | 274 |
| Automation settlement, persistence, deduplication, and placement safety | 14 | 288 |
| Feed freshness, stale-tick handling, ordering, and capacity behavior | 8 | 296 |
| Content broker routing, lifecycle, leadership, and UI behavior | 43 | 339 |
| Dashboard rendering, stale-live fallback, setting reconciliation, and payload normalization | 17 | 356 |
| Asset-catalog isolation and runtime registration sanitation | 10 | 366 |
| Historical worker canonicalization, bounds, map safety, and malformed options | 12 | 378 |
| Background leadership restoration, activation races, persistence, and state bounds | 12 | 390 |
| Additional automation malformed-input and durable post-confirmation handling | 15 | 405 |
| Primary-only close settlement and takeover replay | 5 | 410 |
| Quotex decoding, numeric parsing, order outcomes, candles, and placement validation | 28 | 438 |
| Feed malformed numeric/profile/time inputs and synthetic-series bounds | 17 | 455 |
| Engine malformed candles/options, numeric lifecycle values, ordering, and walk-forward sizing | 18 | 473 |
| Indicator malformed inputs, initial-value validation, and finite-arithmetic guards | 27 | **500** |

## Acceptance-critical outcomes

- One selected, top-frame Quotex **trade/chart** tab owns state and automation.
- Activation and service-worker restoration races cannot retarget an in-flight dashboard command.
- A signal can produce at most one persisted attempt, with one placement in flight.
- Automation is off/disarmed by default and requires explicit arming.
- Trades count only after a correlated broker open confirmation.
- An uncertain WebSocket send is never retried by clicking.
- DOM fallback has no generic positional/open-chart click path and still requires broker confirmation.
- CALL and PUT generation/execution are both covered.
- Entry, expiry, and exit times/prices are retained through storage, UI, and CSV history.
- Real broker candle batches are normalized, sorted, deduplicated, and kept per asset/timeframe.
- Missing close outcomes remain unknown; they no longer fabricate losses or freeze assets.
- Account-level close events mutate the shared risk ledger only in the primary tab.
- State/catalog/strategy/marker getters do not expose mutable internal safety state.
- Hot historical work prefers a dedicated worker and uses bounded/canonical jobs.

## Regression evidence

The final audit run passed:

```text
node --check (all src/**/*.js and tools/*.js)
git diff --check
node tools/validate.js
node tools/bugs.js
node tools/auto-trade.js
node tools/background.js
node tools/markers.js
node tools/detection-e2e.js
node tools/backtest.js
node tools/historic.js --days 1 --kinds fx --strategies confluence --minBars 120
```

Deterministic benchmark result remains **14,233 resolved trades at 56.73% aggregate win rate**. The one-day FX worker matrix also completed successfully across 76 asset variants.

## Post-audit findings (v2.4.1)

The 500-instance cap is closed. The pass below continued hunting for genuinely
critical defects in the current source and fixed two that the closed audit did
not cover, each with a new regression check.

1. **auto.js `notifyDesktop` out-of-scope `assetLabel` (alerts-mode desktop
   notifications).** `notifyDesktop(signal)` built its `Notification` body with
   `` `${assetLabel}` ``, but `assetLabel` is a local declared only inside
   `handleSignal()` — not in scope. The `ReferenceError` fired while evaluating
   the body argument, before `new Notification(...)` ran, and the surrounding
   `try/catch` swallowed it, so granted-permission desktop alerts never
   appeared. Fix: derive the label from `signal.asset` with the same
   control-char strip + length cap used elsewhere. Regression: a new
   `notifyDesktopTest` scenario in `tools/bugs.js` (Notification stub asserts a
   notification is constructed when permitted, requests permission when
   undecided, is a no-op when denied, tolerates malformed signals, and
   sanitizes the label). The scenario was verified to FAIL on the pre-fix code
   (`created=0`) and PASS after the fix.

2. **dashboard.js backtest history-wait early error (prior commit de362b6).**
   `runBacktest()` could surface "could not collect enough history" before the
   fresh-history request had a chance to return enough bars. Fix: only short
   circuit on a genuine deadline; otherwise nudge a fresh fetch and continue
   polling up to the full window.

Full post-audit regression run (all green):

```text
node --check (all src/**/*.js and tools/*.js)
git diff --check
node tools/validate.js
node tools/bugs.js
node tools/auto-trade.js
node tools/background.js
node tools/markers.js
node tools/detection-e2e.js
node tools/backtest.js
```
