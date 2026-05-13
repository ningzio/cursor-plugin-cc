import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatRefusal,
  renderCancelReport,
  renderCleanupReport,
  renderDispatchSummary,
  renderForegroundResult,
  renderJobResult,
  renderStatus,
  renderSetupReport
} from "../plugins/cursor/scripts/lib/render.mjs";

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

test("renderSetupReport shows binary and login status, and the allowlist hint when logged in", () => {
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
  // Background-session allowlist hint must be reachable for non-interactive callers.
  assert.match(out, /permissions/);
  assert.match(out, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/cursor-companion\.mjs/);
});

// formatRefusal is the canonical refusal format used by every policy-driven
// rejection. The first line must always start `REFUSED: <CODE>` so callers can
// grep for refusals programmatically, and the body must include Reason + next
// steps + (optional) docs in that order.
test("formatRefusal: first line is `REFUSED: <CODE>`, body has Reason and Caller next steps", () => {
  const out = formatRefusal({
    code: "EFOO",
    reason: "something went sideways",
    nextSteps: ["do X", "or do Y"],
    docs: "see foo.md"
  });
  const lines = out.split("\n");
  assert.equal(lines[0], "REFUSED: EFOO");
  assert.equal(lines[1], "");
  assert.equal(lines[2], "Reason: something went sideways");
  assert.match(out, /Caller next steps:\n {2}- do X\n {2}- or do Y/);
  assert.match(out, /Docs: see foo\.md/);
});

test("formatRefusal: omits Caller next steps section when empty", () => {
  const out = formatRefusal({ code: "EBAR", reason: "nope" });
  assert.match(out, /^REFUSED: EBAR/);
  assert.doesNotMatch(out, /Caller next steps/);
  assert.doesNotMatch(out, /Docs:/);
});

test("renderDispatchSummary distinguishes in-place from isolated", () => {
  const isolated = renderDispatchSummary({
    id: "cur-1", cursorSessionId: "s", worktree: "/repo/.cursor/worktrees/cur-1",
    branch: "cur-1", mode: "isolated", background: false
  });
  assert.match(isolated, /mode\s+: isolated/);
  assert.match(isolated, /branch\s+: cur-1/);
  assert.doesNotMatch(isolated, /cursor edits your cwd directly/);

  const inPlace = renderDispatchSummary({
    id: "cur-2", cursorSessionId: "s", worktree: "/repo",
    branch: null, mode: "in-place", background: true
  });
  assert.match(inPlace, /mode\s+: in-place/);
  assert.match(inPlace, /cursor edits your cwd directly/);
  assert.doesNotMatch(inPlace, /branch\s+:/);
});

test("renderCancelReport mentions sandbox cleanup when isolated job's worktree was removed", () => {
  const out = renderCancelReport(
    { id: "cur-1", status: "cancelled", mode: "isolated", worktree: "/wt" },
    { cleanedSandbox: true }
  );
  assert.match(out, /Cancelled cur-1/);
  assert.match(out, /Removed isolated sandbox worktree at \/wt/);
});

test("renderCancelReport hints at manual cleanup when sandbox wasn't auto-removed", () => {
  const out = renderCancelReport(
    { id: "cur-1", status: "cancelled", mode: "isolated", worktree: "/wt" },
    { cleanedSandbox: false }
  );
  assert.match(out, /Sandbox worktree retained at \/wt/);
  assert.match(out, /\/cursor:cleanup cur-1/);
});

test("renderCancelReport doesn't mention sandbox for in-place jobs", () => {
  const out = renderCancelReport(
    { id: "cur-2", status: "cancelled", mode: "in-place" },
    { cleanedSandbox: false }
  );
  assert.match(out, /Cancelled cur-2/);
  assert.doesNotMatch(out, /sandbox/i);
  assert.doesNotMatch(out, /cleanup/i);
});

test("renderCleanupReport renders empty / dry-run / apply variants distinctly", () => {
  assert.match(renderCleanupReport({ dryRun: true, plan: [] }), /nothing to remove/);
  assert.match(
    renderCleanupReport({ dryRun: true, plan: [{ id: "cur-1", action: "remove", worktree: "/wt" }] }),
    /WOULD REMOVE\s+cur-1\s+worktree=\/wt/
  );
  assert.match(
    renderCleanupReport({ dryRun: false, plan: [{ id: "cur-1", action: "removed", worktree: "/wt" }] }),
    /REMOVED\s+cur-1\s+worktree=\/wt/
  );
  assert.match(
    renderCleanupReport({ dryRun: true, plan: [{ id: "cur-2", action: "skip", reason: "in-place mode has no sandbox" }] }),
    /SKIP\s+cur-2\s+reason=in-place mode has no sandbox/
  );
});
