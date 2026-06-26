import { createIssuePollingWorker } from "./issue-worker";
import { addLabel } from "../gh";

export const triageCreatedIssueWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "triage-created-issue",
    command: "/base-tools:triage-created-issue",
    triggerLabels: ["cc-issue-created", "cc-triage-scope"],
    excludeLabels: ["cc-pr-created", "cc-create-issue", "cc-update-issue", "cc-answer-issue-questions", "cc-exec-issue"],
    epicFilter: opts.epicFilter,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-issue-created");
    },
  })();
