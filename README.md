# cursor-plugin-cc

A Claude Code and Codex plugin that dispatches tasks to the [cursor-agent CLI](https://docs.cursor.com/cli). Foreground or background, with full job control (status / result / cancel / cleanup) and safe boundaries between agent sessions. By default cursor edits your cwd directly; `--isolated` opts into a sandbox git worktree.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-blue.svg)](https://nodejs.org/)

[中文文档 →](./README.zh-CN.md)

> **v0.3 breaking change.** The default execution mode flipped from *isolated worktree* to *in-place*. Cursor now edits your cwd and commits land on your current branch — no cherry-pick needed. To keep the old behaviour, pass `--isolated` (or just `--background`, which still defaults to isolated). See [CHANGELOG.md](./CHANGELOG.md) for the migration note.

---

## What this is

When Claude Code or Codex is doing a task and you want to spin up a parallel agent — a second pair of eyes, a long-running migration, an independent implementation pass — you can hand it off to cursor-agent. This plugin gives your coding agent six slash commands to do that safely:

- `/cursor:setup` — verify cursor-agent is installed and logged in
- `/cursor:dispatch <prompt>` — send a task to cursor-agent in your cwd (or an isolated sandbox)
- `/cursor:status` — list jobs in the current agent session
- `/cursor:result [jobId]` — fetch the result of the latest (or a specific) job
- `/cursor:cancel [jobId]` — cancel a running job
- `/cursor:cleanup [jobId|--all-finished]` — remove sandbox worktrees left behind by isolated jobs

The plugin handles optional git worktree creation, auto-commits (isolated mode only), and persists job state across slash command invocations.

## Background / autonomous use — allow companion in settings.json

If another agent will be driving `/cursor:dispatch` in a background or autonomous session (no human at the keyboard to approve permission prompts), allowlist the companion runtime once:

```json
{
  "permissions": {
    "allow": ["Bash(node ${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs *)"]
  }
}
```

The `${CLAUDE_PLUGIN_ROOT}` path is injected by the plugin host and stays stable across upgrades. Without this, the permission classifier may block `node …/cursor-companion.mjs …` in background sessions and the dispatch will appear to hang or refuse with no human-readable cause.

## Why not just shell out to cursor-agent?

A naïve wrapper would be ~150 lines. This plugin is bigger because it solves four real problems that bite you the moment you go past `--wait` mode:

1. **Background dispatch with job control.** Once `/cursor:status` and `/cursor:result` need to work across separate Claude turns, the plugin must persist state to disk. That means atomic writes, file locks, and a deduplicated job record.
2. **Concurrency safety.** Two `/cursor:dispatch` calls racing each other must not clobber each other's job records. The plugin uses an explicit reservation step inside a state lock.
3. **PID safety.** Cancellation needs to signal the right process. Earlier versions of this code accidentally sent `SIGTERM` to PID `-1` once and logged the user out. The plugin now rejects unsafe pids and does a liveness check before signalling.
4. **Session boundary.** If you have two agent sessions open, `/cursor:status` must only show *your* jobs. A SessionStart hook stamps the current session id into the environment so the companion can filter.

If you don't need any of those, you don't need this plugin — `cursor-agent` directly works fine.

## Prerequisites

- **Claude Code** or **Codex**
- **cursor-agent CLI** — install per [cursor docs](https://docs.cursor.com/cli) and log in (`agent login`)
- **Node.js ≥ 18.18** — only used by the plugin's companion runtime; nothing to install separately
- **Git** — `git worktree` is used heavily

Run `/cursor:setup` after installation to verify the agent binary is found and logged in.

## Installation

### Codex

This repo ships a Codex plugin root at [`plugins/cursor`](./plugins/cursor), with a manifest at [`plugins/cursor/.codex-plugin/plugin.json`](./plugins/cursor/.codex-plugin/plugin.json) and a Codex marketplace catalog at [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json).

Register the marketplace from Codex:

```bash
codex plugin marketplace add ningzio/cursor-plugin-cc
```

Then install the `cursor` plugin from the Codex plugin UI. After installation, start a new Codex session so the SessionStart hook is registered.

To update the registered marketplace later:

```bash
codex plugin marketplace upgrade cursor-plugin-cc
```

If you added this marketplace before `v0.2.2`, run the upgrade command above and restart Codex before searching the plugin UI.

For local development, register a local checkout instead:

```bash
git clone https://github.com/ningzio/cursor-plugin-cc.git
codex plugin marketplace add ./cursor-plugin-cc
```

### Claude Code

The repo ships its own [`marketplace.json`](./.claude-plugin/marketplace.json), so Claude Code can install it directly from GitHub. Inside any Claude Code session run:

```
/plugin marketplace add ningzio/cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc
```

The first command registers the GitHub repo as a marketplace; the second installs the `cursor` plugin from it. After installation, **restart your Claude Code session** so the SessionStart hook is registered.

To update later:

```
/plugin marketplace update cursor-plugin-cc
/plugin install cursor@cursor-plugin-cc      # picks up the new version
```

#### Manual install (path-based)

If you want to hack on it locally without going through the marketplace flow:

```bash
git clone https://github.com/ningzio/cursor-plugin-cc.git ~/.claude/plugins/cursor-plugin-cc
```

Then point Claude Code at the path via your `~/.claude/settings.json`. (The marketplace install is recommended for normal use.)

## Quick start

```text
> /cursor:setup
agent binary: /Users/you/.local/bin/agent
version     : 2026.04.28-e984b46
logged in   : yes
account     : you@example.com

> /cursor:dispatch --background "Refactor the order-processing pipeline to use a state machine"
Dispatched cur-8a0de9e1 in the background.
  cursor session : (pending)
  worktree       : /your/repo/.cursor/worktrees/cur-8a0de9e1
  branch         : cur-8a0de9e1

> /cursor:status
✅ cur-8a0de9e1  completed   Refactor the order-processing pipeline...

> /cursor:result
Job: cur-8a0de9e1  status=completed  cursor=3209a7f0-...
branch: cur-8a0de9e1  head=abc1234
worktree: /your/repo/.cursor/worktrees/cur-8a0de9e1

[cursor's full reply text]
```

## Slash command reference

### `/cursor:dispatch`

```
/cursor:dispatch [--wait | --background]
                 [--isolated | --in-place]
                 [--resume <jobId> | --fresh]
                 [--model <model>]
                 [--mode plan | ask | agent]
                 [--plan-only]
                 [--worktree-base <ref>]
                 [--include-dirty]
                 <prompt>
```

| Flag | What it does |
|---|---|
| `--wait` (default for tiny prompts) | Block until cursor finishes; print result inline |
| `--background` | Detach immediately; check progress with `/cursor:status` |
| `--isolated` | Run in a `.cursor/worktrees/<jobId>/` sandbox on a `<jobId>` branch; auto-commit on success. Default for `--background` |
| `--in-place` | Run in the caller's cwd, no worktree, no auto-commit. Default for `--wait` / interactive dispatch. Pass alongside `--background` to override the default. |
| `--resume <jobId>` | Continue an existing cursor thread. Mode is locked to the original job's mode (isolated stays isolated, in-place stays in-place). |
| `--fresh` | Start a new dispatch even if a previous job is reusable |
| `--model <model>` | Pass a model name to cursor-agent (e.g. `--model claude-4.5-sonnet`). When omitted on a fresh dispatch, the slash command silently appends `--model auto` so cursor's per-request router picks. Run `cursor-agent --list-models` (or `cursor-agent models`) to see currently available IDs — cursor's lineup changes over time. `--resume <jobId>` keeps the thread's existing model. |
| `--mode <plan\|ask\|agent>` | Pick the cursor execution mode. `plan` = read-only/planning. `ask` = read-only Q&A. `agent` = default (may edit). Read-only modes drop `--force` and skip the auto-commit. |
| `--plan-only` | Back-compat alias for `--mode plan` |
| `--worktree-base <ref>` | Branch the sandbox worktree off a specific ref instead of HEAD. Only valid with `--isolated`. |
| `--include-dirty` | Acknowledge dirty-cwd risk and proceed. Required by `--background --in-place` when the cwd has uncommitted changes. |

When the user does not specify a mode, the slash command picks one based on the request shape and confirms once with a three-option chooser (Ask only / Plan only / Agent).

When `<prompt>` contains shell metacharacters (`$`, backticks, `;`), they're never re-evaluated by sh — the slash command pipes the raw prompt to the companion over stdin via a heredoc, and the companion tokenises it inside Node.

### Refusal output

If dispatch (or any companion subcommand) declines for policy reasons, the first line of stderr is `REFUSED: <CODE>` (e.g. `REFUSED: EINPLACEDIRTY`), followed by a `Reason:` line and a `Caller next steps:` list. The output is designed for both humans and agent callers — grep `^REFUSED:` to detect a policy refusal programmatically, and read the steps to know which flag to add/drop. Exit code is `2` for policy refusals.

### `/cursor:status [--all] [--json]`

Lists jobs in the current agent session. `--all` shows jobs from every session.

### `/cursor:result [jobId] [--json]`

Without `jobId`, returns the latest *completed* job from the current session. With `jobId`, returns that specific job (regardless of session).

### `/cursor:cancel [jobId] [--json]`

Cancels a running or queued job. Without `jobId`, picks the newest cancellable job in the current session. Sends SIGTERM to the cursor agent process first, then to the Node wrapper. For isolated jobs, the sandbox worktree is auto-removed (the cancel happened mid-flight so nothing was committed). In-place jobs leave the cwd untouched.

### `/cursor:cleanup [jobId | --all-finished] [--apply] [--json]`

Remove `.cursor/worktrees/<jobId>` sandbox directories for terminal isolated jobs. **Dry-run by default**: prints what would be removed without touching the disk. Pass `--apply` to actually delete. In-place jobs have no sandbox and are listed as skipped. Useful after a series of `--isolated` dispatches whose commits have already been cherry-picked or rejected.

## Cost model — pack each dispatch (auto mode)

When `--model auto` is in effect (the default for fresh dispatches), cursor bills **per request, not per token**. A single dispatch consuming 4M tokens and one consuming 40K tokens both cost 1 request — so splitting work across many thin dispatches is strictly more expensive than bundling it into one fat dispatch with the same total work.

This matters because the natural agent reflex — "I'll send a quick rename now, then a follow-up to update callers, then another to add tests" — turns one feature into three to four requests. The same work shipped as a single packed dispatch with a self-contained spec costs one request.

To get the most out of each call, pack `/cursor:dispatch` with:

- **Scope** — which files / directories are in-bounds, and which must not be touched.
- **Acceptance criteria** — specific tests that must pass, invariants that must hold, observable behaviors to verify.
- **Regression checks** — adjacent features to spot-check so the change doesn't silently break them.
- **Self-validation** — ask cursor to run `npm test` / `npm run lint` / the relevant build and include results in its final answer.

**Exception:** when the caller explicitly passes `--model <id>` (not `auto`), billing falls back to token-based. In that case, keep prompts lean and avoid padding.

This guidance is mirrored in [`skills/cursor-cli-runtime/SKILL.md`](./plugins/cursor/skills/cursor-cli-runtime/SKILL.md) and the [`cursor-dispatch` subagent](./plugins/cursor/agents/cursor-dispatch.md) so upstream agent callers (Claude Code main thread, Codex, other dispatching agents) see it before forwarding. The subagent itself never rewrites or enriches the prompt — the packing responsibility is the upstream caller's.

## How it works (briefly)

```
                    Agent session
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
  SessionStart hook    /cursor:dispatch    /cursor:status
  (stamps session id)  (heredoc | stdin)       ↓
        ↓                   ↓             cursor-companion.mjs
   $CURSOR_COMPANION_  cursor-dispatch    (loads state.json,
    SESSION_ID export   subagent          filters by session)
        ↓                   ↓
        └───────────────────┘
                            ↓
                   cursor-companion.mjs dispatch
                   1. resolve mode (in-place by default,
                      isolated for --background or --isolated)
                   2. reserve job in state.json (atomic)
                   3. ISOLATED: create git worktree
                      IN-PLACE: run in cwd directly
                   4. spawn cursor-agent
                   5. parse stream-json events
                   6. ISOLATED: auto-commit on success
                      IN-PLACE: leave commit decision to caller
                   7. update state.json
```

State lives at `$CLAUDE_PLUGIN_DATA/state/<repo-slug>-<hash>/`, scoped per-cwd so different projects don't share job records.

Worktrees go under `<repo>/.cursor/worktrees/<jobId>/` on a branch named `<jobId>`. The plugin adds `.cursor/worktrees/` to `.gitignore` (or `.git/info/exclude` if `.gitignore` is read-only) on first dispatch.

## Configuration (env vars)

Most users won't touch these.

| Variable | Set by | Purpose |
|---|---|---|
| `CURSOR_COMPANION_SESSION_ID` | SessionStart hook | Current agent session id; used to filter jobs |
| `CLAUDE_PLUGIN_DATA` | Plugin host | Per-plugin data directory |
| `CLAUDE_ENV_FILE` | Plugin host (during SessionStart) | Where the hook exports env vars to be sourced into the session |
| `CURSOR_COMPANION_AGENT_BINARY` | You (testing) | Override the cursor-agent binary path |
| `CURSOR_COMPANION_AGENT_BINARY_ARG0` | You (testing) | Force argv[0] when overriding the binary |

## Status

**Phase 1** — the slash commands above are stable and have 119 unit tests covering atomic state writes, dispatch reservation, PID safety, session filtering, dirty-worktree refusal, stream-json parsing, mode/--plan-only routing, and Codex manifest wiring.

Known limitations:

- `splitRawArgumentString` is intentionally a minimal tokenizer (whitespace + paired single/double quotes; no shell escapes). For prompts containing literal quote characters, wrap them in the opposite style.
- Jobs are pruned at 50 entries per state file (oldest first by `updatedAt`).
- The plugin assumes you're running inside a git repo. `/cursor:dispatch` exits non-zero outside one.

## Development

```bash
git clone https://github.com/ningzio/cursor-plugin-cc.git
cd cursor-plugin-cc
npm test  # runs tests/*.test.mjs via node:test (no dependencies)
```

The plugin has zero runtime dependencies — only Node's stdlib and the cursor-agent CLI.

Test categories:

- `state.test.mjs` — atomic writes, `withStateLock`, `reserveDispatchJob` conflict detection
- `companion-jobs.test.mjs` — status/result/cancel/resume-candidate verbs end-to-end via spawned subprocess
- `companion-dispatch.test.mjs` — full dispatch flow with a fake cursor agent fixture
- `worktree.test.mjs` — git worktree creation, finalize, cleanup, gitignore fallback
- `job-control.test.mjs` — `isSafePid` / `isPidLive` / `cancelJob`
- `cursor-cli.test.mjs` — stream-json event parsing
- `session-lifecycle-hook.test.mjs` — SessionStart / SessionEnd hook
- `args.test.mjs` — argument parser & raw-args tokenizer

## Acknowledgements

Originally developed inside a private project and extracted as a standalone plugin. Cross-reviewed by codex (gpt-5.4 high) and cursor-agent before each major commit.

## License

MIT — see [LICENSE](./LICENSE).
