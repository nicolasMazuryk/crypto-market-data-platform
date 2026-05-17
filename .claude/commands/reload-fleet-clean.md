---
description: Clean runtime fleet data, deploy latest main, restart the 30 execution containers, and verify health without touching ClickHouse or sync timers.
allowed-tools: Bash, Read, Grep, Glob
---

Use the repo-local Claude skill at `.claude/skills/reload-fleet-clean/SKILL.md`.

Run the clean fleet reload end-to-end with:

```bash
bash .claude/skills/reload-fleet-clean/scripts/reload-fleet-clean.sh --yes $ARGUMENTS
```

Follow the skill's completion-evidence requirements before reporting success. If the script stops on a guardrail, report the exact guardrail and do not improvise a partial cleanup unless the user explicitly approves the adjusted scope.
