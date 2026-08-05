import { getUiDesignConfig } from "../config";
import { addLabel, commentOnIssue, findPrNumberByHeadRef, hasLabel } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";
import { designBranchName, designPrNotCreatedComment } from "./ui-design";

export function designPrLabelingFailedComment(
  issueNumber: number,
  prNumber: number,
  error: unknown,
  yolo = false,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const prLabels = yolo ? "`cc-ui-design` / `cc-triage-scope`" : "`cc-ui-design`";
  return [
    "## デザインPRへのラベル付与に失敗しました（要人手確認）",
    `デザインPR #${prNumber}（ブランチ \`${designBranchName(issueNumber)}\`）は作成されましたが、後続ラベル（${prLabels} / \`cc-ui-design-pr-created\`）の付与に失敗しました。`,
    "",
    "## 起こりうる原因",
    "- 本ワークフロー追加時のラベルが未作成の可能性があります。`claude-task-worker init` を再実行してラベルを作成してください",
    "",
    "## エラー内容",
    "```",
    message,
    "```",
    "",
    "## 対応後の進め方",
    `- ラベル作成後にやり直す場合: \`cc-need-human-check\` ラベルを外し、${yolo ? "`cc-ui-design`・`cc-triage-scope`" : "`cc-ui-design`"}（PR側）と \`cc-ui-design-pr-created\`（Issue側）を手動で付けてください`,
  ].join("\n");
}

export const createUiDesignWorker = async (
  opts: { epicFilters?: number[]; labelFilters?: string[] } = {},
): Promise<void> => {
  // uiDesign.enabled が false のリポジトリでは、手動で cc-create-ui-design を付けても
  // 何も起きないようワーカー自体を起動しない（本機能追加前と完全に同一の挙動にする）。
  const uiDesignConfig = getUiDesignConfig();
  if (!uiDesignConfig.enabled) {
    console.log("[create-ui-design] uiDesign.enabled is false, skipping");
    return;
  }
  const yolo = uiDesignConfig.yolo;
  await createIssuePollingWorker({
    name: "create-ui-design",
    command: "/claude-task-worker:create-ui-design",
    triggerLabels: ["cc-create-ui-design"],
    excludeLabels: ["cc-ui-design-pr-created", "cc-ui-design-ready", "cc-exec-issue", "cc-pr-created"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      // Pencil 未導入などスキルが自力で進められないケースでは cc-need-human-check が
      // 付いている。デザインPRが無いのに進行ラベルを付けないよう先に打ち切る。
      if (await hasLabel("issue", issueNumber, "cc-need-human-check")) {
        console.log(`[create-ui-design] #${issueNumber}: cc-need-human-check present, skip cc-ui-design-pr-created`);
        return false;
      }
      // 「デザイン不要」と判定されたパスではスキルが description に不要マーカーを書いたうえで
      // cc-exec-issue（過去の版では cc-ui-design-ready も）を付けて終了する。デザインPRが
      // 無いのが正しい状態なので完了扱いにする。どちらもポーリングの excludeLabels なので、
      // 起動時点では付いておらず「今回のセッションが付けた」と確定できる。
      for (const label of ["cc-ui-design-ready", "cc-exec-issue"]) {
        if (await hasLabel("issue", issueNumber, label)) {
          console.log(`[create-ui-design] #${issueNumber}: design not needed (${label}), completing`);
          return;
        }
      }
      const branch = designBranchName(issueNumber);
      // "open" 限定にすることで、過去ラウンドの closed/merged デザインPRを
      // 今回のセッションの成果と誤認しない（今回何も作らなくても成功扱いになるのを防ぐ）。
      const prNumber = await findPrNumberByHeadRef(branch, "open");
      if (prNumber === null) {
        console.error(
          `[create-ui-design] #${issueNumber}: session exited without an open design PR (branch: ${branch}); marking cc-need-human-check`,
        );
        await addLabel("issue", issueNumber, "cc-need-human-check");
        await commentOnIssue(issueNumber, designPrNotCreatedComment(issueNumber)).catch((err) =>
          console.error(`[create-ui-design] commentOnIssue failed for #${issueNumber}: ${err}`),
        );
        return false;
      }
      try {
        // レビュー観点を切り替えられるよう cc-ui-design（デザインPRのマーカー）を付ける。
        await addLabel("pr", prNumber, "cc-ui-design");
        // cc-triage-scope は triage-pr の自動レビュー・自動マージ入口なので、
        // uiDesign.yolo が true のときだけ付ける。false（既定）ではデザインPRを
        // 人がレビュー・マージするまで止め、デザインへの人の介在を担保する。
        if (yolo) {
          await addLabel("pr", prNumber, "cc-triage-scope");
        } else {
          console.log(
            `[create-ui-design] #${issueNumber}: uiDesign.yolo is false, leaving design PR #${prNumber} for human review (no cc-triage-scope)`,
          );
        }
        await addLabel("issue", issueNumber, "cc-ui-design-pr-created");
      } catch (err) {
        // 本ワークフロー追加時のラベルが init 未実行で存在しない場合、addLabel は
        // リトライの末に throw する。付け漏れたまま完了扱いにすると孤児デザインPRが
        // 残るため、既存の「PR不在」分岐と同じパターンで人手確認に倒す。
        console.error(`[create-ui-design] #${issueNumber}: labeling design PR #${prNumber} failed: ${err}`);
        await addLabel("issue", issueNumber, "cc-need-human-check");
        await commentOnIssue(issueNumber, designPrLabelingFailedComment(issueNumber, prNumber, err, yolo)).catch(
          (commentErr) => console.error(`[create-ui-design] commentOnIssue failed for #${issueNumber}: ${commentErr}`),
        );
        return false;
      }
    },
  })();
};
