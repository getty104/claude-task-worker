import { createIssuePollingWorker } from "./issue-worker";
import { addLabel } from "../gh";

export const createIssueWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "create-issue",
    command: "/base-tools:create-issue-from-issue-number",
    triggerLabels: ["cc-triage-scope"],
    excludeLabels: [
      "cc-issue-created",
      "cc-pr-created",
      "cc-update-issue",
      "cc-answer-issue-questions",
      "cc-exec-issue",
    ],
    epicFilter: opts.epicFilter,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-issue-created");
    },
  })();
