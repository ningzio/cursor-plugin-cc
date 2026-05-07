import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";

export const STATE_VERSION = 1;

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_ROOT = path.join(os.tmpdir(), "cursor-companion");
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_NAME = "state.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
// Lock acquisition: 50 attempts × 20 ms = 1 s ceiling. Contention is rare
// (only concurrent dispatches hit it), and 1 s is comfortably longer than
// a single read-modify-write cycle on this state.
const LOCK_RETRY = 50;
const LOCK_RETRY_DELAY_MS = 20;
// codex F5 — atomic write + advisory lock for state.json. Concurrent dispatch
// invocations (foreground + background _run-job + cancel) all do
// read-modify-write on the same file; without serialization the last writer
// silently overwrites earlier updates and we lose jobs / status / agentPid.

function sleepSync(ms) {
  // Busy wait without burning CPU — Atomics.wait blocks the thread until
  // timeout. Used during the lock retry loop.
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, Math.max(0, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return { version: STATE_VERSION, config: {}, jobs: [] };
}

export function resolveStateDir(cwd) {
  const root = resolveWorkspaceRoot(cwd);
  let canonical = root;
  try {
    canonical = fs.realpathSync.native(root);
  } catch {
    // ignore
  }
  const slugSrc = path.basename(root) || "workspace";
  const slug = slugSrc.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  const base = process.env[PLUGIN_DATA_ENV]
    ? path.join(process.env[PLUGIN_DATA_ENV], "state")
    : FALLBACK_ROOT;
  return path.join(base, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

export function resolveJobLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function resolveLockFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_LOCK_NAME);
}

// Acquire an exclusive advisory lock by O_CREAT|O_EXCL on a lock file. If the
// lock already exists, peek at the recorded pid: if that process is gone, the
// lock is stale and we steal it; otherwise sleep and retry. Lock content is
// just `<pid>\n` — purely informational, no leasing protocol.
export function acquireLock(cwd, { retries = LOCK_RETRY, delayMs = LOCK_RETRY_DELAY_MS } = {}) {
  ensureStateDir(cwd);
  const lockPath = resolveLockFile(cwd);
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        fs.writeSync(fd, `${process.pid}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Stale lock recovery: read pid, ask the kernel if it's alive.
      let stale = false;
      try {
        const lockPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        if (!Number.isInteger(lockPid) || lockPid <= 1) {
          stale = true;
        } else {
          try {
            process.kill(lockPid, 0);
            // alive — keep waiting
          } catch {
            stale = true;
          }
        }
      } catch {
        // unreadable lock — treat as stale
        stale = true;
      }
      if (stale) {
        try { fs.unlinkSync(lockPath); } catch { /* race with another stealer */ }
        continue;
      }
      sleepSync(delayMs);
    }
  }
  throw new Error(`state.mjs: could not acquire lock at ${lockPath} after ${retries * delayMs}ms`);
}

export function releaseLock(lockPath) {
  if (!lockPath) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}

export function withStateLock(cwd, fn) {
  const lock = acquireLock(cwd);
  try {
    return fn();
  } finally {
    releaseLock(lock);
  }
}

export function loadState(cwd) {
  const file = resolveStateFile(cwd);
  if (!fs.existsSync(file)) return defaultState();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: { ...defaultState().config, ...(parsed.config ?? {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

// codex F5 — write to a tmp sibling and rename: POSIX rename(2) is atomic so
// readers either see the old or new file, never a partial write. Caller is
// expected to be inside withStateLock(cwd, ...) for read-modify-write paths.
export function saveState(cwd, state) {
  ensureStateDir(cwd);
  const next = {
    version: STATE_VERSION,
    config: { ...defaultState().config, ...(state.config ?? {}) },
    jobs: pruneJobs(state.jobs ?? [])
  };
  const target = resolveStateFile(cwd);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, target);
  return next;
}

// All read-modify-write of state.json must go through updateState (or call
// withStateLock manually) — load → mutate → save under one lock keeps two
// concurrent dispatches from clobbering each other's job records.
export function updateState(cwd, mutator) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutator(state);
    return saveState(cwd, state);
  });
}

export function generateJobId() {
  return `cur-${randomUUID().slice(0, 8)}`;
}

export function upsertJob(cwd, patch) {
  return updateState(cwd, (state) => {
    const ts = nowIso();
    const idx = state.jobs.findIndex((j) => j.id === patch.id);
    if (idx === -1) {
      state.jobs.unshift({ createdAt: ts, updatedAt: ts, ...patch });
      return;
    }
    state.jobs[idx] = { ...state.jobs[idx], ...patch, updatedAt: ts };
  });
}

// codex F4 — atomic "check no conflict + write reservation" used by dispatch
// to close the TOCTOU window between "is this cursorSessionId already
// running?" and "spawn detached child". Both happen inside a single state
// lock, so two concurrent companions can't both observe "no conflict" and
// both proceed.
//
// `conflictPredicate` is invoked for each existing job; if any returns true
// the call throws an Error with `code === "EJOBCONFLICT"` and `.conflict`
// set to the offending job. Caller catches and reports.
export function reserveDispatchJob(cwd, patch, { conflictPredicate } = {}) {
  return updateState(cwd, (state) => {
    if (conflictPredicate) {
      const conflict = state.jobs.find((j) => j.id !== patch.id && conflictPredicate(j));
      if (conflict) {
        const err = new Error(
          `reserveDispatchJob: conflict with ${conflict.id} (status=${conflict.status})`
        );
        err.code = "EJOBCONFLICT";
        err.conflict = conflict;
        throw err;
      }
    }
    const ts = nowIso();
    const idx = state.jobs.findIndex((j) => j.id === patch.id);
    if (idx === -1) {
      state.jobs.unshift({ createdAt: ts, updatedAt: ts, ...patch });
      return;
    }
    state.jobs[idx] = { ...state.jobs[idx], ...patch, updatedAt: ts };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const file = resolveJobFile(cwd, jobId);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return file;
}

export function readJobFile(cwd, jobId) {
  const file = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
