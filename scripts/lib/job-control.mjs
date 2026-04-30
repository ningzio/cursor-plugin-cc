import { listJobs, upsertJob } from "./state.mjs";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "discarded", "merged"]);

// Filter helper: when sessionId is null/empty, this matches ALL jobs across
// every Claude session — used by `--all` flags. Callers that mean "current
// session only" must NEVER pass a falsy sessionId; the dispatch /
// status / result / cancel verbs go through requireSessionOrExplicit
// (cursor-companion.mjs) before reaching here, and dispatch-resume-candidate
// short-circuits with `available:false` when getClaudeSessionId() is null.
// Adding a new caller? Validate sessionId at the call site, not here.
function inSession(job, sessionId) {
  return !sessionId || job.claudeSessionId === sessionId;
}

function newest(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function findResultJob(cwd, { jobId = null, sessionId = null } = {}) {
  const jobs = listJobs(cwd);
  if (jobId) {
    return jobs.find((j) => j.id === jobId) ?? null;
  }
  const candidates = jobs.filter((j) => inSession(j, sessionId) && TERMINAL_STATUSES.has(j.status));
  return newest(candidates)[0] ?? null;
}

export function findCancelableJob(cwd, { jobId = null, sessionId = null } = {}) {
  const jobs = listJobs(cwd);
  if (jobId) {
    return jobs.find((j) => j.id === jobId) ?? null;
  }
  const candidates = jobs.filter((j) => inSession(j, sessionId) && (j.status === "running" || j.status === "queued"));
  return newest(candidates)[0] ?? null;
}

export function findResumeCandidate(cwd, { sessionId = null } = {}) {
  const jobs = listJobs(cwd);
  const candidates = jobs.filter(
    (j) => inSession(j, sessionId) && j.status === "completed" && j.cursorSessionId && j.worktree
  );
  const top = newest(candidates)[0];
  if (!top) return null;
  return {
    jobId: top.id,
    cursorSessionId: top.cursorSessionId,
    worktree: top.worktree,
    branch: top.branch,
    repoRoot: top.repoRoot,
    lastPrompt: top.prompt
  };
}

// Reject pid <= 1 to avoid POSIX broadcast semantics: kill(0) hits the
// caller's process group, kill(-1) hits all user processes (logs the user
// out), kill(-N) hits process group N. Only accept finite integer pid > 1
// pointing at a real child we spawned.
export function isSafePid(pid) {
  return Number.isInteger(pid) && pid > 1;
}

// Liveness check: returns true if the kernel reports the pid is still alive
// and we have permission to signal it. process.kill(pid, 0) is the POSIX
// idiom — it sends no signal but throws ESRCH if the process is gone or
// EPERM if it isn't ours.
export function isPidLive(pid) {
  if (!isSafePid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// codex F3: cancel must signal both the cursor agent child AND the Node
// wrapper, in that order — agent first so the model interrupts cleanly,
// wrapper second so it can't restart anything. Each candidate goes through
// isSafePid so a corrupted/stale state.json entry can't escalate into a
// broadcast signal. killProcess is invoked at most once per safe pid.
export function cancelJob(cwd, jobId, killProcess) {
  const jobs = listJobs(cwd);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return null;

  const targets = [job.agentPid, job.pid].filter((pid) => isSafePid(pid));
  // Dedupe: in foreground mode the wrapper IS the parent of the agent and
  // they are different pids; but if any callers ever set them equal, don't
  // signal the same process twice.
  const seen = new Set();
  if (killProcess && (job.status === "running" || job.status === "queued")) {
    for (const pid of targets) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        killProcess(pid);
      } catch {
        // pid 已不存在 or no permission — fine, we'll still mark cancelled
      }
    }
  }
  upsertJob(cwd, { id: jobId, status: "cancelled" });
  return { ...job, status: "cancelled" };
}
