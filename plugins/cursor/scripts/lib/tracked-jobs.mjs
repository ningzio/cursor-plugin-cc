import { runAgentSync } from "./cursor-cli.mjs";
import { resolveJobLogFile, upsertJob, writeJobFile } from "./state.mjs";
import { createDispatchWorktree, finalizeWorktree } from "./worktree.mjs";

export const SESSION_ID_ENV = "CURSOR_COMPANION_SESSION_ID";

function nowIso() {
  return new Date().toISOString();
}

export function defaultAgent() {
  if (process.env.CURSOR_COMPANION_AGENT_BINARY) {
    const arg0 = process.env.CURSOR_COMPANION_AGENT_BINARY_ARG0;
    return { binary: process.env.CURSOR_COMPANION_AGENT_BINARY, args: arg0 ? [arg0] : [] };
  }
  return { binary: undefined, args: [] };
}

/**
 * 前台同步执行：worktree 准备 / spawn agent / 写 log / auto-commit / 写 state.
 *
 * @param {object} args
 * @param {string} args.cwd
 * @param {string} args.repoRoot
 * @param {string} args.jobId
 * @param {string} args.prompt
 * @param {object} args.options { force, model, resume(cursorSessionId), mode, baseRef }
 * @param {string} args.claudeSessionId
 * @param {string} [args.parentJobId]
 * @param {string} [args.cursorSessionId]
 * @param {string} [args.worktreePath]
 * @param {string} [args.agentBinary]
 * @param {string[]} [args.agentBinaryArgs]
 * @param {object} [args.env]
 */
export async function runForegroundJob({
  cwd,
  repoRoot,
  jobId,
  prompt,
  options = {},
  claudeSessionId,
  parentJobId = null,
  cursorSessionId: providedSessionId = null,
  worktreePath: providedWorktree = null,
  agentBinary,
  agentBinaryArgs,
  env
}) {
  const defaultBin = defaultAgent();
  const finalBinary = agentBinary ?? defaultBin.binary;
  const finalBinaryArgs = agentBinaryArgs ?? defaultBin.args;

  let worktree = providedWorktree;
  if (!worktree) {
    worktree = createDispatchWorktree(repoRoot, jobId, { baseRef: options.baseRef });
  }

  const logFile = resolveJobLogFile(cwd, jobId);

  // codex F3: track wrapper pid (this Node process) AND agent child pid separately.
  //   - `pid`: the Node wrapper (_run-job in background, the companion in foreground).
  //     Lives until the job finishes. Killing it tears the wrapper down so it
  //     can't keep operating on state.
  //   - `agentPid`: the cursor `agent` child. Lives only while the model is
  //     actually running. Killing it interrupts the model itself.
  //   - `agentStartedAtMs`: wall-clock at spawn. Used as a weak identity check
  //     to mitigate PID reuse — if cancel is requested far in the future and
  //     the OS has reissued the same PID, the timestamp lets the caller decide
  //     to skip the kill.
  upsertJob(cwd, {
    id: jobId,
    kind: "dispatch",
    claudeSessionId,
    cursorSessionId: providedSessionId ?? null,
    worktree,
    branch: jobId,
    repoRoot,
    parentJobId,
    status: "running",
    pid: process.pid,
    agentPid: null,
    agentStartedAtMs: null,
    logFile,
    prompt,
    model: options.model ?? null,
    result: null,
    isError: false,
    durationMs: null,
    usage: null,
    headSha: null,
    startedAt: nowIso()
  });

  let captured;
  try {
    captured = await runAgentSync({
      cwd: worktree,
      prompt,
      options: {
        force: options.force ?? true,
        model: options.model ?? null,
        resume: providedSessionId ?? options.resume ?? null,
        mode: options.mode ?? null
      },
      logFile,
      agentBinary: finalBinary,
      agentBinaryArgs: finalBinaryArgs,
      env,
      onSpawn: (child) => {
        if (Number.isInteger(child?.pid) && child.pid > 1) {
          upsertJob(cwd, { id: jobId, agentPid: child.pid, agentStartedAtMs: Date.now() });
        }
      }
    });
  } catch (err) {
    upsertJob(cwd, {
      id: jobId,
      status: "failed",
      result: String(err?.message ?? err),
      isError: true,
      agentPid: null,
      agentStartedAtMs: null
    });
    throw err;
  }

  // Agent has exited; clear agentPid so cancel can't try to signal a stale id.
  upsertJob(cwd, { id: jobId, agentPid: null });

  let headSha = null;
  const shouldFinalize = options.mode !== "plan" && !captured.isError;
  if (shouldFinalize) {
    headSha = finalizeWorktree(worktree, jobId, prompt);
  }

  const finalStatus = captured.isError ? "failed" : "completed";
  const finalCursorSession = captured.sessionId ?? providedSessionId ?? null;

  const jobRecord = {
    id: jobId,
    cursorSessionId: finalCursorSession,
    status: finalStatus,
    result: captured.result,
    isError: captured.isError,
    durationMs: captured.durationMs,
    usage: captured.usage,
    headSha,
    finishedAt: nowIso()
  };
  upsertJob(cwd, jobRecord);
  writeJobFile(cwd, jobId, {
    ...jobRecord,
    prompt,
    worktree,
    branch: jobId,
    repoRoot,
    logFile,
    parentJobId
  });

  return {
    jobId,
    cursorSessionId: finalCursorSession,
    result: captured.result,
    isError: captured.isError,
    durationMs: captured.durationMs,
    headSha,
    worktree,
    logFile
  };
}
