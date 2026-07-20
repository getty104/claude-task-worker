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
  getRunMode,
  resetRunModeCache,
  getHeadroomEnabled,
  resetHeadroomCache,
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
    headroom: false,
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
    headroom: false,
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
    headroom: false,
    projects: {},
    projectGroups: { empty: [] },
  };
  assert.throws(() => resolveTargetProjects(["empty"], config), UserConfigError);
});

function removeConfigFile(): void {
  rmSync(getUserConfigPath(), { force: true });
  resetRunModeCache();
  resetHeadroomCache();
}

test("loadUserConfig defaults mode to default when it is not specified", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().mode, "default");
});

test("loadUserConfig accepts mode herdr", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().mode, "herdr");
});

test("loadUserConfig falls back to default for an unknown mode", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ mode: "tmux", projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().mode, "default");
});

test("loadUserConfig throws UserConfigError when config.json does not exist", () => {
  removeConfigFile();
  assert.throws(() => loadUserConfig(), UserConfigError);
});

test("getRunMode returns default when no config file exists", () => {
  removeConfigFile();
  assert.equal(getRunMode(), "default");
});

test("getRunMode reads mode from the config file", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: {} }));
  assert.equal(getRunMode(), "herdr");
});

test("getRunMode does not fail when the projects section is broken", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: [] }));
  assert.equal(getRunMode(), "herdr");
});

test("getRunMode caches the mode resolved on first call", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ mode: "herdr", projects: {} }));
  assert.equal(getRunMode(), "herdr");
  // 実行中に設定ファイルが書き換わっても、同一プロセス内では最初に確定した mode を保つ。
  writeConfigFile(JSON.stringify({ mode: "default", projects: {} }));
  assert.equal(getRunMode(), "herdr");
  resetRunModeCache();
  assert.equal(getRunMode(), "default");
});

test("loadUserConfig defaults headroom to false when it is not specified", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().headroom, false);
});

test("loadUserConfig accepts headroom true", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ headroom: true, projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().headroom, true);
});

test("loadUserConfig falls back to false for a non-boolean headroom", () => {
  removeConfigFile();
  // "true" as a string must not enable headroom silently.
  writeConfigFile(JSON.stringify({ headroom: "true", projects: { alpha: process.cwd() } }));
  assert.equal(loadUserConfig().headroom, false);
});

test("getHeadroomEnabled returns false when no config file exists", () => {
  removeConfigFile();
  assert.equal(getHeadroomEnabled(), false);
});

test("getHeadroomEnabled reads headroom from the config file", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ headroom: true, projects: {} }));
  assert.equal(getHeadroomEnabled(), true);
});

test("getHeadroomEnabled does not fail when the projects section is broken", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ headroom: true, projects: [] }));
  assert.equal(getHeadroomEnabled(), true);
});

test("getHeadroomEnabled caches the value resolved on first call", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ headroom: true, projects: {} }));
  assert.equal(getHeadroomEnabled(), true);
  // 実行中に設定ファイルが書き換わっても、同一プロセス内では最初に確定した値を保つ。
  writeConfigFile(JSON.stringify({ headroom: false, projects: {} }));
  assert.equal(getHeadroomEnabled(), true);
  resetHeadroomCache();
  assert.equal(getHeadroomEnabled(), false);
});

test("findProjectNameByPath resolves a project name from its path", () => {
  removeConfigFile();
  writeConfigFile(JSON.stringify({ projects: { alpha: process.cwd() } }));
  assert.equal(findProjectNameByPath(process.cwd()), "alpha");
  assert.equal(findProjectNameByPath(configHome), undefined);
});

test("cleanup temp config dir", () => {
  rmSync(configHome, { recursive: true, force: true });
});
