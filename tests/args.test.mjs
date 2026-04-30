import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, splitRawArgumentString } from "../scripts/lib/args.mjs";

const config = {
  booleans: ["wait", "background", "fresh", "all", "json", "plan-only"],
  values: ["resume", "model", "worktree-base"]
};

test("parses positional args", () => {
  const { positional } = parseArgs(["hello", "world"], config);
  assert.deepEqual(positional, ["hello", "world"]);
});

test("parses boolean flags", () => {
  const { options, positional } = parseArgs(["--wait", "do thing"], config);
  assert.equal(options.wait, true);
  assert.deepEqual(positional, ["do thing"]);
});

test("parses --key value", () => {
  const { options } = parseArgs(["--model", "gpt-5", "task"], config);
  assert.equal(options.model, "gpt-5");
});

test("parses --key=value", () => {
  const { options } = parseArgs(["--resume=cur-abc"], config);
  assert.equal(options.resume, "cur-abc");
});

test("optional value flag with no value following", () => {
  const { options } = parseArgs(["--resume", "--background"], config);
  assert.equal(options.resume, true);
  assert.equal(options.background, true);
});

test("splitRawArgumentString respects double quotes", () => {
  assert.deepEqual(splitRawArgumentString(`--wait "hello world" foo`), ["--wait", "hello world", "foo"]);
});

test("splitRawArgumentString handles single quotes", () => {
  assert.deepEqual(splitRawArgumentString(`--model gpt-5 'a b'`), ["--model", "gpt-5", "a b"]);
});

test("unknown flags are kept as positional", () => {
  const { positional } = parseArgs(["--unknown", "task"], config);
  assert.deepEqual(positional, ["--unknown", "task"]);
});
