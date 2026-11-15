import { addLabel, closeIssue, commentOnPR, getPrDetail, getRepoInfo, parseClosingIssueNumbers } from "../gh";
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

// スキルが人の判断待ちを `cc-need-human-check`（パターンD）に落とし損ね、ラベルなしの「保留」で終え続けると、
// cc-triage-scope が残ったまま毎ポーリング同じPRで全手順を走らせ直す。スキルの判断に依存しない最後の砦として、
// 時間経過で状態が変わる保留（CI未完了・CI再実行）以外の保留が連続したらワーカー側で止める。
export const STALL_LIMIT = 3;
const LABEL_NEED_HUMAN_CHECK = "cc-need-human-check";

export function parseVerdict(output: string): string | null {
  return output.match(/判定\**\s*[:：]\s*\**\s*([^\n]+)/)?.[1].trim() ?? null;
}

export function isStalledHold(verdict: string | null): boolean {
  return verdict !== null && verdict.startsWith("保留") && !/CI(未完了|再実行)/.test(verdict);
}

// shortcut: 連続回数はプロセス内メモリのみで、ワーカー再起動でリセットされる。再起動を跨いだループが観測されたら PR コメントから数える
const stallCounts = new Map<number, number>();

export function recordVerdict(counts: Map<number, number>, prNumber: number, output: string): number {
  const next = isStalledHold(parseVerdict(output)) ? (counts.get(prNumber) ?? 0) + 1 : 0;
  if (next === 0) counts.delete(prNumber);
  else counts.set(prNumber, next);
  return next;
}

export const triagePrWorker = createPrPollingWorker({
  name: "triage-pr",
  command: "/claude-task-worker:triage-pr",
  triggerLabel: "cc-triage-scope",
  excludeLabels: ["cc-fix-onetime", "cc-resolve-conflict", "cc-release-ready", "cc-need-human-check"],
  onCompleted: async (pr, output) => {
    if (recordVerdict(stallCounts, pr.number, output) >= STALL_LIMIT) {
      stallCounts.delete(pr.number);
      await addLabel("pr", pr.number, LABEL_NEED_HUMAN_CHECK);
      await commentOnPR(
        pr.number,
        [
          "## 自動トリアージを停止しました（cc-need-human-check）",
          "",
          `\`triage-pr\` が CI 待ち以外の理由で ${STALL_LIMIT} 回続けてマージを保留したため、\`cc-need-human-check\` ラベルを付与しました。`,
          "",
          `- **直近の判定**: ${parseVerdict(output)}`,
          "",
          "対応したら、`cc-need-human-check` ラベルを外してください（`triage-pr` が再開します）。",
        ].join("\n"),
      );
      console.log(`[triage-pr] PR #${pr.number} held ${STALL_LIMIT} times without progress; added ${LABEL_NEED_HUMAN_CHECK}`);
      return;
    }
    const detail = await getPrDetail(pr.number);
    const { defaultBranch } = await getRepoInfo();
    if (!shouldCloseLinkedIssues(detail, defaultBranch)) return;
    for (const issueNumber of parseClosingIssueNumbers(detail!.body)) {
      try {
        await closeIssue(issueNumber);
        console.log(`[triage-pr] closed issue #${issueNumber} (PR #${pr.number} merged into ${detail!.baseRefName})`);
      } catch (err) {
        console.error(`[triage-pr] failed to close issue #${issueNumber} for PR #${pr.number}: ${err}`);
      }
    }
  },
});
