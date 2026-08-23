# CYBER BINARY — 100-instance market-filter audit

Status: **100 / 100 concrete broker-market omissions fixed and regression-checked**.

## Root cause

The UI describes `OTC` as an asset filter, but the catalog correctly retains each instrument's underlying class (`fx`, `crypto`, `commodity`, `index`, or `stock`). The backtest/dashboard/worker filter incorrectly used `asset.kind === "otc"`, which returned only the two synthetic demo assets and omitted every genuine Quotex `_otc` market.

Each row below is a distinct selectable/tradable broker market that could not be reached through the OTC filter. The audit is capped at 100; the fix restores all 125 `_otc` markets plus the two generic OTC demo instruments.

## Fix coverage

- Added one canonical `CYBER_ASSETS.matchesKind()` venue-aware predicate.
- Made `CYBER_ASSETS.byKind("otc")` return all OTC venues across underlying classes.
- Applied the predicate to synchronous matrix runs, browser worker jobs, Node worker jobs, chunked fallback jobs, and dashboard backtest selection.
- Kept FX/crypto/commodity/index/stock classification intact for class-specific reporting.
- Clarified the UI label to **OTC (all classes)**.
- Added catalog, worker, and historic-matrix regressions proving cross-class OTC selection.
- Also fixed stale-tick validation-before-rebase and independent action-button selector failure isolation found while running the full suite.

## 100 concrete instances

| # | Broker market | Underlying class | Previous failure |
|---:|---|---|---|
| 1 | `EURUSD_otc` | fx | OTC filter omitted the market |
| 2 | `GBPUSD_otc` | fx | OTC filter omitted the market |
| 3 | `USDJPY_otc` | fx | OTC filter omitted the market |
| 4 | `AUDUSD_otc` | fx | OTC filter omitted the market |
| 5 | `USDCAD_otc` | fx | OTC filter omitted the market |
| 6 | `USDCHF_otc` | fx | OTC filter omitted the market |
| 7 | `EURJPY_otc` | fx | OTC filter omitted the market |
| 8 | `EURGBP_otc` | fx | OTC filter omitted the market |
| 9 | `EURCHF_otc` | fx | OTC filter omitted the market |
| 10 | `AUDJPY_otc` | fx | OTC filter omitted the market |
| 11 | `GBPJPY_otc` | fx | OTC filter omitted the market |
| 12 | `EURAUD_otc` | fx | OTC filter omitted the market |
| 13 | `EURCAD_otc` | fx | OTC filter omitted the market |
| 14 | `GBPCHF_otc` | fx | OTC filter omitted the market |
| 15 | `CADJPY_otc` | fx | OTC filter omitted the market |
| 16 | `NZDUSD_otc` | fx | OTC filter omitted the market |
| 17 | `EURNZD_otc` | fx | OTC filter omitted the market |
| 18 | `AUDCAD_otc` | fx | OTC filter omitted the market |
| 19 | `AUDCHF_otc` | fx | OTC filter omitted the market |
| 20 | `AUDNZD_otc` | fx | OTC filter omitted the market |
| 21 | `GBPAUD_otc` | fx | OTC filter omitted the market |
| 22 | `GBPCAD_otc` | fx | OTC filter omitted the market |
| 23 | `GBPNZD_otc` | fx | OTC filter omitted the market |
| 24 | `CHFJPY_otc` | fx | OTC filter omitted the market |
| 25 | `EURSGD_otc` | fx | OTC filter omitted the market |
| 26 | `CADCHF_otc` | fx | OTC filter omitted the market |
| 27 | `NZDJPY_otc` | fx | OTC filter omitted the market |
| 28 | `NZDCAD_otc` | fx | OTC filter omitted the market |
| 29 | `NZDCHF_otc` | fx | OTC filter omitted the market |
| 30 | `ARSUSD_otc` | fx | OTC filter omitted the market |
| 31 | `BRLUSD_otc` | fx | OTC filter omitted the market |
| 32 | `DZDUSD_otc` | fx | OTC filter omitted the market |
| 33 | `INRUSD_otc` | fx | OTC filter omitted the market |
| 34 | `USDBDT_otc` | fx | OTC filter omitted the market |
| 35 | `USDCOP_otc` | fx | OTC filter omitted the market |
| 36 | `USDMXN_otc` | fx | OTC filter omitted the market |
| 37 | `USDPKR_otc` | fx | OTC filter omitted the market |
| 38 | `USDTRY_otc` | fx | OTC filter omitted the market |
| 39 | `USDZAR_otc` | fx | OTC filter omitted the market |
| 40 | `EURTRY_otc` | fx | OTC filter omitted the market |
| 41 | `EURPLN_otc` | fx | OTC filter omitted the market |
| 42 | `EURHUF_otc` | fx | OTC filter omitted the market |
| 43 | `USDRUB_otc` | fx | OTC filter omitted the market |
| 44 | `USDSEK_otc` | fx | OTC filter omitted the market |
| 45 | `USDNOK_otc` | fx | OTC filter omitted the market |
| 46 | `EURNOK_otc` | fx | OTC filter omitted the market |
| 47 | `EURSEK_otc` | fx | OTC filter omitted the market |
| 48 | `ADAUSD_otc` | crypto | OTC filter omitted the market |
| 49 | `APTUSD_otc` | crypto | OTC filter omitted the market |
| 50 | `ARBUSD_otc` | crypto | OTC filter omitted the market |
| 51 | `ATOUSD_otc` | crypto | OTC filter omitted the market |
| 52 | `AVAUSD_otc` | crypto | OTC filter omitted the market |
| 53 | `AXSUSD_otc` | crypto | OTC filter omitted the market |
| 54 | `BCHUSD_otc` | crypto | OTC filter omitted the market |
| 55 | `BNBUSD_otc` | crypto | OTC filter omitted the market |
| 56 | `BONUSD_otc` | crypto | OTC filter omitted the market |
| 57 | `BTCUSD_otc` | crypto | OTC filter omitted the market |
| 58 | `DOGUSD_otc` | crypto | OTC filter omitted the market |
| 59 | `ETHUSD_otc` | crypto | OTC filter omitted the market |
| 60 | `FLOUSD_otc` | crypto | OTC filter omitted the market |
| 61 | `XRPUSD_otc` | crypto | OTC filter omitted the market |
| 62 | `SOLUSD_otc` | crypto | OTC filter omitted the market |
| 63 | `LTCUSD_otc` | crypto | OTC filter omitted the market |
| 64 | `TRXUSD_otc` | crypto | OTC filter omitted the market |
| 65 | `SHIBUSD_otc` | crypto | OTC filter omitted the market |
| 66 | `MATICUSD_otc` | crypto | OTC filter omitted the market |
| 67 | `DOTUSD_otc` | crypto | OTC filter omitted the market |
| 68 | `LINKUSD_otc` | crypto | OTC filter omitted the market |
| 69 | `XLMUSD_otc` | crypto | OTC filter omitted the market |
| 70 | `DOGEUSD_otc` | crypto | OTC filter omitted the market |
| 71 | `DASHUSD_otc` | crypto | OTC filter omitted the market |
| 72 | `ETCUSD_otc` | crypto | OTC filter omitted the market |
| 73 | `NEARUSD_otc` | crypto | OTC filter omitted the market |
| 74 | `SUIUSD_otc` | crypto | OTC filter omitted the market |
| 75 | `TIAUSD_otc` | crypto | OTC filter omitted the market |
| 76 | `XAUUSD_otc` | commodity | OTC filter omitted the market |
| 77 | `XAGUSD_otc` | commodity | OTC filter omitted the market |
| 78 | `UKBrent_otc` | commodity | OTC filter omitted the market |
| 79 | `USCrude_otc` | commodity | OTC filter omitted the market |
| 80 | `XNGUSD_otc` | commodity | OTC filter omitted the market |
| 81 | `XPTUSD_otc` | commodity | OTC filter omitted the market |
| 82 | `XPDUSD_otc` | commodity | OTC filter omitted the market |
| 83 | `COPPER_otc` | commodity | OTC filter omitted the market |
| 84 | `AAPL_otc` | stock | OTC filter omitted the market |
| 85 | `AMZN_otc` | stock | OTC filter omitted the market |
| 86 | `AXP_otc` | stock | OTC filter omitted the market |
| 87 | `BA_otc` | stock | OTC filter omitted the market |
| 88 | `CSCO_otc` | stock | OTC filter omitted the market |
| 89 | `DIS_otc` | stock | OTC filter omitted the market |
| 90 | `FB_otc` | stock | OTC filter omitted the market |
| 91 | `GOOGL_otc` | stock | OTC filter omitted the market |
| 92 | `INTC_otc` | stock | OTC filter omitted the market |
| 93 | `JNJ_otc` | stock | OTC filter omitted the market |
| 94 | `JPM_otc` | stock | OTC filter omitted the market |
| 95 | `KO_otc` | stock | OTC filter omitted the market |
| 96 | `MCD_otc` | stock | OTC filter omitted the market |
| 97 | `MSFT_otc` | stock | OTC filter omitted the market |
| 98 | `NFLX_otc` | stock | OTC filter omitted the market |
| 99 | `NVDA_otc` | stock | OTC filter omitted the market |
| 100 | `PFE_otc` | stock | OTC filter omitted the market |

## Acceptance criteria

1. `byKind("otc")` contains every static `_otc` instrument.
2. The OTC result contains at least 100 real broker markets.
3. FX, crypto, and stock OTC instruments survive worker job filtering.
4. Historic matrix filtering excludes a non-OTC control while retaining cross-class OTC inputs.
5. Stale broker ticks cannot mutate a synthetic warm-up through rebasing.
6. Failure of one DOM selector cannot suppress valid CALL/PUT controls found by other selectors.
