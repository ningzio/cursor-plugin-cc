import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_BINARY = "agent";

export function buildAgentArgs({ prompt, resume = null, model = null, mode = null, force = false } = {}) {
  const out = ["--print", "--output-format", "stream-json", "--stream-partial-output", "--trust"];
  if (force) out.push("--force");
  if (mode) out.push("--mode", mode);
  if (resume) out.push("--resume", resume);
  if (model) out.push("--model", model);
  out.push(prompt ?? "");
  return out;
}

export function parseStreamLine(line) {
  if (!line || !line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function spawnAgent({
  cwd,
  prompt,
  options = {},
  agentBinary = DEFAULT_BINARY,
  agentBinaryArgs = [],
  env = process.env
}) {
  const args = [...agentBinaryArgs, ...buildAgentArgs({ prompt, ...options })];
  return spawn(agentBinary, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false
  });
}

/**
 * 同步消费整个 stream，写 logFile，返回最终结果。
 *
 * 失败判定（codex F6）：仅当 agent 干净退出（exitCode === 0）并发出过 `result` 事件
 * 且事件未声明错误时，才返回 isError=false。crash / SIGKILL / 流在 result 之前断
 * 都会被标 isError=true，避免把崩溃的运行误标 completed 后还触发 auto-commit。
 */
export async function runAgentSync({
  cwd,
  prompt,
  options = {},
  logFile,
  agentBinary,
  agentBinaryArgs,
  env,
  onEvent = null,
  onSpawn = null
}) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a");
  const proc = spawnAgent({ cwd, prompt, options, agentBinary, agentBinaryArgs, env });
  if (onSpawn) {
    try {
      onSpawn(proc);
    } catch {
      // ignore caller errors so we still consume the stream
    }
  }

  let sessionId = null;
  let resultText = null;
  let resultEventIsError = false;
  let sawResultEvent = false;
  let durationMs = 0;
  let usage = null;

  const rl = readline.createInterface({ input: proc.stdout });
  const stderrChunks = [];

  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk) => {
    stderrChunks.push(chunk);
    fs.writeSync(logFd, `[stderr] ${chunk}`);
  });

  rl.on("line", (line) => {
    fs.writeSync(logFd, line + "\n");
    const evt = parseStreamLine(line);
    if (!evt) return;
    if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
      sessionId = evt.session_id;
    }
    if (evt.type === "result") {
      sawResultEvent = true;
      resultText = typeof evt.result === "string" ? evt.result : JSON.stringify(evt.result ?? "");
      resultEventIsError = Boolean(evt.is_error);
      durationMs = evt.duration_ms ?? 0;
      usage = evt.usage ?? null;
    }
    if (onEvent) onEvent(evt);
  });

  await new Promise((resolve) => {
    proc.on("close", () => resolve());
    proc.on("error", () => resolve());
  });
  // readline may still have a queued 'line' that fires after 'close'; flush.
  await new Promise((r) => setImmediate(r));
  fs.closeSync(logFd);

  const exitCode = proc.exitCode;
  const exitSignal = proc.signalCode ?? null;
  const cleanExit = exitCode === 0 && exitSignal == null;
  const isError = !cleanExit || !sawResultEvent || resultEventIsError;

  return {
    sessionId,
    result: resultText,
    isError,
    durationMs,
    usage,
    exitCode,
    exitSignal,
    sawResultEvent,
    stderr: stderrChunks.join("")
  };
}
