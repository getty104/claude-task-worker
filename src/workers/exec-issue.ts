import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const execIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "exec-issue",
    command: "/claude-task-worker:exec-issue",
    triggerLabels: ["cc-exec-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-pr-created");
    },
  })();
