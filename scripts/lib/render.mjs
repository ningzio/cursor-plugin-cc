function fmtDuration(ms) {
  if (!ms) return "0s";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtSha(sha) {
  return sha ? sha.slice(0, 10) : "-";
}

export function renderDispatchSummary({ id, cursorSessionId, worktree, branch, background }) {
  const where = background ? "in the background" : "(foreground)";
  return [
    `Dispatched ${id} ${where}.`,
    `  cursor session : ${cursorSessionId ?? "(pending)"}`,
    `  worktree       : ${worktree}`,
    `  branch         : ${branch}`,
    `Check progress with /cursor:status, fetch result with /cursor:result.`
  ].join("\n") + "\n";
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
  if (job.worktree) lines.push(`worktree: ${job.worktree}`);
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

export function renderCancelReport(job) {
  return `Cancelled ${job.id} (status=${job.status}).\n`;
}

export function renderSetupReport({ binary, version, loggedIn, account }) {
  const lines = [];
  lines.push(`agent binary: ${binary ?? "(not found)"}`);
  if (version) lines.push(`version     : ${version}`);
  lines.push(`logged in   : ${loggedIn ? "yes" : "no"}`);
  if (account) lines.push(`account     : ${account}`);
  if (!binary) lines.push("\nInstall: brew install cursor or see https://docs.cursor.com/cli");
  if (binary && !loggedIn) lines.push("\nRun: agent login");
  return lines.join("\n") + "\n";
}
