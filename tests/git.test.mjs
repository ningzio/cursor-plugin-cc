import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  gitAddAll,
  gitCommit,
  gitDiffShortstat,
  gitStatusPorcelain,
  isAncestor,
  isGitRepo,
  revParseHead
} from "../plugins/cursor/scripts/lib/git.mjs";
import { withTempDir } from "./helpers.mjs";

function initRepo(dir) {
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t.t", { cwd: dir });
  execSync("git config user.name test", { cwd: dir });
}

function commitFile(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content);
  execSync("git add -A", { cwd: dir });
  execSync(`git commit -q -m "${msg}"`, { cwd: dir });
  return revParseHead(dir);
}

test("isGitRepo true inside repo", () => {
  withTempDir((dir) => {
    initRepo(dir);
    assert.equal(isGitRepo(dir), true);
  });
});

test("isGitRepo false outside", () => {
  withTempDir((dir) => {
    assert.equal(isGitRepo(dir), false);
  });
});

test("revParseHead returns sha after commit", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const sha = commitFile(dir, "a.txt", "x", "init");
    assert.match(sha, /^[a-f0-9]{40}$/);
  });
});

test("isAncestor true when sha is ancestor", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const sha1 = commitFile(dir, "a.txt", "1", "c1");
    commitFile(dir, "a.txt", "2", "c2");
    assert.equal(isAncestor(dir, sha1), true);
  });
});

test("isAncestor false for unrelated sha", () => {
  withTempDir((dir) => {
    initRepo(dir);
    commitFile(dir, "a.txt", "1", "c1");
    assert.equal(isAncestor(dir, "0".repeat(40)), false);
  });
});

test("gitStatusPorcelain reports untracked", () => {
  withTempDir((dir) => {
    initRepo(dir);
    commitFile(dir, "a.txt", "x", "c1");
    fs.writeFileSync(path.join(dir, "b.txt"), "y");
    const out = gitStatusPorcelain(dir);
    assert.match(out, /^\?\? b\.txt/m);
  });
});

test("gitAddAll + gitCommit succeed when there are changes", () => {
  withTempDir((dir) => {
    initRepo(dir);
    commitFile(dir, "a.txt", "x", "c1");
    fs.writeFileSync(path.join(dir, "b.txt"), "y");
    gitAddAll(dir);
    const sha = gitCommit(dir, "[cur-x] add b");
    assert.match(sha, /^[a-f0-9]{40}$/);
  });
});

test("gitCommit returns null when nothing staged", () => {
  withTempDir((dir) => {
    initRepo(dir);
    commitFile(dir, "a.txt", "x", "c1");
    gitAddAll(dir);
    assert.equal(gitCommit(dir, "noop"), null);
  });
});

test("gitDiffShortstat returns summary", () => {
  withTempDir((dir) => {
    initRepo(dir);
    commitFile(dir, "a.txt", "x\n", "c1");
    fs.writeFileSync(path.join(dir, "a.txt"), "x\ny\n");
    const out = gitDiffShortstat(dir);
    assert.match(out, /1 file changed/);
  });
});
