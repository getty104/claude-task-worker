import { addLabel, commentOnIssue, findOpenPrNumberByHeadRef, getIssueSubIssuesSummary } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

export function epicPrMissingComment(issueNumber: number): string {
  return [
    "## Epic PR未作成のまま自動実行が終了しました（要人手確認）",
    `create-epic-pr のセッションは正常終了（exit 0）しましたが、Epic ブランチ \`cc-epic-${issueNumber}\` を head とするオープンなPRが見つかりませんでした。PR作成前にセッションが終了した可能性があります。`,
    "",
    "## 状態の確認",
    `- 変更が push 済みの場合はリモートブランチ \`cc-epic-${issueNumber}\` が残っています。内容を確認し、必要なら手動でPRを作成してください`,
    "",
    "## 対応後の進め方",
    "- 自動実行をやり直す場合: `cc-need-human-check` ラベルを外し、`cc-epic-issue` ラベルを付け直してください",
    "- 手動でPRを作成した場合など対応済みの場合: `cc-need-human-check` ラベルを外してください",
  ].join("\n");
}

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
      // create-epic-pr が作成した Epic PR を epic ブランチ名で特定する。
      // exit 0 はPR作成の保証にならないため、実在を確認してから cc-pr-created を付与する
      // （確認前に付与すると、PR不在でも完了扱いになり Epic が停滞する）。
      const prNumber = await findOpenPrNumberByHeadRef(`cc-epic-${issueNumber}`);
      if (prNumber === null) {
        console.error(`[epic-issue] Epic PR for branch cc-epic-${issueNumber} not found; skip cc-pr-created`);
        await addLabel("issue", issueNumber, "cc-need-human-check");
        await commentOnIssue(issueNumber, epicPrMissingComment(issueNumber)).catch((err) =>
          console.error(`[epic-issue] commentOnIssue failed for #${issueNumber}: ${err}`),
        );
        return false;
      }
      await addLabel("issue", issueNumber, "cc-pr-created");
      // triage-pr がリリースゲートとして拾えるよう cc-epic-issue（マーカー）と
      // cc-triage-scope（triage 投入）を付与する。
      await addLabel("pr", prNumber, "cc-epic-issue");
      await addLabel("pr", prNumber, "cc-triage-scope");
    },
  })();
