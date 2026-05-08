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
import {
  renderCancelReport,
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
  booleans: ["wait", "background", "fresh", "plan-only", "include-dirty", "json"],
  values: ["resume", "model", "worktree-base", "mode"]
};
// cursor-agent --mode only accepts plan|ask. "agent" is the implicit default and
// must NOT be forwarded as a flag — we accept it here purely so callers can
// state the choice explicitly, then map it to null downstream.
const DISPATCH_MODES = new Set(["plan", "ask", "agent"]);
const STATUS_FLAGS = { booleans: ["all", "json"], values: [] };
const RESULT_FLAGS = { booleans: ["json"], values: [] };
const CANCEL_FLAGS = { booleans: ["json"], values: [] };

function printUsage() {
  process.stdout.write([
    "Usage:",
    "  cursor-companion.mjs setup [--json]",
    "  cursor-companion.mjs dispatch [--wait|--background] [--resume <jobId>|--fresh] [--model <m>] [--mode plan|ask|agent] [--plan-only] [--worktree-base <ref>] <prompt>",
    "  cursor-companion.mjs status [--all] [--json]",
    "  cursor-companion.mjs result [jobId] [--json]",
    "  cursor-companion.mjs cancel [jobId] [--json]",
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
  process.stderr.write(
    `${verb}: $${SESSION_ID_ENV} is not set, refusing the default "current session" filter.\n` +
    `Either start a new Claude Code session so the SessionStart hook runs, ` +
    `or pass an explicit jobId / --all.\n`
  );
  process.exit(2);
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
    process.stderr.write("dispatch requires a prompt.\n");
    process.exit(2);
  }

  const cwd = process.cwd();
  const repoRoot = resolveRepoRoot(cwd);
  if (!repoRoot) {
    process.stderr.write("dispatch must be run inside a git repository.\n");
    process.exit(2);
  }

  const claudeSessionId = getClaudeSessionId();
  const background = Boolean(options.background) && !options.wait;

  // resume context lookup is read-only — the reservation below does the actual
  // conflict check inside the state lock so a concurrent dispatch cannot also
  // observe "no conflict" and proceed.
  let resumeContext = null;
  if (typeof options.resume === "string") {
    const job = loadState(cwd).jobs.find((j) => j.id === options.resume);
    if (!job) {
      process.stderr.write(`Cannot resume: job ${options.resume} not found.\n`);
      process.exit(2);
    }
    if (!job.cursorSessionId || !job.worktree) {
      process.stderr.write(`Cannot resume ${options.resume}: missing cursorSessionId or worktree.\n`);
      process.exit(2);
    }
    // codex F7 — refuse resume when the existing worktree has uncommitted
    // edits the user hasn't approved yet. cursor's auto-commit on
    // finalizeWorktree would `git add -A` and silently absorb anything the
    // user touched manually. --include-dirty is the explicit override.
    if (job.worktree && isGitRepo(job.worktree) && !options["include-dirty"]) {
      const status = gitStatusPorcelain(job.worktree).trim();
      if (status) {
        process.stderr.write(
          `Cannot resume ${options.resume}: worktree ${job.worktree} has uncommitted changes:\n` +
          status + "\n" +
          `Commit, stash, or run /cursor:dispatch --resume ${options.resume} --include-dirty to override.\n`
        );
        process.exit(2);
      }
    }
    resumeContext = {
      cursorSessionId: job.cursorSessionId,
      worktree: job.worktree,
      branch: job.branch,
      repoRoot: job.repoRoot ?? repoRoot,
      parentJobId: job.parentJobId ?? job.id
    };
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
      process.stderr.write(`Invalid --mode "${options.mode}". Allowed: plan, ask, agent.\n`);
      process.exit(2);
    }
    resolvedMode = options.mode === "agent" ? null : options.mode;
  } else if (options["plan-only"]) {
    resolvedMode = "plan";
  }
  const isReadOnlyMode = resolvedMode === "plan" || resolvedMode === "ask";

  const jobId = generateJobId();
  const { binary, args: agentBinaryArgs } = resolveAgentBinary();
  const finalRepoRoot = resumeContext?.repoRoot ?? repoRoot;
  const finalWorktree = resumeContext?.worktree ?? path.join(finalRepoRoot, ".cursor", "worktrees", jobId);
  const finalCursorSessionId = resumeContext?.cursorSessionId ?? null;

  const jobParams = {
    cwd,
    repoRoot: finalRepoRoot,
    jobId,
    prompt,
    options: {
      force: !isReadOnlyMode,
      model: typeof options.model === "string" ? options.model : null,
      mode: resolvedMode,
      baseRef: typeof options["worktree-base"] === "string" ? options["worktree-base"] : null
    },
    claudeSessionId,
    parentJobId: resumeContext?.parentJobId ?? null,
    cursorSessionId: finalCursorSessionId,
    worktreePath: resumeContext?.worktree ?? null,
    agentBinary: binary,
    agentBinaryArgs
  };

  // codex F4 — atomic reservation before any spawn. For resume, conflict
  // predicate refuses if another job on the same cursorSessionId is still
  // queued/running. For fresh dispatch, cursorSessionId is null so no
  // conflict is possible — the reservation is purely a placeholder so
  // /cursor:status shows it immediately and a follow-up resume against the
  // same chat (when the agent eventually emits its session_id) is blocked.
  try {
    reserveDispatchJob(cwd, {
      id: jobId,
      kind: "dispatch",
      claudeSessionId,
      cursorSessionId: finalCursorSessionId,
      worktree: finalWorktree,
      branch: jobId,
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
    }, {
      conflictPredicate: resumeContext
        ? (j) =>
            j.cursorSessionId === resumeContext.cursorSessionId &&
            (j.status === "running" || j.status === "queued")
        : null
    });
  } catch (err) {
    if (err.code === "EJOBCONFLICT") {
      const c = err.conflict;
      process.stderr.write(
        `Cannot dispatch follow-up: ${c.id} is still ${c.status} on cursorSessionId ${c.cursorSessionId}.\n` +
        `Wait, or run /cursor:cancel ${c.id} first.\n`
      );
      process.exit(2);
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
    branch: jobId,
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
    process.stderr.write("No matching job.\n");
    process.exit(1);
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(job, null, 2) + "\n");
    return;
  }
  process.stdout.write(renderJobResult(job));
}

function cancel(rawArgs) {
  const { options, positional } = parseArgs(rawArgs, CANCEL_FLAGS);
  requireSessionOrExplicit("cancel", { explicit: Boolean(positional[0]) });
  const cwd = process.cwd();
  const job = positional[0]
    ? findResultJob(cwd, { jobId: positional[0], sessionId: null })
    : findCancelableJob(cwd, { sessionId: getClaudeSessionId() });
  if (!job) {
    process.stderr.write("No cancelable job.\n");
    process.exit(1);
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
  if (options.json) {
    process.stdout.write(JSON.stringify(updated, null, 2) + "\n");
  } else {
    process.stdout.write(renderCancelReport(updated));
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
    process.stderr.write(
      `dispatch-resume-candidate: $${SESSION_ID_ENV} is not set; not surfacing a candidate from foreign sessions.\n`
    );
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
// dispatch $ARGUMENTS`) is a command-injection hole. The fix is to write
// $ARGUMENTS to a tempfile and pass `--raw-args-file <path>` to companion;
// the file is read and tokenised inside Node, never re-evaluated by sh.
//
// expandRawArgsFile finds any `--raw-args-file <path>` (or `--raw-args-file=<path>`)
// in argv, replaces it in-place with the file's tokenised contents, and
// removes the original file. Multiple flags are honoured in order.
function expandRawArgsFile(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
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
      process.stderr.write("--raw-args-file requires a path argument.\n");
      process.exit(2);
    }
    let raw;
    try {
      raw = fs.readFileSync(path, "utf8");
    } catch (err) {
      process.stderr.write(`--raw-args-file: cannot read ${path}: ${err.message}\n`);
      process.exit(2);
    }
    // Best-effort cleanup: file is single-use, owned by the slash command.
    try { fs.unlinkSync(path); } catch { /* not fatal */ }
    const tokens = splitRawArgumentString(raw);
    out.push(...tokens);
  }
  return out;
}

async function main(argv) {
  // Expand --raw-args-file BEFORE picking the subcommand so the flag may
  // appear anywhere on the line (including supplying the subcommand itself
  // via the file, e.g. file contents = "dispatch --wait \"some prompt\"").
  argv = [...argv.slice(0, 2), ...expandRawArgsFile(argv.slice(2))];
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
