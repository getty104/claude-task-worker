import { addLabel, getIssueSubIssuesSummary } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const epicIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "epic-issue",
    command: "/base-tools:create-epic-pr",
    triggerLabels: ["cc-epic-issue"],
    excludeLabels: ["cc-pr-created"],
    ownNumberFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    preflight: async (epic) => {
      const summary = await getIssueSubIssuesSummary(epic.number);
      if (summary.total === 0) return "skip";
      if (summary.completed !== summary.total) return "skip";
      return "proceed";
    },
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-pr-created");
    },
  })();
