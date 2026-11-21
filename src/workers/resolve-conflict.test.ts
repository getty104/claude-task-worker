import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ResolveConflictModule from "./resolve-conflict";

const { shouldFlagUnresolvedConflict } = (await import("./resolve-conflict.ts")) as typeof ResolveConflictModule;

test("flags a PR that is still conflicting after the skill finished, whatever it reported", () => {
  // クラウド実行では output が定型文になり「aborted」を含まないため、mergeable だけで判定する。
  assert.equal(shouldFlagUnresolvedConflict("CONFLICTING"), true);
});

test("does not flag when the conflict is gone", () => {
  assert.equal(shouldFlagUnresolvedConflict("MERGEABLE"), false);
});

test("does not flag while GitHub is still recomputing mergeability", () => {
  assert.equal(shouldFlagUnresolvedConflict("UNKNOWN"), false);
});
