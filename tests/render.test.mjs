import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderCancelReport,
  renderDispatchSummary,
  renderForegroundResult,
  renderJobResult,
  renderStatus,
  renderSetupReport
} from "../scripts/lib/render.mjs";

test("renderDispatchSummary contains jobId, branch, worktree", () => {
  const out = renderDispatchSummary({
    id: "cur-1",
    cursorSessionId: "sess-x",
    worktree: "/repo/.cursor/worktrees/cur-1",
    branch: "cur-1",
    background: true
  });
  assert.match(out, /cur-1/);
  assert.match(out, /sess-x/);
  assert.match(out, /\.cursor\/worktrees\/cur-1/);
  assert.match(out, /background/i);
});

test("renderForegroundResult shows result + diff + worktree", () => {
  const out = renderForegroundResult({
    job: { id: "cur-1", result: "all good", worktree: "/x", isError: false, durationMs: 1234 },
    gitDiffShortstat: " 1 file changed, 2 insertions(+)"
  });
  assert.match(out, /all good/);
  assert.match(out, /1 file changed/);
  assert.match(out, /\/x/);
  assert.match(out, /1\.2s|1234/);
});

test("renderForegroundResult flags error", () => {
  const out = renderForegroundResult({
    job: { id: "cur-1", result: "broken", isError: true, durationMs: 100 }
  });
  assert.match(out, /❌|error/i);
});

test("renderStatus filters by current session and lists newest first", () => {
  const jobs = [
    { id: "cur-1", claudeSessionId: "s1", status: "running",   updatedAt: "2026-04-29T12:00:00Z", prompt: "first", worktree: "/x" },
    { id: "cur-2", claudeSessionId: "s1", status: "completed", updatedAt: "2026-04-29T13:00:00Z", prompt: "second", worktree: "/y" },
    { id: "cur-3", claudeSessionId: "s2", status: "completed", updatedAt: "2026-04-29T14:00:00Z", prompt: "other", worktree: "/z" }
  ];
  const out = renderStatus(jobs, { currentSessionId: "s1" });
  const idx2 = out.indexOf("cur-2");
  const idx1 = out.indexOf("cur-1");
  const idx3 = out.indexOf("cur-3");
  assert.ok(idx2 < idx1 && idx2 > -1);
  assert.equal(idx3, -1);
});

test("renderStatus --all shows everything", () => {
  const jobs = [{ id: "cur-3", claudeSessionId: "s2", status: "completed", updatedAt: "2026-04-29T14:00:00Z", prompt: "x", worktree: "/z" }];
  const out = renderStatus(jobs, { currentSessionId: "s1", showAll: true });
  assert.match(out, /cur-3/);
});

test("renderJobResult includes diff stat if provided", () => {
  const out = renderJobResult(
    { id: "cur-1", result: "ok", worktree: "/wt", branch: "cur-1", headSha: "abc1234567890" },
    { gitDiffShortstat: "1 file changed" }
  );
  assert.match(out, /ok/);
  assert.match(out, /1 file changed/);
  assert.match(out, /abc1234/);
});

test("renderCancelReport reports terminated", () => {
  const out = renderCancelReport({ id: "cur-1", status: "cancelled" });
  assert.match(out, /cur-1/);
  assert.match(out, /cancel/i);
});

test("renderSetupReport shows binary and login status", () => {
  const out = renderSetupReport({
    binary: "/usr/local/bin/agent",
    version: "1.0.0",
    loggedIn: true,
    account: "user@example.com"
  });
  assert.match(out, /\/usr\/local\/bin\/agent/);
  assert.match(out, /1\.0\.0/);
  assert.match(out, /yes/);
  assert.match(out, /user@example\.com/);
});
