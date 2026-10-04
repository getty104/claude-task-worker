import { createIssuePollingWorker } from "./issue-worker";
import { addLabel } from "../gh";

export const createIssueWorker = createIssuePollingWorker({
  name: "create-issue",
  command: "/claude-task-worker:create-issue-from-issue-number",
  triggerLabels: ["cc-triage-scope"],
  excludeLabels: ["cc-issue-created", "cc-pr-created", "cc-update-issue", "cc-answer-issue-questions", "cc-exec-issue"],
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-issue-created");
  },
});
