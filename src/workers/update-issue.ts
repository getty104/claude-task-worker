import { createIssuePollingWorker } from "./issue-worker";

export const updateIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "update-issue",
    command: "/claude-task-worker:update-issue",
    triggerLabels: ["cc-update-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
  })();
