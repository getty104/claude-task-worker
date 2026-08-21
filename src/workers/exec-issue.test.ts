import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ExecIssueModule from "./exec-issue";

const { formatSessionReport } = (await import("./exec-issue.ts")) as typeof ExecIssueModule;

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
