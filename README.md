# CYBER BINARY — Quotex Trading Automation v2.6

Chrome extension (Manifest V3) that attaches to a Quotex / QX Broker chart, builds 1-minute candles from the live quote, and scores **CALL / PUT / WAIT** from a multi-indicator, multi-timeframe confluence engine with **Auto-Adaptive Strategy Switching** and **Auto-Adapting High-Accuracy Asset Ranking**. The Quotex adapter decodes the platform's WebSocket traffic and drives the engine with real candles/ticks/balance.

> Live signal analysis and explicitly armed automated execution for Quotex. This third-party tool can place real trades. Binary options are high risk, losses can quickly outweigh returns, and no result or profit is guaranteed.

## What's new in v2.6.7 — Real Quotex Capture Tool

- **`tools/capture-quotex.js`**: a Playwright script you run ON YOUR MACHINE to capture genuine Quotex candles with a demo account. It injects the extension's actual protocol decoder (src/page-hook.js) into a real Chromium, logs in (auto-fill or manual headed mode), subscribes 1m history for the assets you name, and writes the standard export file plus a diagnostics block with raw WebSocket frame samples.
- Credentials never leave your machine: pass `--email/--password` as local arguments, or omit them and log in by hand in the visible browser. Do not paste account credentials into chats.
- Output feeds the existing verification chain: `node tools/data-quality.js --candles <file>` (is the data clean?) then `node tools/accuracy.js --candles <file> --horizon 8` (does the preset hold on real candles?).
- The diagnostics frames let us verify the candle-row layout voting and every parser assumption against REAL payloads, not simulations.

## What's new in v2.6.6 — Live Signal Integrity

Signals can now only ever come from the desired asset's real, verified feed:

- **Live-data gate**: until the feed holds genuine broker history for the asset, any engine direction is forced to WAIT with an honest reason ("Waiting for real candles…" / "Warming up on real candles — N/40 bars"). No CALL/PUT, no chart markers, no calibration updates from the synthetic warm-up seed. Trade execution and auto-trading were already blocked; this closes the display path.
- **Demo mode can't fake signals**: the dashboard's synthetic demo feed now shows metrics only — direction held at WAIT with a "Demo mode — synthetic feed" reason.
- **Candle-batch trust chain**: batches whose payload names its own asset (or that come from the platform chart's own series) are symbol-verified and may seed the engine feed. Batches attributed by fallback (payload had no symbol) can never seed the engine feed and may extend it only when their price scale matches the verified feed — candles from a different asset are rejected with a console note. Quotes (always symbol-tagged) and per-asset feeds keep routing isolated per asset.
- **Quote clock-skew tolerance** widened to match the candle filters (a 60-second forward bound was silently rejecting every quote when the broker clock ran ahead).
- **New tool** `node tools/live-integrity.js`: 21 checks proving the contract — gate blocks synthetic-only feeds (engine computed a CALL at confidence 97 on synthetic data and the gate correctly suppressed the display), warm-up accounting, zero synthetic residue after real history, and the cross-asset trust rules (XAU-scale batch rejected from a EURUSD feed).

## What's new in v2.6.5 — Clean Candle Data + Indicator Hardening

Why the dashboard candles could diverge from the Quotex chart, and what changed:

- **Clock-skew fix (root cause)**: candle batches whose broker timestamps ran more than 5 minutes ahead of the PC clock were silently dropped at TWO layers (page hook + content script) — the feed then kept its 120-bar synthetic seed forever, so the dashboard never matched the platform. Both filters now tolerate up to 24h of server-vs-local skew (still rejecting unit mix-ups like seconds-vs-milliseconds), and the live-detection heartbeat got the same tolerance.
- **Array-row layout voting**: Quotex history rows are [ts, open, close, high, low], but the parser used a per-row guess that could mis-assign close on bars where close equals the extreme. The whole batch now votes on the layout from unambiguous rows, then parses consistently and clamps into a valid OHLC range.
- **Indicators no longer blank out on one glitched bar**: ATR, ADX, Stochastic, Supertrend, PSAR, Williams %R, CCI, MFI, VWAP and Donchian used to return all-null if a single bar arrived with h < l or close outside the range. They now repair that bar to the closest valid OHLC and keep flowing. Verified bit-identical on clean data (full suite + 57.03% baseline + 97.13% accuracy unchanged).
- **Demo-data badge**: when the dashboard chart is running on synthetic candles (extension disconnected / Quotex tab closed), an orange "DEMO DATA" badge makes it explicit instead of looking like a real feed.
- **New tool** `node tools/data-quality.js`: audits candle exports (from the "Export live candles" button) for duplicates, non-monotonic or off-grid timestamps, OHLC violations, missing-minute gaps, extreme jumps, flat bars and staleness. `--candles <file>` mode fails only on structural corruption; gaps/spikes are reported since real OTC feeds have them.

The math of every indicator was also re-audited against reference definitions (Wilder RSI/ATR/ADX, standard CCI/MFI/%R/OBV/Donchian/Keltner/PSAR/Supertrend, R/S Hurst) — no formula errors found; the bugs were in data handling, not the formulas.

## What's new in v2.6.4 — Monte Carlo & Hostile-Market Validation

New tool: `node tools/montecarlo.js` — the statistically hard tests for the High-Accuracy preset:

- **Seed Monte Carlo** (60 RNG seeds x 4 assets): pooled 97.15% over 106,049 trades; per-seed mean 97.15% (sd 0.61); worst seed 95.9%. The 80+ claim is not a lucky RNG draw.
- **Lookahead canary** (zero-drift random walk): a causal strategy must be statistically 50% here. 50% sits inside the 95% Wilson CI, and the regime gate correctly sat out 98.8% of bars (40 gated vs 3,281 ungated signals) — no future-information leakage.
- **Hostile markets** (reported, not asserted — this is the honest part):
  - fast trend flips every 5-25 bars: 29.6% WR (829 trades) — the preset is *designed* for persistent trends and is expected to lose here;
  - GARCH volatility clustering: 13.5% (104 trades); mean-revert/OU 41.7%, jump diffusion 35.4%, 4x volatility 44.0% (small samples, CIs include or approach 50%).
  - Conclusion: the ~97% figure is a property of the simulator's persistent-trending regimes plus the gates, not a universal edge. Live performance is bounded by how persistent real trends are.
- **Risk bootstrap** (10,000 equity paths, 85% payout): losing-streak and drawdown percentiles from the measured trade sequence; trivial drawdowns at simulator WR — rerun against your real-candle export before trusting any sizing.

## What's new in v2.6.3 — Real-Candle Backtesting

- **"Export live candles"** button on the Backtest tab: downloads the extension's cached real Quotex 1m candles (up to 5,000 bars per asset actually streamed while charts were open) as JSON.
- **Real-data verification mode**: `node tools/accuracy.js --candles <export.json> [--horizon 8]` re-runs the identical gated-vs-ungated comparison using ONLY the exported real candles — no synthetic padding — and prints per-asset and aggregate win rates, suppression-integrity checks, and payout breakeven lines. The win rate is reported, never asserted: real data says what it says.
- Clarity: the 97.13% figure from v2.6.2 is simulator-measured (no live broker data was available in that environment). The regime+confidence gates remain the design either way — they only suppress signals, and the real-data report shows exactly what they do on your own candles.

## What's new in v2.6.2 — High-Accuracy 80+ Preset

- **New `high_accuracy` strategy preset — 97.1% backtest win rate across the full 174-asset catalog (72,116 trades, 1 day, 8m expiry)**. It combines two engine-level signal gates:
  - `regimeFilter: ["trending"]` — signals fire only in trending regimes (the regime detector is causal: bar `i` uses only data up to bar `i`);
  - `minConfidence: 90` — sub-90 confluence is suppressed.
- Gates apply identically on the live signal path and the backtest lean path, and they only ever **suppress** (WAIT), never flip or fabricate a direction — `tools/accuracy.js` proves this with an ungated twin on identical data (ungated scalp: 79.3%, gated: 97.2% on the same series).
- **Trade-off**: selectivity. The preset fires on roughly one-third of the bars its base strategy would; off-regime bars show WAIT with the gate reason in the HUD.
- **Recommended settings**: expiry 5-8 minutes (backtest horizon 5m: 97.05%, 8m: 97.13%).
- Regression: `node tools/accuracy.js` — 13 checks incl. full-catalog coverage, >=80% WR floor, suppression-only proof, live-path gate reasons.
- **Honesty note**: these numbers are measured on the deterministic per-asset simulator with regime-persistent synthetic candles. They pin the engine's gated behaviour, not live Quotex performance. No preset can guarantee live accuracy; the gates make the system *selective*, and selectivity is what the simulator rewards.

## What's new in v2.6.1 — Emoji-Free UI, Full-Catalog Backtest, Attached Arrows

- **Emoji-free UI**: removed every decorative emoji from the dashboard, strategy labels, engine reason strings, and docs (broker button-detection arrow glyphs in the adapter regexes are functional and stay).
- **Backtest uses all assets**: the Backtest tab now runs the full kind-filtered catalog (every asset × every strategy) instead of only assets with a live candle cache. Cached Quotex candles are preferred wherever they exist; the rest of the catalog runs on the deterministic per-asset simulator, the per-asset table gains a Data column (Live / Live+Sim / Sim), and a coverage line states exactly what ran. Backtests now also run in a pool of up to four dedicated workers with aggregated progress and per-chunk recovery.
- **Signal arrows attached to candles**: lightweight-charts v5 builds no longer fall through to the approximate overlay — arrows render natively via `createSeriesMarkers()` on the captured price series (v4 `setMarkers()` remains first). The v5 `addSeries(CandlestickSeries, ...)` price series is now detected, plugins follow series re-creation on asset/timeframe switches, and the overlay fallback re-projects on every visible-range change (scroll / zoom / new bars) so arrows can no longer drift off their candles.

## What's new in v2.6.0 — High-Accuracy Strategy Suite & Engine Upgrades

- **Elite High-Accuracy Strategy Suite (Removed Worst, Added Best)**:
  - **Removed Worst Performing Strategies**: Eliminated counter-trend and blind mean-reversion presets (`meanrev`, `reversal`, `choppy_range`) which suffered from low winrates (20%–35%) on binary options due to trend-fading vulnerabilities.
  - **Added New High-Accuracy Presets**:
    - `sniper`: **Sniper 90+ Confluence** — Ultra-high conviction multi-timeframe alignment, Supertrend, ADX strength, and Parabolic SAR confirmation (~79.0% win rate).
    - `turbo_trend`: **Turbo Trend Flow** — Fast EMA ribbon acceleration coupled with Supertrend and higher-timeframe continuation (~78.6% win rate).
    - `institutional_flow`: **Institutional VWAP Flow** — Volume-weighted VWAP anchor levels aligned with Hurst fractal persistence (~79.0% win rate).
  - **Refined & Retained Top Strategies**:
    - `scalp`: 1m Ultra Scalp (~79.6% win rate)
    - `momentum_pulse`: Momentum Pulse (~79.4% win rate)
    - `confluence`: Balanced Confluence (~79.2% win rate)
    - `ribbon`: EMA Ribbon Matrix (~79.1% win rate)
    - `breakout`: Breakout Velocity (~79.1% win rate)
    - `trend`: Trend Master (~78.6% win rate)
    - `squeeze`: Volatility Squeeze Expansion (~78.2% win rate)
    - `otc`: OTC Pro Matrix (~76.4% win rate)
    - `auto_adaptive`: Auto-Adaptive Elite Strategy Router (~76.1% win rate across all regimes)
- **Signal Generation & Auto-Adaptive Engine Fixes**:
  - **Uncapped Fitness Comparison**: Fixed a critical bug in `evaluateAdaptive` where candidate strategy fitness scores were clamped to 100 before applying the signal bonus, causing ties at 200 that prevented higher-confluence strategies (such as Ribbon, Trend, or Momentum Pulse) from being selected over the baseline preset.
  - **Stochastic Signal Trigger Fix**: Extended stochastic oversold/overbought detection to recognize intra-bar crossovers and fresh reversals, restoring signals across oscillator-based strategies.
  - **MTF 15m Warmup Gate Fix**: Lowered the completion threshold in `mtfTrendSeries` from 30 bars (450 minutes) to 21 bars (the slow EMA length), ensuring higher-timeframe trend alignment actively contributes to live signals on standard 200-bar histories.
  - **Regime Directional Alignment**: Corrected regime detection so strong directional EMA separation properly identifies `strong-trend` regimes.
  - **400x Backtest & Evaluation Performance**: Vectorized numerical extraction in indicators (`stdev`, `donchian`, `stochastic`, `williamsR`, `cci`, `hurst`), pre-resolved strategy parameter maps, and shared invariant indicators across parallel evaluation passes.
- **Asset Selector Bare-Object Support**:
  - Enhanced `CYBER_ASSET_SELECTOR.evaluateAsset()` to automatically augment partial asset references (e.g. `{ id: "EURUSD" }`) with full catalog metadata (payout, classification, and OTC flags) used by the auto-trade gate.
- **Manifest & UI Refresh**:
  - Upgraded Manifest V3 version to `2.6.0` and refreshed dashboard cockpit headers and strategy selection menus.

## What's new in v2.5.0 — Auto-Adaptive System & High-Accuracy Assets

- **Auto-Adaptive Strategy Engine (`auto_adaptive`)**:
  - Dynamically evaluates market situation and regime (`trending`, `strong-trend`, `mean-reverting`, `choppy`, `ranging`, `squeeze`, `volatile`) on every bar.
  - Concurrently analyzes all 11 concrete strategy presets (`confluence`, `trend`, `meanrev`, `breakout`, `scalp`, `otc`, `squeeze`, `ribbon`, `reversal`, `momentum_pulse`, `choppy_range`).
  - Calculates a **Situation Fitness Score** (0-100) combining regime compatibility, indicator confluence, signal strength, and strategy hit-rate history.
  - Automatically selects and executes using the **Best Strategy** for the current market situation!
- **Auto-Adapting High-Accuracy Asset Selector**:
  - Continuously ranks all catalog instruments in real time by **Expected Value (EV = WinRate% × (1 + Payout%) - 1)** and **Accuracy Score**.
  - Displays top high-accuracy assets with EV %, win rate, payout %, and recommended strategy.
  - Includes a **High-Accuracy Asset Filter Gate** in Auto-Trade mode: automatically suppresses trades on negative-EV / low-accuracy assets and executes on top high-accuracy opportunities.
  - Quick "Select Best High-Accuracy Asset" button on the live dashboard.
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
src/lib/asset-selector.js# v2.6: Auto-Adapting High-Accuracy Asset Selector
src/lib/strategy.js      # 12 strategy presets + auto_adaptive
src/lib/engine.js        # v2.6: confluence + auto-adaptive strategy evaluator
src/lib/feed.js          # live + synthetic 1m series generator (ingestCandle)
src/lib/storage.js       # chrome.storage.local settings / history / calibration
src/lib/auto.js          # auto-trade controller (alerts + click + placeTrade)
src/lib/backtest.js      # full asset×strategy matrix
src/lib/workers.js       # parallel backtest (Node worker_threads, browser chunks)
src/lib/quotex.js        # Socket.IO v3 adapter, asset catalog, placeTrade
icons/
tools/adaptive-test.js   # v2.6: test suite for adaptive strategies & assets
```

**Live-trading notice.** This is a third-party Quotex signal and automation client. Explicitly armed click mode can place real orders. Binary options have a built-in payout edge against the trader (most brokers require more than 50% wins to break even), so no signal, backtest, or automation result is a profit guarantee. Automation remains off and disarmed by default.
