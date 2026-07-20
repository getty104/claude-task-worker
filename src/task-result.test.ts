import { test } from "node:test";
import assert from "node:assert/strict";
import type * as TaskResultModule from "./task-result";

const { buildTaskResult, stripHeadroomBanner } = (await import("./task-result.ts")) as typeof TaskResultModule;

// `headroom wrap claude` が claude 起動前に必ず stdout へ出すバナー（実測を要約したもの）。
const HEADROOM_BANNER = [
  "",
  "  ╔═══════════════════════════════════════════════╗",
  "  ║            HEADROOM WRAP: CLAUDE              ║",
  "  ╚═══════════════════════════════════════════════╝",
  "",
  "  Launching Claude Code (API routed through Headroom)...",
  "  ANTHROPIC_BASE_URL=http://127.0.0.1:8787",
  "  Extra args: -p /claude-task-worker:exec-issue 123",
  "",
].join("\n");

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

test("stripHeadroomBanner removes the launch banner and keeps the report", () => {
  assert.equal(stripHeadroomBanner(`${HEADROOM_BANNER}判定: パターンB\n`), "判定: パターンB\n");
});

test("stripHeadroomBanner leaves a banner-only stdout empty", () => {
  assert.equal(stripHeadroomBanner(HEADROOM_BANNER).trim(), "");
});

test("stripHeadroomBanner only strips the leading block, not indented report lines", () => {
  // claude のレポート本文に含まれるインデント行まで落とさないこと。
  const report = "## 完了報告\n  - 変更点A\n  - 変更点B\n";
  assert.equal(stripHeadroomBanner(`${HEADROOM_BANNER}${report}`), report);
});

test("headroom mode still detects an empty session behind the launch banner", () => {
  // バナーを数えてしまうと「exit 0 かつ無出力＝空振り」の検知が効かなくなり、
  // triage-pr のようにトリガーラベルが再装填されるワーカーが無限リトライに陥る。
  const result = buildTaskResult(0, HEADROOM_BANNER, "", { headroom: true });
  assert.equal(result.status, "failed");
  assert.match(result.output, /produced no output/);
});

test("headroom mode keeps a real report completed and notifies with the full stdout", () => {
  const stdout = `${HEADROOM_BANNER}判定: パターンB\n`;
  const result = buildTaskResult(0, stdout, "", { headroom: true });
  assert.equal(result.status, "completed");
  // 通知には元の stdout をそのまま載せる（バナー除去は空判定にのみ使う）。
  assert.equal(result.output, stdout);
});

test("the banner is only stripped when headroom is enabled", () => {
  // headroom 無効時に同じ整形をすると、インデントで始まる正当な出力を空と誤判定しうる。
  const result = buildTaskResult(0, HEADROOM_BANNER, "");
  assert.equal(result.status, "completed");
});
