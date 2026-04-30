import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempDir(prefix = "cursor-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function withTempDir(fn) {
  const dir = makeTempDir();
  try {
    return fn(dir);
  } finally {
    cleanupDir(dir);
  }
}

export function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
