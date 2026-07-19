import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as UserConfigModule from "./user-config";

const configHome = mkdtempSync(join(tmpdir(), "ptw-config-"));
process.env.XDG_CONFIG_HOME = configHome;

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const {
  loadUserConfig,
  resolveTargetProjects,
  UserConfigError,
  getUserConfigPath,
  getLegacyUserConfigPath,
  getRunMode,
  resetRunModeCache,
  findProjectNameByPath,
} = (await import("./user-config.ts")) as typeof UserConfigModule;

const configDir = join(configHome, "claude-task-worker");

function writeConfigFile(content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(getUserConfigPath(), content, "utf-8");
}

test("loadUserConfig throws UserConfigError when raw JSON is null", () => {
  writeConfigFile("null");
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig throws UserConfigError when raw JSON is an array", () => {
  writeConfigFile("[]");
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig throws UserConfigError when raw JSON is a string primitive", () => {
  writeConfigFile('"hello"');
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig throws UserConfigError when raw JSON is a number primitive", () => {
  writeConfigFile("42");
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig does not treat Object.prototype members as valid projectGroups members", () => {
  writeConfigFile(
    JSON.stringify({
      projects: {
        alpha: process.cwd(),
      },
      projectGroups: {
        mygroup: ["alpha", "toString", "constructor", "hasOwnProperty"],
      },
    }),
  );
  const config = loadUserConfig();
  assert.deepEqual(config.projectGroups["mygroup"], ["alpha"]);
});

test("loadUserConfig loads a valid config.json normally", () => {
  writeConfigFile(
    JSON.stringify({
      projects: {
        alpha: process.cwd(),
      },
      projectGroups: {
        mygroup: ["alpha"],
      },
    }),
  );
  const config = loadUserConfig();
  assert.deepEqual(config.projects, { alpha: process.cwd() });
  assert.deepEqual(config.projectGroups, { mygroup: ["alpha"] });
});

test("resolveTargetProjects throws UserConfigError for constructor/toString requests", () => {
  const config = {
    mode: "default" as const,
    projects: { alpha: "/tmp/alpha" },
    projectGroups: { mygroup: ["alpha"] },
  };
  assert.throws(() => resolveTargetProjects(["constructor"], config), UserConfigError);
  assert.throws(() => resolveTargetProjects(["toString"], config), UserConfigError);
  assert.throws(() => resolveTargetProjects(["hasOwnProperty"], config), UserConfigError);
});

test("resolveTargetProjects resolves known projects and groups normally", () => {
  const config = {
    mode: "default" as const,
    projects: { alpha: "/tmp/alpha", beta: "/tmp/beta" },
    projectGroups: { mygroup: ["alpha", "beta"] },
  };
  const resolved = resolveTargetProjects(["mygroup"], config);
  assert.deepEqual(resolved.map((r: { name: string }) => r.name).sort(), ["alpha", "beta"]);
});

test("loadUserConfig throws UserConfigError when projects is an array", () => {
  writeConfigFile(
    JSON.stringify({
      projects: [],
    }),
  );
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig throws UserConfigError when projects is an array with entries", () => {
  writeConfigFile(
    JSON.stringify({
      projects: ["/tmp/app"],
    }),
  );
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig throws UserConfigError when projectGroups is an array", () => {
  writeConfigFile(
    JSON.stringify({
      projects: {
        alpha: process.cwd(),
      },
      projectGroups: [["alpha"]],
    }),
  );
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("loadUserConfig throws UserConfigError when projects contains a __proto__ key", () => {
  writeConfigFile('{"projects": {"__proto__": ' + JSON.stringify(process.cwd()) + "}}");
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("resolveTargetProjects throws UserConfigError when resolution yields no projects", () => {
  const config = {
    mode: "default" as const,
    projects: {},
    projectGroups: { empty: [] },
  };
  assert.throws(() => resolveTargetProjects(["empty"], config), UserConfigError);
});

function writeLegacyConfigFile(content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(getLegacyUserConfigPath(), content, "utf-8");
}

function removeConfigFiles(): void {
  rmSync(getUserConfigPath(), { force: true });
  rmSync(getLegacyUserConfigPath(), { force: true });
  resetRunModeCache();
}

test("loadUserConfig defaults mode to default when it is not specified", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().mode, "default");
});

test("loadUserConfig accepts mode herdr", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().mode, "herdr");
});

test("loadUserConfig falls back to default for an unknown mode", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ mode: "tmux", projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().mode, "default");
});

test("loadUserConfig reads the legacy projects.json when config.json is absent", () => {
  removeConfigFiles();
  writeLegacyConfigFile(JSON.stringify({ mode: "herdr", projects: { alpha: process.cwd() } }));
  const config = loadUserConfig();
  assert.deepEqual(Object.keys(config.projects), ["alpha"]);
  assert.equal(config.mode, "herdr");
});

test("loadUserConfig prefers config.json over the legacy projects.json", () => {
  removeConfigFiles();
  writeLegacyConfigFile(JSON.stringify({ mode: "herdr", projects: { legacy: process.cwd() } }));
  writeConfigFile(JSON.stringify({ mode: "default", projects: { current: process.cwd() } }));
  const config = loadUserConfig();
  assert.deepEqual(Object.keys(config.projects), ["current"]);
  assert.equal(config.mode, "default");
});

test("getRunMode returns default when no config file exists", () => {
  removeConfigFiles();
  assert.equal(getRunMode(), "default");
});

test("getRunMode reads mode from the config file", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: {} }));
  assert.equal(getRunMode(), "herdr");
});

test("getRunMode does not fail when the projects section is broken", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: [] }));
  assert.equal(getRunMode(), "herdr");
});

test("getRunMode caches the mode resolved on first call", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: {} }));
  assert.equal(getRunMode(), "herdr");
  // 実行中に設定ファイルが書き換わっても、同一プロセス内では最初に確定した mode を保つ。
  writeConfigFile(JSON.stringify({ mode: "default", projects: {} }));
  assert.equal(getRunMode(), "herdr");
  resetRunModeCache();
  assert.equal(getRunMode(), "default");
});

test("findProjectNameByPath resolves a project name from its path", () => {
  removeConfigFiles();
  writeConfigFile(JSON.stringify({ projects: { alpha: process.cwd() } }));
  assert.equal(findProjectNameByPath(process.cwd()), "alpha");
  assert.equal(findProjectNameByPath(configHome), undefined);
});

test("cleanup temp config dir", () => {
  rmSync(configHome, { recursive: true, force: true });
});
