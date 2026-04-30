import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listJobs, upsertJob } from "../scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

const COMPANION = path.resolve(fileURLToPath(import.meta.url), "../../scripts/cursor-companion.mjs");

function run(cwd, args, env = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    encoding: "utf8",
    cwd,
    env: { ...process.env, ...env }
  });
}

test("status filters by current session", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "s1" };
      const baseEnv = { ...process.env, ...env };
      Object.assign(process.env, env);
      try {
        upsertJob(repo, { id: "a", status: "completed", claudeSessionId: "s1", prompt: "p1" });
        upsertJob(repo, { id: "b", status: "completed", claudeSessionId: "s2", prompt: "p2" });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }
      const r = run(repo, ["status"], env);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /a/);
      assert.doesNotMatch(r.stdout, /b\s+completed/);
      const all = run(repo, ["status", "--all"], env);
      assert.match(all.stdout, /b/);
    });
  });
});

test("result returns latest completed in session", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "s1" };
      Object.assign(process.env, env);
      try {
        upsertJob(repo, { id: "a", status: "completed", claudeSessionId: "s1", prompt: "p", result: "RES-A" });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }
      const r = run(repo, ["result"], env);
      assert.match(r.stdout, /RES-A/);
    });
  });
});

test("cancel marks running job", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "s1" };
      Object.assign(process.env, env);
      try {
        // Use 0 (unsafe per POSIX kill(0, ...) semantics) to verify cancelJob's
        // safe-pid guard rejects it. Never use -1 here: process.kill(-1, ...)
        // would broadcast SIGTERM to all of the user's processes and log them
        // out. The companion's cancel command must skip the kill call entirely
        // and still mark the job as cancelled.
        upsertJob(repo, { id: "a", status: "running", claudeSessionId: "s1", pid: 0, prompt: "p" });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }
      const r = run(repo, ["cancel"], env);
      assert.match(r.stdout, /Cancelled/);
    });
  });
});

test("dispatch-resume-candidate returns available:false when no completed", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "s1" };
      const r = run(repo, ["dispatch-resume-candidate", "--json"], env);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.available, false);
    });
  });
});

test("dispatch-resume-candidate returns latest completed", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "s1" };
      Object.assign(process.env, env);
      try {
        upsertJob(repo, { id: "a", status: "completed", claudeSessionId: "s1", cursorSessionId: "sx", worktree: "/wt", branch: "a", repoRoot: repo, prompt: "earlier" });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }
      const r = run(repo, ["dispatch-resume-candidate", "--json"], env);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.available, true);
      assert.equal(parsed.jobId, "a");
      assert.equal(parsed.cursorSessionId, "sx");
    });
  });
});

// H2 — without CURSOR_COMPANION_SESSION_ID (hook never ran or running outside
// CC), dispatch-resume-candidate must NOT surface a candidate from another
// Claude session. inSession(_, null) used to match-all; the slash command
// would then offer a foreign session's worktree as a resume target.
test("dispatch-resume-candidate refuses when no session is bound", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      Object.assign(process.env, { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "foreign" });
      try {
        upsertJob(repo, { id: "a", status: "completed", claudeSessionId: "foreign", cursorSessionId: "sx", worktree: "/wt", branch: "a", repoRoot: repo, prompt: "p" });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }
      // Spawn without inheriting CURSOR_COMPANION_SESSION_ID — strip it
      // explicitly from the parent env in case the test runs inside a
      // session that has it set.
      const cleanEnv = { ...process.env };
      delete cleanEnv.CURSOR_COMPANION_SESSION_ID;
      cleanEnv.CLAUDE_PLUGIN_DATA = data;
      const r = spawnSync(process.execPath, [COMPANION, "dispatch-resume-candidate", "--json"], {
        encoding: "utf8",
        cwd: repo,
        env: cleanEnv
      });
      assert.equal(r.status, 0, r.stderr);
      const parsed = JSON.parse(r.stdout);
      assert.equal(parsed.available, false);
      assert.match(r.stderr, /not set/);
    });
  });
});

// codex F4 — dispatch --resume must refuse when target's cursorSessionId is
// still busy. Seed a running follow-up on the same cursorSessionId and verify
// the second --resume exits non-zero with the EJOBCONFLICT message and
// writes no new job to state.
test("dispatch --resume refuses when cursorSessionId is already busy", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = {
        CLAUDE_PLUGIN_DATA: data,
        CURSOR_COMPANION_SESSION_ID: "claude-s1"
      };
      // Need a real git repo for resolveRepoRoot to succeed
      execSync("git init -q -b main", { cwd: repo });
      execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
      execSync("touch a.txt && git add -A && git commit -q -m init", { cwd: repo });

      // Seed via upsertJob (need CLAUDE_PLUGIN_DATA in env for state path)
      Object.assign(process.env, env);
      try {
        upsertJob(repo, {
          id: "cur-target", status: "completed", claudeSessionId: "claude-s1",
          cursorSessionId: "sess-busy", worktree: "/tmp/cur-target-wt",
          branch: "cur-target", repoRoot: repo
        });
        upsertJob(repo, {
          id: "cur-busy", status: "running", claudeSessionId: "claude-s1",
          cursorSessionId: "sess-busy", worktree: "/tmp/cur-target-wt",
          branch: "cur-target", repoRoot: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }

      const r = run(repo, ["dispatch", "--wait", "--resume", "cur-target", "follow up"], env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /still running on cursorSessionId sess-busy/);

      Object.assign(process.env, env);
      try {
        const jobs = listJobs(repo);
        assert.equal(jobs.length, 2, "no new job should be reserved on conflict");
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }
    });
  });
});

// codex F7 — dispatch --resume must refuse when the target worktree has
// uncommitted changes (auto-commit would silently absorb them). The
// --include-dirty flag is the explicit override.
test("dispatch --resume refuses when target worktree is dirty", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "claude-s1" };

      // Real git repo for resolveRepoRoot
      execSync("git init -q -b main", { cwd: repo });
      execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
      fs.writeFileSync(path.join(repo, "a.txt"), "x");
      execSync("git add -A && git commit -q -m init", { cwd: repo });

      // Create a sub-worktree to simulate a previous dispatch
      const wt = path.join(repo, ".cursor", "worktrees", "cur-prev");
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      execSync(`git worktree add -b cur-prev "${wt}"`, { cwd: repo });
      // Make it dirty by writing an untracked file
      fs.writeFileSync(path.join(wt, "uncommitted.txt"), "user edit");

      Object.assign(process.env, env);
      try {
        upsertJob(repo, {
          id: "cur-prev", status: "completed", claudeSessionId: "claude-s1",
          cursorSessionId: "sess-z", worktree: wt, branch: "cur-prev", repoRoot: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }

      const r = run(repo, ["dispatch", "--wait", "--resume", "cur-prev", "follow up"], env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /worktree.*has uncommitted changes/);
      assert.match(r.stderr, /--include-dirty/);
    });
  });
});

test("dispatch --resume --include-dirty bypasses the dirty check", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data, CURSOR_COMPANION_SESSION_ID: "claude-s1" };

      execSync("git init -q -b main", { cwd: repo });
      execSync("git config user.email t@t.t && git config user.name t", { cwd: repo });
      fs.writeFileSync(path.join(repo, "a.txt"), "x");
      execSync("git add -A && git commit -q -m init", { cwd: repo });

      const wt = path.join(repo, ".cursor", "worktrees", "cur-dirty");
      fs.mkdirSync(path.dirname(wt), { recursive: true });
      execSync(`git worktree add -b cur-dirty "${wt}"`, { cwd: repo });
      fs.writeFileSync(path.join(wt, "uncommitted.txt"), "user edit");

      Object.assign(process.env, env);
      try {
        upsertJob(repo, {
          id: "cur-dirty", status: "completed", claudeSessionId: "claude-s1",
          cursorSessionId: "sess-d", worktree: wt, branch: "cur-dirty", repoRoot: repo
        });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
        delete process.env.CURSOR_COMPANION_SESSION_ID;
      }

      // With --include-dirty the dirty check is skipped. The dispatch will
      // still fail because we have not stubbed the agent binary, but the
      // failure must NOT be the dirty check — verify stderr does not match.
      const r = run(repo, ["dispatch", "--wait", "--include-dirty", "--resume", "cur-dirty", "follow"], {
        ...env,
        CURSOR_COMPANION_AGENT_BINARY: "/no/such/binary"
      });
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stderr, /uncommitted changes/);
    });
  });
});

// codex F8 — refuse session-default ops when SessionStart hook never set
// CURSOR_COMPANION_SESSION_ID. Otherwise the filter `claudeSessionId === null`
// quietly matches dispatch records from earlier hook-less invocations.
test("status without session env and without --all exits 2", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      // Hook not run: only CLAUDE_PLUGIN_DATA, no CURSOR_COMPANION_SESSION_ID
      const env = { CLAUDE_PLUGIN_DATA: data };
      const r = run(repo, ["status"], env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /CURSOR_COMPANION_SESSION_ID is not set/);
    });
  });
});

test("status --all without session env succeeds", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data };
      const r = run(repo, ["status", "--all"], env);
      assert.equal(r.status, 0, r.stderr);
    });
  });
});

test("result without session env and without jobId exits 2", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data };
      const r = run(repo, ["result"], env);
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /CURSOR_COMPANION_SESSION_ID is not set/);
    });
  });
});

test("cancel <jobId> without session env succeeds (jobId is explicit)", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data };
      Object.assign(process.env, env);
      try {
        upsertJob(repo, { id: "cur-x", status: "running", claudeSessionId: "some-other-session", pid: 0 });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run(repo, ["cancel", "cur-x"], env);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /Cancelled/);
    });
  });
});
