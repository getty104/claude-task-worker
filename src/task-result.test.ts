import { test } from "node:test";
import assert from "node:assert/strict";
import type * as TaskResultModule from "./task-result";

const { buildTaskResult, appendCloudFailureGuidance } = (await import("./task-result")) as typeof TaskResultModule;

test("exit 0 with output is completed and keeps stdout as-is", () => {
  const result = buildTaskResult(0, "判定: パターンB-通常（マージ済み）\n", "");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "判定: パターンB-通常（マージ済み）\n");
});

test("exit 0 with empty stdout is failed (aborted session before the model ran)", () => {
  const result = buildTaskResult(0, "", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /exited with code 0 but produced no output/);
});

test("exit 0 with whitespace-only stdout is failed", () => {
  const result = buildTaskResult(0, "\n", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /produced no output/);
});

test("non-zero exit is failed and reports the exit code", () => {
  const result = buildTaskResult(1, "partial output", "");
  assert.equal(result.status, "failed");
  assert.match(result.output, /^partial output/);
  assert.match(result.output, /exited with code 1/);
});

test("stderr tail is appended on failure", () => {
  const result = buildTaskResult(1, "", "fatal: something broke");
  assert.equal(result.status, "failed");
  assert.match(result.output, /\[stderr\] fatal: something broke/);
});

test("stderr tail is not appended on success", () => {
  const result = buildTaskResult(0, "ok", "warning: noise");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "ok");
});

test("appendCloudFailureGuidance appends guidance for a failed cloud task", () => {
  const result = appendCloudFailureGuidance({ status: "failed", output: "boom" }, true);
  assert.match(result.output, /^boom/);
  assert.match(result.output, /GitHub 連携/);
  assert.match(result.output, /allow_remote_sessions/);
});

test("appendCloudFailureGuidance leaves non-cloud failures untouched", () => {
  const failed = { status: "failed" as const, output: "boom" };
  const result = appendCloudFailureGuidance(failed, false);
  assert.equal(result, failed);
  assert.equal(result.output, "boom");
});

test("appendCloudFailureGuidance leaves completed cloud tasks untouched", () => {
  const completed = { status: "completed" as const, output: "ok" };
  const result = appendCloudFailureGuidance(completed, true);
  assert.equal(result, completed);
  assert.equal(result.output, "ok");
});
