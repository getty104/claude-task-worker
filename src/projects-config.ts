import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const RESERVED_ALL = "all";

export interface ProjectsConfig {
  projects: Record<string, string>;
  projectGroups: Record<string, string[]>;
}

export interface ResolvedProject {
  name: string;
  path: string;
}

export class ProjectsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectsConfigError";
  }
}

function getProjectsConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  const configHome = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(configHome, "claude-task-worker", "projects.json");
}

export const PROJECTS_CONFIG_PATH = getProjectsConfigPath();

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function loadProjectsConfig(): ProjectsConfig {
  const configPath = PROJECTS_CONFIG_PATH;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectsConfigError(`projects.json not found: ${configPath}`);
    }
    if (err instanceof SyntaxError) {
      throw new ProjectsConfigError(`projects.json contains invalid JSON: ${configPath}: ${err.message}`);
    }
    throw err;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProjectsConfigError(`projects.json must contain a JSON object: ${configPath}`);
  }

  if (
    !("projects" in raw) ||
    typeof raw["projects"] !== "object" ||
    raw["projects"] === null ||
    Array.isArray(raw["projects"])
  ) {
    throw new ProjectsConfigError(`projects.json must contain a "projects" section as an object: ${configPath}`);
  }

  if (
    "projectGroups" in raw &&
    (typeof raw["projectGroups"] !== "object" || raw["projectGroups"] === null || Array.isArray(raw["projectGroups"]))
  ) {
    throw new ProjectsConfigError(`projects.json "projectGroups" must be an object: ${configPath}`);
  }

  const rawProjects = raw["projects"] as Record<string, unknown>;
  const rawProjectGroups = ("projectGroups" in raw ? raw["projectGroups"] : {}) as Record<string, unknown>;

  const projectKeys = Object.keys(rawProjects);
  const groupKeys = Object.keys(rawProjectGroups);

  if (projectKeys.includes(RESERVED_ALL) || groupKeys.includes(RESERVED_ALL)) {
    throw new ProjectsConfigError(
      `"${RESERVED_ALL}" is a reserved word and cannot be used as a key in "projects" or "projectGroups"`,
    );
  }

  const groupKeySet = new Set(groupKeys);
  const duplicateKeys = projectKeys.filter((key) => groupKeySet.has(key));
  if (duplicateKeys.length > 0) {
    throw new ProjectsConfigError(
      `"projects" and "projectGroups" share the same key namespace; duplicate keys are not allowed: ${duplicateKeys.join(", ")}`,
    );
  }

  const projects: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawProjects)) {
    if (name === "__proto__") {
      throw new ProjectsConfigError(`"__proto__" cannot be used as a key in "projects": ${configPath}`);
    }
    if (typeof value !== "string" || !isAbsolute(value)) {
      console.warn(`[projects-config] invalid projects.${name}: expected an absolute path, skipping`);
      continue;
    }
    if (!isDirectory(value)) {
      console.warn(`[projects-config] projects.${name} does not exist as a directory: ${value}, skipping`);
      continue;
    }
    projects[name] = value;
  }

  const projectGroups: Record<string, string[]> = {};
  for (const [groupName, value] of Object.entries(rawProjectGroups)) {
    if (groupName === "__proto__") {
      throw new ProjectsConfigError(`"__proto__" cannot be used as a key in "projectGroups": ${configPath}`);
    }
    if (!Array.isArray(value)) {
      console.warn(`[projects-config] invalid projectGroups.${groupName}: expected an array, skipping`);
      continue;
    }
    const members: string[] = [];
    for (const member of value) {
      if (typeof member !== "string" || !Object.prototype.hasOwnProperty.call(projects, member)) {
        console.warn(
          `[projects-config] projectGroups.${groupName} references unknown project "${String(member)}", skipping`,
        );
        continue;
      }
      members.push(member);
    }
    projectGroups[groupName] = members;
  }

  return { projects, projectGroups };
}

export function resolveTargetProjects(requested: string[], config: ProjectsConfig): ResolvedProject[] {
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
    throw new ProjectsConfigError(
      `Unknown project or group: "${name}". Available projects: ${availableProjects}. Available groups: ${availableGroups}.`,
    );
  }

  const resolvedProjects = Array.from(resolved.values());
  if (resolvedProjects.length === 0) {
    throw new ProjectsConfigError(`No projects resolved from requested targets: ${requested.join(", ")}`);
  }

  return resolvedProjects;
}
