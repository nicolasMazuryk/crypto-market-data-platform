# `framework/specs/` — Gap analysis & implementation plan

This directory aligns the codebase with the re-specified funding-rate strategies in
`docs-strategy/strategies/**` (the authoritative spec set: `00_globals.md` + 7 strategy files).
It is **analysis + an ordered task plan only** — no code was changed producing it.

## What's here

| File                     | Purpose                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`              | This index + reading order.                                                                                                                                         |
| `gap-analysis.md`        | Per-requirement verdict table (Conforms/Partial/Missing/Contradicts) with `path:line` citations and an **OPEN QUESTIONS** section. Conforming rows produce no task. |
| `implementation-plan.md` | The ordered task index (`NN`, title, goal, deps, priority, parity impact) + critical path.                                                                          |
| `traceability-matrix.md` | requirement ↔ gap ↔ task, plus the R1–R12 reconciliation → task map.                                                                                                |
| `tasks/NN-<slug>.md`     | One self-contained, dependency-ordered implementation task per file, sized for a single ~80k-token agent window.                                                    |

## Reading order

1. **`gap-analysis.md`** — understand what diverged and why it matters (start with the summary scoreboard and the OPEN QUESTIONS).
2. **`implementation-plan.md`** — see the sequenced tasks and the critical path.
3. **`traceability-matrix.md`** — cross-check coverage (every non-conforming requirement → ≥1 task).
4. **`tasks/`** — pick the next unblocked task and execute it in order.

## The one fact that shapes everything

The **backtest** (`src/backtesting/**`) and **live** (`src/execution/**`) engines are two independent implementations with **no shared code and no shared canonical schema**, contradicting globals §11.2.1. Parity is held only by this spec, so **backtest↔live parity is the central risk surface**. Findings in one sentence:

- **Live engine:** broadly conformant. Main breaks: S4.1a ladder implements the pre-R11 lifecycle (structurally can't catch the drop), `exit_reason` enum names differ from §12.1, S6 threshold key is the legacy `funding_threshold` (R6), and several per-exchange guards drift (stagger, 60s stale, S6 sort).
- **Backtest engine:** systematically **optimistic** — no injected latency, no market slippage, a naïve `T_drop` detector (not §3.1) whose fallback is anti-conservative, the lookahead guard is dead code, 4.\* strategies book funding (R7 violation), S4.1a/4.2a place protective orders after fills (R11 violation), the terminal-state enum is the pre-R12 vocabulary, and **S1-WS does not exist**.
- **Config:** no canonical source; live zod is nearly bound-free; no `unit_suspect_fraction` guard (a live YAML carries `takeProfitPct: 0.003`); some live YAMLs are written in the wrong schema shape and parse to a zero-strategy engine.

## Execution rules for the downstream agent

- Execute tasks in ascending `NN` order; **respect `Deps`** — no task depends on a higher number.
- Do **Phase 1 removals first** (shrink the surface), then the **canonical schema (Task 05)** which everything config-shaped asserts against, then the **backtest core (Tasks 11–12)** which gates all backtest strategy work.
- **Parity discipline:** for a `both` task, change backtest and live together and add/extend the round-trip or a parity assertion; never fix one side and leave the other on the old behavior.
- Each task states its own verification (a unit test to add/extend, or a concrete manual/replay check). Add it; don't hand-wave.
- If a task is blocked by an **OPEN QUESTION** (see `gap-analysis.md`), resolve the question first — several tasks (11, 17, 20, 22, 23) are qualified or blocked by one.

## Acceptance self-check (this deliverable)

- Every `docs-strategy/strategies/**` file was read and is represented in the requirement inventory (`gap-analysis.md` §A–§M + R1–R12).
- Every requirement has a verdict backed by `path:line` (or "absent").
- Every non-conforming requirement maps to ≥1 task (`traceability-matrix.md`); conforming ones map to none.
- Tasks are totally ordered, no forward deps, parity-safe.
- OPEN QUESTIONS capture every ambiguity with spec + code location and a proposed resolution; blocked tasks reference them.
