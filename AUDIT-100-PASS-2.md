# CYBER BINARY — second 100-instance bug audit

Status: **100 / 100 concrete catalog-metadata bugs fixed and regression-checked**.

## Root cause

The static catalog had 125 real `_otc` broker instruments, but none carried the canonical `isOtc` field. Consumers received incomplete asset objects and had to infer venue from inconsistent ids, names, or sessions. This also exposed all 42 OTC stock instruments as `NYSE` session markets even though Quotex lists them as OTC.

The ledger is capped at 100 distinct broker instruments. The implementation fixes all 125 suffix-based OTC instruments, non-suffix catalog markets explicitly assigned to an OTC session, generic OTC instruments, and future runtime-registered OTC symbols.

## Fix coverage

- Canonicalized `isOtc` on every static catalog entry.
- Preserved the underlying class (`fx`, `crypto`, `commodity`, `stock`) independently of venue.
- Corrected all OTC stock sessions from `NYSE` to `OTC 24/7`.
- Added `isOtc` to runtime-created assets.
- Prevented live instrument refreshes from erasing static OTC identity.
- Made the venue-aware filter prefer canonical metadata while retaining compatibility fallbacks.
- Added catalog-wide, stock-session, runtime-registration, and live-update regressions.

## 100 concrete instances

| # | Broker market | Underlying class | Previous failure |
|---:|---|---|---|
| 1 | `EURUSD_otc` | fx | `isOtc` was missing |
| 2 | `GBPUSD_otc` | fx | `isOtc` was missing |
| 3 | `USDJPY_otc` | fx | `isOtc` was missing |
| 4 | `AUDUSD_otc` | fx | `isOtc` was missing |
| 5 | `USDCAD_otc` | fx | `isOtc` was missing |
| 6 | `USDCHF_otc` | fx | `isOtc` was missing |
| 7 | `EURJPY_otc` | fx | `isOtc` was missing |
| 8 | `EURGBP_otc` | fx | `isOtc` was missing |
| 9 | `EURCHF_otc` | fx | `isOtc` was missing |
| 10 | `AUDJPY_otc` | fx | `isOtc` was missing |
| 11 | `GBPJPY_otc` | fx | `isOtc` was missing |
| 12 | `EURAUD_otc` | fx | `isOtc` was missing |
| 13 | `EURCAD_otc` | fx | `isOtc` was missing |
| 14 | `GBPCHF_otc` | fx | `isOtc` was missing |
| 15 | `CADJPY_otc` | fx | `isOtc` was missing |
| 16 | `NZDUSD_otc` | fx | `isOtc` was missing |
| 17 | `EURNZD_otc` | fx | `isOtc` was missing |
| 18 | `AUDCAD_otc` | fx | `isOtc` was missing |
| 19 | `AUDCHF_otc` | fx | `isOtc` was missing |
| 20 | `AUDNZD_otc` | fx | `isOtc` was missing |
| 21 | `GBPAUD_otc` | fx | `isOtc` was missing |
| 22 | `GBPCAD_otc` | fx | `isOtc` was missing |
| 23 | `GBPNZD_otc` | fx | `isOtc` was missing |
| 24 | `CHFJPY_otc` | fx | `isOtc` was missing |
| 25 | `EURSGD_otc` | fx | `isOtc` was missing |
| 26 | `CADCHF_otc` | fx | `isOtc` was missing |
| 27 | `NZDJPY_otc` | fx | `isOtc` was missing |
| 28 | `NZDCAD_otc` | fx | `isOtc` was missing |
| 29 | `NZDCHF_otc` | fx | `isOtc` was missing |
| 30 | `ARSUSD_otc` | fx | `isOtc` was missing |
| 31 | `BRLUSD_otc` | fx | `isOtc` was missing |
| 32 | `DZDUSD_otc` | fx | `isOtc` was missing |
| 33 | `INRUSD_otc` | fx | `isOtc` was missing |
| 34 | `USDBDT_otc` | fx | `isOtc` was missing |
| 35 | `USDCOP_otc` | fx | `isOtc` was missing |
| 36 | `USDMXN_otc` | fx | `isOtc` was missing |
| 37 | `USDPKR_otc` | fx | `isOtc` was missing |
| 38 | `USDTRY_otc` | fx | `isOtc` was missing |
| 39 | `USDZAR_otc` | fx | `isOtc` was missing |
| 40 | `EURTRY_otc` | fx | `isOtc` was missing |
| 41 | `EURPLN_otc` | fx | `isOtc` was missing |
| 42 | `EURHUF_otc` | fx | `isOtc` was missing |
| 43 | `USDRUB_otc` | fx | `isOtc` was missing |
| 44 | `USDSEK_otc` | fx | `isOtc` was missing |
| 45 | `USDNOK_otc` | fx | `isOtc` was missing |
| 46 | `EURNOK_otc` | fx | `isOtc` was missing |
| 47 | `EURSEK_otc` | fx | `isOtc` was missing |
| 48 | `ADAUSD_otc` | crypto | `isOtc` was missing |
| 49 | `APTUSD_otc` | crypto | `isOtc` was missing |
| 50 | `ARBUSD_otc` | crypto | `isOtc` was missing |
| 51 | `ATOUSD_otc` | crypto | `isOtc` was missing |
| 52 | `AVAUSD_otc` | crypto | `isOtc` was missing |
| 53 | `AXSUSD_otc` | crypto | `isOtc` was missing |
| 54 | `BCHUSD_otc` | crypto | `isOtc` was missing |
| 55 | `BNBUSD_otc` | crypto | `isOtc` was missing |
| 56 | `BONUSD_otc` | crypto | `isOtc` was missing |
| 57 | `BTCUSD_otc` | crypto | `isOtc` was missing |
| 58 | `DOGUSD_otc` | crypto | `isOtc` was missing |
| 59 | `ETHUSD_otc` | crypto | `isOtc` was missing |
| 60 | `FLOUSD_otc` | crypto | `isOtc` was missing |
| 61 | `XRPUSD_otc` | crypto | `isOtc` was missing |
| 62 | `SOLUSD_otc` | crypto | `isOtc` was missing |
| 63 | `LTCUSD_otc` | crypto | `isOtc` was missing |
| 64 | `TRXUSD_otc` | crypto | `isOtc` was missing |
| 65 | `SHIBUSD_otc` | crypto | `isOtc` was missing |
| 66 | `MATICUSD_otc` | crypto | `isOtc` was missing |
| 67 | `DOTUSD_otc` | crypto | `isOtc` was missing |
| 68 | `LINKUSD_otc` | crypto | `isOtc` was missing |
| 69 | `XLMUSD_otc` | crypto | `isOtc` was missing |
| 70 | `DOGEUSD_otc` | crypto | `isOtc` was missing |
| 71 | `DASHUSD_otc` | crypto | `isOtc` was missing |
| 72 | `ETCUSD_otc` | crypto | `isOtc` was missing |
| 73 | `NEARUSD_otc` | crypto | `isOtc` was missing |
| 74 | `SUIUSD_otc` | crypto | `isOtc` was missing |
| 75 | `TIAUSD_otc` | crypto | `isOtc` was missing |
| 76 | `XAUUSD_otc` | commodity | `isOtc` was missing |
| 77 | `XAGUSD_otc` | commodity | `isOtc` was missing |
| 78 | `UKBrent_otc` | commodity | `isOtc` was missing |
| 79 | `USCrude_otc` | commodity | `isOtc` was missing |
| 80 | `XNGUSD_otc` | commodity | `isOtc` was missing |
| 81 | `XPTUSD_otc` | commodity | `isOtc` was missing |
| 82 | `XPDUSD_otc` | commodity | `isOtc` was missing |
| 83 | `COPPER_otc` | commodity | `isOtc` was missing |
| 84 | `AAPL_otc` | stock | `isOtc` was missing |
| 85 | `AMZN_otc` | stock | `isOtc` was missing |
| 86 | `AXP_otc` | stock | `isOtc` was missing |
| 87 | `BA_otc` | stock | `isOtc` was missing |
| 88 | `CSCO_otc` | stock | `isOtc` was missing |
| 89 | `DIS_otc` | stock | `isOtc` was missing |
| 90 | `FB_otc` | stock | `isOtc` was missing |
| 91 | `GOOGL_otc` | stock | `isOtc` was missing |
| 92 | `INTC_otc` | stock | `isOtc` was missing |
| 93 | `JNJ_otc` | stock | `isOtc` was missing |
| 94 | `JPM_otc` | stock | `isOtc` was missing |
| 95 | `KO_otc` | stock | `isOtc` was missing |
| 96 | `MCD_otc` | stock | `isOtc` was missing |
| 97 | `MSFT_otc` | stock | `isOtc` was missing |
| 98 | `NFLX_otc` | stock | `isOtc` was missing |
| 99 | `NVDA_otc` | stock | `isOtc` was missing |
| 100 | `PFE_otc` | stock | `isOtc` was missing |

## Acceptance criteria

1. At least 100 static `_otc` markets exist and every one reports `isOtc: true`.
2. Every OTC stock reports session `OTC 24/7`.
3. Runtime-created OTC instruments carry canonical venue and session metadata.
4. A broker refresh cannot clear OTC identity from a suffix-based static instrument.
5. `byKind("otc")` and worker/backtest selection continue to use the corrected venue metadata.
