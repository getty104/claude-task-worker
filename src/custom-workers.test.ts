import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as CustomWorkersModule from "./custom-workers";
import type { LoadedWorkerFile } from "./custom-workers";
import type * as WorkerDefinitionModule from "./workers/worker-definition";

const { validateCustomWorkers, loadCustomWorkers } = (await import("./custom-workers")) as typeof CustomWorkersModule;
const { defineWorker } = (await import("./workers/worker-definition")) as typeof WorkerDefinitionModule;

const def = (name: string) => defineWorker({ name, kind: "issue", start: async () => {} });
const file = (path: string, ...names: string[]): LoadedWorkerFile => ({ path, definitions: names.map(def) });

test("validateCustomWorkers accepts distinct non-preset names", () => {
  assert.deepEqual(validateCustomWorkers([file("/a.ts", "x", "y"), file("/b.ts", "z")], ["exec-issue"]), []);
});

test("validateCustomWorkers reports missing, failed, empty, preset-colliding and duplicate cases with paths", () => {
  const errors = validateCustomWorkers(
    [
      { path: "/missing.ts", definitions: [], missing: true },
      { path: "/broken.ts", definitions: [], error: "SyntaxError: boom" },
      file("/empty.ts"),
      file("/preset.ts", "exec-issue"),
      file("/a.ts", "dup"),
      file("/b.ts", "dup", "dup2"),
      file("/c.ts", "dup2"),
    ],
    ["exec-issue"],
  );
  assert.equal(errors.length, 6);
  assert.match(errors[0], /\/missing\.ts does not exist/);
  assert.match(errors[1], /\/broken\.ts: SyntaxError: boom/);
  assert.match(errors[2], /\/empty\.ts exports no worker definition/);
  assert.match(errors[3], /\/preset\.ts.*"exec-issue".*preset/);
  assert.match(errors[4], /\/b\.ts.*"dup".*\/a\.ts/);
  assert.match(errors[5], /\/c\.ts.*"dup2".*\/b\.ts/);
});

test("validateCustomWorkers detects a collision inside one file", () => {
  const errors = validateCustomWorkers([file("/a.ts", "same", "same")], []);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"same".*\/a\.ts/);
});

test("validateCustomWorkers rejects names reserved by CLI commands", () => {
  const errors = validateCustomWorkers([file("/a.ts", "all", "yolo", "ok")], []);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /"all", which collides with a CLI command/);
  assert.match(errors[1], /"yolo", which collides with a CLI command/);
});

test("loadCustomWorkers loads TS files importing claude-task-worker/lib and relative .ts helpers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-custom-"));
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "helper.ts"), `export const label: string = "cc-from-helper";\n`);
  writeFileSync(
    join(dir, "multi.ts"),
    `import { defineWorker, isWorkerDefinition } from "claude-task-worker/lib";
import { label } from "./sub/helper.ts";
interface Unused { a: number }
export const one = defineWorker({ name: label, kind: "issue", start: async () => {} });
export const two = defineWorker({ name: "second", kind: "pr", start: async () => {} });
export const notADefinition = { name: "nope" };
export const flag: boolean = isWorkerDefinition(one);
`,
  );
  const { workers, errors } = await loadCustomWorkers([join(dir, "multi.ts")], []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    workers.map((w) => w.definition.name),
    ["cc-from-helper", "second"],
  );
  assert.equal(workers[0].source, join(dir, "multi.ts"));
});

test("loadCustomWorkers reports missing files and syntax errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-custom-"));
  writeFileSync(join(dir, "bad.ts"), "export const = ;\n");
  const { workers, errors } = await loadCustomWorkers([join(dir, "nope.ts"), join(dir, "bad.ts")], []);
  assert.deepEqual(workers, []);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /nope\.ts does not exist/);
  assert.match(errors[1], /bad\.ts/);
});
