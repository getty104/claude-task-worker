import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface Config {
  maxConcurrentTasks: number;
}

const DEFAULT_CONFIG: Config = {
  maxConcurrentTasks: 4,
};

function loadConfig(): Config {
  const configPath = join(homedir(), ".config", "claude-task-worker.json");
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

  return result;
}

export const config = loadConfig();
