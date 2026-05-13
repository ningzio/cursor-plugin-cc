import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upsertJob } from "../plugins/cursor/scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

const COMPANION = path.resolve(fileURLToPath(import.meta.url), "../../plugins/cursor/scripts/cursor-companion.mjs");

function run(cwd, args, env = {}, opts = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env },
    ...opts
  });
}

function initRepo(dir) {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
}

// cleanup with no jobId and no --all-finished must refuse rather than guess.
test("cleanup with no target → EMISSINGTARGET refusal with next-step guidance", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      const r = run(repo, ["cleanup"], { CLAUDE_PLUGIN_DATA: data });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /^REFUSED: EMISSINGTARGET/);
      assert.match(r.stderr, /jobId/);
      assert.match(r.stderr, /--all-finished/);
      assert.match(r.stderr, /dry-run/);
    });
  });
});

test("cleanup <unknown-jobId> → ENOMATCHINGJOB refusal", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      const r = run(repo, ["cleanup", "cur-nope"], { CLAUDE_PLUGIN_DATA: data });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /^REFUSED: ENOMATCHINGJOB/);
      assert.match(r.stderr, /cur-nope/);
    });
  });
});

test("cleanup --all-finished dry-run lists what it would remove without touching disk", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      // Create a real worktree to clean and seed state.
      const wt = path.join(repo, ".cursor", "worktrees", "cur-done");
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      execSync(`git worktree add -b cur-done "${wt}"`, { cwd: repo });
      Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data });
      try {
        upsertJob(repo, {
          id: "cur-done", status: "completed", mode: "isolated",
          claudeSessionId: "s1", worktree: wt, branch: "cur-done", repoRoot: repo
        });
        // An in-place job too: must be skipped.
        upsertJob(repo, {
          id: "cur-ip", status: "completed", mode: "in-place",
          claudeSessionId: "s1", worktree: repo, branch: null, repoRoot: repo, cwd: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run(repo, ["cleanup", "--all-finished"], { CLAUDE_PLUGIN_DATA: data });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /dry-run/);
      assert.match(r.stdout, /WOULD REMOVE\s+cur-done/);
      assert.doesNotMatch(r.stdout, /cur-ip/); // in-place not included in the all-finished sweep
      // Worktree dir still exists — dry-run didn't actually remove it.
      assert.equal(fs.existsSync(wt), true);
    });
  });
});

test("cleanup --all-finished --apply removes isolated sandbox worktrees on disk", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      const wt = path.join(repo, ".cursor", "worktrees", "cur-done2");
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      execSync(`git worktree add -b cur-done2 "${wt}"`, { cwd: repo });
      Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data });
      try {
        upsertJob(repo, {
          id: "cur-done2", status: "completed", mode: "isolated",
          claudeSessionId: "s1", worktree: wt, branch: "cur-done2", repoRoot: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run(repo, ["cleanup", "--all-finished", "--apply"], { CLAUDE_PLUGIN_DATA: data });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /REMOVED\s+cur-done2/);
      assert.equal(fs.existsSync(wt), false);
    });
  });
});

test("cleanup <in-place-jobId> is a no-op (cwd is never touched)", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data });
      try {
        upsertJob(repo, {
          id: "cur-ip", status: "completed", mode: "in-place",
          claudeSessionId: "s1", worktree: repo, branch: null, repoRoot: repo, cwd: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run(repo, ["cleanup", "cur-ip", "--apply"], { CLAUDE_PLUGIN_DATA: data });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /SKIP\s+cur-ip\s+reason=in-place mode has no sandbox/);
      // cwd file is untouched.
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), true);
    });
  });
});

test("cancel of isolated running job auto-removes sandbox", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      const wt = path.join(repo, ".cursor", "worktrees", "cur-running");
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      execSync(`git worktree add -b cur-running "${wt}"`, { cwd: repo });
      Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data });
      try {
        upsertJob(repo, {
          id: "cur-running", status: "running", mode: "isolated",
          claudeSessionId: "s-cancel", pid: 0, worktree: wt, branch: "cur-running",
          repoRoot: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run(repo, ["cancel", "cur-running"], {
        CLAUDE_PLUGIN_DATA: data,
        CURSOR_COMPANION_SESSION_ID: "s-cancel"
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Cancelled cur-running/);
      assert.match(r.stdout, /Removed isolated sandbox worktree/);
      assert.equal(fs.existsSync(wt), false);
    });
  });
});

test("cancel of in-place running job does NOT touch cwd", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data });
      try {
        upsertJob(repo, {
          id: "cur-ip-running", status: "running", mode: "in-place",
          claudeSessionId: "s-cancel-ip", pid: 0, worktree: repo, branch: null,
          repoRoot: repo, cwd: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run(repo, ["cancel", "cur-ip-running"], {
        CLAUDE_PLUGIN_DATA: data,
        CURSOR_COMPANION_SESSION_ID: "s-cancel-ip"
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Cancelled cur-ip-running/);
      assert.doesNotMatch(r.stdout, /Removed/);
      // The init file is still there: cancel didn't run a worktree-remove on cwd.
      assert.equal(fs.existsSync(path.join(repo, "a.txt")), true);
    });
  });
});
