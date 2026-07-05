import { addLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const answerIssueQuestionsWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "answer-issue-questions",
    command: "/claude-task-worker:answer-issue-questions",
    triggerLabels: ["cc-answer-issue-questions"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-update-issue");
    },
  })();
