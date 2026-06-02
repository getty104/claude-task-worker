import { createIssuePollingWorker } from "./issue-worker";

export const updateIssueWorker = createIssuePollingWorker({
  name: "update-issue",
  command: "/base-tools:update-issue",
  triggerLabels: ["cc-update-issue"],
});
