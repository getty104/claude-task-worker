export type WorkerKind = "issue" | "pr" | "scheduled";

export interface WorkerStartOptions {
  epicFilters?: number[];
  labelFilters?: string[];
}

// Symbol.for にするのは、別バンドルの lib から作られた定義もロード時に判別できるようにするため。
export const WORKER_DEFINITION = Symbol.for("claude-task-worker.worker-definition");

export interface WorkerDefinition {
  readonly [WORKER_DEFINITION]: true;
  readonly name: string;
  readonly kind: WorkerKind;
  readonly start: (opts?: WorkerStartOptions) => Promise<void>;
}

export function defineWorker(def: {
  name: string;
  kind: WorkerKind;
  start: (opts?: WorkerStartOptions) => Promise<void>;
}): WorkerDefinition {
  return { [WORKER_DEFINITION]: true, name: def.name, kind: def.kind, start: def.start };
}

const KINDS: readonly string[] = ["issue", "pr", "scheduled"];

export function isWorkerDefinition(value: unknown): value is WorkerDefinition {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<PropertyKey, unknown>;
  return (
    v[WORKER_DEFINITION] === true &&
    typeof v.name === "string" &&
    v.name !== "" &&
    typeof v.kind === "string" &&
    KINDS.includes(v.kind) &&
    typeof v.start === "function"
  );
}
