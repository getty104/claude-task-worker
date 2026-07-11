import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ProjectsConfigModule from "./projects-config";

const configHome = mkdtempSync(join(tmpdir(), "ptw-config-"));
process.env.XDG_CONFIG_HOME = configHome;

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する一方、
// tsc --noEmit（npm run build）は allowImportingTsExtensions が無効なため
// 静的import文中の .ts 拡張子指定子を許容せず失敗する。両立のため、
// TSの静的解析対象にならない動的文字列結合でパスを構築している。
const projectsConfigModulePath = ["./projects-config", "ts"].join(".");
const { loadProjectsConfig, resolveTargetProjects, ProjectsConfigError, PROJECTS_CONFIG_PATH } = (await import(
  projectsConfigModulePath
)) as typeof ProjectsConfigModule;

const configDir = join(configHome, "claude-task-worker");

function writeConfigFile(content: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(PROJECTS_CONFIG_PATH, content, "utf-8");
}

test("loadProjectsConfig throws ProjectsConfigError when raw JSON is null", () => {
  writeConfigFile("null");
  assert.throws(() => loadProjectsConfig(), ProjectsConfigError);
});

test("loadProjectsConfig throws ProjectsConfigError when raw JSON is an array", () => {
  writeConfigFile("[]");
  assert.throws(() => loadProjectsConfig(), ProjectsConfigError);
});

test("loadProjectsConfig throws ProjectsConfigError when raw JSON is a string primitive", () => {
  writeConfigFile('"hello"');
  assert.throws(() => loadProjectsConfig(), ProjectsConfigError);
});

test("loadProjectsConfig throws ProjectsConfigError when raw JSON is a number primitive", () => {
  writeConfigFile("42");
  assert.throws(() => loadProjectsConfig(), ProjectsConfigError);
});

test("loadProjectsConfig does not treat Object.prototype members as valid projectGroups members", () => {
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
  const config = loadProjectsConfig();
  assert.deepEqual(config.projectGroups["mygroup"], ["alpha"]);
});

test("loadProjectsConfig loads a valid projects.json normally", () => {
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
  const config = loadProjectsConfig();
  assert.deepEqual(config.projects, { alpha: process.cwd() });
  assert.deepEqual(config.projectGroups, { mygroup: ["alpha"] });
});

test("resolveTargetProjects throws ProjectsConfigError for constructor/toString requests", () => {
  const config = {
    projects: { alpha: "/tmp/alpha" },
    projectGroups: { mygroup: ["alpha"] },
  };
  assert.throws(() => resolveTargetProjects(["constructor"], config), ProjectsConfigError);
  assert.throws(() => resolveTargetProjects(["toString"], config), ProjectsConfigError);
  assert.throws(() => resolveTargetProjects(["hasOwnProperty"], config), ProjectsConfigError);
});

test("resolveTargetProjects resolves known projects and groups normally", () => {
  const config = {
    projects: { alpha: "/tmp/alpha", beta: "/tmp/beta" },
    projectGroups: { mygroup: ["alpha", "beta"] },
  };
  const resolved = resolveTargetProjects(["mygroup"], config);
  assert.deepEqual(resolved.map((r) => r.name).sort(), ["alpha", "beta"]);
});

test("cleanup temp config dir", () => {
  rmSync(configHome, { recursive: true, force: true });
});
