import { createIssuePollingWorker } from "./issue-worker";

export const triageIssueWorker = createIssuePollingWorker({
  name: "triage-issue",
  pollingIntervalMs: 15 * 60 * 1000,
  triggerLabels: ["cc-triage-scope"],
  excludeLabels: ["cc-created-issue"],
  buildPrompt: (issue) => `/base-tools:triage-issue ${issue.number}`,
});
