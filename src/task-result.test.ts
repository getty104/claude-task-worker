import { test } from "node:test";
import assert from "node:assert/strict";
import type * as TaskResultModule from "./task-result";

const { buildTaskResult } = (await import("./task-result.ts")) as typeof TaskResultModule;

test("exit 0 with output is completed and keeps stdout as-is", () => {
  const result = buildTaskResult(0, false, "判定: パターンB-通常（マージ済み）\n", "");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "判定: パターンB-通常（マージ済み）\n");
});

test("exit 0 with empty stdout is failed (aborted session before the model ran)", () => {
  const result = buildTaskResult(0, false, "", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /exited with code 0 but produced no output/);
});

test("exit 0 with whitespace-only stdout is failed", () => {
  const result = buildTaskResult(0, false, "\n", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /produced no output/);
});

test("non-zero exit is failed and reports the exit code", () => {
  const result = buildTaskResult(1, false, "partial output", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /^partial output/);
  assert.match(result.output, /exited with code 1/);
});

test("timeout is failed with a timeout note even on exit 0", () => {
  const result = buildTaskResult(0, true, "some output", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /timed out after/);
});

test("stderr tail is appended on failure", () => {
  const result = buildTaskResult(1, false, "", "fatal: something broke");
  assert.equal(result.status, "failed");
  assert.match(result.output, /\[stderr\] fatal: something broke/);
});

test("stderr tail is not appended on success", () => {
  const result = buildTaskResult(0, false, "ok", "warning: noise");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "ok");
});
