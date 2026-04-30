import { execFileSync } from "node:child_process";

export function resolveWorkspaceRoot(cwd) {
  return cwd;
}

export function resolveRepoRoot(cwd) {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}
