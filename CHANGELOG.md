# Changelog

All notable changes to this project are documented here.

This project follows semantic versioning where practical.

## [Unreleased]

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
