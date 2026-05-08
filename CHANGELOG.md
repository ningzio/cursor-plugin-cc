# Changelog

All notable changes to this project are documented here.

This project follows semantic versioning where practical.

## [Unreleased]

## [0.2.3] - 2026-05-08

### Added

- `/cursor:dispatch --mode <plan|ask|agent>` selects the cursor-agent execution mode. `plan` is read-only/planning, `ask` is read-only Q&A, `agent` is the implicit default (no `--mode` is forwarded). Read-only modes drop `--force` and skip the worktree auto-commit step.
- `dispatch.md` mode-routing rule: when the user does not specify a mode, the main thread infers from intent and offers a three-option `AskUserQuestion` (Ask only / Plan only / Agent), recommending the option that best matches the request.

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
