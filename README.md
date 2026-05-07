# cursor-plugin-cc

A Claude Code and Codex plugin that dispatches tasks to the [cursor-agent CLI](https://docs.cursor.com/cli) and runs them in isolated git worktrees. Foreground or background, with full job control (status / result / cancel) and safe boundaries between agent sessions.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18.18-blue.svg)](https://nodejs.org/)

[中文文档 →](./README.zh-CN.md)

---

## What this is

When Claude Code or Codex is doing a task and you want to spin up a parallel agent — a second pair of eyes, a long-running migration, an independent implementation pass — you can hand it off to cursor-agent. This plugin gives your coding agent five slash commands to do that safely:

- `/cursor:setup` — verify cursor-agent is installed and logged in
- `/cursor:dispatch <prompt>` — send a task to cursor-agent in a fresh git worktree (foreground or background)
- `/cursor:status` — list jobs in the current agent session
- `/cursor:result [jobId]` — fetch the result of the latest (or a specific) job
- `/cursor:cancel [jobId]` — cancel a running job

The plugin handles git worktree creation, auto-commits cursor's changes back to a per-job branch, and persists job state across slash command invocations.

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

This repo ships a Codex plugin manifest at [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) and a Codex marketplace catalog at [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json).

Register the marketplace from Codex:

```bash
codex plugin marketplace add ningzio/cursor-plugin-cc
```

Then install the `cursor` plugin from the Codex plugin UI. After installation, start a new Codex session so the SessionStart hook is registered.

To update the registered marketplace later:

```bash
codex plugin marketplace upgrade cursor-plugin-cc
```

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
                 [--resume <jobId> | --fresh]
                 [--model <model>]
                 [--plan-only]
                 [--worktree-base <ref>]
                 <prompt>
```

| Flag | What it does |
|---|---|
| `--wait` (default for tiny prompts) | Block until cursor finishes; print result inline |
| `--background` | Detach immediately; check progress with `/cursor:status` |
| `--resume <jobId>` | Continue an existing cursor thread in the same worktree |
| `--fresh` | Start a new dispatch even if a previous job is reusable |
| `--model <model>` | Pass a model name to cursor-agent (e.g. `--model claude-4.5-sonnet`) |
| `--plan-only` | Tell cursor to plan only, not execute |
| `--worktree-base <ref>` | Branch the worktree off a specific ref instead of HEAD |

When `<prompt>` contains shell metacharacters (`$`, backticks, `;`), they're never re-evaluated by sh. The slash command writes the raw prompt to a tempfile and the companion tokenises it inside Node.

### `/cursor:status [--all] [--json]`

Lists jobs in the current agent session. `--all` shows jobs from every session.

### `/cursor:result [jobId] [--json]`

Without `jobId`, returns the latest *completed* job from the current session. With `jobId`, returns that specific job (regardless of session).

### `/cursor:cancel [jobId] [--json]`

Cancels a running or queued job. Without `jobId`, picks the newest cancellable job in the current session. Sends SIGTERM to the cursor agent process first, then to the Node wrapper.

## How it works (briefly)

```
                    Agent session
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
  SessionStart hook    /cursor:dispatch    /cursor:status
  (stamps session id)  (writes raw args        ↓
        ↓               to tempfile)      cursor-companion.mjs
   $CURSOR_COMPANION_         ↓           (loads state.json,
    SESSION_ID export    cursor-dispatch        filters by session)
        ↓                  subagent
        └──────────────────┐  ↓
                           ↓  ↓
                   cursor-companion.mjs dispatch
                   1. reserve job in state.json (atomic)
                   2. create git worktree
                   3. spawn cursor-agent
                   4. parse stream-json events
                   5. auto-commit on completion
                   6. update state.json
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

**Phase 1** — the slash commands above are stable and have 112 unit tests covering atomic state writes, dispatch reservation, PID safety, session filtering, dirty-worktree refusal, stream-json parsing, and Codex manifest wiring.

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
