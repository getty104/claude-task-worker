import { strict as assert } from "node:assert";
import test from "node:test";
import type * as LastRunPr from "./last-run-pr";

const m = (await import("./last-run-pr")) as typeof LastRunPr;

test("lastRunBranchName is fixed per worker so an open PR is reused instead of piling up", () => {
  assert.equal(m.lastRunBranchName("update-design-md"), "ctw-last-run-update-design-md");
  assert.equal(m.lastRunBranchName("update-design-md"), m.lastRunBranchName("update-design-md"));
});

test("hasLastRunChange treats an empty porcelain output as nothing to commit", () => {
  assert.equal(m.hasLastRunChange(""), false);
  assert.equal(m.hasLastRunChange("\n"), false);
  assert.equal(m.hasLastRunChange(" M claude-task-worker.json\n"), true);
  assert.equal(m.hasLastRunChange("?? claude-task-worker.json\n"), true);
});
