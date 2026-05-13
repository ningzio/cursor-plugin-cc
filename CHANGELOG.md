# Changelog

All notable changes to this project are documented here.

This project follows semantic versioning where practical.

## [0.3.0] - 2026-05-13

### Changed — BREAKING

- **Default execution mode flipped from isolated worktree to in-place.** `/cursor:dispatch <prompt>` (with no mode flag) now runs cursor-agent in the caller's cwd; commits land directly on the current branch with no auto-commit, no `.cursor/worktrees/<jobId>` sandbox, and no cherry-pick needed. This matches the most common autonomous / pipeline usage where downstream tasks depend on upstream files. `--background` still defaults to `--isolated` (a background agent racing live cwd edits is a footgun); pass `--in-place` alongside `--background` to override.

  **Migration:** if you depended on the previous always-isolated behaviour, add `--isolated` (or, for read-only modes, nothing changes — `--mode plan` / `--mode ask` never touched the worktree anyway).

- `/cursor:dispatch` and its companion subagent now transport `$ARGUMENTS` over stdin via a heredoc (`--raw-args-stdin`) instead of writing a tempfile (`--raw-args-file`). No more `ENOENT` races when the permission classifier silently blocks `mktemp` / `Write` in autonomous sessions. The `--raw-args-file` path is retained for back-compat but is no longer recommended.

### Added

- `/cursor:dispatch --isolated` opts into the legacy `.cursor/worktrees/<jobId>` sandbox with auto-commit to a `<jobId>` branch. `--in-place` is the explicit form of the new default and is useful when overriding `--background`'s implicit `--isolated`.
- `/cursor:cleanup [jobId | --all-finished] [--apply] [--json]` removes sandbox worktrees for terminal isolated jobs. Dry-run by default. In-place jobs are listed as skipped (they have no sandbox).
- `/cursor:cancel` of an isolated job now auto-removes the sandbox worktree (the cancel happened mid-flight so nothing was committed). In-place jobs leave the cwd untouched.
- **Structured refusal output.** Every policy-driven refusal from `cursor-companion.mjs` (missing prompt, dirty cwd, mode mismatch on resume, in-place cwd already busy, etc.) emits `REFUSED: <CODE>` as the first line of stderr, followed by a `Reason:` line and a `Caller next steps:` list. Designed so the calling agent can parse and react programmatically. Exit code remains `2` for policy refusals.
- New refusal codes: `EMISSINGPROMPT`, `ENOTGITREPO`, `ERESUMENOTFOUND`, `ERESUMEUNUSABLE`, `ERESUMEMODEMISMATCH`, `EWORKTREEDIRTY`, `EINVALIDMODE`, `EJOBCONFLICT`, `EINPLACEDIRTY`, `EINPLACEBUSY`, `EFLAGCONFLICT`, `ENOSESSION`, `ENOMATCHINGJOB`, `ENOCANCELABLEJOB`, `EMISSINGTARGET`, `ERAWARGSSTDIN`, `ERAWARGSFILE`.
- `/cursor:setup` output now includes the recommended `permissions.allow` snippet for `~/.claude/settings.json` so background / autonomous Claude sessions can run the companion without interactive approval.
- README has a new "Background / autonomous use" section at the top showing the same allowlist snippet.
- `state.json` job records gained two new fields: `mode` (`"isolated"` | `"in-place"`) and `cwd` (the caller's cwd at dispatch time). Legacy records without `mode` are treated as `"isolated"` for back-compat.
- **Cost-model guidance for upstream agent callers.** README, `plugins/cursor/skills/cursor-cli-runtime/SKILL.md`, and `plugins/cursor/agents/cursor-dispatch.md` now document that cursor `--model auto` (the dispatch default) bills per request, not per token — so upstream agents (Claude Code main thread, Codex, etc.) should pack each `/cursor:dispatch` with scope + acceptance criteria + regression checks + self-validation instead of splitting work across multiple thin dispatches. The subagent itself remains a verbatim forwarder.

### Fixed

- `destroyDispatchWorktree` is now actually wired up. Previously it was dead code — sandbox worktrees accumulated in `.cursor/worktrees/` forever. Cancel cleans them automatically; `/cursor:cleanup` cleans the rest on demand.
- Dirty-cwd check on `--in-place --background` refuses with `EINPLACEDIRTY` so a background dispatch can't race the user's live edits. Override with `--include-dirty` if you really mean it.
- In-place dispatches on the same cwd now serialise: starting a second `--in-place` while another is running gives `EINPLACEBUSY`. Isolated dispatches still parallelise because each has its own sandbox worktree.

## [0.2.3] - 2026-05-08

### Added

- `/cursor:dispatch --mode <plan|ask|agent>` selects the cursor-agent execution mode. `plan` is read-only/planning, `ask` is read-only Q&A, `agent` is the implicit default (no `--mode` is forwarded). Read-only modes drop `--force` and skip the worktree auto-commit step.
- `dispatch.md` mode-routing rule: when the user does not specify a mode, the main thread infers from intent and offers a three-option `AskUserQuestion` (Ask only / Plan only / Agent), recommending the option that best matches the request.
- `dispatch.md` model-routing rule: on a fresh dispatch with no `--model`, the slash command silently appends `--model auto` so cursor's per-request router picks the model. `--resume` keeps the thread's bound model. Users override with explicit `--model <id>`; `cursor-agent --list-models` (or `cursor-agent models`) lists currently available IDs.

### Changed

- `--plan-only` is retained as a back-compat alias for `--mode plan`.

## [0.2.2] - 2026-05-08

### Changed

- Move the Claude Code plugin root from the repo root into `plugins/cursor`, so a single self-contained directory serves both Claude Code and Codex.
- Point the Claude Code marketplace entry at `./plugins/cursor`.
- Drop the root-level compatibility symlinks (`agents`, `commands`, `hooks`, `scripts`, `skills`) and the duplicated root-level `.codex-plugin/`.

### Migration

- Existing Claude Code installs should re-add the marketplace (or run `/plugin marketplace update cursor-plugin-cc`) so the new subdirectory layout takes effect.

## [0.2.1] - 2026-05-07

### Fixed

- Point the Codex marketplace entry at the standard `./plugins/cursor` plugin root so the Codex plugin UI can enumerate `cursor`.
- Move shared commands, agents, hooks, scripts, and skills under the self-contained `plugins/cursor` plugin root, with root-level compatibility symlinks for existing Claude Code paths.

## [0.2.0] - 2026-05-07

### Added

- Add Codex plugin support with `.codex-plugin/plugin.json`.
- Add Codex marketplace support with `.agents/plugins/marketplace.json`.
- Add manifest tests for Codex plugin wiring.

### Changed

- Update English and Chinese READMEs with Codex installation instructions.
- Describe the plugin as supporting both Claude Code and Codex.

## [0.1.0] - 2026-04-30

### Added

- Initial Claude Code plugin release.
- Add `/cursor:setup`, `/cursor:dispatch`, `/cursor:status`, `/cursor:result`, and `/cursor:cancel`.
- Add cursor-agent dispatch runtime with isolated git worktrees.
- Add background job state, result retrieval, cancellation, and session filtering.
