import { getUiDesignConfig } from "../config";
import {
  addAssignee,
  addLabel,
  bodyMentionsIssue,
  commentOnIssue,
  deleteRemoteBranch,
  findPrNumberByHeadRef,
  getCurrentUser,
  hasLabel,
  listPrsCrossReferencingIssue,
  renameRemoteBranch,
} from "../gh";
import { selectOwnedClosingPr } from "./exec-issue";
import { createIssuePollingWorker } from "./issue-worker";
import { defineWorker } from "./worker-definition";
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

// クラウドセッションは `--ref` 起点の `claude/<...>` ブランチで作業し、セッション側のブランチ規約が
// スキルの固定ブランチ（`cc-ui-design-<N>`）への切り替えに勝つため、デザインPRが正しく作られても
// head ref 一致では見つからない。exec-issue と同じ所有権判定（Issue を `#N` で参照する PR ＋ base
// 一致 ＋ 起動時刻以降の作成）で特定し、head ブランチを固定名へ改名して、後段（apply-ui-design の
// ワーカー preflight とスキル）の head ref 一致をそのまま成立させる。
export async function adoptCloudDesignPr(
  issueNumber: number,
  branch: string,
  ctx: { baseBranch: string; startedAt: number },
): Promise<number | null> {
  const candidates = await listPrsCrossReferencingIssue(issueNumber, bodyMentionsIssue);
  const prNumber = selectOwnedClosingPr(candidates, {
    cloud: true,
    expectedHeadRefName: branch,
    baseBranch: ctx.baseBranch,
    startedAt: ctx.startedAt,
    now: Date.now(),
  });
  if (prNumber === null) return null;
  const head = candidates.find((c) => c.number === prNumber)?.headRefName ?? "";
  if (head === "" || head === branch) return prNumber;
  // 過去ラウンドの残骸（open PR の無い固定ブランチ）があると改名が 422 で止まるため先に消す。
  // スキル自身も同ブランチを force-push で上書きする契約なので、消してよい。
  await deleteRemoteBranch(branch).catch(() => {});
  await renameRemoteBranch(head, branch);
  console.log(`[create-ui-design] #${issueNumber}: renamed design PR #${prNumber} head ${head} -> ${branch}`);
  return prNumber;
}

export const createUiDesignWorker = defineWorker({
  name: "create-ui-design",
  kind: "issue",
  start: async (opts) => {
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
      onCompleted: async (issueNumber, _worktreeId, _output, ctx) => {
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
        let prNumber = await findPrNumberByHeadRef(branch, "open");
        if (prNumber === null && ctx.cloud) {
          prNumber = await adoptCloudDesignPr(issueNumber, branch, ctx).catch((err) => {
            console.error(`[create-ui-design] #${issueNumber}: adoptCloudDesignPr failed: ${err}`);
            return null;
          });
        }
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
          // triage-pr は Assignee でも絞るため付け直す（クラウドの MCP 作成経路では欠落しうる。冪等）。
          // 付け漏れても人のレビュー経路は止まらないので、人手確認には倒さない。
          await getCurrentUser()
            .then((user) => addAssignee("pr", prNumber, user))
            .catch((assignErr) =>
              console.error(`[create-ui-design] addAssignee failed for PR #${prNumber}: ${assignErr}`),
            );
        } catch (err) {
          // 本ワークフロー追加時のラベルが init 未実行で存在しない場合、addLabel は
          // リトライの末に throw する。付け漏れたまま完了扱いにすると孤児デザインPRが
          // 残るため、既存の「PR不在」分岐と同じパターンで人手確認に倒す。
          console.error(`[create-ui-design] #${issueNumber}: labeling design PR #${prNumber} failed: ${err}`);
          await addLabel("issue", issueNumber, "cc-need-human-check");
          await commentOnIssue(issueNumber, designPrLabelingFailedComment(issueNumber, prNumber, err, yolo)).catch(
            (commentErr) =>
              console.error(`[create-ui-design] commentOnIssue failed for #${issueNumber}: ${commentErr}`),
          );
          return false;
        }
      },
    }).start(opts);
  },
});
