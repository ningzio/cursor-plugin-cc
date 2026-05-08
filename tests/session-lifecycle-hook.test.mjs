import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { upsertJob, listJobs } from "../plugins/cursor/scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

const HOOK = path.resolve(fileURLToPath(import.meta.url), "../../plugins/cursor/scripts/session-lifecycle-hook.mjs");

function run(eventName, input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, eventName], {
    encoding: "utf8",
    input: input ? JSON.stringify(input) : "",
    env: { ...process.env, ...env }
  });
  return r;
}

test("SessionStart writes session_id to CLAUDE_ENV_FILE", () => {
  withTempDir((dir) => {
    const envFile = path.join(dir, "env");
    const r = run("SessionStart", { session_id: "sess-abc" }, { CLAUDE_ENV_FILE: envFile });
    assert.equal(r.status, 0, r.stderr);
    const content = fs.readFileSync(envFile, "utf8");
    assert.match(content, /export CURSOR_COMPANION_SESSION_ID='sess-abc'/);
  });
});

test("SessionStart also exports CLAUDE_PLUGIN_DATA when present", () => {
  withTempDir((dir) => {
    const envFile = path.join(dir, "env");
    const dataDir = path.join(dir, "plugin-data");
    fs.mkdirSync(dataDir);
    const r = run("SessionStart", { session_id: "s" }, {
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: dataDir
    });
    assert.equal(r.status, 0, r.stderr);
    const content = fs.readFileSync(envFile, "utf8");
    assert.match(content, /export CURSOR_COMPANION_SESSION_ID='s'/);
    assert.match(content, /export CLAUDE_PLUGIN_DATA='/);
  });
});

// codex F8/F10 — silent no-op on missing CLAUDE_ENV_FILE was the failure
// mode. We must fail loudly so misinstalled plugins surface immediately.
test("SessionStart without CLAUDE_ENV_FILE exits 1 with explanation", () => {
  // Strip CLAUDE_ENV_FILE explicitly even if the parent has one
  const env = { ...process.env };
  delete env.CLAUDE_ENV_FILE;
  const r = spawnSync(process.execPath, [HOOK, "SessionStart"], {
    encoding: "utf8",
    input: JSON.stringify({ session_id: "s" }),
    env
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /CLAUDE_ENV_FILE is not set/);
});

test("SessionEnd kills running jobs in matching session and prunes them", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data };
      Object.assign(process.env, env);
      try {
        upsertJob(repo, { id: "a", status: "running", claudeSessionId: "s1", pid: 0, agentPid: 0 });
        upsertJob(repo, { id: "b", status: "running", claudeSessionId: "s2", pid: 0, agentPid: 0 });
        upsertJob(repo, { id: "c", status: "completed", claudeSessionId: "s1", pid: 0 });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run("SessionEnd", { session_id: "s1", cwd: repo }, env);
      assert.equal(r.status, 0, r.stderr);
      Object.assign(process.env, env);
      try {
        const remaining = listJobs(repo).map((j) => j.id).sort();
        assert.deepEqual(remaining, ["b"]);
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
    });
  });
});

test("SessionEnd without session_id is a no-op", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      const env = { CLAUDE_PLUGIN_DATA: data };
      Object.assign(process.env, env);
      try {
        upsertJob(repo, { id: "a", status: "running", claudeSessionId: "s1", pid: 0 });
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
      const r = run("SessionEnd", { cwd: repo }, env);
      assert.equal(r.status, 0, r.stderr);
      Object.assign(process.env, env);
      try {
        assert.equal(listJobs(repo).length, 1);
      } finally {
        delete process.env.CLAUDE_PLUGIN_DATA;
      }
    });
  });
});
