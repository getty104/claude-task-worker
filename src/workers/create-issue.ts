import { createIssuePollingWorker } from "./issue-worker";

export const createIssueWorker = createIssuePollingWorker({
  name: "create-issue",
  pollingIntervalMs: 60 * 1000,
  triggerLabels: ["cc-create-issue"],
  buildPrompt: (issue) => `/base-tools:create-issue #${issue.number}`,
});
