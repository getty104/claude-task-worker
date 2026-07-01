import { readFileSync } from "node:fs";
import { join } from "node:path";

export type WorkerName =
  | "exec-issue"
  | "answer-issue-questions"
  | "create-issue"
  | "update-issue"
  | "triage-created-issue"
  | "fix-review-point"
  | "check-dependabot"
  | "triage-pr"
  | "resolve-conflict"
  | "epic-issue";

export interface WorkerRuntimeConfig {
  skill: string;
  model: string;
  effort: string;
  pollingIntervalSeconds: number;
  cooldownSeconds: number;
  maxConcurrentTasks: number;
}

interface Config {
  fixReviewPointCallbackCommentMessage?: string;
  workers: Record<string, WorkerRuntimeConfig>;
}

export const DEFAULT_WORKER_CONFIG: WorkerRuntimeConfig = {
  skill: "",
  model: "sonnet",
  effort: "xhigh",
  pollingIntervalSeconds: 60,
  cooldownSeconds: 0,
  maxConcurrentTasks: 1,
};

export const WORKER_DEFAULTS: Record<string, WorkerRuntimeConfig> = {
  "answer-issue-questions": { skill: "/base-tools:answer-issue-questions", model: "opus", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "create-issue": { skill: "/base-tools:create-issue-from-issue-number", model: "opus", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "update-issue": { skill: "/base-tools:update-issue", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "exec-issue": { skill: "/base-tools:exec-issue", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "fix-review-point": { skill: "/base-tools:fix-review-point", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "triage-created-issue": { skill: "/base-tools:triage-created-issue", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "triage-pr": { skill: "/base-tools:triage-pr", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "resolve-conflict": { skill: "/base-tools:resolve-pr-conflict", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 60, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "check-dependabot": { skill: "/base-tools:check-dependabot", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 3600, cooldownSeconds: 0, maxConcurrentTasks: 1 },
  "epic-issue": { skill: "/base-tools:create-epic-pr", model: "sonnet", effort: "xhigh", pollingIntervalSeconds: 300, cooldownSeconds: 0, maxConcurrentTasks: 1 },
};

export const DEFAULT_CONFIG: Config = {
  fixReviewPointCallbackCommentMessage: "",
  workers: {},
};

export const CONFIG_PATH = join(process.cwd(), "claude-task-worker.json");

function defaultsFor(name: string): WorkerRuntimeConfig {
  return WORKER_DEFAULTS[name] ?? DEFAULT_WORKER_CONFIG;
}

function parseWorkerEntry(name: string, val: unknown): WorkerRuntimeConfig | null {
  const base = defaultsFor(name);
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    console.warn(`[config] invalid workers.${name}: expected object, using defaults`);
    return null;
  }
  const entry = val as Record<string, unknown>;
  const result: WorkerRuntimeConfig = { ...base };
  if ("skill" in entry) {
    if (typeof entry.skill === "string" && entry.skill.length > 0) {
      result.skill = entry.skill;
    } else {
      console.warn(`[config] invalid workers.${name}.skill: ${String(entry.skill)}, using default ${base.skill}`);
    }
  }
  if ("model" in entry) {
    if (typeof entry.model === "string" && entry.model.length > 0) {
      result.model = entry.model;
    } else {
      console.warn(`[config] invalid workers.${name}.model: ${String(entry.model)}, using default ${base.model}`);
    }
  }
  if ("effort" in entry) {
    if (typeof entry.effort === "string" && entry.effort.length > 0) {
      result.effort = entry.effort;
    } else {
      console.warn(`[config] invalid workers.${name}.effort: ${String(entry.effort)}, using default ${base.effort}`);
    }
  }
  if ("pollingIntervalSeconds" in entry) {
    const val = entry.pollingIntervalSeconds;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      result.pollingIntervalSeconds = val;
    } else {
      console.warn(
        `[config] invalid workers.${name}.pollingIntervalSeconds: ${String(val)}, using default ${base.pollingIntervalSeconds}`,
      );
    }
  }
  if ("cooldownSeconds" in entry) {
    const val = entry.cooldownSeconds;
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      result.cooldownSeconds = val;
    } else {
      console.warn(
        `[config] invalid workers.${name}.cooldownSeconds: ${String(val)}, using default ${base.cooldownSeconds}`,
      );
    }
  }
  if ("maxConcurrentTasks" in entry) {
    const val = entry.maxConcurrentTasks;
    if (typeof val === "number" && Number.isInteger(val) && val > 0) {
      result.maxConcurrentTasks = val;
    } else {
      console.warn(
        `[config] invalid workers.${name}.maxConcurrentTasks: ${String(val)}, using default ${base.maxConcurrentTasks}`,
      );
    }
  }
  return result;
}

export function loadConfig(): Config {
  const configPath = CONFIG_PATH;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG, workers: {} };
    }
    throw err;
  }

  const result: Config = { ...DEFAULT_CONFIG, workers: {} };

  if ("fixReviewPointCallbackCommentMessage" in raw) {
    const val = raw["fixReviewPointCallbackCommentMessage"];
    if (typeof val === "string") {
      result.fixReviewPointCallbackCommentMessage = val;
    }
  }

  if ("workers" in raw) {
    const workers = raw["workers"];
    if (typeof workers !== "object" || workers === null || Array.isArray(workers)) {
      console.warn(`[config] invalid workers: expected object, ignoring`);
    } else {
      for (const [name, val] of Object.entries(workers as Record<string, unknown>)) {
        const parsed = parseWorkerEntry(name, val);
        if (parsed) result.workers[name] = parsed;
      }
    }
  }

  return result;
}

export function getWorkerConfig(workerName: string): WorkerRuntimeConfig {
  const config = loadConfig();
  return config.workers[workerName] ?? { ...defaultsFor(workerName) };
}
