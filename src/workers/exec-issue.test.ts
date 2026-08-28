import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ExecIssueModule from "./exec-issue";
import type { ClosingPrRef } from "../gh";

const { formatSessionReport, selectOwnedClosingPr } = (await import("./exec-issue.ts")) as typeof ExecIssueModule;

function pr(overrides: Partial<ClosingPrRef>): ClosingPrRef {
  return {
    number: 1,
    state: "MERGED",
    headRefName: "adj-noun-1234",
    baseRefName: "main",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("wraps the session report in a code fence", () => {
  assert.equal(formatSessionReport("PR未作成: push に失敗\n"), "```\nPR未作成: push に失敗\n```");
});

test("falls back to a placeholder when the session produced no output", () => {
  assert.equal(formatSessionReport("   \n"), "（セッションの出力はありませんでした）");
});

test("keeps the tail of a long report, where the conclusion is", () => {
  const report = `${"x".repeat(5000)}\n最終報告: PRを作成できませんでした`;
  const formatted = formatSessionReport(report);
  assert.ok(formatted.includes("最終報告: PRを作成できませんでした"));
  assert.ok(formatted.includes("…（先頭を省略）"));
  assert.ok(formatted.length < report.length);
});

const baseCtx = {
  cloud: false,
  expectedHeadRefName: "adj-noun-1234",
  baseBranch: "main",
  startedAt: Date.parse("2026-01-01T00:00:00Z"),
  now: Date.parse("2026-01-02T00:00:00Z"),
};

test("selectOwnedClosingPr (local): adopts a PR whose headRefName matches", () => {
  const candidates = [pr({ number: 7, headRefName: "adj-noun-1234" })];
  assert.equal(selectOwnedClosingPr(candidates, baseCtx), 7);
});

test("selectOwnedClosingPr (local): rejects a PR whose headRefName does not match", () => {
  const candidates = [pr({ number: 7, headRefName: "other-branch" })];
  assert.equal(selectOwnedClosingPr(candidates, baseCtx), null);
});

test("selectOwnedClosingPr (cloud): adopts a PR whose base matches and createdAt is within range", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "main",
      createdAt: "2026-01-01T12:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), 9);
});

test("selectOwnedClosingPr (cloud): rejects a PR whose base does not match", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "cc-epic-1",
      createdAt: "2026-01-01T12:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), null);
});

test("selectOwnedClosingPr (cloud): rejects a PR created before the task started", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "main",
      createdAt: "2025-12-31T23:59:59Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), null);
});

test("selectOwnedClosingPr (cloud): rejects a PR created after the verification time", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "main",
      createdAt: "2026-01-03T00:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), null);
});

test("selectOwnedClosingPr: a CLOSED (unmerged) candidate is never adopted in either mode", () => {
  const closedLocal = [pr({ number: 7, state: "CLOSED", headRefName: "adj-noun-1234" })];
  assert.equal(selectOwnedClosingPr(closedLocal, baseCtx), null);

  const closedCloud = [
    pr({
      number: 9,
      state: "CLOSED",
      baseRefName: "main",
      createdAt: "2026-01-01T12:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(closedCloud, { ...baseCtx, cloud: true }), null);
});
