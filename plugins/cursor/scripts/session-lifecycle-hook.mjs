#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { updateState } from "./lib/state.mjs";
import { isPidLive, isSafePid } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";

const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

// codex F8/F10 — appendEnvVar must NEVER silently no-op when CLAUDE_ENV_FILE
// is missing: that turns a misconfigured plugin install into "session
// filtering quietly broken", which is exactly the failure mode F8 fixes
// in the companion. We fail loudly so the user notices at install time.
function appendEnvVar(envFile, name, value) {
  if (value == null || value === "") return;
  fs.appendFileSync(envFile, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

// Reject pid <= 1 to avoid POSIX broadcast semantics: kill(0) hits the
// caller's process group, kill(-1) hits all user processes (logs the user
// out), kill(-N) hits process group N. M2 — also do an isPidLive liveness
// check so a recycled pid (whose original child died and the kernel handed
// the number to an unrelated process) isn't signalled. Mirrors what
// cancelJob does on the explicit-cancel path.
function killTree(pid) {
  if (!isSafePid(pid)) return;
  if (!isPidLive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // pid disappeared between the liveness probe and the signal — fine.
  }
}

function handleSessionStart(input) {
  // codex F8/F10 — Claude Code only sets CLAUDE_ENV_FILE for SessionStart
  // hooks that are wired up correctly. If it's missing, the hook is
  // installed wrong (or running outside CC) and downstream subcommands
  // would silently fall back to the dangerous "match jobs with null
  // sessionId" path. Refuse to proceed.
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) {
    throw new Error(
      "CLAUDE_ENV_FILE is not set. The cursor plugin's SessionStart hook " +
      "must be invoked by Claude Code so it can export CURSOR_COMPANION_SESSION_ID. " +
      "If you're testing locally, set CLAUDE_ENV_FILE to a writable path."
    );
  }
  appendEnvVar(envFile, SESSION_ID_ENV, input.session_id);
  appendEnvVar(envFile, PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!sessionId) return;
  // H1 — must run inside the state-lock contract (state.mjs:186): a bare
  // load → mutate → save races with companion's reserveDispatchJob /
  // upsertJob, dropping concurrent updates. updateState wraps the whole
  // read-modify-write in withStateLock.
  updateState(cwd, (state) => {
    for (const job of state.jobs) {
      if (job.claudeSessionId !== sessionId) continue;
      if (job.status === "running" || job.status === "queued") {
        killTree(job.agentPid);
        killTree(job.pid);
      }
    }
    state.jobs = state.jobs.filter((j) => j.claudeSessionId !== sessionId);
  });
}

async function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";
  if (eventName === "SessionStart") return handleSessionStart(input);
  if (eventName === "SessionEnd") return handleSessionEnd(input);
}

main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`);
  process.exit(1);
});
