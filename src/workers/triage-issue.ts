import { createIssuePollingWorker } from "./issue-worker";

export const triageIssueWorker = createIssuePollingWorker({
  name: "triage-issue",
  pollingIntervalMs: 15 * 60 * 1000,
  triggerLabel: "cc-triage-scope",
  excludeLabels: ["cc-pr-created", "cc-create-issue", "cc-update-issue", "cc-answer-issue-questions", "cc-exec-issue"],
  buildPrompt: (issue) => `/base-tools:triage-issue ${issue.number}`,
});
