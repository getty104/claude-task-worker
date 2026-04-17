import { createIssuePollingWorker } from "./issue-worker";

export const triageIssueWorker = createIssuePollingWorker({
  name: "triage-issue",
  triggerLabel: "cc-triage-scope",
  buildPrompt: (issue) => `/base-tools:triage-issue ${issue.number}`,
});
