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
