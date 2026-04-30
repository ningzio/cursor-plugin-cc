import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLock,
  ensureStateDir,
  generateJobId,
  listJobs,
  loadState,
  readJobFile,
  releaseLock,
  reserveDispatchJob,
  resolveJobFile,
  resolveJobLogFile,
  resolveJobsDir,
  resolveLockFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  updateState,
  upsertJob,
  withStateLock,
  writeJobFile
} from "../scripts/lib/state.mjs";
import { withTempDir } from "./helpers.mjs";

function withPluginData(fn) {
  withTempDir((cwd) => {
    withTempDir((data) => {
      const prev = process.env.CLAUDE_PLUGIN_DATA;
      process.env.CLAUDE_PLUGIN_DATA = data;
      try {
        fn(cwd, data);
      } finally {
        if (prev === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
        else process.env.CLAUDE_PLUGIN_DATA = prev;
      }
    });
  });
}

test("generateJobId has cur- prefix", () => {
  const id = generateJobId();
  assert.match(id, /^cur-[a-z0-9-]+$/);
});

test("loadState returns default when no file", () => {
  withPluginData((cwd) => {
    const state = loadState(cwd);
    assert.equal(state.version, 1);
    assert.deepEqual(state.jobs, []);
  });
});

test("saveState writes JSON to expected path", () => {
  withPluginData((cwd) => {
    saveState(cwd, { version: 1, config: {}, jobs: [{ id: "cur-1", status: "running" }] });
    const stateFile = resolveStateFile(cwd);
    assert.ok(fs.existsSync(stateFile));
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(parsed.jobs[0].id, "cur-1");
  });
});

test("upsertJob creates a new job", () => {
  withPluginData((cwd) => {
    upsertJob(cwd, { id: "cur-1", status: "queued" });
    const state = loadState(cwd);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "queued");
    assert.ok(state.jobs[0].createdAt);
    assert.ok(state.jobs[0].updatedAt);
  });
});

test("upsertJob updates an existing job", () => {
  withPluginData((cwd) => {
    upsertJob(cwd, { id: "cur-1", status: "queued" });
    upsertJob(cwd, { id: "cur-1", status: "running", pid: 42 });
    const state = loadState(cwd);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].status, "running");
    assert.equal(state.jobs[0].pid, 42);
  });
});

test("resolveJobLogFile returns path under jobs dir", () => {
  withPluginData((cwd) => {
    const log = resolveJobLogFile(cwd, "cur-1");
    assert.ok(log.endsWith("/jobs/cur-1.log"));
  });
});

test("writeJobFile persists payload", () => {
  withPluginData((cwd) => {
    writeJobFile(cwd, "cur-1", { result: "hello" });
    const file = resolveJobFile(cwd, "cur-1");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(parsed.result, "hello");
  });
});

test("saveState prunes jobs older than max", () => {
  withPluginData((cwd) => {
    const jobs = [];
    for (let i = 0; i < 60; i += 1) {
      jobs.push({ id: `cur-${i}`, updatedAt: new Date(2026, 0, i + 1).toISOString() });
    }
    saveState(cwd, { version: 1, config: {}, jobs });
    const state = loadState(cwd);
    assert.equal(state.jobs.length, 50);
  });
});

test("listJobs returns jobs from state", () => {
  withPluginData((cwd) => {
    upsertJob(cwd, { id: "cur-1", status: "queued" });
    upsertJob(cwd, { id: "cur-2", status: "running" });
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].id, "cur-2"); // most recent first
    assert.equal(jobs[1].id, "cur-1");
  });
});

test("readJobFile returns null if file missing", () => {
  withPluginData((cwd) => {
    const payload = readJobFile(cwd, "cur-missing");
    assert.equal(payload, null);
  });
});

test("updateState applies mutator function", () => {
  withPluginData((cwd) => {
    upsertJob(cwd, { id: "cur-1", status: "queued" });
    updateState(cwd, (state) => {
      state.config.test = true;
    });
    const state = loadState(cwd);
    assert.equal(state.config.test, true);
  });
});

// codex F5 — lock fundamentals
test("acquireLock + releaseLock roundtrip writes pid then removes file", () => {
  withPluginData((cwd) => {
    const lockPath = acquireLock(cwd);
    assert.equal(lockPath, resolveLockFile(cwd));
    assert.ok(fs.existsSync(lockPath));
    const recorded = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    assert.equal(recorded, process.pid);
    releaseLock(lockPath);
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("acquireLock steals a stale lock whose pid is dead", () => {
  withPluginData((cwd) => {
    ensureStateDir(cwd);
    const lockPath = resolveLockFile(cwd);
    // Seed a stale lock owned by a definitely-dead pid (pid 1 is excluded by
    // isSafePid in stale check; use a number that the kernel won't have)
    fs.writeFileSync(lockPath, "999999999\n", "utf8");
    const acquired = acquireLock(cwd, { retries: 3, delayMs: 5 });
    assert.equal(acquired, lockPath);
    const recorded = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    assert.equal(recorded, process.pid);
    releaseLock(lockPath);
  });
});

test("acquireLock throws after exhausting retries when held by live pid", () => {
  withPluginData((cwd) => {
    ensureStateDir(cwd);
    const lockPath = resolveLockFile(cwd);
    fs.writeFileSync(lockPath, `${process.pid}\n`, "utf8");
    assert.throws(
      () => acquireLock(cwd, { retries: 2, delayMs: 1 }),
      /could not acquire lock/i
    );
    fs.unlinkSync(lockPath);
  });
});

test("withStateLock releases lock even if fn throws", () => {
  withPluginData((cwd) => {
    const lockPath = resolveLockFile(cwd);
    assert.throws(
      () => withStateLock(cwd, () => { throw new Error("boom"); }),
      /boom/
    );
    assert.equal(fs.existsSync(lockPath), false);
  });
});

test("saveState writes via tmp + rename (no partial files left)", () => {
  withPluginData((cwd) => {
    saveState(cwd, { version: 1, config: {}, jobs: [{ id: "cur-1", status: "running" }] });
    const dir = resolveStateDir(cwd);
    const leftover = fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftover, []);
  });
});

// codex F4 — reservation conflict semantics
test("reserveDispatchJob writes record when no conflict predicate matches", () => {
  withPluginData((cwd) => {
    reserveDispatchJob(cwd, { id: "cur-a", status: "queued", cursorSessionId: "sess-x" }, {
      conflictPredicate: (j) => j.cursorSessionId === "sess-x" && (j.status === "running" || j.status === "queued")
    });
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "cur-a");
    assert.equal(jobs[0].status, "queued");
  });
});

test("reserveDispatchJob throws EJOBCONFLICT when predicate matches another job", () => {
  withPluginData((cwd) => {
    upsertJob(cwd, { id: "cur-existing", status: "running", cursorSessionId: "sess-x" });
    let caught = null;
    try {
      reserveDispatchJob(cwd, { id: "cur-new", status: "queued", cursorSessionId: "sess-x" }, {
        conflictPredicate: (j) => j.cursorSessionId === "sess-x" && (j.status === "running" || j.status === "queued")
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught);
    assert.equal(caught.code, "EJOBCONFLICT");
    assert.equal(caught.conflict.id, "cur-existing");
    // Loser must not be written
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].id, "cur-existing");
  });
});

test("reserveDispatchJob ignores its own id in conflict scan (idempotent)", () => {
  withPluginData((cwd) => {
    reserveDispatchJob(cwd, { id: "cur-self", status: "queued", cursorSessionId: "sess-x" }, {
      conflictPredicate: (j) => j.cursorSessionId === "sess-x"
    });
    // Re-reserving same id (e.g. retry path) must not flag self as conflict
    reserveDispatchJob(cwd, { id: "cur-self", status: "queued", cursorSessionId: "sess-x", prompt: "second pass" }, {
      conflictPredicate: (j) => j.cursorSessionId === "sess-x"
    });
    const jobs = listJobs(cwd);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].prompt, "second pass");
  });
});
