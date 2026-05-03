import { createIssuePollingWorker } from "./issue-worker";

export const triageCreatedIssueWorker = createIssuePollingWorker({
  name: "triage-created-issue",
  pollingIntervalMs: 30 * 1000,
  triggerLabels: ["cc-issue-created", "cc-triage-issue"],
  excludeLabels: ["cc-pr-created", "cc-create-issue", "cc-update-issue", "cc-answer-issue-questions", "cc-exec-issue"],
  buildPrompt: (issue) => `/base-tools:triage-created-issue ${issue.number}`,
});
