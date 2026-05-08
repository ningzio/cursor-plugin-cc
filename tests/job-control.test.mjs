import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelJob,
  findCancelableJob,
  findResultJob,
  findResumeCandidate,
  isPidLive,
  isSafePid
} from "../plugins/cursor/scripts/lib/job-control.mjs";
import { upsertJob } from "../plugins/cursor/scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

function withState(fn) {
  withTempDir((cwd) => {
    withTempDir((data) => {
      const prev = process.env.CLAUDE_PLUGIN_DATA;
      process.env.CLAUDE_PLUGIN_DATA = data;
      try {
        fn(cwd);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
        else process.env.CLAUDE_PLUGIN_DATA = prev;
      }
    });
  });
}

test("findResultJob returns latest completed in session", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "a", status: "completed", claudeSessionId: "s1", updatedAt: "2026-04-29T10:00:00Z" });
    upsertJob(cwd, { id: "b", status: "completed", claudeSessionId: "s1", updatedAt: "2026-04-29T11:00:00Z" });
    upsertJob(cwd, { id: "c", status: "running",   claudeSessionId: "s1", updatedAt: "2026-04-29T12:00:00Z" });
    const job = findResultJob(cwd, { sessionId: "s1" });
    assert.equal(job.id, "b");
  });
});

test("findResultJob with explicit jobId", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "a", status: "completed", claudeSessionId: "s1" });
    const job = findResultJob(cwd, { jobId: "a", sessionId: "s1" });
    assert.equal(job.id, "a");
  });
});

test("findResultJob returns null when nothing in session", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "a", status: "completed", claudeSessionId: "other" });
    assert.equal(findResultJob(cwd, { sessionId: "s1" }), null);
  });
});

test("findCancelableJob returns latest running", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "a", status: "running", claudeSessionId: "s1", updatedAt: "2026-04-29T10:00:00Z" });
    upsertJob(cwd, { id: "b", status: "running", claudeSessionId: "s1", updatedAt: "2026-04-29T11:00:00Z" });
    upsertJob(cwd, { id: "c", status: "completed", claudeSessionId: "s1", updatedAt: "2026-04-29T12:00:00Z" });
    const job = findCancelableJob(cwd, { sessionId: "s1" });
    assert.equal(job.id, "b");
  });
});

test("cancelJob updates status and invokes killProcess", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "a", status: "running", pid: 999, claudeSessionId: "s1" });
    let killed = null;
    cancelJob(cwd, "a", (pid) => { killed = pid; });
    assert.equal(killed, 999);
    const refetched = findResultJob(cwd, { jobId: "a", sessionId: "s1" });
    assert.equal(refetched.status, "cancelled");
  });
});

test("findResumeCandidate prefers latest completed in session with cursorSessionId", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "a", status: "completed", claudeSessionId: "s1", cursorSessionId: "x", worktree: "/a", updatedAt: "2026-04-29T10:00:00Z" });
    upsertJob(cwd, { id: "b", status: "completed", claudeSessionId: "s1", cursorSessionId: "y", worktree: "/b", updatedAt: "2026-04-29T11:00:00Z" });
    const cand = findResumeCandidate(cwd, { sessionId: "s1" });
    assert.equal(cand.jobId, "b");
    assert.equal(cand.cursorSessionId, "y");
  });
});

// codex F3 — guard helpers
test("isSafePid only accepts integers > 1", () => {
  assert.equal(isSafePid(123), true);
  assert.equal(isSafePid(2), true);
  assert.equal(isSafePid(1), false);
  assert.equal(isSafePid(0), false);
  assert.equal(isSafePid(-1), false);
  assert.equal(isSafePid(NaN), false);
  assert.equal(isSafePid(1.5), false);
  assert.equal(isSafePid("123"), false);
  assert.equal(isSafePid(null), false);
  assert.equal(isSafePid(undefined), false);
});

test("isPidLive returns true for our own pid, false for unsafe inputs", () => {
  assert.equal(isPidLive(process.pid), true);
  assert.equal(isPidLive(0), false);
  assert.equal(isPidLive(-1), false);
  assert.equal(isPidLive(NaN), false);
  // pid 1 (init/launchd) is excluded by isSafePid even though it's alive
  assert.equal(isPidLive(1), false);
});

// codex F3 — cancel signals agentPid first, then wrapper pid; both via spy.
test("cancelJob signals agentPid and wrapper pid in order", () => {
  withState((cwd) => {
    upsertJob(cwd, {
      id: "j",
      status: "running",
      claudeSessionId: "s1",
      pid: 1234,         // wrapper Node process
      agentPid: 5678     // cursor agent child
    });
    const killed = [];
    cancelJob(cwd, "j", (pid) => killed.push(pid));
    assert.deepEqual(killed, [5678, 1234]); // agent first, wrapper second
    const refetched = findResultJob(cwd, { jobId: "j", sessionId: "s1" });
    assert.equal(refetched.status, "cancelled");
  });
});

// codex F3 — unsafe agentPid is skipped, wrapper still signalled.
test("cancelJob skips unsafe agentPid (0/-1) but still kills safe wrapper pid", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "j2", status: "running", claudeSessionId: "s1", pid: 4321, agentPid: -1 });
    const killed = [];
    cancelJob(cwd, "j2", (pid) => killed.push(pid));
    assert.deepEqual(killed, [4321]); // -1 silently skipped
  });
});

// codex F3 — both pids unsafe → no kill at all, status still cancelled.
test("cancelJob with all unsafe pids skips kill but still marks cancelled", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "j3", status: "running", claudeSessionId: "s1", pid: 0, agentPid: -1 });
    const killed = [];
    cancelJob(cwd, "j3", (pid) => killed.push(pid));
    assert.deepEqual(killed, []);
    const refetched = findResultJob(cwd, { jobId: "j3", sessionId: "s1" });
    assert.equal(refetched.status, "cancelled");
  });
});

// codex F3 — duplicate pid (foreground edge case) only signalled once.
test("cancelJob deduplicates same pid set on both agent and wrapper", () => {
  withState((cwd) => {
    upsertJob(cwd, { id: "j4", status: "running", claudeSessionId: "s1", pid: 7777, agentPid: 7777 });
    const killed = [];
    cancelJob(cwd, "j4", (pid) => killed.push(pid));
    assert.deepEqual(killed, [7777]);
  });
});
