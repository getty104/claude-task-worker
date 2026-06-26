import { createIssuePollingWorker } from "./issue-worker";

export const updateIssueWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "update-issue",
    command: "/base-tools:update-issue",
    triggerLabels: ["cc-update-issue"],
    epicFilter: opts.epicFilter,
  })();
