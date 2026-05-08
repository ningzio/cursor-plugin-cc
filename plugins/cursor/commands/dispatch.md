---
description: Dispatch a task to cursor agent in an isolated git worktree
argument-hint: '[--wait|--background] [--resume <jobId>|--fresh] [--model <m>] [--mode plan|ask|agent] [--plan-only] [--worktree-base <ref>] <prompt>'
disable-model-invocation: true
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Forward the user request to the `cursor:cursor-dispatch` subagent. The subagent invokes `cursor-companion.mjs dispatch` once via the `--raw-args-file` channel (codex F2 — `$ARGUMENTS` may contain shell metacharacters; never interpolate it into a bash pipeline) and returns stdout verbatim.

Raw user request:
$ARGUMENTS

Routing rules:

- If the request contains `--wait`, run the subagent in foreground.
- If the request contains `--background`, run the subagent in background (`Agent({..., run_in_background: true})`).
- Otherwise, decide based on prompt size:
  - For tiny / clearly bounded tasks, recommend `--wait`.
  - For multi-step / open-ended / "this could take a while" tasks, recommend `--background`.
  - When in doubt, recommend `--background`.
  - Use `AskUserQuestion` exactly once with two options:
    - `Wait for results`
    - `Run in background`
  - Put the recommended option first and suffix its label with `(Recommended)`.

Mode routing (cursor-agent supports `plan`, `ask`, `agent`):

- If the request already contains `--mode <plan|ask|agent>` or `--plan-only`, do not ask — honor it.
- Otherwise infer from intent and ask the user once via `AskUserQuestion`:
  - Pure question / explanation / read-only inspection ("what does X do", "why is Y", "解释一下", "看看") → recommend `Ask only (read-only Q&A)` first.
  - Wants a written plan or design before any edit ("draft a plan", "先出个方案", "怎么改") → recommend `Plan only (no edits)` first.
  - Wants the agent to actually do the work ("fix", "implement", "改一下", "动手") → recommend `Agent (default, may edit)` first.
  - When in doubt, recommend `Agent (default, may edit)` first.
- Three options total; never offer more.
- On `Ask only`, append `--mode ask` to the forwarded text.
- On `Plan only`, append `--mode plan`.
- On `Agent`, append nothing (default).

Resume routing:

- If the request contains `--resume` or `--fresh`, do not ask.
- Otherwise, run:
  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" dispatch-resume-candidate --json
  ```
  - If `available: true`, ask the user (`AskUserQuestion`) whether to continue the previous cursor thread or start a new one.
  - Choices:
    - `Continue current cursor thread`
    - `Start a new dispatch`
  - If the user's request reads like a follow-up ("再", "继续", "调整一下", "基础上", "another pass"), put `Continue current cursor thread (Recommended)` first.
  - Otherwise put `Start a new dispatch (Recommended)` first.
  - On `Continue`, append `--resume <returned-jobId>` to the forwarded text.
  - On `Start a new dispatch`, append `--fresh`.

Forwarding (codex F2 — write the full forwarded text to a tempfile in this turn, never inline it):

```bash
TMP=$(mktemp -t cursor-args.XXXXXXXX)
cat >"$TMP" <<'__CURSOR_RAW_ARGS_END_a8f3c91d4b__'
<the full forwarded request, including any --resume/--fresh/--wait/--background you appended>
__CURSOR_RAW_ARGS_END_a8f3c91d4b__
```

Then `Agent({ subagent_type: "cursor:cursor-dispatch", prompt: "Run cursor-companion.mjs dispatch --raw-args-file " + $TMP })` (or pass `$TMP` to the subagent through the prompt). The subagent will execute exactly one `node cursor-companion.mjs dispatch --raw-args-file <path>` call.

- Return the subagent's stdout verbatim.
- Do not paraphrase, summarize, fix issues, or do any follow-up work in the main thread.
