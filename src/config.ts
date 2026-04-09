import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Config {
  maxConcurrentTasks: number;
  fixReviewPointCallbackCommentMessage?: string;
}

export const DEFAULT_CONFIG: Config = {
  maxConcurrentTasks: 4,
};

export const CONFIG_PATH = join(homedir(), ".config", "claude-task-worker.json");

function loadConfig(): Config {
  const configPath = CONFIG_PATH;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG };
    }
    throw err;
  }

  const result: Config = { ...DEFAULT_CONFIG };

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

  return result;
}

export const config = loadConfig();
