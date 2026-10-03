import { existsSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { isWorkerDefinition, type WorkerDefinition } from "./workers/worker-definition";

export interface CustomWorker {
  definition: WorkerDefinition;
  source: string;
}

export interface LoadedWorkerFile {
  path: string;
  definitions: WorkerDefinition[];
  missing?: boolean;
  error?: string;
}

// フックのソースを文字列で持つのは、esbuild バンドル後に別ファイル参照が壊れないようにするため。
const HOOKS_SOURCE = `
let libUrl;
export function initialize(data) { libUrl = data.libUrl; }
export async function resolve(specifier, context, next) {
  if (specifier === "claude-task-worker/lib") return { url: libUrl, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  if (url.startsWith("file:") && (url.endsWith(".ts") || url.endsWith(".mts"))) {
    const { readFile } = await import("node:fs/promises");
    const { stripTypeScriptTypes } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const source = stripTypeScriptTypes(await readFile(fileURLToPath(url), "utf8"));
    return { format: "module", source, shortCircuit: true };
  }
  return next(url, context);
}
`;

let hooksRegistered = false;

// CLI 自身の lib を読ませるのは、process-manager の台帳・worktree の直列化・設定キャッシュを
// カスタムワーカーと共有するため（別コピーを読むとプロセス内状態が分裂する）。
function registerHooks(): void {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const libFile = import.meta.url.endsWith(".ts") ? "./lib.ts" : "./lib.js";
  register(`data:text/javascript,${encodeURIComponent(HOOKS_SOURCE)}`, {
    parentURL: import.meta.url,
    data: { libUrl: new URL(libFile, import.meta.url).href },
  });
}

export function validateCustomWorkers(loaded: readonly LoadedWorkerFile[], presetNames: readonly string[]): string[] {
  const errors: string[] = [];
  const owners = new Map<string, string>();
  for (const file of loaded) {
    if (file.missing) {
      errors.push(`workerFiles: ${file.path} does not exist. Fix the path in claude-task-worker.json or remove it.`);
      continue;
    }
    if (file.error !== undefined) {
      errors.push(
        `workerFiles: failed to load ${file.path}: ${file.error}. Fix the file or remove it from workerFiles.`,
      );
      continue;
    }
    if (file.definitions.length === 0) {
      errors.push(
        `workerFiles: ${file.path} exports no worker definition. Export the result of createIssuePollingWorker / createPrPollingWorker / createScheduledWorker / defineWorker.`,
      );
      continue;
    }
    for (const { name } of file.definitions) {
      if (presetNames.includes(name)) {
        errors.push(
          `workerFiles: ${file.path} defines worker "${name}", which collides with a preset worker. Rename it.`,
        );
        continue;
      }
      const owner = owners.get(name);
      if (owner !== undefined) {
        errors.push(
          `workerFiles: ${file.path} defines worker "${name}", which is already defined in ${owner}. Rename one of them.`,
        );
        continue;
      }
      owners.set(name, file.path);
    }
  }
  return errors;
}

export async function loadCustomWorkers(
  paths: readonly string[],
  presetNames: readonly string[],
): Promise<{ workers: CustomWorker[]; errors: string[] }> {
  if (paths.length > 0) registerHooks();
  const loaded: LoadedWorkerFile[] = [];
  for (const path of paths) {
    if (!existsSync(path)) {
      loaded.push({ path, definitions: [], missing: true });
      continue;
    }
    try {
      const mod = (await import(pathToFileURL(path).href)) as Record<string, unknown>;
      loaded.push({ path, definitions: Object.values(mod).filter(isWorkerDefinition) });
    } catch (err) {
      loaded.push({ path, definitions: [], error: err instanceof Error ? err.message : String(err) });
    }
  }
  const errors = validateCustomWorkers(loaded, presetNames);
  const workers =
    errors.length > 0 ? [] : loaded.flatMap((f) => f.definitions.map((definition) => ({ definition, source: f.path })));
  return { workers, errors };
}
