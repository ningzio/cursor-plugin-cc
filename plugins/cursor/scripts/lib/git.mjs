import { execFileSync, spawnSync } from "node:child_process";

function runGit(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    const err = new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
    err.stderr = result.stderr;
    err.status = result.status;
    throw err;
  }
  return result;
}

export function isGitRepo(cwd) {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim() === "true";
}

export function revParseHead(cwd) {
  return runGit(cwd, ["rev-parse", "HEAD"]).stdout.trim();
}

export function isAncestor(cwd, sha, ref = "HEAD") {
  const r = spawnSync("git", ["-C", cwd, "merge-base", "--is-ancestor", sha, ref], { encoding: "utf8" });
  return r.status === 0;
}

export function gitStatusPorcelain(cwd) {
  return runGit(cwd, ["status", "--porcelain"]).stdout;
}

export function gitDiffShortstat(cwd, ref = null) {
  const args = ["diff", "--shortstat"];
  if (ref) args.push(ref);
  return runGit(cwd, args).stdout.trim();
}

export function gitAddAll(cwd) {
  runGit(cwd, ["add", "-A"]);
}

export function gitCommit(cwd, message) {
  // 没有 staged 改动时返回 null
  const diff = spawnSync("git", ["-C", cwd, "diff", "--cached", "--quiet"], { encoding: "utf8" });
  if (diff.status === 0) return null;
  execFileSync(
    "git",
    ["-C", cwd, "-c", "user.name=cursor-plugin", "-c", "user.email=cursor@plugin", "commit", "-m", message],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  return revParseHead(cwd);
}

export function worktreeAdd(cwd, branch, worktreePath, baseRef = null) {
  const args = ["worktree", "add", "-b", branch, worktreePath];
  if (baseRef) args.push(baseRef);
  runGit(cwd, args);
}

export function worktreeRemove(cwd, worktreePath, { force = false } = {}) {
  const args = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(worktreePath);
  runGit(cwd, args, { allowFailure: true });
}

export function deleteBranch(cwd, branch, { force = true } = {}) {
  const flag = force ? "-D" : "-d";
  runGit(cwd, ["branch", flag, branch], { allowFailure: true });
}
