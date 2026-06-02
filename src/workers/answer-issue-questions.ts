import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const answerIssueQuestionsWorker = createIssuePollingWorker({
  name: "answer-issue-questions",
  command: "/base-tools:answer-issue-questions",
  triggerLabels: ["cc-answer-issue-questions"],
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-update-issue");
  },
});
