import { createIssuePollingWorker } from "./issue-worker";

export const updateIssueWorker = createIssuePollingWorker({
  name: "update-issue",
  command: "/claude-task-worker:update-issue",
  triggerLabels: ["cc-update-issue"],
});
