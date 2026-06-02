import { createIssuePollingWorker } from "./issue-worker";

export const createIssueWorker = createIssuePollingWorker({
  name: "create-issue",
  command: "/base-tools:create-issue",
  triggerLabels: ["cc-create-issue"],
});
