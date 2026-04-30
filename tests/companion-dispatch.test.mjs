import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadState } from "../scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

const COMPANION = path.resolve(fileURLToPath(import.meta.url), "../../scripts/cursor-companion.mjs");
const FIXTURE = path.resolve(fileURLToPath(import.meta.url), "../fake-cursor-fixture.mjs");

function initRepo(dir) {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
}

test("dispatch fresh foreground writes job and prints summary", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      const r = spawnSync(process.execPath, [COMPANION, "dispatch", "--wait", "do thing"], {
        encoding: "utf8",
        cwd: repo,
        env: {
          ...process.env,
          CLAUDE_PLUGIN_DATA: data,
          CURSOR_COMPANION_SESSION_ID: "claude-sess-1",
          CURSOR_COMPANION_AGENT_BINARY: process.execPath,
          CURSOR_COMPANION_AGENT_BINARY_ARG0: FIXTURE,
          FAKE_CURSOR_SESSION_ID: "sess-fg",
          FAKE_CURSOR_RESULT: "DONE",
          FAKE_CURSOR_TOUCH_FILE: "result.txt"
        }
      });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /DONE/);

      process.env.CLAUDE_PLUGIN_DATA = data;
      const state = loadState(repo);
      delete process.env.CLAUDE_PLUGIN_DATA;
      assert.equal(state.jobs.length, 1);
      const job = state.jobs[0];
      assert.equal(job.status, "completed");
      assert.equal(job.cursorSessionId, "sess-fg");

      // 验证 worktree 自动 commit 用了真实 jobId
      const commitMsg = execSync(`git -C "${job.worktree}" log -1 --pretty=%s`, { encoding: "utf8" }).trim();
      assert.match(commitMsg, new RegExp(`^\\[${job.id}\\] do thing$`));
    });
  });
});

test("dispatch background returns immediately and job runs to completion", async () => {
  await new Promise((resolve, reject) => {
    withTempDir((repo) => {
      withTempDir((data) => {
        try {
          initRepo(repo);
          const r = spawnSync(process.execPath, [COMPANION, "dispatch", "--background", "do bg"], {
            encoding: "utf8",
            cwd: repo,
            env: {
              ...process.env,
              CLAUDE_PLUGIN_DATA: data,
              CURSOR_COMPANION_SESSION_ID: "claude-sess-bg",
              CURSOR_COMPANION_AGENT_BINARY: process.execPath,
              CURSOR_COMPANION_AGENT_BINARY_ARG0: FIXTURE,
              FAKE_CURSOR_SESSION_ID: "sess-bg",
              FAKE_CURSOR_RESULT: "BG OK",
              FAKE_CURSOR_DELAY_MS: "20"
            }
          });
          assert.equal(r.status, 0, r.stderr);
          assert.match(r.stdout, /background/i);

          // 等任务跑完
          const start = Date.now();
          let state;
          process.env.CLAUDE_PLUGIN_DATA = data;
          while (Date.now() - start < 5000) {
            state = loadState(repo);
            if (state.jobs.length && state.jobs[0].status === "completed") break;
            // 简短 sleep
            execSync("sleep 0.1");
          }
          delete process.env.CLAUDE_PLUGIN_DATA;
          assert.equal(state.jobs[0].status, "completed");
          assert.equal(state.jobs[0].cursorSessionId, "sess-bg");
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  });
});

test("dispatch --resume <jobId> reuses cursorSessionId and worktree", () => {
  withTempDir((repo) => {
    withTempDir((data) => {
      initRepo(repo);
      const baseEnv = {
        ...process.env,
        CLAUDE_PLUGIN_DATA: data,
        CURSOR_COMPANION_SESSION_ID: "claude-sess-r",
        CURSOR_COMPANION_AGENT_BINARY: process.execPath,
        CURSOR_COMPANION_AGENT_BINARY_ARG0: FIXTURE
      };
      const first = spawnSync(process.execPath, [COMPANION, "dispatch", "--wait", "first"], {
        encoding: "utf8", cwd: repo,
        env: { ...baseEnv, FAKE_CURSOR_SESSION_ID: "sess-r1", FAKE_CURSOR_RESULT: "1", FAKE_CURSOR_TOUCH_FILE: "f1" }
      });
      assert.equal(first.status, 0, first.stderr);
      process.env.CLAUDE_PLUGIN_DATA = data;
      const firstId = loadState(repo).jobs[0].id;
      delete process.env.CLAUDE_PLUGIN_DATA;

      const second = spawnSync(process.execPath, [COMPANION, "dispatch", "--wait", "--resume", firstId, "follow"], {
        encoding: "utf8", cwd: repo,
        env: { ...baseEnv, FAKE_CURSOR_RESULT: "2", FAKE_CURSOR_TOUCH_FILE: "f2" }
      });
      assert.equal(second.status, 0, second.stderr);
      process.env.CLAUDE_PLUGIN_DATA = data;
      const jobs = loadState(repo).jobs;
      delete process.env.CLAUDE_PLUGIN_DATA;
      const followup = jobs.find((j) => j.parentJobId === firstId);
      assert.ok(followup);
      // 复用同 worktree
      assert.equal(followup.worktree, jobs.find((j) => j.id === firstId).worktree);
    });
  });
});
