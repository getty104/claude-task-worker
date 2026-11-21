import { addLabel, commentOnPR, getPrMergeable } from "../gh";
import { createPrPollingWorker } from "./pr-worker";
import { closeLinkedIssuesAfterMerge } from "./triage-pr";

const LABEL_NEED_HUMAN_CHECK = "cc-need-human-check";

// resolve-pr-conflict は解消困難な場合に `git rebase --abort` して正常終了する。ワーカーはこれを完了とみなして
// `cc-resolve-conflict` を外し `cc-triage-scope` を戻すため、そのままだと triage-pr が再びコンフリクトを検知して
// 同じラベルを付け直し、解けないコンフリクトを永久にリトライし続ける。完了後もまだ CONFLICTING なら、
// スキルが何を報告したか（aborted / no-conflict の誤判定 / push 失敗）に関わらず次の triage-pr で同じ結果になるため、
// `cc-need-human-check` へ落としてループを断ち切る（同ラベルは triage-pr のポーリング除外にも入っている）。
// スキルの報告本文を判定に使わないのは、クラウド実行（`--debug` なし）では output が定型文になり報告が届かないため。
// GitHub が再計算中に返す UNKNOWN（push 直後など）では付与しない。
export function shouldFlagUnresolvedConflict(mergeable: string): boolean {
  return mergeable === "CONFLICTING";
}

export const resolveConflictWorker = createPrPollingWorker({
  name: "resolve-conflict",
  command: "/claude-task-worker:resolve-pr-conflict",
  triggerLabel: "cc-resolve-conflict",
  onCompleted: async (pr) => {
    // スキルは push 後に CI を待って triage-pr を呼び、そのままマージまで進めうる（Epic 配下の連動クローズを担保する）。
    await closeLinkedIssuesAfterMerge("resolve-conflict", pr.number);
    const mergeable = await getPrMergeable(pr.number);
    if (!shouldFlagUnresolvedConflict(mergeable)) return;
    await addLabel("pr", pr.number, LABEL_NEED_HUMAN_CHECK);
    await commentOnPR(
      pr.number,
      [
        "コンフリクトを自動解消できなかったため、`cc-need-human-check` ラベルを付与しました。",
        "",
        "- 手動でコンフリクトを解消した場合: `cc-need-human-check` ラベルを外してください（`triage-pr` が再開します）",
        "- 自動解消をやり直す場合: `cc-need-human-check` ラベルを外し、`cc-resolve-conflict` ラベルを付け直してください",
      ].join("\n"),
    );
  },
});
