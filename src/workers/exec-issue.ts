import {
  addLabel,
  commentOnIssue,
  findPrNumberByHeadRef,
  findPrNumberClosingIssue,
  getIssueState,
  hasLabel,
} from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

function prMissingComment(worktreeId: string): string {
  return [
    "## PR未作成のまま自動実行が終了しました（要人手確認）",
    `exec-issue のセッションは正常終了（exit 0）しましたが、この実行の作業ブランチ（\`${worktreeId}\`）を head とするPRも、本Issueを closing 参照するPRも見つかりませんでした。PR作成前にセッションが終了した可能性があります。`,
    "",
    "## 状態の確認",
    `- 変更が push 済みの場合はリモートブランチ \`${worktreeId}\` が残っています。内容を確認し、必要なら手動でPRを作成してください`,
    "",
    "## 対応後の進め方",
    "- 自動実行をやり直す場合: `cc-need-human-check` ラベルを外し、`cc-exec-issue` ラベルを付け直してください",
    "- 手動でPRを作成した場合など対応済みの場合: `cc-need-human-check` ラベルを外してください",
  ].join("\n");
}

export const execIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "exec-issue",
    command: "/claude-task-worker:exec-issue",
    triggerLabels: ["cc-exec-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber, worktreeId) => {
      // スキルがPRを作成できず cc-need-human-check を付与した場合は、
      // PRが存在しないのに cc-pr-created を付けて完了扱いにしないよう抑止する。
      if (await hasLabel("issue", issueNumber, "cc-need-human-check")) {
        console.log(`[exec-issue] #${issueNumber}: cc-need-human-check present, skip cc-pr-created`);
        return false;
      }
      // 「コード変更不要」パスではスキルが説明コメント付きでIssueをクローズして終了する。
      // PRが無いのが正しい状態なので cc-pr-created は付けない。
      if ((await getIssueState(issueNumber)) === "CLOSED") {
        console.log(`[exec-issue] #${issueNumber}: issue closed by skill (no-change path), skip cc-pr-created`);
        return;
      }
      // exit 0 は「PR作成完了」を保証しない。処理未完のままターンが終わっても print モードでは
      // プロセスが正常終了するため、PRの実在を確認できた場合のみ cc-pr-created を付与する。
      // 作業ブランチ（worktreeId）を head とするPRを第一に、ブランチが変えられたケースの
      // 保険として closing 参照PRも探す。
      const prNumber =
        (await findPrNumberByHeadRef(worktreeId, "all")) ?? (await findPrNumberClosingIssue(issueNumber));
      if (prNumber !== null) {
        await addLabel("issue", issueNumber, "cc-pr-created");
        return;
      }
      console.error(
        `[exec-issue] #${issueNumber}: session exited without a PR (branch: ${worktreeId}); marking cc-need-human-check`,
      );
      await addLabel("issue", issueNumber, "cc-need-human-check");
      await commentOnIssue(issueNumber, prMissingComment(worktreeId)).catch((err) =>
        console.error(`[exec-issue] commentOnIssue failed for #${issueNumber}: ${err}`),
      );
      return false;
    },
  })();
