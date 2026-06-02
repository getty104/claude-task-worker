import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const execIssueWorker = createIssuePollingWorker({
  name: "exec-issue",
  command: "/base-tools:exec-issue",
  triggerLabels: ["cc-exec-issue"],
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-pr-created");
  },
});
