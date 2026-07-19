Execute framework/specs task NN = 1.

You are implementing ONE task from an ordered gap-analysis plan that aligns this codebase with the authoritative strategy specs. Work only on task NN; do not scope-creep into other tasks.

## Read first (in this order)

1. framework/specs/tasks/NN-\*.md — YOUR TASK. Goal, files to read/edit, the change, and the exact Verification method. This is the contract.
2. framework/specs/implementation-plan.md — find task NN's row: confirm its **Deps** and **Parity** tag.
3. framework/specs/gap-analysis.md — read the rows this task "Closes" (listed in the task header) for the full defect context + `path:line` citations, and any OPEN QUESTION (OQ-N) the task references.
4. The spec anchors the task cites, e.g. docs-strategy/strategies/00*globals.md §<section> and docs-strategy/strategies/0N*\*.md — the spec is authoritative; when code and spec disagree, spec wins.
5. Skim .claude/CLAUDE.md and .claude/agent-workflow.md for repo conventions.

## Before writing code

- Verify every **Dep** of task NN is already merged/done. If a dep is unmet, STOP and report which — do not implement out of order.
- If the task references an OPEN QUESTION that is unresolved, STOP and surface it with your proposed resolution; do not guess.
- Open each file the task lists under "Files to read"/"Files to edit" and confirm the cited `path:line` still matches (line numbers may have drifted — re-locate by symbol, not line).

## Implement

- Make the change exactly as the task's "The change" section specifies. Match surrounding code style.
- **Parity discipline:** if the Parity tag is `both`, change backtest AND live together and keep them numerically identical; never fix one engine and leave the other on old behavior. If `cfg`, keep the two schemas in sync via the canonical source (task 05).
- Store both `symbol` (normalized) and `exchange_symbol` where relevant; keep unit conventions exact (percent vs fraction — see globals §1.2).

## Verify (do the task's own Verification method — do not skip)

1. Add/extend the unit test the task names, asserting the spec'd behavior. If the task gives a manual/replay check instead, run it and paste the observed output.
2. Run: `npm test` (or the targeted test file), `npm run typecheck` — both must pass. For lint, scope to the files you changed: `npx eslint <changed files>` (the repo-wide `npm run lint` baseline has ~292 preexisting errors unrelated to your task; do not treat those as regressions). Introduce no NEW lint errors on files you touch.
3. For runtime-behavior changes, exercise the affected flow end-to-end (invoke /verify if available), not just tests.
4. Re-read the task's acceptance bullets and confirm each is met.

## Report back

- What changed (files + one-line why each).
- The verification you ran and its result (test names + pass/fail, lint/build status, any replay output).
- Any citation drift you corrected, any spec ambiguity you hit, and whether an OPEN QUESTION needs the human before the next task.
- Do NOT commit or open a PR unless explicitly asked.
