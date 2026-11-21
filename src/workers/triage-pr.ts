import { closeIssue, getPrDetail, getRepoInfo, parseClosingIssueNumbers } from "../gh";
import { createPrPollingWorker } from "./pr-worker";

// マージ後に関連Issueを閉じるのは triage-pr スキルのステップ3-2（`gh issue close`）だが、
// セッションがその1ステップを落としても誰も気づけなかった: 本ワーカーに検証が無く、
// マージ済みPRは `listPullRequestsWithChecks()` の `--state open` で二度と拾われないため、
// 自己修復もしない。GitHub の自動クローズも base が非デフォルトブランチ（`cc-epic-<N>`）では
// 発動せず、Epic PR 本文もサブIssueを closing keyword で参照しない（`create-epic-pr`）ため、
// サブIssueは実装がマージ済みのまま永久に open で残る（実測: マージから84分放置され手動クローズ）。
// スキルの成否に依存せず、ワーカー側で決定論的に閉じ直す。
// スキル自身が既に閉じていれば REST の PATCH は 200 を返すだけなので二重実行の害は無い。
export function shouldCloseLinkedIssues(
  pr: { state: string; baseRefName: string } | null,
  defaultBranch: string,
): boolean {
  return pr !== null && pr.state === "MERGED" && pr.baseRefName !== defaultBranch;
}

export async function closeLinkedIssuesAfterMerge(workerName: string, prNumber: number): Promise<void> {
  const detail = await getPrDetail(prNumber);
  const { defaultBranch } = await getRepoInfo();
  if (!shouldCloseLinkedIssues(detail, defaultBranch)) return;
  for (const issueNumber of parseClosingIssueNumbers(detail!.body)) {
    try {
      await closeIssue(issueNumber);
      console.log(`[${workerName}] closed issue #${issueNumber} (PR #${prNumber} merged into ${detail!.baseRefName})`);
    } catch (err) {
      console.error(`[${workerName}] failed to close issue #${issueNumber} for PR #${prNumber}: ${err}`);
    }
  }
}

export const triagePrWorker = createPrPollingWorker({
  name: "triage-pr",
  command: "/claude-task-worker:triage-pr",
  triggerLabel: "cc-triage-scope",
  excludeLabels: ["cc-fix-onetime", "cc-release-ready", "cc-need-human-check"],
  onCompleted: (pr) => closeLinkedIssuesAfterMerge("triage-pr", pr.number),
});
