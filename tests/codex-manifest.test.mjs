import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const RELEASE_VERSION = "0.2.3";
const PLUGIN_ROOT = "plugins/cursor";

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

test("Codex plugin manifest describes the cursor plugin and existing component paths", () => {
  const manifest = readJson(`${PLUGIN_ROOT}/.codex-plugin/plugin.json`);

  assert.equal(manifest.name, "cursor");
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.hooks, "./hooks/hooks.json");

  for (const componentPath of [
    manifest.skills,
    manifest.hooks,
    "./commands/",
    "./agents/",
    "./scripts/cursor-companion.mjs"
  ]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, PLUGIN_ROOT, componentPath)),
      `expected Codex plugin component path to exist: ${componentPath}`
    );
  }

  assert.equal(manifest.interface.displayName, "Cursor Agent");
  assert.equal(manifest.interface.developerName, "ningzio");
  assert.equal(manifest.interface.category, "Coding");
  assert.deepEqual(manifest.interface.capabilities, ["Interactive", "Read", "Write"]);
});

test("release version is consistent across package and plugin manifests", () => {
  const packageJson = readJson("package.json");
  const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
  const claudePluginManifest = readJson(`${PLUGIN_ROOT}/.claude-plugin/plugin.json`);
  const codexPluginManifest = readJson(`${PLUGIN_ROOT}/.codex-plugin/plugin.json`);

  assert.equal(packageJson.version, RELEASE_VERSION);
  assert.equal(claudeMarketplace.metadata.version, RELEASE_VERSION);
  assert.equal(claudeMarketplace.plugins[0].version, RELEASE_VERSION);
  assert.equal(claudePluginManifest.version, RELEASE_VERSION);
  assert.equal(codexPluginManifest.version, RELEASE_VERSION);
});

test("Claude Code marketplace points the cursor plugin at plugins/cursor", () => {
  const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
  const plugin = claudeMarketplace.plugins.find((entry) => entry.name === "cursor");

  assert.ok(plugin, "expected Claude marketplace entry for cursor");
  assert.equal(plugin.source, `./${PLUGIN_ROOT}`);
});

test("Codex marketplace installs the standard plugins/cursor plugin root", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json");
  const plugin = marketplace.plugins.find((entry) => entry.name === "cursor");

  assert.equal(marketplace.name, "cursor-plugin-cc");
  assert.equal(marketplace.interface.displayName, "Cursor Plugin CC");
  assert.ok(plugin, "expected marketplace entry for cursor");
  assert.deepEqual(plugin.source, { source: "local", path: `./${PLUGIN_ROOT}` });
  assert.equal(plugin.policy.installation, "AVAILABLE");
  assert.equal(plugin.policy.authentication, "ON_INSTALL");
  assert.equal(plugin.category, "Coding");
});
