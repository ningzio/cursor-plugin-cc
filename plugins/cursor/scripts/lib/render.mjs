function fmtDuration(ms) {
  if (!ms) return "0s";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtSha(sha) {
  return sha ? sha.slice(0, 10) : "-";
}

export function renderDispatchSummary({ id, cursorSessionId, worktree, branch, mode, background }) {
  const where = background ? "in the background" : "(foreground)";
  const lines = [
    `Dispatched ${id} ${where}.`,
    `  mode           : ${mode ?? "isolated"}`,
    `  cursor session : ${cursorSessionId ?? "(pending)"}`,
    `  worktree       : ${worktree}`
  ];
  if (branch) lines.push(`  branch         : ${branch}`);
  if (mode === "in-place") {
    lines.push("  note           : cursor edits your cwd directly. You are responsible for commits.");
  }
  lines.push("Check progress with /cursor:status, fetch result with /cursor:result.");
  return lines.join("\n") + "\n";
}

export function renderForegroundResult({ job, gitDiffShortstat = "" }) {
  const head = job.isError
    ? `❌ ${job.id} failed (${fmtDuration(job.durationMs)})`
    : `✅ ${job.id} completed (${fmtDuration(job.durationMs)})`;
  const lines = [
    head,
    "",
    String(job.result ?? "").trim() || "(no result)",
    ""
  ];
  if (gitDiffShortstat) lines.push(gitDiffShortstat);
  if (job.mode) lines.push(`mode    : ${job.mode}`);
  if (job.worktree) lines.push(`worktree: ${job.worktree}`);
  if (job.mode === "in-place" && !job.isError) {
    lines.push("note    : edits landed in your cwd; review the diff and commit when ready.");
  }
  return lines.join("\n") + "\n";
}

const STATUS_BADGES = {
  queued: "⌛",
  running: "▶",
  completed: "✅",
  failed: "❌",
  cancelled: "⊘"
};

export function renderStatus(jobs, { currentSessionId = null, showAll = false } = {}) {
  let filtered = jobs;
  if (!showAll && currentSessionId) {
    filtered = jobs.filter((j) => j.claudeSessionId === currentSessionId);
  }
  filtered = [...filtered].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  if (filtered.length === 0) {
    return showAll ? "No cursor jobs.\n" : "No cursor jobs in this Claude session. Try /cursor:status --all.\n";
  }
  const lines = filtered.map((j) => {
    const badge = STATUS_BADGES[j.status] ?? "?";
    const promptShort = String(j.prompt ?? "").slice(0, 60).replace(/\s+/g, " ");
    return `${badge} ${j.id}  ${j.status.padEnd(10)}  ${promptShort}`;
  });
  return lines.join("\n") + "\n";
}

export function renderJobResult(job, { gitDiffShortstat = "" } = {}) {
  const lines = [
    `Job: ${job.id}  status=${job.status}  cursor=${job.cursorSessionId ?? "-"}`,
    `branch: ${job.branch ?? "-"}  head=${fmtSha(job.headSha)}`,
    `worktree: ${job.worktree ?? "-"}`,
    "",
    String(job.result ?? "").trim() || "(no result)"
  ];
  if (gitDiffShortstat) {
    lines.push("");
    lines.push(gitDiffShortstat);
  }
  return lines.join("\n") + "\n";
}

export function renderCancelReport(job, { cleanedSandbox = false } = {}) {
  const lines = [`Cancelled ${job.id} (status=${job.status}).`];
  if (cleanedSandbox) {
    lines.push(`Removed isolated sandbox worktree at ${job.worktree}.`);
  } else if ((job.mode ?? "isolated") === "isolated" && job.worktree) {
    lines.push(`Sandbox worktree retained at ${job.worktree}. Run /cursor:cleanup ${job.id} --apply to remove.`);
  }
  return lines.join("\n") + "\n";
}

export function renderCleanupReport({ dryRun, plan }) {
  if (!plan.length) {
    return dryRun
      ? "cleanup --dry-run: nothing to remove (no terminal isolated jobs).\n"
      : "cleanup: nothing to do.\n";
  }
  const lines = [
    dryRun
      ? "cleanup --dry-run: the following would be removed. Re-run with --apply to do it."
      : "cleanup: results"
  ];
  for (const item of plan) {
    if (item.action === "remove") {
      lines.push(`  WOULD REMOVE  ${item.id}  worktree=${item.worktree}`);
    } else if (item.action === "removed") {
      lines.push(`  REMOVED       ${item.id}  worktree=${item.worktree}`);
    } else if (item.action === "skip") {
      lines.push(`  SKIP          ${item.id}  reason=${item.reason}`);
    } else if (item.action === "error") {
      lines.push(`  ERROR         ${item.id}  ${item.error}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function renderSetupReport({ binary, version, loggedIn, account }) {
  const lines = [];
  lines.push(`agent binary: ${binary ?? "(not found)"}`);
  if (version) lines.push(`version     : ${version}`);
  lines.push(`logged in   : ${loggedIn ? "yes" : "no"}`);
  if (account) lines.push(`account     : ${account}`);
  if (!binary) lines.push("\nInstall: brew install cursor or see https://docs.cursor.com/cli");
  if (binary && !loggedIn) lines.push("\nRun: agent login");
  if (binary && loggedIn) {
    lines.push("");
    lines.push("Background / autonomous sessions: add to ~/.claude/settings.json:");
    lines.push(`  "permissions": { "allow": ["Bash(node \${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs *)"] }`);
  }
  return lines.join("\n") + "\n";
}

// Every policy-driven refusal goes through formatRefusal so callers (especially
// other agents driving /cursor:dispatch from a background session) get a
// machine-parseable first line (`REFUSED: <CODE>`) and a concrete list of next
// steps. Output goes to stderr; exit code stays 2 (caller convention).
export function formatRefusal({ code, reason, nextSteps = [], docs = null }) {
  const lines = [`REFUSED: ${code}`, "", `Reason: ${reason}`];
  if (nextSteps.length) {
    lines.push("");
    lines.push("Caller next steps:");
    for (const step of nextSteps) lines.push(`  - ${step}`);
  }
  if (docs) {
    lines.push("");
    lines.push(`Docs: ${docs}`);
  }
  return lines.join("\n") + "\n";
}
