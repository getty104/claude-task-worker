import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type * as M from "./pencil";

const { buildPencilNodeOptions } = (await import("./pencil")) as typeof M;

test("buildPencilNodeOptions injects the hook when NODE_OPTIONS is unset", () => {
  assert.equal(buildPencilNodeOptions(undefined, "file:///tmp/fix.mjs"), "--import file:///tmp/fix.mjs");
});

test("buildPencilNodeOptions keeps existing NODE_OPTIONS", () => {
  assert.equal(
    buildPencilNodeOptions("--max-old-space-size=4096", "file:///tmp/fix.mjs"),
    "--import file:///tmp/fix.mjs --max-old-space-size=4096",
  );
  assert.equal(buildPencilNodeOptions("   ", "file:///tmp/fix.mjs"), "--import file:///tmp/fix.mjs");
});

test("buildPencilNodeOptions produces a space-free value for paths containing spaces", () => {
  const value = buildPencilNodeOptions(undefined, pathToFileURL("/tmp/my dir/fix.mjs").href);
  assert.equal(value.split(" ").length, 2);
  assert.match(value, /my%20dir/);
});
