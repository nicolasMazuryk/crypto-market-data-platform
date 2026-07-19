# Traceability Matrix — requirement ↔ gap ↔ task

Maps every requirement to its verdict and the task(s) that close it. **Conforming requirements map to no task** (listed at the bottom for completeness). Requirement IDs and verdicts are defined in `gap-analysis.md`; task IDs in `implementation-plan.md`.

## Requirement → verdict → task

| REQ                                  | Spec anchor | Verdict              | Task(s)           | Reconciliation |
| ------------------------------------ | ----------- | -------------------- | ----------------- | -------------- |
| A1 event two-timestamp               | §2, §1.1    | Partial              | 11                | R1             |
| A2 empirical drop model              | §2.1-2.4    | Contradicts          | 11                | —              |
| A3 `T_drop` localization algo        | §3.1        | Contradicts          | 11                | —              |
| A4 3 localization keys               | §3.1        | Missing              | 11                | —              |
| A5 lookahead scope guard             | §3.2        | Missing              | 11                | —              |
| B1 latency injection                 | §4          | Missing              | 12                | —              |
| B2 market slippage                   | §4          | Contradicts          | 12                | —              |
| B4 stop gap-through                  | §4          | Missing              | 12                | R (§5.5.5)     |
| B5 reduce-only cap                   | §4          | Missing              | 12                | —              |
| B6 throttles/staggers                | §4          | Partial              | 12, 19            | —              |
| B7 lot/minCost feasibility           | §4          | Missing              | 12, 19            | —              |
| C1 accrual boundary                  | §5.1        | Partial/Contradicts  | 13                | —              |
| C3 credit-gated at `T_drop`          | §5.3        | Partial/Missing      | 17, 18            | —              |
| C5 same-candle rule 1 (SL exception) | §5.5.1      | Partial              | 14                | —              |
| C6 same-candle rule 2                | §5.5.2      | Partial              | 14, 17, 18        | —              |
| C8 same-candle rule 4                | §5.5.4      | Missing              | 14, 20            | —              |
| C9 gap-through                       | §5.5.5      | Missing              | 12                | —              |
| E1 kill-switch modes                 | §7.1        | Contradicts (naming) | 23                | —              |
| F3 submission stagger default        | §8          | Partial/Contradicts  | 22                | —              |
| F4 rate-limit reservation            | §8          | Missing              | 22                | —              |
| F6 REST funding poll coverage        | §8          | Partial              | 22                | —              |
| F7 S2 tracker ±5s upper bound        | §8          | Partial              | 22                | —              |
| F8 OKX deltas                        | §8          | Config-owned         | 5, 22             | R9             |
| G2 60s stale snapshot                | §9.2        | Contradicts          | 22                | —              |
| G3 S6 most-extreme sort              | §9.3        | Partial              | 22                | —              |
| G4 backtest selection replication    | §9          | Partial              | 15                | —              |
| H1 §10.2 bridge names/units          | §10.2       | Partial/Contradicts  | 5                 | R1, R9, R10    |
| H2 §11.1 bounds both loaders         | §11.1       | Missing/Contradicts  | 6                 | —              |
| H3 single canonical source           | §11.2.1     | **Missing**          | 5                 | —              |
| H5 unit_suspect_fraction guard       | §11.2.3     | **Missing**          | 7                 | R4             |
| H6 CI round-trip test                | §11.2.4     | Missing              | 8                 | —              |
| H7 wrong-unit/unknown-key error      | §11.2       | Missing              | 7                 | —              |
| H9 exit_offset >5                    | §11.1       | Contradicts          | 6                 | R2             |
| H10 deadline 10–3600                 | §11.1       | Contradicts          | 6                 | R3             |
| H11 S6 key + alias                   | §10.2       | Contradicts          | 9                 | R6             |
| H12 retracement cap (backtest)       | §11.1       | Partial              | 6                 | —              |
| I1 exit_reason enum                  | §12.1       | Contradicts (both)   | 10                | R12            |
| I2 error_code enum (backtest)        | §12.2       | Missing              | 10, 19, 20        | R5             |
| I3 output vars                       | §10.3       | Partial              | 15                | —              |
| L1 conservatisms active              | §14         | Contradicts          | 11,12,17,18,19,20 | R7             |
| L2 conservatism reporting            | §14         | Missing              | 15                | —              |
| S1 backtest exit re-key              | 01\_ §6.3   | Contradicts          | 16                | R2             |
| S1-WS backtest                       | 02\_ §6     | Missing              | 17                | —              |
| S2 backtest tracker                  | 03\_        | Partial              | 18                | R8             |
| S3a backtest cost realism            | 04\_        | Partial              | 12, 21            | —              |
| S4.1a R11 lifecycle                  | 05\_        | Contradicts (both)   | 19                | R7, R11        |
| S4.2a R11 + limit_expired            | 06\_        | Partial/Contradicts  | 20                | R5, R7, R11    |
| S4.2a slMult>limitOffset guard       | 06\_ §5     | Missing              | 6                 | —              |
| S6 TP/SL settled-rate nuance         | 07\_ §2     | Conforms (nuance)    | 24 (opt)          | —              |
| S6 validation protocol               | 07\_ §6.2   | Missing              | 24                | —              |
| M spec-less removal                  | §Inventory  | —                    | 01, 02, 03, 04    | —              |

## Reconciliation index → task (R1–R12, §13)

| ID  | Delta                                   | Task(s) |
| --- | --------------------------------------- | ------- |
| R1  | `T_settle`/`T_drop`, signed-percent F   | 05, 11  |
| R2  | S1 exit offset >5, not re-keyed         | 06, 16  |
| R3  | deadline 10–3600                        | 06      |
| R4  | takeProfitPct unit guard                | 07      |
| R5  | `limit_expired` normative               | 10, 20  |
| R6  | S6 threshold key + alias                | 09      |
| R7  | 4.\* `FUNDING_PNL=0`                    | 19, 20  |
| R8  | S2 trailing tracker normative           | 18      |
| R9  | timeout values consolidated / OKX delta | 05, 22  |
| R10 | Group-L threshold −0.4 default          | 05      |
| R11 | 4.1a/4.2a SL placed with ladder/limit   | 19, 20  |
| R12 | exit-reason full registry               | 10      |

## Task → requirements closed (reverse index)

| Task | Closes                                |
| ---- | ------------------------------------- |
| 01   | M (4_1b, 4_2b, 4_3b, spot_futures)    |
| 02   | M (4_3a)                              |
| 03   | M (3b)                                |
| 04   | M (5)                                 |
| 05   | H1, H3, R1, R9, R10, OQ-7             |
| 06   | H2, H9, H10, H12, S4.2a-guard, R2, R3 |
| 07   | H5, H7, R4                            |
| 08   | H6                                    |
| 09   | H11, R6                               |
| 10   | I1, I2, R5, R12                       |
| 11   | A1–A5, L1, R1                         |
| 12   | B1, B2, B4, B5, B6, B7, C9, L1, S3a   |
| 13   | C1, OQ-4                              |
| 14   | C5, C6, C8                            |
| 15   | G4, I3, L2, OQ-5                      |
| 16   | S1 backtest, R2                       |
| 17   | S1-WS, C3, C6                         |
| 18   | S2 backtest, C3, C6, R8               |
| 19   | S4.1a, B6, B7, I2, L1, R7, R11        |
| 20   | S4.2a, C8, I2, L1, R5, R7, R11        |
| 21   | S3a confirm                           |
| 22   | F3, F4, F6, F7, F8, G2, G3, R9        |
| 23   | E1, OQ-3                              |
| 24   | S6 validation, S6 nuance              |

## Conforming requirements (no task)

C2 (settled-rate proxy), C7 (SL-first), B3 (limit trade-through), D1–D4 (sizing/leverage/fees/enabled), E2–E3 (sweep/orphan), F1–F2 (WS-mandatory/OKX fallback), F5 (fill-poll), G1 (0.1pp filter), H8 (co-run guard), I2-live (error_code live), S1-live, S2-live, S3a-live, S6-live (state machine), S6 backtest exclusion (registry throws).
