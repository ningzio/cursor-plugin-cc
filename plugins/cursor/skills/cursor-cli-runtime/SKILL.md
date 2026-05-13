---
name: cursor-cli-runtime
description: Internal helper contract for calling cursor-companion runtime from Claude Code
user-invocable: false
---

# Cursor Runtime

Use this skill from the `cursor:cursor-dispatch` subagent (Claude Code) or directly from an upstream agent that needs to dispatch work to cursor-agent (e.g. Codex invoking the cursor companion).

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" dispatch [flags] <prompt>`

## Upstream prompt construction — pack each dispatch (auto mode)

**This section is for the upstream caller building the prompt**, not for this skill's runtime. Read it before deciding what to send to `dispatch`.

Cursor's `auto` model (the default for this plugin) is billed **per request, not per token**. A 4-million-token dispatch costs the same as a 40-thousand-token dispatch — both are 1 request. To get the most out of each call, the upstream agent should pack every `/cursor:dispatch` with a complete, self-contained spec:

- **Scope** — which files / directories may be touched, and which must not be.
- **Acceptance criteria** — what counts as done. Specific tests that must pass, invariants that must hold, observable behaviors to verify.
- **Regression checks** — adjacent files/features to spot-check so the change doesn't silently break them.
- **Self-validation** — ask cursor to run `npm test` / `npm run lint` / the relevant build, and report results in its final answer.

**Anti-pattern:** splitting one feature into 3–4 thin dispatches ("first rename X", then "now update callers", then "now add tests"). Each thin call costs 1 request. Bundle into one dispatch with a checklist — same cost, better coherence.

**Exception:** when the caller explicitly sets `--model <id>` (not `auto`), billing falls back to token-based. In that case, keep prompts lean and avoid padding.

This skill does NOT rewrite or enrich the prompt — it forwards verbatim. The packing responsibility is the upstream caller's.

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
