import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const answerIssueQuestionsWorker = createIssuePollingWorker({
  name: "answer-issue-questions",
  pollingIntervalMs: 30 * 1000,
  triggerLabel: "cc-answer-questions",
  buildPrompt: (issue) => `/base-tools:answer-questions ${issue.number}`,
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-update-issue");
  },
});
