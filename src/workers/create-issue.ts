import { createIssuePollingWorker } from "./issue-worker";

export const createIssueWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "create-issue",
    command: "/base-tools:create-issue-from-issue-number",
    triggerLabels: ["cc-create-issue"],
    epicFilter: opts.epicFilter,
  })();
