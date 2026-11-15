import { test } from "node:test";
import assert from "node:assert/strict";
import type * as TriagePrModule from "./triage-pr";

const { shouldCloseLinkedIssues } = (await import("./triage-pr.ts")) as typeof TriagePrModule;

test("closes linked issues when the PR was merged into a non-default branch", () => {
  assert.equal(shouldCloseLinkedIssues({ state: "MERGED", baseRefName: "cc-epic-6089" }, "main"), true);
});

test("leaves it to GitHub when the PR was merged into the default branch", () => {
  assert.equal(shouldCloseLinkedIssues({ state: "MERGED", baseRefName: "main" }, "main"), false);
});

test("does nothing when the task ended without merging", () => {
  assert.equal(shouldCloseLinkedIssues({ state: "OPEN", baseRefName: "cc-epic-6089" }, "main"), false);
  assert.equal(shouldCloseLinkedIssues({ state: "CLOSED", baseRefName: "cc-epic-6089" }, "main"), false);
});

test("does nothing when the PR could not be read", () => {
  assert.equal(shouldCloseLinkedIssues(null, "main"), false);
});

const { parseVerdict, isStalledHold, recordVerdict } = (await import("./triage-pr.ts")) as typeof TriagePrModule;

test("parseVerdict reads the verdict line of the skill report", () => {
  assert.equal(parseVerdict("- **判定**: 保留（terraform apply 未実施）\n- **理由**: x"), "保留（terraform apply 未実施）");
  assert.equal(parseVerdict("no report"), null);
});

test("only holds that do not resolve with time count as stalls", () => {
  assert.equal(isStalledHold("保留（terraform apply 未実施）"), true);
  assert.equal(isStalledHold("保留（CI未完了）"), false);
  assert.equal(isStalledHold("保留（CI再実行）"), false);
  assert.equal(isStalledHold("パターンA（修正をpush）"), false);
  assert.equal(isStalledHold(null), false);
});

test("recordVerdict counts consecutive stalls per PR and resets on progress", () => {
  const counts = new Map<number, number>();
  const hold = "- **判定**: 保留（承認待ち）";
  assert.equal(recordVerdict(counts, 1, hold), 1);
  assert.equal(recordVerdict(counts, 1, hold), 2);
  assert.equal(recordVerdict(counts, 2, hold), 1);
  assert.equal(recordVerdict(counts, 1, "- **判定**: 保留（CI未完了）"), 0);
  assert.equal(recordVerdict(counts, 1, hold), 1);
});
