import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const answerIssueQuestionsWorker = createIssuePollingWorker({
  name: "answer-issue-questions",
  pollingIntervalMs: 60 * 1000,
  triggerLabels: ["cc-answer-issue-questions"],
  buildPrompt: (issue) => `/base-tools:answer-issue-questions ${issue.number}`,
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-update-issue");
  },
});
