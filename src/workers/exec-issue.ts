import { addLabel, hasLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export const execIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "exec-issue",
    command: "/claude-task-worker:exec-issue",
    triggerLabels: ["cc-exec-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      // スキルがPRを作成できず cc-need-human-check を付与した場合は、
      // PRが存在しないのに cc-pr-created を付けて完了扱いにしないよう抑止する。
      if (await hasLabel("issue", issueNumber, "cc-need-human-check")) {
        console.log(`[exec-issue] #${issueNumber}: cc-need-human-check present, skip cc-pr-created`);
        return;
      }
      await addLabel("issue", issueNumber, "cc-pr-created");
    },
  })();
