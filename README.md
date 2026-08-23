# CYBER BINARY — Quotex Trading Automation v2.5

Chrome extension (Manifest V3) that attaches to a Quotex / QX Broker chart, builds 1-minute candles from the live quote, and scores **CALL / PUT / WAIT** from a multi-indicator, multi-timeframe confluence engine with **Auto-Adaptive Strategy Switching** and **Auto-Adapting High-Accuracy Asset Ranking**. The Quotex adapter decodes the platform's WebSocket traffic and drives the engine with real candles/ticks/balance.

> Live signal analysis and explicitly armed automated execution for Quotex. This third-party tool can place real trades. Binary options are high risk, losses can quickly outweigh returns, and no result or profit is guaranteed.

## What's new in v2.5.0 — Auto-Adaptive System & High-Accuracy Assets

- **⚡ Auto-Adaptive Strategy Engine (`auto_adaptive`)**:
  - Dynamically evaluates market situation and regime (`trending`, `strong-trend`, `mean-reverting`, `choppy`, `ranging`, `squeeze`, `volatile`) on every bar.
  - Concurrently analyzes all 11 concrete strategy presets (`confluence`, `trend`, `meanrev`, `breakout`, `scalp`, `otc`, `squeeze`, `ribbon`, `reversal`, `momentum_pulse`, `choppy_range`).
  - Calculates a **Situation Fitness Score** (0-100) combining regime compatibility, indicator confluence, signal strength, and strategy hit-rate history.
  - Automatically selects and executes using the **Best Strategy** for the current market situation!
- **🎯 Auto-Adapting High-Accuracy Asset Selector**:
  - Continuously ranks all catalog instruments in real time by **Expected Value (EV = WinRate% × (1 + Payout%) - 1)** and **Accuracy Score**.
  - Displays top high-accuracy assets with EV %, win rate, payout %, and recommended strategy.
  - Includes a **High-Accuracy Asset Filter Gate** in Auto-Trade mode: automatically suppresses trades on negative-EV / low-accuracy assets and executes on top high-accuracy opportunities.
  - Quick "🎯 Select Best High-Accuracy Asset" button on the live dashboard.
- **5 New Specialized Strategy Presets**:
  - `squeeze`: Volatility Squeeze & Expansion (Bollinger Bands compression inside Keltner Channels + momentum expansion).
  - `ribbon`: EMA Ribbon Alignment (Fast / Medium / Slow EMA stack alignment + ADX).
  - `reversal`: Extreme Reversal / Rejection (Oversold/Overbought RSI, Stochastic, CCI & BB band touches).
  - `momentum_pulse`: Momentum Pulse (MACD acceleration + Parabolic SAR + Williams %R).
  - `choppy_range`: Choppy Range Bound (VWAP & oscillator mean reversion for low-ADX sideways markets).

## What's new in v2.4.0 — responsive UI, confirmed execution, one main chart

- **No more multi-chart/multi-tab mimicry** — quote and history fan-out updates each asset's own feed but cannot select it. Only an explicit main-chart socket event changes the dashboard asset. The background owns one selected Quotex tab, and both content scripts are top-frame-only, so secondary tabs/iframes cannot trade or overwrite dashboard state.
- **No more open-chart icon clicks** — CALL/PUT matching now requires exact direction tokens or a credible green/red action-button pair. Broad `up` substring and positional fallbacks were removed (they could interpret `popup` as UP/CALL).
- **Confirmed trade execution** — auto mode uses the page's authenticated WebSocket first, sends the correct Quotex contract shape (OTC duration + `optionType=100`; regular market absolute expiry + `optionType=1`), and counts a trade only after `s_orders/open` confirms it. A sent-but-unconfirmed order is never retried with a DOM click.
- **Hard async anti-spam lock** — only one order can be in flight, processed signal keys remain deduped across asset/direction churn, and only the primary tab may execute.
- **Complete call lifecycle** — Live, History, recent broker orders, and CSV export include expiry duration/time plus entry and exit times/prices.
- **Correct, stable dashboard candles** — broker batches are merged per asset + timeframe, sorted, deduped, OHLC envelopes are validated, incremental batches no longer replace the entire chart, and candle/EMA/MACD x-coordinates align.
- **Faster UI** — expensive closed-bar analysis is cached once per bar, state pushes are throttled, dashboard rendering is animation-frame coalesced, and marker updates happen only when a new marker is added.
- **Both directions are covered** — regression tests assert bullish data emits **CALL** and bearish data emits **PUT**.

## What's new in v2.3.3 — non-repainting signal arrows on the Quotex chart

- **Arrows on the platform chart** — every qualifying signal now draws an arrow on the Quotex chart itself: green **CALL** arrow below the bar, red **PUT** arrow above it, glued to the exact bar that triggered the signal.
- **Non-repainting by construction** — arrows are anchored to a *closed* bar's (time, close). The anchor is fixed before the next candle exists, deduped per (asset, bar, direction), and never changes afterwards; re-rendering only re-projects fixed anchors, so arrows can never move, flicker or double up as new candles form.
- **Historical arrows too** — on attach, every settled trade in your stored history is replayed as a fixed marker, so past signals are visible on the chart alongside the live ones.
- **Renders through TradingView Lightweight Charts natively** — the page hook (MAIN world, document_start) captures the chart instance three ways: it wraps `LightweightCharts.createChart` before the page bundle assigns the global, reads `<lightweight-chart>` web-component instances, and runs a bounded React-fiber scan of the chart container for bundled builds. Markers are drawn with the library's own `series.setMarkers()` — the arrows scroll and zoom with the chart exactly like platform drawings.
- **Overlay-canvas fallback** — if no chart API is reachable, arrows are drawn on a transparent overlay above the price chart from the same fixed anchors (approximate mapping from the live feed bars; redrawn on resize/scroll).
- **Dashboard chart arrows** — the same fixed anchors are drawn on the dashboard's candle chart (green/red triangles at their bar slots).

## What's new in v2.3.2 — bug-audit fixes

- **Settings no longer silently drop rapid changes** — `storage.js` used to re-read `chrome.storage.local` on every `load()`, so two quick updates inside the 200ms save debounce (e.g. mode then arm, stake then expiry) lost the earlier one. Writes pending in the debounce are now flushed before every read; cross-context changes (dashboard popup ↔ content script) are still picked up. Covered by `tools/bugs.js`.
- **Daily P&L resets after 24h, not 1h** — `recordTrade()` used `36e5` ms (= one hour) as its "daily" reset horizon. Now a real 24h window, matching the UTC `byDay` keys.
- **Huge WebSocket frames no longer crash the decoder** — `String.fromCharCode.apply` on a multi-megabyte binary frame threw *Maximum call stack size exceeded* (history/instruments payloads are routinely >1MB). Both the adapter and the page hook now convert byte payloads in 32KB chunks. Tested at 1KB → 4MB.
- **Confidence calibration actually applies** — the settings toggle existed but the content script never read it; reported confidence now shrinks toward the observed hit rate of its confidence bucket before signals reach the auto controller and stats.
- **Live stats breakdowns populate** — settled trades never updated `byStrategy` / `byAsset` / `byRegime` (or the history `pnl` column) in the content script, so the dashboard's live win-rate and splits stayed empty. Fixed + unit-covered.
- **Stale ticks can't corrupt the candle feed** — a delayed/replayed tick older than the in-progress bar used to become the "current" bar, producing unsorted series and garbage indicators. Such ticks are now dropped; newer ticks still flow.
- **Background history can't hijack the active asset** — a candle replay for a chart you're not watching no longer force-switches the engine's active asset away from what the page socket/DOM says (manual pins still win).
- **Dashboard ARM button no longer dead-clicks** — it dereferenced `settings` before the async settings load resolved (TypeError); now safe, and the auto-mode selector no longer emits `armed: null`.

## What's new in v2.3 — every Quotex asset + reliable auto-detection

- **Full Quotex asset catalog** (~170 symbols): every base FX pair (EURUSD, GBPUSD, … GBPNZD, NZDCAD, NZDCHF) **plus its `_otc` twin**, exotic FX OTC pairs (BRL/USD, USD/MXN, ARS/USD, USD/TRY, USD/COP …), all crypto OTC (BTC, ETH, SOL, ADA, XRP, LTC, DOGE, SHIB, TRX, LINK, DOT …), commodities (XAU, XAG, oil, gas, platinum, palladium, copper), all 13 indices, and the full stock list (AAPL, AMZN, TSLA, NVDA, MSFT, GOOGL, META, JPM, KO, WMT …). Broker-internal numeric IDs are baked in where confirmed and **self-heal at runtime**: any asset the platform lists in `instruments/list` is registered on the fly with its real ID, payout and timeframes, and appears in the Assets tab, the asset dropdown and per-asset accuracy reports.
- **Auto-detection that actually works on the live platform:**
  - **Outgoing-frame sniffing** — the extension watches the frames the page itself sends (`instruments/follow`, `instruments/update`, `history/list/v2`, `chart_notification/get`, `orders/open`), so the moment you open or switch a chart, the exact asset (e.g. `EURUSD_otc`) is known — no DOM guessing.
  - **Numeric-id tick resolution** — `quotes/stream` rows that arrive as `[assetId, ts, price]` are resolved through the live instruments list.
  - **DOM text-scan fallback** — the modern Quotex UI ships hashed CSS-module class names, so class selectors miss; the extension now scans small visible text nodes against the catalog ("EUR/USD", "EUR/USD OTC", "Bitcoin (OTC)", "S&P 500" …) and picks the most specific match.
  - **History-payload detection** — incoming `history/list/v2` / `chart_notification/get` responses name their asset, another reliable signal.
  - Detection layers in order: socket symbol → adapter DOM helpers → class selectors → text scan → page title → URL.
- **Trade placement that works on the current UI** — the CALL/PUT button finder understands hashed-class DOM but still fails closed: it requires exact direction tokens or a credible green/red action-button pair, with no generic positional click fallback. The stake input finder scores candidates (hints + trade-panel containment + proximity to verified buttons), and placement prefers a correlated `orders/open` WebSocket frame.
- **No more trade spam** — the auto controller now dedups per (asset, closed-bar, direction), so it fires **once per signal**, not once per 500ms tick; `cooldownBars` is enforced unconditionally (the old check read a `metrics.closeTime` field the engine never set, so cooldown silently never fired); and a hard minimum interval (5s, configurable via `settings.minIntervalMs`) prevents double-fires. Auto "alerts" mode no longer floods notifications for the same bar either.

## What's new in v2

- **Automatic asset detection** from the visible chart symbol, URL, page title, and WebSocket frames — works across `qxbroker.com` and `quotex.com` and follows SPA navigation.
- **Multi-strategy presets** — Auto-Adaptive, Confluence, Trend, Mean-reversion, Breakout, 1m Scalp, OTC 24/7, Squeeze, Ribbon, Reversal, Momentum Pulse, Choppy Range. Switchable per asset, per session.
- **15+ indicators** — EMA / RSI / MACD / Stochastic / Bollinger / ATR / **ADX / Keltner / Parabolic SAR / Supertrend / VWAP / Hurst / Williams %R / CCI / MFI / OBV / Donchian / momentum**.
- **Multi-timeframe** — resamples 1m → 5m, 15m and votes on agreement.
- **Regime detection** — trending / strong-trend / mean-reverting / choppy / ranging / squeeze / volatile.
- **Calibration** — the engine learns which predicted-confidence buckets actually win and shrinks the reported confidence accordingly.
- **Auto-trade** with two modes:
  - **Alerts** — sound + desktop notification + dashboard pulse on qualifying signals. (Default.)
  - **Click** — actively click the visible CALL/PUT button with your stake and expiry, gated by safety limits.
- **Safety limits** — confidence floor, daily loss cap, hourly / daily trade caps, cooldown bars, per-asset freeze, kill-switch (ARM/DISARM), high-accuracy asset filter gate.
- **Historic backtest** — runs the engine on cached Quotex live/tick-built 1m candles captured from the page feed (no synthetic fallback in the dashboard backtester). Returns per-asset, per-strategy, per-regime, per-confidence-bucket accuracy.
- **Per-asset historic accuracy** + best-strategy recommendation.
- **Trade history** with filters (dir / outcome / asset), CSV export, and per-asset / per-strategy / per-regime breakdowns.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this folder
4. Open Quotex (`qxbroker.com` / `quotex.com`) and a chart
5. The HUD appears on the chart; the dashboard window opens automatically
6. You can also click the extension icon on any tab to focus the dashboard

## Local tools

```bash
node tools/validate.js              # structure + engine + backtest smoke
node tools/adaptive-test.js          # auto-adaptive strategy & high-accuracy asset tests
node tools/backtest.js              # legacy single-asset backtest
node tools/historic.js              # full matrix across 170+ assets × strategies
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
src/lib/asset-selector.js# v2.5: Auto-Adapting High-Accuracy Asset Selector
src/lib/strategy.js      # 12 strategy presets + auto_adaptive
src/lib/engine.js        # v2.5: confluence + auto-adaptive strategy evaluator
src/lib/feed.js          # live + synthetic 1m series generator (ingestCandle)
src/lib/storage.js       # chrome.storage.local settings / history / calibration
src/lib/auto.js          # auto-trade controller (alerts + click + placeTrade)
src/lib/backtest.js      # full asset×strategy matrix
src/lib/workers.js       # parallel backtest (Node worker_threads, browser chunks)
src/lib/quotex.js        # Socket.IO v3 adapter, asset catalog, placeTrade
icons/
tools/adaptive-test.js   # v2.5: test suite for adaptive strategies & assets
```

**Live-trading notice.** This is a third-party Quotex signal and automation client. Explicitly armed click mode can place real orders. Binary options have a built-in payout edge against the trader (most brokers require more than 50% wins to break even), so no signal, backtest, or automation result is a profit guarantee. Automation remains off and disarmed by default.
