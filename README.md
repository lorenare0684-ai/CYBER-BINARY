# CYBER BINARY — Quotex Signal Lab v2

Chrome extension (Manifest V3) that attaches to a Quotex / QX Broker chart, builds 1-minute candles from the live quote, and scores **CALL / PUT / WAIT** from a multi-indicator, multi-timeframe confluence engine. The new **v2** dashboard is a tabbed lab with live signals, an automation panel, a historic backtester, a trade history, an asset catalog, and settings.

> Educational market analysis only. Not a broker. Not financial advice. Binary options have a built-in payout edge against the trader — nothing here is a profit guarantee.

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
- **Historic backtest** — runs the engine across the full asset catalog (16 assets: FX, crypto, commodities, indices, OTC) on deterministic synthetic 1m candles that cycle through trending / ranging / choppy regimes. Returns per-asset, per-strategy, per-regime, per-confidence-bucket accuracy.
- **Per-asset historic accuracy** + best-strategy recommendation.
- **Trade history** with filters (dir / outcome / asset), CSV export, and per-asset / per-strategy / per-regime breakdowns.
- **Walk-forward validation** helper to detect overfit.
- **Parallel workers** — Node tool uses `worker_threads`, browser dashboard chunks to keep the UI responsive.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this folder
4. Open Quotex (`qxbroker.com` / `quotex.com`) and a chart
5. The HUD appears on the chart; the dashboard window opens automatically
6. You can also click the extension icon on any tab to focus the dashboard

## Dashboard tabs

- **Live** — current signal, indicators, chart, recent calls, asset + strategy selector.
- **Auto** — mode, stake, expiry, confidence floor, daily loss cap, hourly/daily trade caps, cooldown, sound/desktop alerts, ARM/DISARM, automation log.
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
node tools/historic.js              # full matrix across 16 assets × strategies
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
src/page-hook.js         # MAIN-world WebSocket wrap (price + symbol)
src/content.js           # quote ingest, candles, multi-asset feeds, auto-trade
src/dashboard.html|.js|.css  # tabbed lab UI
src/lib/indicators.js    # 19 indicators + multi-timeframe resampler
src/lib/assets.js        # 16-asset catalog (FX/crypto/commodities/index/OTC)
src/lib/strategy.js      # 6 strategy presets
src/lib/engine.js        # confluence engine + backtest + walk-forward
src/lib/feed.js          # live + synthetic 1m series generator
src/lib/storage.js       # chrome.storage.local settings / history / calibration
src/lib/auto.js          # auto-trade controller (alerts + click)
src/lib/backtest.js      # full asset×strategy matrix
src/lib/workers.js       # parallel backtest (Node worker_threads, browser chunks)
icons/
```

## Notes on the synthetic history

The engine always has **at least 40 candles** because the active asset's feed is **seeded with 120 synthetic bars** of the matching profile (FX, crypto, commodity, etc.) when the page loads. The engine waits for live ticks to flow in on top of that. The seeded bars use a regime cycle (trending → ranging → choppy → trending-down) so the dashboard has something to score immediately.

The historic backtest uses the **same generator** at longer windows (1–14 days) so the accuracy numbers are comparable to what you'd see on a similar live period — though obviously synthetic, not a substitute for live forward testing.

## Limits

Quotex does not expose a public candle API. Ticks are read from the page quote + the in-page WebSocket. If the DOM class names change, price discovery may pause until the quote is visible again. The auto-trade click mode is best-effort: it locates the CALL/PUT button by class name and visible text on the current chart, sets the stake input if it can find it, and clicks. If the broker changes the markup, the click will fail safely and log it. Always confirm on the chart before you act.
