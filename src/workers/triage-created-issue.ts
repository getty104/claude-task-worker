import { createIssuePollingWorker } from "./issue-worker";
import { addLabel } from "../gh";

export const triageCreatedIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "triage-created-issue",
    command: "/claude-task-worker:triage-created-issue",
    triggerLabels: ["cc-issue-created", "cc-triage-scope"],
    // cc-create-ui-design / cc-ui-design-pr-created はUIデザイン先行フローの進行中マーカー。
    // 除外しないと、トリガーラベル（cc-issue-created / cc-triage-scope）はトリアージ完了後も
    // 付き直されるため、デザインPRの作成〜レビュー〜マージが終わるまでの間ずっと再トリアージが
    // 走り続ける。しかもスキルのパターンE-1は「cc-create-ui-design / cc-ui-design-pr-created が
    // 付いていない」ことを前提ゲートにしているため、再実行では E-1 がスキップされてパターンE
    // （cc-exec-issue 付与）へ落ち、デザイン合意前に実装フェーズが始まってしまう。
    // cc-ui-design-ready はデザイン確定後のマーカーで、同時に付く cc-exec-issue 側で除外されるため
    // ここには含めない（実装完了後の再トリアージ可能性を残す）。
    excludeLabels: [
      "cc-pr-created",
      "cc-update-issue",
      "cc-answer-issue-questions",
      "cc-exec-issue",
      "cc-create-ui-design",
      "cc-ui-design-pr-created",
    ],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: async (issueNumber) => {
      await addLabel("issue", issueNumber, "cc-issue-created");
    },
  })();
