import { createIssuePollingWorker } from "./issue-worker";

export const triageIssueWorker = createIssuePollingWorker({
  name: "triage-issue",
  triggerLabel: "cc-triage-scope",
  excludeLabel: "cc-pr-created",
  buildPrompt: (issue) => `/base-tools:triage-issue ${issue.number}`,
});
