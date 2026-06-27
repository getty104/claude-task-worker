import { createIssuePollingWorker } from "./issue-worker";
import { addLabel } from "../gh";

export const triageCreatedIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "triage-created-issue",
    command: "/base-tools:triage-created-issue",
    triggerLabels: ["cc-issue-created", "cc-triage-scope"],
    excludeLabels: ["cc-pr-created", "cc-update-issue", "cc-answer-issue-questions", "cc-exec-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-issue-created");
    },
  })();
