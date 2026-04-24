import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const execIssueWorker = createIssuePollingWorker({
  name: "exec-issue",
  pollingIntervalMs: 30 * 1000,
  triggerLabel: "cc-exec-issue",
  buildPrompt: (issue) => `/base-tools:exec-issue ${issue.number}`,
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-pr-created");
  },
});
