import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const execIssueWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "exec-issue",
    command: "/base-tools:exec-issue",
    triggerLabels: ["cc-exec-issue"],
    epicFilter: opts.epicFilter,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-pr-created");
    },
  })();
