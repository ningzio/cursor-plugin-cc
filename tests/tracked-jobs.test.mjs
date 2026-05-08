import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runForegroundJob } from "../plugins/cursor/scripts/lib/tracked-jobs.mjs";
import { loadState, resolveJobLogFile } from "../plugins/cursor/scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../fake-cursor-fixture.mjs");

function initRepo(dir) {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
}

async function withState(fn) {
  // Create both temp dirs upfront without nesting cleanup
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-test-"));

  const prev = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = data;

  try {
    return await fn(repo, data);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = prev;

    try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  }
}

test("runForegroundJob writes state, commits worktree, and returns result", async () => {
  await withState(async (repo, data) => {
    initRepo(repo);
    const job = await runForegroundJob({
      cwd: data,
      repoRoot: repo,
      jobId: "cur-fg1",
      prompt: "hello",
      options: { force: true },
      claudeSessionId: "claude-sess-1",
      agentBinary: process.execPath,
      agentBinaryArgs: [FIXTURE],
      env: {
        ...process.env,
        FAKE_CURSOR_SESSION_ID: "sess-fg1",
        FAKE_CURSOR_RESULT: "done",
        FAKE_CURSOR_TOUCH_FILE: "out.txt"
      }
    });

    assert.equal(job.cursorSessionId, "sess-fg1");
    assert.equal(job.result, "done");
    assert.equal(job.isError, false);
    assert.match(job.headSha, /^[a-f0-9]{40}$/);

    const state = loadState(data);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "completed");
    assert.equal(state.jobs[0].cursorSessionId, "sess-fg1");

    const log = resolveJobLogFile(data, "cur-fg1");
    assert.ok(fs.existsSync(log));

    const commitMsg = execSync(
      `git -C "${path.join(repo, ".cursor/worktrees/cur-fg1")}" log -1 --pretty=%s`,
      { encoding: "utf8" }
    ).trim();
    assert.match(commitMsg, /^\[cur-fg1\] hello$/);
  });
});

test("runForegroundJob marks failed when is_error true", async () => {
  await withState(async (repo, data) => {
    initRepo(repo);
    const job = await runForegroundJob({
      cwd: data,
      repoRoot: repo,
      jobId: "cur-fg2",
      prompt: "boom",
      options: { force: true },
      claudeSessionId: "claude-sess-1",
      agentBinary: process.execPath,
      agentBinaryArgs: [FIXTURE],
      env: { ...process.env, FAKE_CURSOR_FAIL: "1" }
    });

    assert.equal(job.isError, true);
    const state = loadState(data);
    assert.equal(state.jobs[0].status, "failed");
  });
});
