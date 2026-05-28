import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const execIssueWorker = createIssuePollingWorker({
  name: "exec-issue",
  triggerLabels: ["cc-exec-issue"],
  buildPrompt: (issue) => `/base-tools:exec-issue ${issue.number}`,
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-pr-created");
  },
});
