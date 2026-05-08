import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { resolveRepoRoot, resolveWorkspaceRoot } from "../plugins/cursor/scripts/lib/workspace.mjs";
import { withTempDir } from "./helpers.mjs";

test("resolveWorkspaceRoot returns the cwd path", () => {
  withTempDir((dir) => {
    assert.equal(resolveWorkspaceRoot(dir), dir);
  });
});

test("resolveRepoRoot finds git repo root", () => {
  withTempDir((dir) => {
    execSync("git init -q", { cwd: dir });
    const sub = path.join(dir, "a/b/c");
    execSync(`mkdir -p ${sub}`);
    const root = resolveRepoRoot(sub);
    // On macOS, git returns realpath (via /private symlink), so we need to resolve both
    const resolvedRoot = fs.realpathSync(root);
    const resolvedDir = fs.realpathSync(dir);
    assert.equal(resolvedRoot, resolvedDir);
  });
});

test("resolveRepoRoot returns null outside git", () => {
  withTempDir((dir) => {
    assert.equal(resolveRepoRoot(dir), null);
  });
});
