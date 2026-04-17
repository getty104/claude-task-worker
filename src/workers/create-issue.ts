import { createIssuePollingWorker } from "./issue-worker";

export const createIssueWorker = createIssuePollingWorker({
  name: "create-issue",
  triggerLabel: "cc-create-issue",
  buildPrompt: (issue) => `/base-tools:create-issue #${issue.number}`,
});
