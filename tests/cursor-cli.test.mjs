import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentArgs, parseStreamLine, runAgentSync } from "../plugins/cursor/scripts/lib/cursor-cli.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fake-cursor-fixture.mjs");

test("buildAgentArgs basic", () => {
  const args = buildAgentArgs({ prompt: "hi", force: true });
  assert.deepEqual(args, [
    "--print",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "hi"
  ]);
});

test("buildAgentArgs with resume + model", () => {
  const args = buildAgentArgs({ prompt: "go", resume: "sess-x", model: "gpt-5", force: true });
  assert.deepEqual(args, [
    "--print",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--trust",
    "--force",
    "--resume", "sess-x",
    "--model", "gpt-5",
    "go"
  ]);
});

test("buildAgentArgs plan-only mode", () => {
  const args = buildAgentArgs({ prompt: "review", mode: "plan" });
  assert.deepEqual(args, [
    "--print",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--trust",
    "--mode", "plan",
    "review"
  ]);
});

test("buildAgentArgs ask mode", () => {
  const args = buildAgentArgs({ prompt: "explain", mode: "ask" });
  assert.deepEqual(args, [
    "--print",
    "--output-format", "stream-json",
    "--stream-partial-output",
    "--trust",
    "--mode", "ask",
    "explain"
  ]);
});

test("parseStreamLine returns null for blank", () => {
  assert.equal(parseStreamLine(""), null);
  assert.equal(parseStreamLine("   "), null);
});

test("parseStreamLine parses JSON", () => {
  const evt = parseStreamLine('{"type":"result","is_error":false}');
  assert.equal(evt.type, "result");
});

test("parseStreamLine returns null on bad JSON", () => {
  assert.equal(parseStreamLine("{not json"), null);
});

test("runAgentSync captures session_id and result with fixture", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp-test-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = await runAgentSync({
      cwd: dir,
      prompt: "do it",
      options: { force: true },
      logFile: path.join(dir, "log"),
      agentBinary: process.execPath,
      agentBinaryArgs: [FIXTURE],
      env: { ...process.env, FAKE_CURSOR_SESSION_ID: "sess-test", FAKE_CURSOR_RESULT: "all good" }
    });
    assert.equal(out.sessionId, "sess-test");
    assert.equal(out.result, "all good");
    assert.equal(out.isError, false);
    assert.ok(out.durationMs > 0);
    assert.ok(fs.existsSync(path.join(dir, "log")));
    const logged = fs.readFileSync(path.join(dir, "log"), "utf8");
    assert.ok(logged.includes("sess-test"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runAgentSync surfaces is_error", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp-test-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = await runAgentSync({
      cwd: dir,
      prompt: "boom",
      options: { force: true },
      logFile: path.join(dir, "log"),
      agentBinary: process.execPath,
      agentBinaryArgs: [FIXTURE],
      env: { ...process.env, FAKE_CURSOR_FAIL: "1" }
    });
    assert.equal(out.isError, true);
    assert.equal(out.sawResultEvent, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// codex F6 — crash before result event must be marked isError
test("runAgentSync flags isError when no result event was emitted", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp-test-" + Date.now() + "-noresult");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = await runAgentSync({
      cwd: dir,
      prompt: "die",
      options: { force: true },
      logFile: path.join(dir, "log"),
      agentBinary: process.execPath,
      agentBinaryArgs: [FIXTURE],
      env: { ...process.env, FAKE_CURSOR_EXIT_BEFORE_RESULT: "1" }
    });
    assert.equal(out.sawResultEvent, false);
    assert.equal(out.isError, true);
    assert.notEqual(out.exitCode, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// codex F6 — non-zero exit code overrides result event saying success
test("runAgentSync treats non-zero exit as isError even if result event was clean", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".tmp-test-" + Date.now() + "-exit");
  fs.mkdirSync(dir, { recursive: true });
  try {
    const out = await runAgentSync({
      cwd: dir,
      prompt: "ok-but-nonzero",
      options: { force: true },
      logFile: path.join(dir, "log"),
      agentBinary: process.execPath,
      agentBinaryArgs: [FIXTURE],
      env: { ...process.env, FAKE_CURSOR_EXIT_CODE: "2" }
    });
    assert.equal(out.sawResultEvent, true);
    assert.equal(out.exitCode, 2);
    assert.equal(out.isError, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
