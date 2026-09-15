# CYBER BINARY — Quotex Trading Automation

A Chrome extension (Manifest V3) that attaches to a Quotex / QX Broker trading
page, captures the platform's real market data (WebSocket **and** HTTP), runs a
multi-indicator signal engine on 1-minute candles, and can place explicitly
armed CALL/PUT orders through the page's own authenticated socket.

> **Risk warning.** This is a third-party automation tool for a binary-options
> broker. It can place real trades with real money. Binary options are
> extremely high risk: a losing trade loses the whole stake, and a losing
> streak can deplete an account quickly. Nothing in this project is financial
> advice, and no win rate — historical, backtested, or claimed — guarantees
> future results. Use a demo account before anything else.

---

## v3.0 — what changed

| Area | Change |
|------|--------|
| **Preloaded candles** | The extension now receives the chart's initial history. The platform fetches that block over HTTP at page load, then streams ticks over the socket — the old WebSocket-only hook never saw it, so history only arrived when you panned the chart left. The page hook now captures `fetch`/XHR history responses *and* sends ack-correlated history requests on the page socket, so candles are present from page load. |
| **Martingale** | New money-management system (off by default): double-down progression after losses, reset on win, hard depth cap, balance guards, and a full cost projection table in the dashboard. |
| **Monte Carlo** | Removed entirely (engine, charts, dashboard, tooling). |
| **Backtesting** | Rebuilt to run **only on real cached Quotex candles**. The previous build silently padded missing history with synthetic simulator bars and reported those numbers as market evidence — that is gone. Assets without enough real data are reported as "no data", never simulated. Martingale/flat staking is applied trade-by-trade, so equity, drawdown and P&L reflect the actual money plan. |
| **Trade execution** | Hardened path: broker-confirmed WebSocket orders (ack-correlated) first, strictly validated DOM fallback second, single-flight locking, broker-clock expiry math, $1 broker minimum enforced, stake-vs-balance checks, and automation disarms itself on deterministic page-integration failures. |
| **Dashboard** | Honest content: live data-feed status card (source, real bar count, history state, last tick), Martingale controls with cost projection, real-data labels in backtests, hype wording removed. |

---

## How it works

```
Quotex page (MAIN world)                     Extension (isolated world)
─────────────────────────                    ──────────────────────────
page-hook.js                                 content.js
 ├─ WebSocket wrapper ── decodes ─┐           ├─ feed (1m candle store)
 ├─ fetch / XHR capture ──────────┤           ├─ engine (signals)
 └─ chart-library hooks ──────────┤           ├─ auto controller + money mgmt
              │                   │           ├─ trader (order placement)
              ▼                   │           └─ dashboard bridge
      postMessage frames ─────────┴──────────────►  dashboard.html
```

1. **page-hook.js** (generated from `src/lib/quotex.js` +
   `tools/page-hook.shell.js` — rebuild with `node tools/build-hook.js`)
   installs synchronously at `document_start` in the page's MAIN world. It
   wraps `WebSocket`, `fetch` and `XMLHttpRequest`, decodes the broker's
   Socket.IO frames, attributes every candle batch to an asset (payload,
   ack-correlation, recent-request, or URL), and rebroadcasts typed events to
   the content script.
2. **content.js** maintains a de-duplicated 1m candle feed per asset, feeds
   the signal engine, renders markers on the platform chart, and owns the
   automation controller.
3. **Trade execution** sends an `orders/open` frame on the page's own
   authenticated socket with a Socket.IO callback id, waits for the broker's
   ack or a strictly matching account order-open push, and only falls back to
   validated DOM clicks when the frame could not be sent. Unconfirmed
   sends are never retried by clicking (that would risk duplicate orders).
4. **dashboard.html** is a local extension page (toolbar icon → dashboard).
   It shows live signals, feed status, account info, automation controls,
   Martingale settings, trade history and the backtester.

### Data integrity rules

- The engine only ever seeds from **symbol-verified** candle batches or from
  batches whose price scale matches the asset (wrong-asset protection).
- The backtester never fabricates candles. Synthetic warm-up bars used only
  for live indicator warm-up are never presented as broker history, never
  cached as history, and never enter backtest results.
- Broker timestamps drive bar closes; the local clock is never trusted for
  expiry math.

---

## Installation (developer mode)

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this repository folder.
3. Open a Quotex/QX Broker trading page; the extension attaches automatically.
4. Click the extension icon to open the dashboard.

## Build & validate

```bash
node tools/build-hook.js   # regenerate src/page-hook.js after editing
                           # src/lib/quotex.js or tools/page-hook.shell.js
node tools/validate.js     # structure + engine + martingale + protocol checks
```

`src/page-hook.js` is a **generated file** — never edit it by hand.

## Martingale, honestly

The Martingale system multiplies the stake after each loss and resets on a
win. It does **not** create edge; it converts many small wins into the risk
of one large loss. Controls:

- **multiplier** (1.1–10) and **max steps** (1–10) define the progression;
- the dashboard shows the exact stake and cumulative risk of every step
  before you enable it;
- a planned step the balance cannot fund **refuses the trade** (never
  silently shrinks);
- after `max steps` losses the series resets to base;
- optional **series cap** stops a series once it has cost a configured
  percentage of the balance.

## Repository layout

```
manifest.json            MV3 manifest
src/page-hook.js         GENERATED MAIN-world hook (do not edit)
src/content.js           content-script orchestrator
src/dashboard.*          dashboard page (html/js/css)
src/background.js        service worker (tab ownership, message routing)
src/lib/
  quotex.js              broker protocol decoder / adapter
  engine.js              signal engine + backtester
  money.js               Martingale money management
  auto.js                automation controller
  backtest.js            historic matrix (real data only)
  feed.js indicators.js strategy.js assets.js
  storage.js workers.js markers.js asset-selector.js
tools/build-hook.js      page-hook generator
tools/validate.js        test harness
```

## Safety defaults

- Auto-trading is **off** until a mode is chosen and explicitly armed.
- Default account mode is **demo-only**.
- Daily loss cap, per-hour/per-day trade caps, cooldown bars, minimum
  confidence gate, and broker-confirmation requirement are enforced by the
  controller, not by the strategy.

## Disclaimer

This software is provided as-is, without warranty of any kind. Trading binary
options may not be legal in your jurisdiction — you are responsible for
complying with your local laws and with the broker's terms of service. The
authors accept no liability for losses incurred through the use of this
software.
