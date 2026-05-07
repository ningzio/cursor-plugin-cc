import fs from "node:fs";
import path from "node:path";

import {
  deleteBranch,
  gitAddAll,
  gitCommit,
  revParseHead,
  worktreeAdd,
  worktreeRemove
} from "./git.mjs";

const GITIGNORE_ENTRY = ".cursor/worktrees/";
const COMMIT_PROMPT_LIMIT = 60;
// codex F9 — file system errors that mean ".gitignore is not writable for us"
// rather than "something is broken". Anything in this set triggers fallback
// to .git/info/exclude (which is private to the local repo and never read-only
// in normal git checkouts).
const READONLY_ERROR_CODES = new Set(["EACCES", "EPERM", "EROFS"]);

export function resolveWorktreePath(repoRoot, jobId) {
  return path.join(repoRoot, ".cursor", "worktrees", jobId);
}

function appendIgnoreLine(target, entry) {
  let existing = "";
  if (fs.existsSync(target)) {
    existing = fs.readFileSync(target, "utf8");
  }
  const lines = existing.split(/\r?\n/);
  if (lines.some((l) => l.trim() === entry)) return false;
  const sep = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(target, `${existing}${sep}${entry}\n`, "utf8");
  return true;
}

// Returns one of:
//   { kind: "gitignore", path: <abs> }    — wrote (or confirmed) .gitignore
//   { kind: "exclude",   path: <abs> }    — fell back to .git/info/exclude
// or throws if neither location is writable.
export function ensureGitignore(repoRoot) {
  const gitignore = path.join(repoRoot, ".gitignore");
  try {
    appendIgnoreLine(gitignore, GITIGNORE_ENTRY);
    return { kind: "gitignore", path: gitignore };
  } catch (err) {
    if (!READONLY_ERROR_CODES.has(err.code)) throw err;
    // codex F9 fallback — .gitignore is read-only / not ours; .git/info/exclude
    // is per-checkout, untracked, and writable on every normal git checkout.
    const excludeDir = path.join(repoRoot, ".git", "info");
    const exclude = path.join(excludeDir, "exclude");
    try {
      fs.mkdirSync(excludeDir, { recursive: true });
      appendIgnoreLine(exclude, GITIGNORE_ENTRY);
      return { kind: "exclude", path: exclude };
    } catch (excludeErr) {
      const wrap = new Error(
        `ensureGitignore: cannot write either ${gitignore} (${err.code}) ` +
        `or ${exclude} (${excludeErr.code ?? "?"}). dispatch refuses to ` +
        `proceed because the worktree path would be tracked by git.`
      );
      wrap.code = "EIGNOREUNWRITABLE";
      wrap.causes = [err, excludeErr];
      throw wrap;
    }
  }
}

export function createDispatchWorktree(repoRoot, jobId, { baseRef = null } = {}) {
  ensureGitignore(repoRoot);
  const wt = resolveWorktreePath(repoRoot, jobId);
  fs.mkdirSync(path.dirname(wt), { recursive: true });
  worktreeAdd(repoRoot, jobId, wt, baseRef);
  return wt;
}

function shortPrompt(prompt) {
  const normalized = String(prompt ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  if (normalized.length <= COMMIT_PROMPT_LIMIT) return normalized;
  return `${normalized.slice(0, COMMIT_PROMPT_LIMIT - 3)}...`;
}

export function finalizeWorktree(worktreePath, jobId, prompt) {
  gitAddAll(worktreePath);
  const message = `[${jobId}] ${shortPrompt(prompt)}`.trim();
  const sha = gitCommit(worktreePath, message);
  return sha ?? revParseHead(worktreePath);
}

export function destroyDispatchWorktree(repoRoot, worktreePath, branch) {
  worktreeRemove(repoRoot, worktreePath, { force: true });
  if (branch) deleteBranch(repoRoot, branch, { force: true });
  // 清理空 .cursor/worktrees 目录
  try {
    fs.rmdirSync(path.dirname(worktreePath));
    fs.rmdirSync(path.dirname(path.dirname(worktreePath)));
  } catch {
    // 非空目录忽略
  }
}
