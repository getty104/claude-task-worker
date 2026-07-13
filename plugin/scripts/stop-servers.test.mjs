import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isRecord, isUnder, selectPidsToKill, parseLsofCwds, resolveTargetDir } from "./stop-servers.mjs";

const sep = path.sep;
const dir = (...parts) => parts.join(sep);

test("isRecord distinguishes plain objects from null/arrays/primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(42), false);
});

test("isUnder matches the dir itself and nested paths, not siblings/prefixes", () => {
  const root = dir("", "home", "u", ".claude", "worktrees", "brave-otter-0421");
  assert.equal(isUnder(root, root), true);
  assert.equal(isUnder(dir(root, "frontend"), root), true);
  assert.equal(isUnder(dir(root, "a", "b", "c"), root), true);
  // Trailing separator on the target dir is tolerated.
  assert.equal(isUnder(dir(root, "frontend"), root + sep), true);
  // Un-normalized segments in the child path still resolve correctly.
  assert.equal(isUnder(dir(root, "a", "..", "b"), root), true);
  // A real child whose name merely starts with ".." is not mistaken for an escape.
  assert.equal(isUnder(dir(root, "..foo"), root), true);
  // Sibling directory sharing a name prefix must not match.
  assert.equal(isUnder(root + "-sibling", root), false);
  assert.equal(isUnder(dir("", "home", "u"), root), false);
  // A child path that escapes above the dir via `..` is not under it.
  assert.equal(isUnder(dir(root, "..", "sibling"), root), false);
  assert.equal(isUnder("", root), false);
  assert.equal(isUnder(root, ""), false);
});

test("selectPidsToKill keeps only in-tree, unprotected, valid pids", () => {
  const root = dir("", "run", "wt");
  const list = [
    { pid: 100, cwd: dir(root, "frontend") }, // keep
    { pid: 101, cwd: root }, // keep (exact dir)
    { pid: 102, cwd: dir("", "elsewhere") }, // drop: outside
    { pid: 103, cwd: dir(root, "api") }, // drop: protected (ancestor)
    { pid: 1, cwd: root }, // drop: init
    { pid: 0, cwd: root }, // drop: pid<=1
  ];
  const result = selectPidsToKill(list, root, new Set([103]));
  assert.deepEqual(result, [100, 101]);
});

test("selectPidsToKill dedupes repeated pids and ignores malformed entries", () => {
  const root = dir("", "run", "wt");
  const list = [
    { pid: 200, cwd: root },
    { pid: 200, cwd: dir(root, "x") }, // duplicate pid
    null,
    "nope",
    { pid: "201", cwd: root }, // non-numeric pid
    { pid: 2.5, cwd: root }, // non-integer pid
    { cwd: root }, // missing pid
  ];
  assert.deepEqual(selectPidsToKill(list, root, new Set()), [200]);
});

test("selectPidsToKill returns [] for bad inputs", () => {
  assert.deepEqual(selectPidsToKill(null, "/x", new Set()), []);
  assert.deepEqual(selectPidsToKill([{ pid: 5, cwd: "/x" }], "", new Set()), []);
  // A non-Set `protectedPids` is treated as "nothing protected", never throws.
  assert.deepEqual(selectPidsToKill([{ pid: 5, cwd: "/x" }], "/x", null), [5]);
});

test("parseLsofCwds pairs each process line with its cwd", () => {
  const out = ["p100", "fcwd", "n/run/wt", "p200", "fcwd", "n/run/wt/api", ""].join("\n");
  assert.deepEqual(parseLsofCwds(out), [
    { pid: 100, cwd: "/run/wt" },
    { pid: 200, cwd: "/run/wt/api" },
  ]);
});

test("parseLsofCwds ignores name lines with no preceding pid and bad input", () => {
  assert.deepEqual(parseLsofCwds("n/orphan\np50\nn/run/wt"), [{ pid: 50, cwd: "/run/wt" }]);
  assert.deepEqual(parseLsofCwds(""), []);
  assert.deepEqual(parseLsofCwds(null), []);
});

test("resolveTargetDir prefers the stdin cwd, falls back otherwise", () => {
  const abs = (p) => path.resolve(p);
  assert.equal(resolveTargetDir({ cwd: abs("/run/wt") }, abs("/fallback")), abs("/run/wt"));
  assert.equal(resolveTargetDir({ cwd: "" }, abs("/fallback")), abs("/fallback"));
  assert.equal(resolveTargetDir({}, abs("/fallback")), abs("/fallback"));
  assert.equal(resolveTargetDir(null, abs("/fallback")), abs("/fallback"));
});

test("resolveTargetDir normalizes a relative stdin cwd to an absolute path", () => {
  const result = resolveTargetDir({ cwd: dir("rel", "worktree") }, "/fallback");
  assert.equal(path.isAbsolute(result), true);
  assert.equal(result, path.resolve(dir("rel", "worktree")));
});
