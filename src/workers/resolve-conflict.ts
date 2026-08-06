import { addLabel, commentOnPR, getPrMergeable } from "../gh";
import { createPrPollingWorker } from "./pr-worker";

const LABEL_NEED_HUMAN_CHECK = "cc-need-human-check";

// resolve-pr-conflict は解消困難（人間の仕様判断が必要・Pencil CLI 不在など）の場合、`git rebase --abort` して
// 「判定: aborted」を報告し、正常終了する。ワーカーはこれを完了とみなして `cc-resolve-conflict` を外し
// `cc-triage-scope` を戻すため、そのままだと triage-pr が再びコンフリクトを検知して同じラベルを付け直し、
// 解けないコンフリクトを永久にリトライし続ける。出力が aborted かつ実際にまだ CONFLICTING の場合だけ
// `cc-need-human-check` へ落としてループを断ち切る（同ラベルは triage-pr のポーリング除外にも入っている）。
// mergeable を必ず引き直すのは、報告本文だけでは「abort したが別経路で解消済み」を判別できないため。
// GitHub が再計算中に返す UNKNOWN では付与しない（次のポーリングで確定した判定を使う）。
export function shouldFlagUnresolvedConflict(output: string, mergeable: string): boolean {
  return /aborted/i.test(output) && mergeable === "CONFLICTING";
}

export const resolveConflictWorker = createPrPollingWorker({
  name: "resolve-conflict",
  command: "/claude-task-worker:resolve-pr-conflict",
  triggerLabel: "cc-resolve-conflict",
  onCompleted: async (pr, output) => {
    const mergeable = await getPrMergeable(pr.number);
    if (!shouldFlagUnresolvedConflict(output, mergeable)) return;
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
