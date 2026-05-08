import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  createDispatchWorktree,
  ensureGitignore,
  finalizeWorktree,
  resolveWorktreePath,
  destroyDispatchWorktree
} from "../plugins/cursor/scripts/lib/worktree.mjs";
import { withTempDir } from "./helpers.mjs";

function initRepo(dir) {
  execSync("git init -q -b main", { cwd: dir });
  execSync("git config user.email t@t.t", { cwd: dir });
  execSync("git config user.name t", { cwd: dir });
  fs.writeFileSync(path.join(dir, "a.txt"), "x");
  execSync("git add -A && git commit -q -m init", { cwd: dir });
}

test("resolveWorktreePath produces .cursor/worktrees/<jobId>", () => {
  const p = resolveWorktreePath("/repo", "cur-1");
  assert.equal(p, "/repo/.cursor/worktrees/cur-1");
});

test("ensureGitignore creates .gitignore with entry", () => {
  withTempDir((dir) => {
    initRepo(dir);
    ensureGitignore(dir);
    const txt = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    assert.ok(txt.includes(".cursor/worktrees/"));
  });
});

test("ensureGitignore does not duplicate entry", () => {
  withTempDir((dir) => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, ".gitignore"), ".cursor/worktrees/\n");
    ensureGitignore(dir);
    const txt = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    assert.equal(txt.match(/\.cursor\/worktrees\//g).length, 1);
  });
});

test("createDispatchWorktree creates worktree and branch", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const wt = createDispatchWorktree(dir, "cur-1");
    assert.ok(fs.existsSync(wt));
    assert.equal(wt, path.join(dir, ".cursor/worktrees/cur-1"));
    const branches = execSync("git branch", { cwd: dir, encoding: "utf8" });
    assert.ok(branches.includes("cur-1"));
  });
});

test("finalizeWorktree commits and returns sha", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const wt = createDispatchWorktree(dir, "cur-1");
    fs.writeFileSync(path.join(wt, "new.txt"), "hello");
    const sha = finalizeWorktree(wt, "cur-1", "do thing");
    assert.match(sha, /^[a-f0-9]{40}$/);
    const log = execSync("git log -1 --pretty=%s", { cwd: wt, encoding: "utf8" }).trim();
    assert.match(log, /^\[cur-1\] do thing$/);
  });
});

test("finalizeWorktree returns existing HEAD when no changes", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const wt = createDispatchWorktree(dir, "cur-1");
    const sha = finalizeWorktree(wt, "cur-1", "noop");
    const head = execSync("git rev-parse HEAD", { cwd: wt, encoding: "utf8" }).trim();
    assert.equal(sha, head);
  });
});

test("finalizeWorktree truncates long prompts", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const wt = createDispatchWorktree(dir, "cur-1");
    fs.writeFileSync(path.join(wt, "x.txt"), "y");
    const long = "a".repeat(200);
    finalizeWorktree(wt, "cur-1", long);
    const log = execSync("git log -1 --pretty=%s", { cwd: wt, encoding: "utf8" }).trim();
    assert.ok(log.length <= 80);
  });
});

test("destroyDispatchWorktree removes worktree and branch", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const wt = createDispatchWorktree(dir, "cur-1");
    fs.writeFileSync(path.join(wt, "x.txt"), "y");
    finalizeWorktree(wt, "cur-1", "test");
    destroyDispatchWorktree(dir, wt, "cur-1");
    assert.ok(!fs.existsSync(wt));
    const branches = execSync("git branch", { cwd: dir, encoding: "utf8" });
    assert.ok(!branches.includes("cur-1"));
  });
});

// codex F9 — fallback when .gitignore is read-only
test("ensureGitignore returns kind:gitignore on the writable path", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const result = ensureGitignore(dir);
    assert.equal(result.kind, "gitignore");
    assert.ok(result.path.endsWith(".gitignore"));
  });
});

test("ensureGitignore falls back to .git/info/exclude when .gitignore is read-only", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const gitignore = path.join(dir, ".gitignore");
    fs.writeFileSync(gitignore, "# existing\n");
    fs.chmodSync(gitignore, 0o444);
    try {
      const result = ensureGitignore(dir);
      assert.equal(result.kind, "exclude");
      assert.ok(result.path.endsWith(".git/info/exclude"));
      const exclude = fs.readFileSync(result.path, "utf8");
      assert.match(exclude, /\.cursor\/worktrees\//);
      const gitignoreContents = fs.readFileSync(gitignore, "utf8");
      assert.equal(gitignoreContents, "# existing\n");
    } finally {
      fs.chmodSync(gitignore, 0o644);
    }
  });
});

test("ensureGitignore throws EIGNOREUNWRITABLE when both targets unwritable", () => {
  withTempDir((dir) => {
    initRepo(dir);
    const gitignore = path.join(dir, ".gitignore");
    fs.writeFileSync(gitignore, "# existing\n");
    fs.chmodSync(gitignore, 0o444);
    // git init creates .git/info/exclude with a default template; chmod the
    // file itself to 0o444 so writeFileSync to it raises EACCES.
    const infoDir = path.join(dir, ".git", "info");
    fs.mkdirSync(infoDir, { recursive: true });
    const exclude = path.join(infoDir, "exclude");
    if (!fs.existsSync(exclude)) fs.writeFileSync(exclude, "# git default\n");
    fs.chmodSync(exclude, 0o444);
    fs.chmodSync(infoDir, 0o555);
    try {
      assert.throws(() => ensureGitignore(dir), (err) => err.code === "EIGNOREUNWRITABLE");
    } finally {
      fs.chmodSync(infoDir, 0o755);
      fs.chmodSync(exclude, 0o644);
      fs.chmodSync(gitignore, 0o644);
    }
  });
});
