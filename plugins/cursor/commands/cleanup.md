---
description: Remove isolated sandbox worktrees for terminal cursor jobs (no-op for in-place jobs)
argument-hint: '[jobId | --all-finished] [--apply] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

Forward to `cursor-companion.mjs cleanup`. Dry-run by default — `--apply` actually removes the worktree directories and branches. In-place jobs have no sandbox and are skipped.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" cleanup $ARGUMENTS
```

Return stdout verbatim. If stderr starts with `REFUSED:`, return it too; the refusal message tells you what to fix.
