import { test } from "node:test";
import assert from "node:assert/strict";
import type * as PluginPathModule from "./plugin-path";

const { resolveInstallPath } = (await import("./plugin-path")) as typeof PluginPathModule;

test("resolveInstallPath returns the user-scope installPath", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: {
      "claude-task-worker@claude-task-worker": [
        { scope: "project", installPath: "/proj/path" },
        { scope: "user", installPath: "/home/user/.claude/plugins/claude-task-worker" },
      ],
    },
  });
  assert.equal(resolveInstallPath(json), "/home/user/.claude/plugins/claude-task-worker");
});

test("resolveInstallPath falls back to the first entry when no user scope exists", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: {
      "claude-task-worker@claude-task-worker": [{ scope: "project", installPath: "/proj/path" }],
    },
  });
  assert.equal(resolveInstallPath(json), "/proj/path");
});

test("resolveInstallPath returns undefined when the plugin key is missing", () => {
  const json = JSON.stringify({ version: 2, plugins: {} });
  assert.equal(resolveInstallPath(json), undefined);
});

test("resolveInstallPath returns undefined for an empty entry list", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: { "claude-task-worker@claude-task-worker": [] },
  });
  assert.equal(resolveInstallPath(json), undefined);
});

test("resolveInstallPath returns undefined for malformed JSON", () => {
  assert.equal(resolveInstallPath("{not valid json"), undefined);
});

test("resolveInstallPath returns undefined when installPath is missing", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: { "claude-task-worker@claude-task-worker": [{ scope: "user" }] },
  });
  assert.equal(resolveInstallPath(json), undefined);
});

test("resolveInstallPath returns undefined when entries is not an array", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: { "claude-task-worker@claude-task-worker": { scope: "user", installPath: "/x" } },
  });
  assert.equal(resolveInstallPath(json), undefined);
});

test("resolveInstallPath returns undefined for a null entry", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: { "claude-task-worker@claude-task-worker": [null] },
  });
  assert.equal(resolveInstallPath(json), undefined);
});

test("resolveInstallPath returns undefined when installPath is not a string", () => {
  const json = JSON.stringify({
    version: 2,
    plugins: { "claude-task-worker@claude-task-worker": [{ scope: "user", installPath: 123 }] },
  });
  assert.equal(resolveInstallPath(json), undefined);
});
