# Checklist Index — Execution Engine

42 per-(exchange, strategy) scenario checklists + cross-cutting meta files.

All checklists use status `⏳` until live validation completes.

---

## Legend

| Symbol | Meaning              |
| ------ | -------------------- |
| ⏳     | Pending verification |
| ✅     | Verified live        |
| ❌     | Failed / blocked     |

---

## Checklist Matrix

| Exchange | Strategy                                            | Exit Policy                 | Entry       | Scenarios | Status |
| -------- | --------------------------------------------------- | --------------------------- | ----------- | --------- | ------ |
| binance  | [strategy_1](binance/strategy_1/checklist.md)       | timed                       | REST market | 19        | ⏳     |
| binance  | [strategy_1_ws](binance/strategy_1_ws/checklist.md) | funding_fee_event           | WS market   | ~10       | ⏳     |
| binance  | [strategy_2](binance/strategy_2/checklist.md)       | retracement+funding         | WS market   | ~11       | ⏳     |
| binance  | [strategy_3a](binance/strategy_3a/checklist.md)     | sl_tp_deadline (SHORT)      | REST market | ~11       | ⏳     |
| binance  | [strategy_4_1a](binance/strategy_4_1a/checklist.md) | sl_tp_deadline              | REST ladder | ~12       | ⏳     |
| binance  | [strategy_4_2a](binance/strategy_4_2a/checklist.md) | sl_tp_deadline              | REST limit  | ~10       | ⏳     |
| binance  | [strategy_6](binance/strategy_6/checklist.md)       | sl_tp_deadline_post_funding | WS market×2 | ~12       | ⏳     |
| okx      | [strategy_1](okx/strategy_1/checklist.md)           | timed                       | REST market | ~10       | ⏳     |
| okx      | [strategy_1_ws](okx/strategy_1_ws/checklist.md)     | funding_fee_event           | WS market   | ~10       | ⏳     |
| okx      | [strategy_2](okx/strategy_2/checklist.md)           | retracement+funding         | WS market   | ~11       | ⏳     |
| okx      | [strategy_3a](okx/strategy_3a/checklist.md)         | sl_tp_deadline (SHORT)      | REST market | ~11       | ⏳     |
| okx      | [strategy_4_1a](okx/strategy_4_1a/checklist.md)     | sl_tp_deadline              | REST ladder | ~12       | ⏳     |
| okx      | [strategy_4_2a](okx/strategy_4_2a/checklist.md)     | sl_tp_deadline              | REST limit  | ~10       | ⏳     |
| okx      | [strategy_6](okx/strategy_6/checklist.md)           | sl_tp_deadline_post_funding | WS market×2 | ~12       | ⏳     |
| gateio   | [strategy_1](gateio/strategy_1/checklist.md)        | timed                       | REST market | ~11       | ⏳     |
| gateio   | [strategy_1_ws](gateio/strategy_1_ws/checklist.md)  | funding_fee_event           | WS market   | ~10       | ⏳     |
| gateio   | [strategy_2](gateio/strategy_2/checklist.md)        | retracement+funding         | WS market   | ~12       | ⏳     |
| gateio   | [strategy_3a](gateio/strategy_3a/checklist.md)      | sl_tp_deadline (SHORT)      | REST market | ~12       | ⏳     |
| gateio   | [strategy_4_1a](gateio/strategy_4_1a/checklist.md)  | sl_tp_deadline              | REST ladder | ~13       | ⏳     |
| gateio   | [strategy_4_2a](gateio/strategy_4_2a/checklist.md)  | sl_tp_deadline              | REST limit  | ~11       | ⏳     |
| gateio   | [strategy_6](gateio/strategy_6/checklist.md)        | sl_tp_deadline_post_funding | WS market×2 | ~12       | ⏳     |
| kucoin   | [strategy_1](kucoin/strategy_1/checklist.md)        | timed                       | REST market | ~10       | ⏳     |
| kucoin   | [strategy_1_ws](kucoin/strategy_1_ws/checklist.md)  | funding_fee_event           | WS market   | ~10       | ⏳     |
| kucoin   | [strategy_2](kucoin/strategy_2/checklist.md)        | retracement+funding         | WS market   | ~11       | ⏳     |
| kucoin   | [strategy_3a](kucoin/strategy_3a/checklist.md)      | sl_tp_deadline (SHORT)      | REST market | ~10       | ⏳     |
| kucoin   | [strategy_4_1a](kucoin/strategy_4_1a/checklist.md)  | sl_tp_deadline              | REST ladder | ~12       | ⏳     |
| kucoin   | [strategy_4_2a](kucoin/strategy_4_2a/checklist.md)  | sl_tp_deadline              | REST limit  | ~11       | ⏳     |
| kucoin   | [strategy_6](kucoin/strategy_6/checklist.md)        | sl_tp_deadline_post_funding | WS market×2 | ~11       | ⏳     |
| bybit    | [strategy_1](bybit/strategy_1/checklist.md)         | timed                       | REST market | ~10       | ⏳     |
| bybit    | [strategy_1_ws](bybit/strategy_1_ws/checklist.md)   | funding_fee_event           | WS market   | ~10       | ⏳     |
| bybit    | [strategy_2](bybit/strategy_2/checklist.md)         | retracement+funding         | WS market   | ~11       | ⏳     |
| bybit    | [strategy_3a](bybit/strategy_3a/checklist.md)       | sl_tp_deadline (SHORT)      | REST market | ~11       | ⏳     |
| bybit    | [strategy_4_1a](bybit/strategy_4_1a/checklist.md)   | sl_tp_deadline              | REST ladder | ~12       | ⏳     |
| bybit    | [strategy_4_2a](bybit/strategy_4_2a/checklist.md)   | sl_tp_deadline              | REST limit  | ~10       | ⏳     |
| bybit    | [strategy_6](bybit/strategy_6/checklist.md)         | sl_tp_deadline_post_funding | WS market×2 | ~11       | ⏳     |
| bitget   | [strategy_1](bitget/strategy_1/checklist.md)        | timed                       | REST market | ~9        | ⏳     |
| bitget   | [strategy_1_ws](bitget/strategy_1_ws/checklist.md)  | funding_fee_event           | WS market   | ~9        | ⏳     |
| bitget   | [strategy_2](bitget/strategy_2/checklist.md)        | retracement+funding         | WS market   | ~10       | ⏳     |
| bitget   | [strategy_3a](bitget/strategy_3a/checklist.md)      | sl_tp_deadline (SHORT)      | REST market | ~10       | ⏳     |
| bitget   | [strategy_4_1a](bitget/strategy_4_1a/checklist.md)  | sl_tp_deadline              | REST ladder | ~11       | ⏳     |
| bitget   | [strategy_4_2a](bitget/strategy_4_2a/checklist.md)  | sl_tp_deadline              | REST limit  | ~10       | ⏳     |
| bitget   | [strategy_6](bitget/strategy_6/checklist.md)        | sl_tp_deadline_post_funding | WS market×2 | ~11       | ⏳     |

---

## Key Exchange-Specific Invariants

| Exchange    | Critical Quirk                                                                 | Affects                                                  |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------- |
| **okx**     | `canonicalize()` strips dashes from clientOrderId (UUID 36→32 chars)           | All strategies — both manager.ts:130 and recovery.ts:132 |
| **gateio**  | WS timestamps in **seconds** → adapter ×1000 required                          | All strategies — fill routing, funding gate tolerance    |
| **gateio**  | `cancelIgnoreCode: 'TEXT_DUPLICATED'`                                          | All cancel calls                                         |
| **gateio**  | Symbol normalization in recovery (BTC_USDT → BTCUSDT)                          | recovery.ts:302-305                                      |
| **kucoin**  | Market order WS fills lack `clientOrderId` → `pollForEntryFill` is **PRIMARY** | strategy_1_ws, strategy_2, strategy_3a, strategy_6       |
| **kucoin**  | Limit order WS fills DO echo `clientOrderId` → WS routing works                | strategy_4_1a, strategy_4_2a                             |
| **kucoin**  | `cancelIgnoreCode: 100004` (order not found = success)                         | All cancel calls                                         |
| **kucoin**  | Funding fee: `wallet.funding` WS channel                                       | strategy_1_ws, strategy_2, strategy_6                    |
| **bybit**   | WS timestamps in **microseconds** → adapter ÷1000 required                     | All strategies — all fill timestamps                     |
| **bitget**  | `clientOrderId` echoed for all fills → WS routing works                        | All strategies                                           |
| **binance** | Standard behavior — reference implementation                                   | All strategies                                           |

---

## Exit Policy Summary

| Exit Policy                                | Strategies              | Close Trigger                                                |
| ------------------------------------------ | ----------------------- | ------------------------------------------------------------ |
| `timed`                                    | strategy_1              | setTimeout at timeoutAt                                      |
| `funding_fee_event`                        | strategy_1_ws           | ws.funding_fee ±5s tolerance, fallback timeout               |
| `sl_tp_deadline_retracement_funding_event` | strategy_2              | retracement after funding gate, SL fill, or deadline         |
| `sl_tp_deadline`                           | strategy_3a, 4_1a, 4_2a | SL fill, TP fill, or deadline                                |
| `sl_tp_deadline_post_funding_event`        | strategy_6              | SL fill, TP fill, or deadline after funding event gates MAIN |

---

## Meta Files

| File                                    | Purpose                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| [\_cross_cutting.md](_cross_cutting.md) | Cross-cutting scenarios: TERMINAL guard, bus ordering, WAL drain, sweepReduceOnly |
| [\_index.md](_index.md)                 | This file                                                                         |

---

## Coverage Notes

- All 6 exchanges × 7 strategies = 42 checklists; coverage is complete.
- Bybit strategy_1_ws validation was blocked by API key conflict at time of writing; checklist exists but may need exchange-specific notes updated once deployed.
- All `status: ⏳` items require live funding-rate event observation to verify.
- Recovery scenarios marked `natural_occurrence: rare` require deliberate process-kill during active monitoring to verify.
