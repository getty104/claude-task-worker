import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const answerIssueQuestionsWorker = (opts: { epicFilter?: number } = {}) =>
  createIssuePollingWorker({
    name: "answer-issue-questions",
    command: "/base-tools:answer-issue-questions",
    triggerLabels: ["cc-answer-issue-questions"],
    epicFilter: opts.epicFilter,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-update-issue");
    },
  })();
