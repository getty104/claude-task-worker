import { createIssuePollingWorker } from "./issue-worker";

export const triageIssueWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "triage-issue",
    command: "/base-tools:triage-issue",
    triggerLabels: ["cc-triage-scope"],
    excludeLabels: [
      "cc-issue-created",
      "cc-pr-created",
      "cc-create-issue",
      "cc-update-issue",
      "cc-answer-issue-questions",
      "cc-exec-issue",
    ],
    epicFilter: opts.epicFilter,
  })();
