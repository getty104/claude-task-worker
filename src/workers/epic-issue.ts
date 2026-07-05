import { addLabel, findOpenPrNumberByHeadRef, getIssueSubIssuesSummary } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const epicIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "epic-issue",
    command: "/claude-task-worker:create-epic-pr",
    triggerLabels: ["cc-epic-issue"],
    excludeLabels: ["cc-pr-created"],
    ownNumberFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    preflight: async (epic) => {
      const summary = await getIssueSubIssuesSummary(epic.number);
      if (summary.total === 0) return "skip";
      if (summary.completed !== summary.total) return "skip";
      return "proceed";
    },
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-pr-created");
      // create-epic-pr が作成した Epic PR を epic ブランチ名で特定し、
      // triage-pr がリリースゲートとして拾えるよう cc-epic-issue（マーカー）と
      // cc-triage-scope（triage 投入）を付与する。
      const prNumber = await findOpenPrNumberByHeadRef(`cc-epic-${issueNumber}`);
      if (prNumber === null) {
        console.error(`[epic-issue] Epic PR for branch cc-epic-${issueNumber} not found; skip labeling`);
        return;
      }
      await addLabel("pr", prNumber, "cc-epic-issue");
      await addLabel("pr", prNumber, "cc-triage-scope");
    },
  })();
