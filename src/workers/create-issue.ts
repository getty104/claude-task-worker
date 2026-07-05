import { createIssuePollingWorker } from "./issue-worker";
import { addLabel } from "../gh";

export const createIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "create-issue",
    command: "/claude-task-worker:create-issue-from-issue-number",
    triggerLabels: ["cc-triage-scope"],
    excludeLabels: [
      "cc-issue-created",
      "cc-pr-created",
      "cc-update-issue",
      "cc-answer-issue-questions",
      "cc-exec-issue",
    ],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-issue-created");
    },
  })();
