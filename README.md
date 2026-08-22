# CYBER BINARY — Quotex Signal Lab

Chrome extension (Manifest V3) that attaches to a Quotex / QX Broker chart, builds 1-minute candles from the live quote, and scores **CALL / PUT / WAIT** from multi-indicator confluence.

A performance dashboard (win rate, accuracy, wins, losses, recent calls) **opens in its own window** after the chart is attached and **scales with the window**.

This is **educational market analysis**, not a broker, not auto-trading, and **not a promise of profit**. Binary options have a built-in payout edge against the trader. Honest backtests on synthetic FX-like paths sit near **50%** — that is expected. The engine refuses low-volatility and low-confluence bars instead of forcing a side.

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → this folder
4. Open Quotex (`qxbroker.com` / `quotex.com`) and a chart
5. The HUD appears on the chart; the dashboard window opens automatically
6. You can also click the extension icon on any tab to focus the dashboard

## How signals work

Closed-bar confluence of:

- EMA 8 / 21 trend and fresh cross
- RSI pullback **with** trend (not extreme chase)
- MACD histogram direction
- Stochastic leaving 22 / 78
- Bollinger touch **only** if it agrees with the slow EMA
- ATR% floor so dead markets stay `WAIT`

A signal needs score ≥ 4 and a 2-point lead for one side. Paper results settle after 3 one-minute candles vs the signal bar close.

## Project layout

```
manifest.json
src/background.js      # dashboard window + state relay
src/content.js         # Quotex price scrape, candles, HUD
src/dashboard.html|.js|.css
src/lib/indicators.js
src/lib/engine.js
tools/backtest.js      # node synthetic backtest
tools/validate.js
icons/
```

## Local checks

```bash
node tools/validate.js
node tools/backtest.js
```

No build step. Scripts are plain ES5-compatible IIFEs so they run in both the extension and Node.

## Limits

Quotex does not expose a public candle API to extensions. Ticks are read from the page quote. If the DOM class names change, price discovery may pause until the quote is visible again. Always confirm on the chart before you act.
