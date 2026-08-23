import assert from "node:assert/strict";
import test from "node:test";
import type * as M from "./version";

const { isOutdated } = (await import("./version")) as typeof M;

test("isOutdated compares versions numerically", () => {
  assert.equal(isOutdated("0.85.0", "0.86.0"), true);
  assert.equal(isOutdated("0.9.0", "0.10.0"), true);
  assert.equal(isOutdated("0.85.0", "1.0.0"), true);
  assert.equal(isOutdated("0.85.0", "0.85.0"), false);
  // ローカルが npm より先行しているケース（bump 後・publish 前）では通知しない
  assert.equal(isOutdated("0.86.0", "0.85.0"), false);
  assert.equal(isOutdated("unknown", "0.85.0"), false);
});
