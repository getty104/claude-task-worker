import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const RESERVED_ALL = "all";

// タスクの実行形態。"default" は従来どおり `claude -p` を子プロセスとして spawn する。
// "herdr" は herdr のタブ内で claude を TUI モードとして起動し、agent ステータスで完了を判定する。
export type RunMode = "default" | "herdr";

export const DEFAULT_RUN_MODE: RunMode = "default";

export interface UserConfig {
  mode: RunMode;
  projects: Record<string, string>;
  projectGroups: Record<string, string[]>;
}

export interface ResolvedProject {
  name: string;
  path: string;
}

export class UserConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConfigError";
  }
}

function getConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(configHome, "claude-task-worker");
}

// 設定ファイルのパスは XDG_CONFIG_HOME を実行時に参照して解決する（テストが
// 環境変数を差し替えて検証できるよう、モジュール読込時に固定しない）。
export function getUserConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseConfigFile(path: string): Record<string, unknown> | undefined {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new UserConfigError(`config file contains invalid JSON: ${path}: ${err.message}`);
    }
    throw err;
  }
}

// 設定ファイルが存在しない場合は undefined を返す（--project 未指定のワーカー起動では
// 設定ファイルが無いのが正常なため、ここでは例外にしない）。
function readRawConfig(): Record<string, unknown> | undefined {
  return parseConfigFile(getUserConfigPath());
}

function parseMode(raw: Record<string, unknown>, path: string): RunMode {
  if (!("mode" in raw)) return DEFAULT_RUN_MODE;
  const value = raw["mode"];
  if (value === "default" || value === "herdr") return value;
  console.warn(`[config] invalid mode: ${JSON.stringify(value)} in ${path}, using "${DEFAULT_RUN_MODE}"`);
  return DEFAULT_RUN_MODE;
}

export function loadUserConfig(): UserConfig {
  const path = getUserConfigPath();
  const raw = readRawConfig();
  if (raw === undefined) {
    throw new UserConfigError(`config.json not found: ${path}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new UserConfigError(`config.json must contain a JSON object: ${path}`);
  }

  if (
    !("projects" in raw) ||
    typeof raw["projects"] !== "object" ||
    raw["projects"] === null ||
    Array.isArray(raw["projects"])
  ) {
    throw new UserConfigError(`config.json must contain a "projects" section as an object: ${path}`);
  }

  if (
    "projectGroups" in raw &&
    (typeof raw["projectGroups"] !== "object" || raw["projectGroups"] === null || Array.isArray(raw["projectGroups"]))
  ) {
    throw new UserConfigError(`config.json "projectGroups" must be an object: ${path}`);
  }

  const mode = parseMode(raw, path);
  const rawProjects = raw["projects"] as Record<string, unknown>;
  const rawProjectGroups = ("projectGroups" in raw ? raw["projectGroups"] : {}) as Record<string, unknown>;

  const projectKeys = Object.keys(rawProjects);
  const groupKeys = Object.keys(rawProjectGroups);

  if (projectKeys.includes(RESERVED_ALL) || groupKeys.includes(RESERVED_ALL)) {
    throw new UserConfigError(
      `"${RESERVED_ALL}" is a reserved word and cannot be used as a key in "projects" or "projectGroups"`,
    );
  }

  const groupKeySet = new Set(groupKeys);
  const duplicateKeys = projectKeys.filter((key) => groupKeySet.has(key));
  if (duplicateKeys.length > 0) {
    throw new UserConfigError(
      `"projects" and "projectGroups" share the same key namespace; duplicate keys are not allowed: ${duplicateKeys.join(", ")}`,
    );
  }

  const projects: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawProjects)) {
    if (name === "__proto__") {
      throw new UserConfigError(`"__proto__" cannot be used as a key in "projects": ${path}`);
    }
    if (typeof value !== "string" || !isAbsolute(value)) {
      console.warn(`[config] invalid projects.${name}: expected an absolute path, skipping`);
      continue;
    }
    if (!isDirectory(value)) {
      console.warn(`[config] projects.${name} does not exist as a directory: ${value}, skipping`);
      continue;
    }
    projects[name] = value;
  }

  const projectGroups: Record<string, string[]> = {};
  for (const [groupName, value] of Object.entries(rawProjectGroups)) {
    if (groupName === "__proto__") {
      throw new UserConfigError(`"__proto__" cannot be used as a key in "projectGroups": ${path}`);
    }
    if (!Array.isArray(value)) {
      console.warn(`[config] invalid projectGroups.${groupName}: expected an array, skipping`);
      continue;
    }
    const members: string[] = [];
    for (const member of value) {
      if (typeof member !== "string" || !Object.prototype.hasOwnProperty.call(projects, member)) {
        console.warn(`[config] projectGroups.${groupName} references unknown project "${String(member)}", skipping`);
        continue;
      }
      members.push(member);
    }
    projectGroups[groupName] = members;
  }

  return { mode, projects, projectGroups };
}

// mode はプロセス起動時に確定させる。実行中に設定ファイルが書き換わっても、
// 同一タスクの「引数の組み立て（-p の有無）」と「実行経路（spawn / herdr）」が
// 食い違わないようにするため、初回の解決結果をキャッシュする。
let cachedRunMode: RunMode | undefined;

export function getRunMode(): RunMode {
  if (cachedRunMode === undefined) {
    cachedRunMode = readRunMode();
  }
  return cachedRunMode;
}

// テスト用。設定ファイルを差し替えて再解決させる。
export function resetRunModeCache(): void {
  cachedRunMode = undefined;
}

// ワーカーは `--project` 無しでも起動されるため、設定ファイルが無い・projects セクションが
// 壊れているといった理由で実行形態の判定に失敗させない。mode だけを取り出し、
// 判定できない場合は "default" を返す。
function readRunMode(): RunMode {
  let raw: Record<string, unknown> | undefined;
  try {
    raw = readRawConfig();
  } catch (err) {
    console.warn(`[config] failed to read config file, using "${DEFAULT_RUN_MODE}" mode: ${err}`);
    return DEFAULT_RUN_MODE;
  }
  if (raw === undefined) return DEFAULT_RUN_MODE;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return DEFAULT_RUN_MODE;
  }
  return parseMode(raw, getUserConfigPath());
}

// herdr モードのタブラベル（ctw:<project>:#<n>）に使うプロジェクト名を、
// 設定ファイルの projects からパスで逆引きする。見つからない場合は undefined。
// ディスパッチャー経由の起動では環境変数が優先されるため、これは単体起動時の解決手段。
export function findProjectNameByPath(path: string): string | undefined {
  let config: UserConfig;
  try {
    config = loadUserConfig();
  } catch {
    return undefined;
  }
  const target = resolve(path);
  for (const [name, projectPath] of Object.entries(config.projects)) {
    if (resolve(projectPath) === target) return name;
  }
  return undefined;
}

export function resolveTargetProjects(requested: string[], config: UserConfig): ResolvedProject[] {
  const resolved = new Map<string, ResolvedProject>();

  for (const name of requested) {
    if (name === RESERVED_ALL) {
      for (const [projectName, projectPath] of Object.entries(config.projects)) {
        resolved.set(projectName, { name: projectName, path: projectPath });
      }
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(config.projects, name)) {
      resolved.set(name, { name, path: config.projects[name] });
      continue;
    }

    if (Object.prototype.hasOwnProperty.call(config.projectGroups, name)) {
      for (const projectName of config.projectGroups[name]) {
        const projectPath = config.projects[projectName];
        if (projectPath === undefined) continue;
        resolved.set(projectName, { name: projectName, path: projectPath });
      }
      continue;
    }

    const availableProjects = Object.keys(config.projects).join(", ") || "(none)";
    const availableGroups = Object.keys(config.projectGroups).join(", ") || "(none)";
    throw new UserConfigError(
      `Unknown project or group: "${name}". Available projects: ${availableProjects}. Available groups: ${availableGroups}.`,
    );
  }

  const resolvedProjects = Array.from(resolved.values());
  if (resolvedProjects.length === 0) {
    throw new UserConfigError(`No projects resolved from requested targets: ${requested.join(", ")}`);
  }

  return resolvedProjects;
}
