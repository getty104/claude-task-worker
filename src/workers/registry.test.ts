import assert from "node:assert/strict";
import { test } from "node:test";
import type * as RegistryModule from "./registry";
import type * as WorkerDefinitionModule from "./worker-definition";

const { PRESET_WORKERS } = (await import("./registry")) as typeof RegistryModule;
const { defineWorker, isWorkerDefinition } = (await import("./worker-definition")) as typeof WorkerDefinitionModule;

test("PRESET_WORKERS has 15 unique names", () => {
  const names = PRESET_WORKERS.map((e) => e.definition.name);
  assert.equal(names.length, 15);
  assert.equal(new Set(names).size, 15);
});

test("PRESET_WORKERS membership in all / yolo", () => {
  assert.equal(PRESET_WORKERS.filter((e) => e.inAll).length, 12);
  assert.equal(PRESET_WORKERS.filter((e) => e.inYolo).length, 15);
  const notInAll = PRESET_WORKERS.filter((e) => !e.inAll).map((e) => e.definition.name);
  assert.deepEqual(notInAll, ["triage-created-issue", "triage-pr", "check-dependabot"]);
});

test("every preset is a WorkerDefinition with the expected kind", () => {
  const prNames = ["fix-review-point", "triage-pr", "resolve-conflict", "check-dependabot"];
  const scheduledNames = ["update-coding-guidelines", "update-requirement-rules", "update-design-md"];
  for (const { definition } of PRESET_WORKERS) {
    assert.ok(isWorkerDefinition(definition), definition.name);
    const expected = prNames.includes(definition.name)
      ? "pr"
      : scheduledNames.includes(definition.name)
        ? "scheduled"
        : "issue";
    assert.equal(definition.kind, expected, definition.name);
  }
});

test("isWorkerDefinition rejects plain objects and functions", () => {
  assert.equal(isWorkerDefinition({ name: "x", kind: "issue", start: async () => {} }), false);
  assert.equal(
    isWorkerDefinition(async () => {}),
    false,
  );
  assert.equal(isWorkerDefinition(null), false);
  assert.equal(isWorkerDefinition(defineWorker({ name: "", kind: "issue", start: async () => {} })), false);
  assert.equal(isWorkerDefinition(defineWorker({ name: "x", kind: "issue", start: async () => {} })), true);
});
