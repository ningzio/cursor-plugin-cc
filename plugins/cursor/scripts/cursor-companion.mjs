#!/usr/bin/env node

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  generateJobId,
  loadState,
  reserveDispatchJob,
  resolveJobLogFile,
  upsertJob
} from "./lib/state.mjs";
import { findCancelableJob, findResultJob, findResumeCandidate, cancelJob, isPidLive } from "./lib/job-control.mjs";
import { destroyDispatchWorktree } from "./lib/worktree.mjs";
import {
  formatRefusal,
  renderCancelReport,
  renderCleanupReport,
  renderDispatchSummary,
  renderForegroundResult,
  renderJobResult,
  renderSetupReport,
  renderStatus
} from "./lib/render.mjs";
import { runForegroundJob, SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveRepoRoot } from "./lib/workspace.mjs";
import { gitStatusPorcelain, isGitRepo } from "./lib/git.mjs";

const DISPATCH_FLAGS = {
  booleans: [
    "wait", "background", "fresh", "plan-only", "include-dirty", "json",
    "isolated", "in-place"
  ],
  values: ["resume", "model", "worktree-base", "mode"]
};
// cursor-agent --mode only accepts plan|ask. "agent" is the implicit default and
// must NOT be forwarded as a flag — we accept it here purely so callers can
// state the choice explicitly, then map it to null downstream.
const DISPATCH_MODES = new Set(["plan", "ask", "agent"]);
const STATUS_FLAGS = { booleans: ["all", "json"], values: [] };
const RESULT_FLAGS = { booleans: ["json"], values: [] };
const CANCEL_FLAGS = { booleans: ["json"], values: [] };
const CLEANUP_FLAGS = { booleans: ["all-finished", "apply", "json"], values: [] };

function refuse(code, reason, nextSteps = [], docs = null) {
  process.stderr.write(formatRefusal({ code, reason, nextSteps, docs }));
  process.exit(2);
}

function printUsage() {
  process.stdout.write([
    "Usage:",
    "  cursor-companion.mjs setup [--json]",
    "  cursor-companion.mjs dispatch [--wait|--background] [--isolated|--in-place] [--resume <jobId>|--fresh] [--model <m>] [--mode plan|ask|agent] [--plan-only] [--worktree-base <ref>] [--include-dirty] <prompt>",
    "  cursor-companion.mjs status [--all] [--json]",
    "  cursor-companion.mjs result [jobId] [--json]",
    "  cursor-companion.mjs cancel [jobId] [--json]",
    "  cursor-companion.mjs cleanup [jobId|--all-finished] [--apply] [--json]",
    "  cursor-companion.mjs dispatch-resume-candidate [--json]"
  ].join("\n") + "\n");
}

function which(binary) {
  const r = spawnSync("which", [binary], { encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function detectAgent() {
  const binary = which("agent") ?? which("cursor-agent");
  if (!binary) return { binary: null, version: null, loggedIn: false, account: null };
  let version = null, loggedIn = false, account = null;
  try { version = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(); } catch {}
  try {
    const status = execFileSync(binary, ["status"], { encoding: "utf8" });
    if (/Logged in/.test(status)) {
      loggedIn = true;
      const m = status.match(/Logged in as ([^\s\n]+)/);
      if (m) account = m[1];
    }
  } catch {}
  return { binary, version, loggedIn, account };
}

function resolveAgentBinary() {
  if (process.env.CURSOR_COMPANION_AGENT_BINARY) {
    const args = [];
    if (process.env.CURSOR_COMPANION_AGENT_BINARY_ARG0) args.push(process.env.CURSOR_COMPANION_AGENT_BINARY_ARG0);
    return { binary: process.env.CURSOR_COMPANION_AGENT_BINARY, args };
  }
  const detected = which("agent") ?? which("cursor-agent");
  if (!detected) {
    throw new Error("agent binary not found. Run /cursor:setup.");
  }
  return { binary: detected, args: [] };
}

function joinPrompt(positional) {
  return positional.join(" ").trim();
}

function getClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

// codex F8 — refuse "default-to-current-session" semantics when the
// SessionStart hook never injected CURSOR_COMPANION_SESSION_ID. Otherwise
// the filter `claudeSessionId === null` quietly matches dispatch records
// from earlier hook-less invocations, which lets /cursor:cancel /
// /cursor:result act on jobs from a different Claude session. Caller
// supplies a verb name for the error message.
function requireSessionOrExplicit(verb, { explicit }) {
  if (explicit) return; // user gave --all or an explicit jobId — fine
  if (getClaudeSessionId()) return; // hook is healthy
  refuse(
    "ENOSESSION",
    `${verb}: $${SESSION_ID_ENV} is not set. Refusing the default "current session" filter so we don't act on jobs from a different Claude Code session.`,
    [
      "Start a new Claude Code session so the SessionStart hook runs and exports the env var.",
      `Or pass an explicit jobId, e.g. \`cursor-companion.mjs ${verb} <jobId>\`.`,
      `Or pass \`--all\` if you really want every Claude session's jobs (only supported by \`status\`).`
    ]
  );
}

function spawnDetachedRunJob(paramsFile, jobId, cwd) {
  const child = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    "_run-job",
    "--params-file",
    paramsFile
  ], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"]
  });
  // M4 — surface spawn failures instead of letting the reservation sit
  // in `queued` forever. Sync failure leaves child.pid === undefined; async
  // EAGAIN/ENOMEM fires the 'error' event before unref takes effect.
  // Both failure paths must also unlink paramsFile: success path relies on
  // _run-job's finally block (cursor-companion.mjs:301) to clean up, but if
  // _run-job never starts, the 0o600 tmpfile with full prompt + worktree
  // would otherwise persist in /tmp until reboot (codex follow-up).
  child.on("error", (err) => {
    try { fs.unlinkSync(paramsFile); } catch { /* already gone */ }
    try {
      upsertJob(cwd, { id: jobId, status: "failed", isError: true, result: `_run-job spawn error: ${err.message}` });
    } catch { /* state may also be unavailable; nothing more we can do */ }
  });
  if (child.pid === undefined) {
    try { fs.unlinkSync(paramsFile); } catch { /* already gone */ }
    try {
      upsertJob(cwd, { id: jobId, status: "failed", isError: true, result: "_run-job spawn failed (no pid)" });
    } catch { /* ditto */ }
    process.stderr.write("Failed to spawn _run-job background process.\n");
    process.exit(1);
  }
  child.unref();
  return child;
}

async function dispatch(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, DISPATCH_FLAGS);
  const prompt = joinPrompt(positional);
  if (!prompt) {
    refuse(
      "EMISSINGPROMPT",
      "dispatch requires a non-empty <prompt>.",
      [
        "Pass the task description as positional arguments after the flags.",
        "Example: `cursor-companion.mjs dispatch --wait \"refactor X to Y\"`."
      ]
    );
  }

  const cwd = process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    refuse(
      "ENOTGITREPO",
      `dispatch must be run inside a git repository. Current cwd has no .git: ${cwd}`,
      [
        "Change into a git repository before invoking /cursor:dispatch.",
        "If you really want to scaffold work outside a repo, run `git init` first."
      ]
    );
  }

  const claudeSessionId = getClaudeSessionId();
  const background = Boolean(options.background) && !options.wait;

  // ---------------------------------------------------------------------------
  // Sandbox mode resolution.
  //
  // Default behaviour (v0.3+): in-place — cursor edits the caller's cwd, no
  // worktree, no auto-commit. The caller (typically another agent or a human
  // watching the diff) is responsible for committing.
  //
  // `--isolated` opts into the legacy sandbox: a `.cursor/worktrees/<jobId>/`
  // worktree on a `<jobId>` branch, auto-committed on success.
  //
  // `--background` flips the default to `--isolated` (a background task and
  // a hot cwd both racing the working tree is a real footgun). Pass
  // `--in-place` alongside `--background` to override.
  //
  // `--resume` forces the mode to match the original job — you can't resume
  // an isolated thread in-place or vice versa.
  // ---------------------------------------------------------------------------
  const explicitIsolated = Boolean(options.isolated);
  const explicitInPlace = Boolean(options["in-place"]);
  if (explicitIsolated && explicitInPlace) {
    refuse(
      "EFLAGCONFLICT",
      "`--isolated` and `--in-place` are mutually exclusive.",
      [
        "Pick one: `--isolated` runs cursor in a `.cursor/worktrees/<jobId>` sandbox; `--in-place` runs in your cwd.",
        "Or omit both and let the default apply (in-place for foreground, isolated for `--background`)."
      ]
    );
  }
  if (typeof options["worktree-base"] === "string" && explicitInPlace) {
    refuse(
      "EFLAGCONFLICT",
      "`--worktree-base` only makes sense in isolated mode (it picks the ref to branch the sandbox worktree off).",
      [
        "Drop `--worktree-base`, or drop `--in-place` and add `--isolated` if you actually want a sandbox.",
        "If you wanted to start cursor from a specific branch, switch to that branch first and then dispatch in-place."
      ]
    );
  }

  // resume context lookup is read-only — the reservation below does the actual
  // conflict check inside the state lock so a concurrent dispatch cannot also
  // observe "no conflict" and proceed.
  let resumeContext = null;
  if (typeof options.resume === "string") {
    const job = loadState(cwd).jobs.find((j) => j.id === options.resume);
    if (!job) {
      refuse(
        "ERESUMENOTFOUND",
        `Cannot resume: job ${options.resume} not found in state.json for this workspace.`,
        [
          "Run `cursor-companion.mjs status --all` to see known job ids in this workspace.",
          "If you meant to start fresh, drop `--resume` (and optionally pass `--fresh`)."
        ]
      );
    }
    if (!job.cursorSessionId || !job.worktree) {
      refuse(
        "ERESUMEUNUSABLE",
        `Cannot resume ${options.resume}: the job record has no cursorSessionId or worktree — it never finished bootstrapping.`,
        [
          "Start a new dispatch instead: drop `--resume` (and optionally add `--fresh`).",
          `Inspect the broken record with \`cursor-companion.mjs result ${options.resume} --json\` if you want to know why.`
        ]
      );
    }
    const jobMode = job.mode ?? "isolated"; // legacy records have no `mode`
    if (explicitIsolated && jobMode === "in-place") {
      refuse(
        "ERESUMEMODEMISMATCH",
        `Cannot resume ${options.resume} with \`--isolated\`: the original job ran in-place (cwd=${job.worktree}). Resuming it must stay in-place.`,
        [
          "Drop `--isolated` to resume in the same in-place mode.",
          "Or start a fresh isolated dispatch by dropping `--resume` and adding `--isolated`."
        ]
      );
    }
    if (explicitInPlace && jobMode === "isolated") {
      refuse(
        "ERESUMEMODEMISMATCH",
        `Cannot resume ${options.resume} with \`--in-place\`: the original job ran in an isolated worktree (${job.worktree}). Resuming it must stay isolated.`,
        [
          "Drop `--in-place` to resume against the existing sandbox.",
          "Or start a fresh in-place dispatch by dropping `--resume`."
        ]
      );
    }
    // If --background was requested with no explicit mode and the job is
    // in-place, --background would normally imply --isolated — but resume
    // overrides that. Treat the resume's mode as authoritative.
    // codex F7 — refuse resume when the existing worktree has uncommitted
    // edits the user hasn't approved yet. cursor's auto-commit on
    // finalizeWorktree would `git add -A` and silently absorb anything the
    // user touched manually. --include-dirty is the explicit override.
    // For in-place resume, the "worktree" IS the user's cwd, so dirty status
    // is the user's own work — we still warn but allow with --wait, refuse
    // only on --background where the race is dangerous.
    if (jobMode === "isolated" && isGitRepo(job.worktree) && !options["include-dirty"]) {
      const status = gitStatusPorcelain(job.worktree).trim();
      if (status) {
        refuse(
          "EWORKTREEDIRTY",
          `Cannot resume ${options.resume}: isolated worktree ${job.worktree} has uncommitted changes.`,
          [
            `Commit or stash inside ${job.worktree} first.`,
            `Or override explicitly: re-run with \`--resume ${options.resume} --include-dirty\`.`,
            "Note: cursor's auto-commit will `git add -A` and absorb whatever is there if you proceed."
          ]
        );
      }
    }
    resumeContext = {
      cursorSessionId: job.cursorSessionId,
      worktree: job.worktree,
      branch: job.branch,
      repoRoot: job.repoRoot ?? repoRoot,
      parentJobId: job.parentJobId ?? job.id,
      mode: jobMode
    };
  }

  // Resolve sandbox mode now (resume forces the choice).
  let isolated;
  if (resumeContext) {
    isolated = resumeContext.mode === "isolated";
  } else if (explicitIsolated) {
    isolated = true;
  } else if (explicitInPlace) {
    isolated = false;
  } else {
    // Background defaults to isolated, foreground defaults to in-place.
    isolated = background;
  }

  // Resolve execution mode. Precedence:
  //   1. --mode <plan|ask|agent>  (explicit)
  //   2. --plan-only              (back-compat alias for --mode plan)
  //   3. default                  (agent mode, no --mode forwarded)
  // Read-only modes (plan, ask) drop --force so a misbehaving agent can't
  // edit files behind the user's back, and skip the auto-commit finalize step.
  let resolvedMode = null;
  if (typeof options.mode === "string") {
    if (!DISPATCH_MODES.has(options.mode)) {
      refuse(
        "EINVALIDMODE",
        `Invalid --mode "${options.mode}". Allowed values: plan, ask, agent.`,
        [
          "Use `--mode plan` for a written plan (read-only, no edits).",
          "Use `--mode ask` for Q&A only (read-only, no edits).",
          "Use `--mode agent` (or omit `--mode`) for write-capable execution."
        ]
      );
    }
    resolvedMode = options.mode === "agent" ? null : options.mode;
  } else if (options["plan-only"]) {
    resolvedMode = "plan";
  }
  const isReadOnlyMode = resolvedMode === "plan" || resolvedMode === "ask";

  // In-place dirty-cwd policy. Applies to BOTH fresh dispatches AND resumes:
  // the resume's worktree IS the user's cwd, so the same race risk applies.
  // (Isolated resume's dirty check happens earlier in the resume block and
  // refuses with EWORKTREEDIRTY; that path is unaffected here.)
  // - Background + dirty cwd: refuse. Cursor and the user editing concurrently
  //   on the same tree is a footgun.
  // - Foreground + dirty cwd: allow (user is watching the diff). No hint —
  //   stderr noise would confuse the dispatch-summary parser the slash
  //   command uses; the agent can see the working tree itself if it cares.
  if (!isolated && background && !options["include-dirty"]) {
    const status = gitStatusPorcelain(cwd).trim();
    if (status) {
      refuse(
        "EINPLACEDIRTY",
        `Refusing to start a background in-place dispatch: cwd ${cwd} has uncommitted changes, and the background agent would race your edits.`,
        [
          "Commit or stash your local changes, then re-dispatch.",
          "Or pass `--include-dirty` to acknowledge the race risk.",
          "Or pass `--isolated` to run in a sandbox worktree where the race can't happen.",
          "Or pass `--wait` to run in the foreground so you can supervise."
        ]
      );
    }
  }

  const jobId = generateJobId();
  const { binary, args: agentBinaryArgs } = resolveAgentBinary();
  const finalRepoRoot = resumeContext?.repoRoot ?? repoRoot;
  // In-place: worktree IS cwd, branch is the caller's current branch (best
  // effort — we don't fail if HEAD is detached, we just record `null`).
  // Isolated: worktree is the sandbox path, branch matches jobId.
  let finalWorktree, finalBranch;
  if (resumeContext) {
    finalWorktree = resumeContext.worktree;
    finalBranch = resumeContext.branch;
  } else if (isolated) {
    finalWorktree = path.join(finalRepoRoot, ".cursor", "worktrees", jobId);
    finalBranch = jobId;
  } else {
    finalWorktree = cwd;
    finalBranch = null;
  }
  const finalCursorSessionId = resumeContext?.cursorSessionId ?? null;
  const finalMode = isolated ? "isolated" : "in-place";

  const jobParams = {
    cwd,
    repoRoot: finalRepoRoot,
    jobId,
    prompt,
    options: {
      force: !isReadOnlyMode,
      model: typeof options.model === "string" ? options.model : null,
      mode: resolvedMode,
      baseRef: typeof options["worktree-base"] === "string" ? options["worktree-base"] : null,
      isolated
    },
    claudeSessionId,
    parentJobId: resumeContext?.parentJobId ?? null,
    cursorSessionId: finalCursorSessionId,
    worktreePath: resumeContext?.worktree ?? (isolated ? null : cwd),
    agentBinary: binary,
    agentBinaryArgs
  };

  // codex F4 — atomic reservation before any spawn. Two conflict predicates:
  //
  //   - Resume: refuse if another job on the same cursorSessionId is still
  //     queued/running. Otherwise two resumes would hit the same cursor chat
  //     simultaneously and the stream events would interleave.
  //   - Fresh in-place: refuse if another in-place dispatch is using the same
  //     cwd. Two cursor agents writing the same working tree at once is a
  //     guaranteed race. Isolated dispatches can run concurrently in their
  //     own sandbox worktrees, so we don't gate them.
  //
  // Both checks happen inside the same state lock as the write, so concurrent
  // companions can't both observe "no conflict" and both proceed.
  // Canonicalise cwd for the same-cwd check so a record stored as /var/...
  // still matches a process whose cwd resolves to /private/var/... on macOS.
  // Best-effort: if realpath fails (path was removed since the record was
  // written), fall back to the literal string.
  const canonicalCwd = (() => {
    try { return fs.realpathSync(cwd); } catch { return cwd; }
  })();
  const sameCwd = (a, b) => {
    if (a === b) return true;
    try { return fs.realpathSync(a) === b; } catch { return false; }
  };
  const conflictPredicate = resumeContext
    ? (j) =>
        j.cursorSessionId === resumeContext.cursorSessionId &&
        (j.status === "running" || j.status === "queued")
    : !isolated
      ? (j) =>
          (j.mode ?? "isolated") === "in-place" &&
          j.cwd && sameCwd(j.cwd, canonicalCwd) &&
          (j.status === "running" || j.status === "queued")
      : null;

  try {
    reserveDispatchJob(cwd, {
      id: jobId,
      kind: "dispatch",
      mode: finalMode,
      cwd,
      claudeSessionId,
      cursorSessionId: finalCursorSessionId,
      worktree: finalWorktree,
      branch: finalBranch,
      repoRoot: finalRepoRoot,
      parentJobId: resumeContext?.parentJobId ?? null,
      status: "queued",
      pid: null,
      agentPid: null,
      agentStartedAtMs: null,
      logFile: null,
      prompt,
      model: jobParams.options.model,
      result: null,
      isError: false,
      durationMs: null,
      usage: null,
      headSha: null,
      startedAt: null
    }, { conflictPredicate });
  } catch (err) {
    if (err.code === "EJOBCONFLICT") {
      const c = err.conflict;
      if (resumeContext) {
        refuse(
          "EJOBCONFLICT",
          `Cannot dispatch follow-up: job ${c.id} is still ${c.status} on cursor session ${c.cursorSessionId}. Concurrent activity on the same cursor thread would interleave.`,
          [
            `Wait for ${c.id} to finish: poll \`cursor-companion.mjs status\`.`,
            `Or cancel it: \`cursor-companion.mjs cancel ${c.id}\` then retry.`
          ]
        );
      } else {
        refuse(
          "EINPLACEBUSY",
          `Cannot start in-place dispatch: ${c.id} is already running in-place in this cwd (${c.cwd}). Two cursor agents on the same working tree would corrupt each other's edits.`,
          [
            `Wait for ${c.id} to finish: poll \`cursor-companion.mjs status\`.`,
            `Or cancel it: \`cursor-companion.mjs cancel ${c.id}\` then retry.`,
            "Or pass `--isolated` to run this dispatch in a sandbox worktree where it can't collide."
          ]
        );
      }
    }
    throw err;
  }

  if (!background) {
    const result = await runForegroundJob(jobParams);
    process.stdout.write(renderForegroundResult({ job: result }));
    process.exit(result.isError ? 1 : 0);
    return;
  }

  // Background: reservation already written above; now spawn detached child
  // which will runForegroundJob and upgrade status queued → running → done.
  // M3 — params include the full prompt and worktree path; on multi-user
  // hosts the default umask leaves /tmp files world-readable. 0o600 keeps
  // the file owner-only.
  const paramsFile = path.join(os.tmpdir(), `cursor-companion-${jobId}.json`);
  fs.writeFileSync(paramsFile, JSON.stringify(jobParams) + "\n", { encoding: "utf8", mode: 0o600 });
  spawnDetachedRunJob(paramsFile, jobId, cwd);
  process.stdout.write(renderDispatchSummary({
    id: jobId,
    cursorSessionId: finalCursorSessionId,
    worktree: finalWorktree,
    branch: finalBranch,
    mode: finalMode,
    background: true
  }));
}

async function runJob(rawArgs) {
  const { options } = parseArgs(rawArgs, { booleans: [], values: ["params-file"] });
  if (!options["params-file"]) {
    process.stderr.write("_run-job requires --params-file.\n");
    process.exit(2);
  }
  const params = JSON.parse(fs.readFileSync(options["params-file"], "utf8"));
  try {
    await runForegroundJob({
      ...params,
      env: process.env
    });
  } finally {
    try { fs.unlinkSync(options["params-file"]); } catch {}
  }
}

function status(rawArgs) {
  const { options } = parseArgs(rawArgs, STATUS_FLAGS);
  requireSessionOrExplicit("status", { explicit: Boolean(options.all) });
  const cwd = process.cwd();
  const jobs = loadState(cwd).jobs;
  if (options.json) {
    const filtered = options.all ? jobs : jobs.filter((j) => j.claudeSessionId === getClaudeSessionId());
    process.stdout.write(JSON.stringify(filtered, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderStatus(jobs, { currentSessionId: getClaudeSessionId(), showAll: Boolean(options.all) }));
}

function result(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, RESULT_FLAGS);
  requireSessionOrExplicit("result", { explicit: Boolean(positional[0]) });
  const cwd = process.cwd();
  const job = findResultJob(cwd, { jobId: positional[0] ?? null, sessionId: getClaudeSessionId() });
  if (!job) {
    const jobIdArg = positional[0];
    refuse(
      "ENOMATCHINGJOB",
      jobIdArg
        ? `No job matching id "${jobIdArg}" in this workspace.`
        : "No completed jobs in this Claude session yet.",
      [
        "Run `cursor-companion.mjs status` to see what's in this session.",
        "Run `cursor-companion.mjs status --all` to see jobs from other Claude sessions.",
        jobIdArg
          ? "Double-check the jobId — it must match a `cur-XXXXXXXX` id from state.json."
          : "If you expected a result, the job may still be running — check status first."
      ]
    );
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(job, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderJobResult(job));
}

async function cancel(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, CANCEL_FLAGS);
  requireSessionOrExplicit("cancel", { explicit: Boolean(positional[0]) });
  const cwd = process.cwd();
  const job = positional[0]
    ? findResultJob(cwd, { jobId: positional[0], sessionId: null })
    : findCancelableJob(cwd, { sessionId: getClaudeSessionId() });
  if (!job) {
    const jobIdArg = positional[0];
    refuse(
      "ENOCANCELABLEJOB",
      jobIdArg
        ? `No job matching id "${jobIdArg}" found in this workspace's state.json.`
        : "No running or queued jobs to cancel in this Claude session.",
      [
        "Run `cursor-companion.mjs status` to see what's actually running.",
        jobIdArg
          ? "Confirm the jobId matches a `cur-XXXXXXXX` value from status output."
          : "If a job ran in a different Claude session, pass its explicit jobId."
      ]
    );
  }
  const updated = cancelJob(cwd, job.id, (pid) => {
    // Liveness check before signalling — guards against PID reuse: if the
    // OS recycled this pid into someone else's process between job spawn
    // and now, we'd send SIGTERM to an unrelated process. isPidLive returns
    // false for dead pids, and the cancel still proceeds to mark the job
    // cancelled in state.json.
    if (!isPidLive(pid)) return;
    try { process.kill(pid, "SIGTERM"); } catch {}
  });
  // Auto-cleanup the sandbox for cancelled ISOLATED jobs only. The worktree
  // had no successful commit (cancel happens mid-flight), so dropping it
  // loses nothing — and it spares the user from accumulating dead sandboxes
  // under .cursor/worktrees/. In-place cancels never touch the user's cwd.
  let cleanedSandbox = false;
  if ((updated.mode ?? "isolated") === "isolated" && updated.worktree && updated.repoRoot) {
    try {
      destroyDispatchWorktree(updated.repoRoot, updated.worktree, updated.branch);
      cleanedSandbox = true;
    } catch {
      // Best-effort — caller can rerun /cursor:cleanup manually.
    }
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({ ...updated, cleanedSandbox }, null, 2) + "\n");
  } else {
    process.stdout.write(renderCancelReport(updated, { cleanedSandbox }));
  }
}

const CLEANABLE_STATUSES = new Set(["completed", "failed", "cancelled", "discarded", "merged"]);

function cleanup(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, CLEANUP_FLAGS);
  const jobIdArg = positional[0] ?? null;
  if (!jobIdArg && !options["all-finished"]) {
    refuse(
      "EMISSINGTARGET",
      "cleanup needs either a jobId or `--all-finished` to know which sandboxes to remove.",
      [
        "Pass a specific jobId: `cursor-companion.mjs cleanup cur-XXXXXXXX`.",
        "Or pass `--all-finished` to clean every completed/failed/cancelled isolated job in this workspace.",
        "Without `--apply`, cleanup runs in dry-run mode and only lists what it would remove."
      ]
    );
  }
  const cwd = process.cwd();
  const allJobs = loadState(cwd).jobs;
  let targets;
  if (jobIdArg) {
    const j = allJobs.find((x) => x.id === jobIdArg);
    if (!j) {
      refuse(
        "ENOMATCHINGJOB",
        `cleanup: no job "${jobIdArg}" in state.json for this workspace.`,
        [
          "Run `cursor-companion.mjs status --all` to see known job ids.",
          "If the sandbox was already removed, state.json may have pruned the record (50 most-recent kept) — delete the directory manually."
        ]
      );
    }
    targets = [j];
  } else {
    targets = allJobs.filter((j) => CLEANABLE_STATUSES.has(j.status) && (j.mode ?? "isolated") === "isolated");
  }
  // In-place jobs have no sandbox to remove — skip them so cleanup never
  // touches the user's cwd. We still list them in the report as "skipped".
  const plan = targets.map((j) => {
    const mode = j.mode ?? "isolated";
    if (mode !== "isolated") {
      return { id: j.id, action: "skip", reason: "in-place mode has no sandbox" };
    }
    if (!j.worktree || !j.repoRoot) {
      return { id: j.id, action: "skip", reason: "job record missing worktree/repoRoot" };
    }
    if (!CLEANABLE_STATUSES.has(j.status)) {
      return { id: j.id, action: "skip", reason: `status=${j.status} is not terminal` };
    }
    return { id: j.id, action: "remove", worktree: j.worktree, repoRoot: j.repoRoot, branch: j.branch };
  });

  if (!options.apply) {
    if (options.json) {
      process.stdout.write(JSON.stringify({ dryRun: true, plan }, null, 2) + "\n");
    } else {
      process.stdout.write(renderCleanupReport({ dryRun: true, plan }));
    }
    return;
  }

  const results = [];
  for (const item of plan) {
    if (item.action !== "remove") {
      results.push(item);
      continue;
    }
    try {
      destroyDispatchWorktree(item.repoRoot, item.worktree, item.branch);
      results.push({ ...item, action: "removed" });
    } catch (err) {
      results.push({ ...item, action: "error", error: String(err?.message ?? err) });
    }
  }
  if (options.json) {
    process.stdout.write(JSON.stringify({ dryRun: false, results }, null, 2) + "\n");
  } else {
    process.stdout.write(renderCleanupReport({ dryRun: false, plan: results }));
  }
}

function dispatchResumeCandidate(rawArgs) {
  // Output is unconditionally JSON; parseArgs is invoked only to consume
  // and validate the legacy `--json` flag the slash command still passes
  // (dispatch.md:31). No non-JSON mode exists.
  parseArgs(rawArgs, { booleans: ["json"], values: [] });
  // H2 — when no Claude session is bound (hook never ran or running outside
  // CC), refuse to surface a resume target. status/result/cancel use
  // requireSessionOrExplicit; resume has no jobId argument so the safe
  // default is "no candidate" — otherwise inSession(_, null) would match
  // jobs from foreign Claude sessions and the slash command would offer
  // them as a resume target.
  const sessionId = getClaudeSessionId();
  if (!sessionId) {
    // Soft refusal: this verb is purely advisory (the slash command uses it
    // to decide whether to offer "continue thread?"). Returning
    // `{available:false}` is the safe answer when we have no session binding,
    // not an error. We do emit a refusal line on stderr so a debugging caller
    // can see why no candidate appeared.
    process.stderr.write(formatRefusal({
      code: "ENOSESSION",
      reason: `dispatch-resume-candidate: $${SESSION_ID_ENV} is not set; not surfacing a candidate from foreign sessions.`,
      nextSteps: [
        "Treat this as advisory — the slash command will offer a fresh dispatch instead.",
        "Start a new Claude Code session if you want resume candidates from this workspace to be discoverable."
      ]
    }));
    process.stdout.write(JSON.stringify({ available: false }, null, 2) + "\n");
    return;
  }
  const cwd = process.cwd();
  const cand = findResumeCandidate(cwd, { sessionId });
  const out = cand ? { available: true, ...cand } : { available: false };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
}

// codex F2 — slash commands receive Claude Code's raw `$ARGUMENTS` value,
// which can contain `;`, `$()`, backticks, and other shell metacharacters.
// Interpolating it directly into a shell pipeline (e.g. `node companion.mjs
// dispatch $ARGUMENTS`) is a command-injection hole. Two safe transport
// options, both read+tokenise inside Node so sh never re-evaluates the
// content:
//
//   --raw-args-stdin              (PREFERRED, v0.3+)
//     The whole args blob is piped on stdin. No tempfile, no race. Use a
//     heredoc in the slash command so the prompt is not interpolated by sh:
//       node ... dispatch --raw-args-stdin <<'__END__'
//       <prompt and flags>
//       __END__
//
//   --raw-args-file <path>        (LEGACY, retained for back-compat)
//     The full args blob is written to <path> first. Companion reads it,
//     tokenises, deletes the file. Suffers from a permission-classifier
//     footgun: in autonomous/background Claude sessions, `mktemp` or `Write`
//     to /tmp may be blocked, and the caller agent can hallucinate a path
//     that was never written → ENOENT. Prefer stdin unless you have a
//     specific reason.
//
// expandRawArgs handles both. Multiple --raw-args-file flags are honoured
// in order; --raw-args-stdin is consumed at most once.
function expandRawArgs(argv) {
  const out = [];
  let stdinConsumed = false;
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === "--raw-args-stdin") {
      if (stdinConsumed) {
        refuse(
          "EFLAGCONFLICT",
          "`--raw-args-stdin` passed more than once.",
          ["Pass it at most once; the entire args blob goes on stdin in a single read."]
        );
      }
      stdinConsumed = true;
      let raw;
      try {
        raw = fs.readFileSync(0, "utf8"); // fd 0 = stdin
      } catch (err) {
        refuse(
          "ERAWARGSSTDIN",
          `--raw-args-stdin: cannot read stdin: ${err.message}`,
          [
            "Pipe the args blob: `... | node cursor-companion.mjs dispatch --raw-args-stdin`.",
            "Or use a heredoc: `node ... dispatch --raw-args-stdin <<'__END__'\\n<args>\\n__END__`."
          ]
        );
      }
      out.push(...splitRawArgumentString(raw));
      continue;
    }
    let path = null;
    if (tok === "--raw-args-file") {
      path = argv[i + 1];
      i += 1;
    } else if (tok && tok.startsWith("--raw-args-file=")) {
      path = tok.slice("--raw-args-file=".length);
    } else {
      out.push(tok);
      continue;
    }
    if (!path) {
      refuse(
        "ERAWARGSFILE",
        "--raw-args-file requires a path argument.",
        [
          "Pass the path explicitly: `--raw-args-file /tmp/foo.txt` or `--raw-args-file=/tmp/foo.txt`.",
          "Better: switch to `--raw-args-stdin` — no tempfile, no race condition. See dispatch.md."
        ]
      );
    }
    let raw;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch (err) {
      refuse(
        "ERAWARGSFILE",
        `--raw-args-file: cannot read ${path}: ${err.message}`,
        [
          "Most common cause: the caller agent wrote a path that was blocked by the permission classifier (so the file never landed). Switch to `--raw-args-stdin` to remove the filesystem dependency entirely.",
          "If you must use a tempfile, check `${CLAUDE_PLUGIN_DATA}` exists and is writable, and confirm the path was actually created before invoking companion."
        ]
      );
    }
    // Best-effort cleanup: file is single-use, owned by the slash command.
    try { fs.unlinkSync(path); } catch { /* not fatal */ }
    const tokens = splitRawArgumentString(raw);
    out.push(...tokens);
  }
  return out;
}

async function main(argv) {
  // Expand --raw-args-stdin / --raw-args-file BEFORE picking the subcommand
  // so the flag may appear anywhere on the line (including supplying the
  // subcommand itself via the transport, e.g. stdin payload =
  // "dispatch --wait \"some prompt\"").
  argv = [...argv.slice(0, 2), ...expandRawArgs(argv.slice(2))];
  const sub = argv[2];
  const rest = argv.slice(3);
  if (!sub) { printUsage(); process.exit(1); }

  switch (sub) {
    case "setup": {
      const json = rest.includes("--json");
      const r = detectAgent();
      process.stdout.write(json ? JSON.stringify(r, null, 2) + "\n" : renderSetupReport(r));
      return;
    }
    case "dispatch":              return dispatch(rest);
    case "_run-job":              return runJob(rest);
    case "status":                return status(rest);
    case "result":                return result(rest);
    case "cancel":                return cancel(rest);
    case "cleanup":               return cleanup(rest);
    case "dispatch-resume-candidate": return dispatchResumeCandidate(rest);
    default:
      process.stderr.write(`Unknown subcommand: ${sub}\n`);
      printUsage();
      process.exit(1);
  }
}

main(process.argv).catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
});
