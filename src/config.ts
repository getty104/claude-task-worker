import { readFileSync } from "node:fs";
import { join } from "node:path";

export type WorkerName =
  | "exec-issue"
  | "answer-issue-questions"
  | "create-issue"
  | "update-issue"
  | "triage-issue"
  | "fix-review-point"
  | "check-dependabot"
  | "triage-pr";

export interface WorkerRuntimeConfig {
  model: string;
  effort: string;
}

interface Config {
  maxConcurrentTasks: number;
  fixReviewPointCallbackCommentMessage?: string;
  workers: Record<string, WorkerRuntimeConfig>;
}

export const DEFAULT_WORKER_CONFIG: WorkerRuntimeConfig = {
  model: "sonnet",
  effort: "high",
};

export const WORKER_DEFAULTS: Record<string, WorkerRuntimeConfig> = {
  "answer-issue-questions": { model: "opus", effort: "high" },
  "create-issue": { model: "opus", effort: "high" },
  "update-issue": { model: "sonnet", effort: "high" },
  "exec-issue": { model: "sonnet", effort: "high" },
  "fix-review-point": { model: "sonnet", effort: "high" },
  "triage-issue": { model: "sonnet", effort: "high" },
  "triage-pr": { model: "sonnet", effort: "high" },
  "check-dependabot": { model: "sonnet", effort: "high" },
};

export const DEFAULT_CONFIG: Config = {
  maxConcurrentTasks: 2,
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

  if ("maxConcurrentTasks" in raw) {
    const val = raw["maxConcurrentTasks"];
    if (typeof val !== "number" || !Number.isInteger(val) || val <= 0) {
      console.warn(`[config] invalid maxConcurrentTasks: ${val}, using default ${DEFAULT_CONFIG.maxConcurrentTasks}`);
    } else {
      result.maxConcurrentTasks = val;
    }
  }

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
