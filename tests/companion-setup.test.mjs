import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const COMPANION = path.resolve(fileURLToPath(import.meta.url), "../../plugins/cursor/scripts/cursor-companion.mjs");

test("companion without args prints usage", () => {
  const r = spawnSync(process.execPath, [COMPANION], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /Usage:/i);
});

test("companion setup --json with missing agent reports unavailable", () => {
  const r = spawnSync(process.execPath, [COMPANION, "setup", "--json"], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.binary, null);
});

// codex F2 — --raw-args-file lets slash commands hand the user's raw
// $ARGUMENTS to companion via a tempfile, never through a shell pipeline.
function makeRawArgsFile(contents) {
  const file = path.join(os.tmpdir(), `cursor-raw-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(file, contents, "utf8");
  return file;
}

test("--raw-args-file expands the file's contents into argv", () => {
  const file = makeRawArgsFile("setup --json");
  const r = spawnSync(process.execPath, [COMPANION, "--raw-args-file", file], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.binary, null);
  // companion must consume + delete the file
  assert.equal(fs.existsSync(file), false);
});

test("--raw-args-file=path equals form also works", () => {
  const file = makeRawArgsFile("setup --json");
  const r = spawnSync(process.execPath, [COMPANION, `--raw-args-file=${file}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.binary, null);
});

test("--raw-args-file preserves quoted shell-metacharacters as a single token", () => {
  // If the contents got interpreted by sh, the `;` would split the command
  // and `$(...)` would be substituted. We pass them quoted in the file —
  // splitRawArgumentString must keep them as one token.
  const file = makeRawArgsFile(`status "; echo INJECTED; $(uname) \\\` token \\\`"`);
  const r = spawnSync(process.execPath, [COMPANION, "--raw-args-file", file], {
    encoding: "utf8",
    env: { ...process.env, PATH: "/usr/bin:/bin" }
  });
  // status accepts no extra positional args but should not have invoked any
  // shell. Verify nothing in the output suggests command substitution ran.
  assert.doesNotMatch(r.stdout + r.stderr, /INJECTED/);
});

test("--raw-args-file with missing path exits non-zero", () => {
  const r = spawnSync(process.execPath, [COMPANION, "--raw-args-file", "/no/such/file/at/all"], {
    encoding: "utf8"
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /cannot read/);
});
