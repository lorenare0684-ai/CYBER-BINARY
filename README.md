# CYBER BINARY — Quotex Signal Lab v2.3

Chrome extension (Manifest V3) that attaches to a Quotex / QX Broker chart, builds 1-minute candles from the live quote, and scores **CALL / PUT / WAIT** from a multi-indicator, multi-timeframe confluence engine. The Quotex adapter decodes the platform's WebSocket traffic and drives the engine with real candles/ticks/balance.

> Educational market analysis only. Not a broker. Not financial advice. Binary options have a built-in payout edge against the trader — nothing here is a profit guarantee.

## What's new in v2.3.3 — non-repainting signal arrows on the Quotex chart

- **Arrows on the platform chart** — every qualifying signal now draws an arrow on the Quotex chart itself: green **CALL** arrow below the bar, red **PUT** arrow above it, glued to the exact bar that triggered the signal.
- **Non-repainting by construction** — arrows are anchored to a *closed* bar's (time, close). The anchor is fixed before the next candle exists, deduped per (asset, bar, direction), and never changes afterwards; re-rendering only re-projects fixed anchors, so arrows can never move, flicker or double up as new candles form.
- **Historical arrows too** — on attach, every settled trade in your stored history is replayed as a fixed marker, so past signals are visible on the chart alongside the live ones.
- **Renders through TradingView Lightweight Charts natively** — the page hook (MAIN world, document_start) captures the chart instance three ways: it wraps `LightweightCharts.createChart` before the page bundle assigns the global, reads `<lightweight-chart>` web-component instances, and runs a bounded React-fiber scan of the chart container for bundled builds. Markers are drawn with the library's own `series.setMarkers()` — the arrows scroll and zoom with the chart exactly like platform drawings.
- **Overlay-canvas fallback** — if no chart API is reachable, arrows are drawn on a transparent overlay above the price chart from the same fixed anchors (approximate mapping from the live feed bars; redrawn on resize/scroll).
- **Dashboard chart arrows** — the same fixed anchors are drawn on the dashboard's candle chart (green/red triangles at their bar slots).
- All of it is regression-tested in `tools/markers.js` (store semantics, immutable anchors, dedupe, UTC-second conversion, hook capture paths, native + overlay rendering, idempotent re-renders) and `tools/detection-e2e.js` (markers message + state payload).

## What's new in v2.3.2 — bug-audit fixes

- **Settings no longer silently drop rapid changes** — `storage.js` used to re-read `chrome.storage.local` on every `load()`, so two quick updates inside the 200ms save debounce (e.g. mode then arm, stake then expiry) lost the earlier one. Writes pending in the debounce are now flushed before every read; cross-context changes (dashboard popup ↔ content script) are still picked up. Covered by `tools/bugs.js`.
- **Daily P&L resets after 24h, not 1h** — `recordTrade()` used `36e5` ms (= one hour) as its "daily" reset horizon. Now a real 24h window, matching the UTC `byDay` keys.
- **Huge WebSocket frames no longer crash the decoder** — `String.fromCharCode.apply` on a multi-megabyte binary frame threw *Maximum call stack size exceeded* (history/instruments payloads are routinely >1MB). Both the adapter and the page hook now convert byte payloads in 32KB chunks. Tested at 1KB → 4MB.
- **Confidence calibration actually applies** — the settings toggle existed but the content script never read it; reported confidence now shrinks toward the observed hit rate of its confidence bucket before signals reach the auto controller and stats.
- **Live stats breakdowns populate** — settled trades never updated `byStrategy` / `byAsset` / `byRegime` (or the history `pnl` column) in the content script, so the dashboard's live win-rate and splits stayed empty. Fixed + unit-covered.
- **Stale ticks can't corrupt the candle feed** — a delayed/replayed tick older than the in-progress bar used to become the "current" bar, producing unsorted series and garbage indicators. Such ticks are now dropped; newer ticks still flow.
- **Background history can't hijack the active asset** — a candle replay for a chart you're not watching no longer force-switches the engine's active asset away from what the page socket/DOM says (manual pins still win).
- **Dashboard ARM button no longer dead-clicks** — it dereferenced `settings` before the async settings load resolved (TypeError); now safe, and the auto-mode selector no longer emits `armed: null`.
- **Engine `lean` flag simplified** — the convoluted `cfg.lean !== false && (opts && opts.lean !== false && (opts.lean !== undefined ? opts.lean : true))` collapsed to `cfg.lean !== false && !(opts && opts.lean === false)`; behavior identical for every caller (live UI keeps all indicators, backtests stay fast), including callers that pass no options at all.

## What's new in v2.3 — every Quotex asset + reliable auto-detection

- **Full Quotex asset catalog** (~170 symbols): every base FX pair (EURUSD, GBPUSD, … GBPNZD, NZDCAD, NZDCHF) **plus its `_otc` twin**, exotic FX OTC pairs (BRL/USD, USD/MXN, ARS/USD, USD/TRY, USD/COP …), all crypto OTC (BTC, ETH, SOL, ADA, XRP, LTC, DOGE, SHIB, TRX, LINK, DOT …), commodities (XAU, XAG, oil, gas, platinum, palladium, copper), all 13 indices, and the full stock list (AAPL, AMZN, TSLA, NVDA, MSFT, GOOGL, META, JPM, KO, WMT …). Broker-internal numeric IDs are baked in where confirmed and **self-heal at runtime**: any asset the platform lists in `instruments/list` is registered on the fly with its real ID, payout and timeframes, and appears in the Assets tab, the asset dropdown and per-asset accuracy reports.
- **Auto-detection that actually works on the live platform:**
  - **Outgoing-frame sniffing** — the extension watches the frames the page itself sends (`instruments/follow`, `instruments/update`, `history/list/v2`, `chart_notification/get`, `orders/open`), so the moment you open or switch a chart, the exact asset (e.g. `EURUSD_otc`) is known — no DOM guessing.
  - **Numeric-id tick resolution** — `quotes/stream` rows that arrive as `[assetId, ts, price]` are resolved through the live instruments list.
  - **DOM text-scan fallback** — the modern Quotex UI ships hashed CSS-module class names, so class selectors miss; the extension now scans small visible text nodes against the catalog ("EUR/USD", "EUR/USD OTC", "Bitcoin (OTC)", "S&P 500" …) and picks the most specific match.
  - **History-payload detection** — incoming `history/list/v2` / `chart_notification/get` responses name their asset, another reliable signal.
  - Detection layers in order: socket symbol → adapter DOM helpers → class selectors → text scan → page title → URL.
- **Trade placement that works on the current UI** — the CALL/PUT button finder now understands the hashed-class DOM: it classifies any visible clickable by its label/aria/class (call/buy/up vs put/sell/down), falls back to green=call / red=put color detection, and only as a last resort to position. The stake input finder scores candidates (hints + trade-panel containment + proximity to the buttons) so it sets the right field, and `placeTrade` still prefers a real `orders/open` WebSocket frame.
- **No more trade spam** — the auto controller now dedups per (asset, closed-bar, direction), so it fires **once per signal**, not once per 500ms tick; `cooldownBars` is enforced unconditionally (the old check read a `metrics.closeTime` field the engine never set, so cooldown silently never fired); and a hard minimum interval (5s, configurable via `settings.minIntervalMs`) prevents double-fires. Auto "alerts" mode no longer floods notifications for the same bar either.

## What's new in v2

- **Automatic asset detection** from the visible chart symbol, URL, page title, and WebSocket frames — works across `qxbroker.com` and `quotex.com` and follows SPA navigation.
- **Multi-strategy presets** — Confluence, Trend, Mean-reversion, Breakout, 1m Scalp, OTC 24/7. Switchable per asset, per session.
- **15+ indicators** — EMA / RSI / MACD / Stochastic / Bollinger / ATR / **ADX / Keltner / Parabolic SAR / Supertrend / VWAP / Hurst / Williams %R / CCI / MFI / OBV / Donchian / momentum**.
- **Multi-timeframe** — resamples 1m → 5m, 15m and votes on agreement.
- **Regime detection** — trending / strong-trend / mean-reverting / choppy / ranging.
- **Calibration** — the engine learns which predicted-confidence buckets actually win and shrinks the reported confidence accordingly.
- **Auto-trade** with two modes:
  - **Alerts** — sound + desktop notification + dashboard pulse on qualifying signals. (Default.)
  - **Click** — actively click the visible CALL/PUT button with your stake and expiry, gated by safety limits.
- **Safety limits** — confidence floor, daily loss cap, hourly / daily trade caps, cooldown bars, per-asset freeze, kill-switch (ARM/DISARM).
- **Historic backtest** — runs the engine across the full asset catalog (170+ assets: every Quotex FX pair + OTC twins, crypto OTC, commodities, indices, stocks OTC) on deterministic synthetic 1m candles that cycle through trending / ranging / choppy regimes. Returns per-asset, per-strategy, per-regime, per-confidence-bucket accuracy.
- **Per-asset historic accuracy** + best-strategy recommendation.
- **Trade history** with filters (dir / outcome / asset), CSV export, and per-asset / per-strategy / per-regime breakdowns.
- **Walk-forward validation** helper to detect overfit.
- **Parallel workers** — Node tool uses `worker_threads`, browser dashboard chunks to keep the UI responsive.

## What's new in v2.1 — full Quotex integration

v2.1 turns the extension into a first-class Quotex citizen. The generic page-hook is still there as a fallback, but the primary path is the new **`src/lib/quotex.js`** adapter.

- **Quotex Socket.IO v3 decoder.** Handles every frame shape the live platform emits:
  - Engine.IO control: `0{...}` (open), `40` (connect), `2`/`3` (ping/pong), `41` (disconnect)
  - Socket.IO events: `42["event", payload]`
  - Headered binary: `451-["event",{_placeholder:true}]` followed by a `\x04<json>` body
  - Headerless binary: `\x04<...>` payloads inferred by shape (instruments list, quotes stream, history candles, balance)
  - 30+ known event names mapped to typed callbacks (`candle`, `tick`, `instruments`, `balance`, `order_opened`, `order_closed`, `authenticated`, `auth_error`, `error`)
- **Page-side WebSocket hijack** (`attachPageSocket`). The adapter wraps `window.WebSocket` so every page-owned socket goes through the decoder. The wrapper is idempotent (`__cyberWrapped` flag) and exposes a `detach()` to put the native constructor back. We never open a second connection — we listen to the page's own traffic.
- **Full Quotex asset catalog baked in** (~170 symbols with their broker-internal numeric IDs where confirmed, including every `_otc` synthetic variant). The adapter exposes a `getInstruments()` helper, a runtime `ASSET_IDS` map, and `rememberIds()` — live `instruments/list` payloads merge in the real IDs, payouts and timeframes for any symbol the platform adds.
- **Real-platform payload parsers** for instruments list, candles, ticks, balance, and orders (opened/closed) — including the `[ts, open, low, high, close, vol?]` candle shape with high/low normalization and ms-epoch inference.
- **Real platform DOM helpers** — `findPanel`, `findAssetHeader`, `findPriceLabel`, `findStakeInput`, `findExpirySelect`, `findCallButton`, `findPutButton`, `findBalance`, `setStake`. These supersede the inline selectors that lived in `content.js` / `auto.js`.
- **`placeTrade`** with two modes:
  - `dom` (default) — find the visible CALL/PUT button, set the stake, click. Works in any state where the page is showing the trade panel.
  - `ws` — send a real `42["orders/open", {...}]` frame on the page's own WebSocket, plus the platform's `tick` and `instruments/follow` warmup messages. Payload shape mirrors the open-source A11ksa/API-Quotex client (`asset`, `amount`, `time`, `action`, `isDemo`, `tournamentId`, `requestId`, `optionType`).
- **Live-candle ingest path.** The page-hook forwards each `candles_received` event to the content script, which routes it to the right per-asset feed via the new `feed.ingestCandle(c)` method.
- **Instruments tab** in the dashboard. Filter by symbol/type, see payout %, available timeframes, open/closed state. Plus a live "Recent live orders" feed.
- **Quotex status pill** in the dashboard header — shows `Quotex · live` when authenticated, `Quotex · auth_error` on rejection, `Quotex · fallback` if the adapter failed to load.
- **Live balance & order-result surface** in the Live tab and a dedicated order list in the Instruments tab.
- **New background message types**: `CYBER_QUOTEX_STATUS`, `CYBER_QUOTEX_INSTRUMENTS`, `CYBER_QUOTEX_BALANCE`, `CYBER_QUOTEX_TRADE_RESULT`, `CYBER_QUOTEX_SET_AUTH`. The first four are forwarded from content.js to the dashboard; the last is a no-op (the extension never reads or stores the SSID — it only uses what the page itself transmits).

The adapter is **pure ES5** and runs in both the extension ISOLATED world (content scripts, dashboard) and the MAIN world (page-hook loaded into the page's window). It has no module-level side effects.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this folder
4. Open Quotex (`qxbroker.com` / `quotex.com`) and a chart
5. The HUD appears on the chart; the dashboard window opens automatically
6. You can also click the extension icon on any tab to focus the dashboard

## Dashboard tabs

- **Live** — current signal, indicators, chart, recent calls, asset + strategy selector, live balance, detected instruments count, last orders.
- **Auto** — mode, stake, expiry, confidence floor, daily loss cap, hourly/daily trade caps, cooldown, sound/desktop alerts, ARM/DISARM, automation log.
- **Instruments** (v2.1) — connection state, detected instruments with payout / timeframes / open-closed, filter by symbol or type, recent live orders.
- **Backtest** — run the full engine across the asset catalog. Equity curve, per-strategy, per-asset, per-regime tables, and confidence calibration.
- **History** — every recorded trade, filter by direction / outcome / asset, CSV export, clear.
- **Assets** — full asset catalog with per-asset live winrate and historic best-strategy winrate (from the backtest).
- **Settings** — calibration on/off, reset.

## How signals work

Closed-bar confluence of (each vote weighted per strategy preset):

- EMA 8/21 trend and fresh cross
- RSI pullback **with** trend (not extreme chase)
- MACD histogram direction
- Stochastic leaving 22 / 78
- Bollinger touch **only** if it agrees with the slow EMA
- ADX+/ADX- aligned with the slow EMA
- Supertrend direction
- Parabolic SAR
- VWAP (if available)
- Williams %R / CCI extremes
- Donchian breakout
- Multi-timeframe (5m, 15m) agreement
- Hurst exponent — only contributes in trending regimes
- ATR% floor so dead markets stay `WAIT`

A signal needs a vote score ≥ the strategy's `minScore` and a 2-point lead for one side. The reported confidence is a softmax of the opposing vote scores, optionally shrunk by observed hit rate.

## Local tools

```bash
node tools/validate.js              # structure + engine + backtest smoke
node tools/backtest.js              # legacy single-asset backtest
node tools/historic.js              # full matrix across 170+ assets × strategies
node tools/historic.js --days 7     # 7 days
node tools/historic.js --kinds fx   # FX only
node tools/historic.js --strategies trend,meanrev,breakout
node tools/historic.js --json       # machine-readable output
node tools/search.js                # bounded parameter grid search
```

## Project layout

```
manifest.json
src/background.js        # dashboard window + state relay
src/page-hook.js         # MAIN-world WebSocket wrap → CYBER_QUOTEX adapter
src/content.js           # quote ingest, candles, multi-asset feeds, auto-trade
src/dashboard.html|.js|.css  # tabbed lab UI
src/lib/indicators.js    # 19 indicators + multi-timeframe resampler
src/lib/assets.js        # full Quotex catalog (170+) + runtime registerQuotexAsset()
src/lib/strategy.js      # 6 strategy presets
src/lib/engine.js        # confluence engine + backtest + walk-forward
src/lib/feed.js          # live + synthetic 1m series generator (ingestCandle)
src/lib/storage.js       # chrome.storage.local settings / history / calibration
src/lib/auto.js          # auto-trade controller (alerts + click + placeTrade)
src/lib/backtest.js      # full asset×strategy matrix
src/lib/workers.js       # parallel backtest (Node worker_threads, browser chunks)
src/lib/quotex.js        # v2.1: Socket.IO v3 adapter, asset catalog, placeTrade
icons/
```

## Notes on the synthetic history

The engine always has **at least 40 candles** because the active asset's feed is **seeded with 120 synthetic bars** of the matching profile (FX, crypto, commodity, etc.) when the page loads. The engine waits for live ticks to flow in on top of that. The seeded bars use a regime cycle (trending → ranging → choppy → trending-down) so the dashboard has something to score immediately.

The historic backtest uses the **same generator** at longer windows (1–14 days) so the accuracy numbers are comparable to what you'd see on a similar live period — though obviously synthetic, not a substitute for live forward testing.

## Limits

Quotex does not expose a public candle API. v2.1 reads the platform's own WebSocket frames (Socket.IO v3, engine.io v3) for the live candle/quote/balance/instrument list. The exact event names and payload shapes are reverse-engineered from open-source clients (A11ksa/API-Quotex, ericpedra/quotexapi) and may need defensive fallbacks if the broker updates the protocol. The decoder logs unmatched frames under a `frame` callback so the dashboard can surface them; the `lib/quotex.js` module is small and standalone so updates are safe.

The auto-trade click mode is best-effort: it locates the CALL/PUT button by class name and visible text on the current chart, sets the stake input if it can find it, and clicks. The WS mode (opt-in, `args.mode === "ws"`) sends a real `orders/open` frame on the page's own socket. Both modes are gated by the safety limits above. Always confirm on the chart before you act. The extension never reads, stores, or transmits your SSID — for `ws` mode it only uses whatever the page is already transmitting, on the same socket.

**Disclaimer.** Educational market analysis only. Not a broker. Not financial advice. Binary options have a built-in payout edge against the trader (most brokers require >50% to break even on the headline payout). Nothing here is a profit guarantee. The auto-trade modes are off by default and require explicit arming.
