import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ResolveConflictModule from "./resolve-conflict";

const { shouldFlagUnresolvedConflict } = (await import("./resolve-conflict.ts")) as typeof ResolveConflictModule;

test("flags a PR only when the skill aborted and the conflict is still there", () => {
  assert.equal(shouldFlagUnresolvedConflict("判定: `aborted`\n理由: 仕様判断が必要", "CONFLICTING"), true);
});

test("does not flag when the conflict was resolved and pushed", () => {
  assert.equal(shouldFlagUnresolvedConflict("判定: `resolved-and-pushed`", "MERGEABLE"), false);
  assert.equal(shouldFlagUnresolvedConflict("判定: `no-conflict`", "MERGEABLE"), false);
});

test("does not flag while GitHub is still recomputing mergeability", () => {
  assert.equal(shouldFlagUnresolvedConflict("判定: `aborted`", "UNKNOWN"), false);
});

test("does not flag when the report aborted but the PR is now mergeable", () => {
  assert.equal(shouldFlagUnresolvedConflict("判定: `aborted`", "MERGEABLE"), false);
});
