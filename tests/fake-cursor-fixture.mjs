#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const sessionId = process.env.FAKE_CURSOR_SESSION_ID || "fake-sess-" + Math.random().toString(36).slice(2, 10);
const result = process.env.FAKE_CURSOR_RESULT || "ok";
const delay = Number(process.env.FAKE_CURSOR_DELAY_MS || 0);
const fail = Boolean(process.env.FAKE_CURSOR_FAIL);
const touch = process.env.FAKE_CURSOR_TOUCH_FILE;
// FAKE_CURSOR_EXIT_BEFORE_RESULT=1 simulates a crash mid-stream: emit init+user
// then exit non-zero without emitting `result`. Used to verify F6 (cursor-cli
// must mark such runs as isError, not completed).
const exitBeforeResult = Boolean(process.env.FAKE_CURSOR_EXIT_BEFORE_RESULT);
const exitCode = process.env.FAKE_CURSOR_EXIT_CODE != null ? Number(process.env.FAKE_CURSOR_EXIT_CODE) : null;
const cwd = process.cwd();

async function emit(line) {
  process.stdout.write(JSON.stringify(line) + "\n");
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
}

async function main() {
  const prompt = process.argv[process.argv.length - 1];

  await emit({ type: "system", subtype: "init", apiKeySource: "login", cwd, session_id: sessionId, model: "Auto", permissionMode: "default" });
  await emit({ type: "user", message: { role: "user", content: [{ type: "text", text: prompt ?? "" }] }, session_id: sessionId });

  if (exitBeforeResult) {
    process.exit(exitCode ?? 137); // simulate SIGKILL-style exit before result event
  }

  if (touch) {
    const target = path.join(cwd, touch);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "fake-cursor wrote this\n");
  }

  await emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: result }] }, session_id: sessionId });
  await emit({
    type: "result",
    subtype: fail ? "error" : "success",
    duration_ms: 100 + delay * 3,
    duration_api_ms: 100,
    is_error: fail,
    result,
    session_id: sessionId,
    request_id: "fake-req",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
  });
  process.exit(exitCode ?? (fail ? 1 : 0));
}

main();
