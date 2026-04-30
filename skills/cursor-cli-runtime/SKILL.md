---
name: cursor-cli-runtime
description: Internal helper contract for calling cursor-companion runtime from Claude Code
user-invocable: false
---

# Cursor Runtime

Use this skill only inside the `cursor:cursor-dispatch` subagent.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" dispatch [flags] <prompt>`

Execution rules:

- The dispatch subagent is a forwarder, not an orchestrator. Its only job is to invoke `dispatch` once and return that stdout unchanged.
- Do not call `setup`, `status`, `result`, `cancel`, or `dispatch-resume-candidate` from this subagent. The main thread handles them.
- Strip nothing. Forward the user's text and flags verbatim.
- If the user provided neither `--wait` nor `--background`, default to whichever the main thread already chose (it asks the user upstream). If neither is set, default to `--background` for safety.
- If the helper output indicates `agent` is missing or unauthenticated, return that text verbatim. The user will run `/cursor:setup`.
- Default mode for `dispatch` is write-capable (cursor runs in an isolated worktree). Add `--plan-only` only if the user explicitly asks for a read-only plan.

Safety rules:

- Do not inspect the repository, read files, monitor progress, or summarize.
- Return the stdout of the `dispatch` command exactly as-is.
- If the Bash call fails, return its stderr verbatim. Do not retry.
