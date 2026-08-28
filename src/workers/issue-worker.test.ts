import { test } from "node:test";
import assert from "node:assert/strict";
import type * as IssueWorkerModule from "./issue-worker";

const { consumableTriggerLabels } = (await import("./issue-worker.ts")) as typeof IssueWorkerModule;

test("consumes work-request trigger labels", () => {
  assert.deepEqual(consumableTriggerLabels(["cc-exec-issue"]), ["cc-exec-issue"]);
});

test("keeps lifecycle markers so a failed run cannot drop them", () => {
  // triage-created-issue: 両方 sticky。外すと create-issue が分析済み Issue を
  // 再分析するループに入る。
  assert.deepEqual(consumableTriggerLabels(["cc-issue-created", "cc-triage-scope"]), []);
});
