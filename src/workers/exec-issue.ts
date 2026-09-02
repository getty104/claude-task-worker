import {
  addLabel,
  commentOnIssue,
  findPrNumberByHeadRef,
  getIssueState,
  hasLabel,
  linkClosingPr,
  listPrsClosingIssue,
  listPrsCrossReferencingIssue,
} from "../gh";
import type { ClosingPrRef } from "../gh";
import { createIssuePollingWorker } from "./issue-worker";

// 最終報告（stdout）は長くなりうるためコメントには末尾のみ載せる。
// PRを作らなかった理由は報告の結び（結論）に現れるため、先頭ではなく末尾を残す。
const REPORT_TAIL_LIMIT = 3000;

export function formatSessionReport(output: string): string {
  const trimmed = output.trim();
  if (trimmed === "") return "（セッションの出力はありませんでした）";
  const tail = trimmed.length > REPORT_TAIL_LIMIT ? `…（先頭を省略）\n${trimmed.slice(-REPORT_TAIL_LIMIT)}` : trimmed;
  return ["```", tail, "```"].join("\n");
}

// クラウド実行はセッションが自分でブランチ名を決めるため headRefName 一致を前提にできない。
// 代わりに base ブランチ一致 ＋ 作成時刻がタスク起動時刻以降であることで所有権を判定する。
export function selectOwnedClosingPr(
  candidates: ClosingPrRef[],
  ctx: {
    cloud: boolean;
    expectedHeadRefName: string;
    baseBranch: string;
    startedAt: number;
    now: number;
  },
): number | null {
  const open = candidates.filter((c) => c.state === "MERGED" || c.state === "OPEN");
  if (!ctx.cloud) {
    const found = open.find((c) => c.headRefName === ctx.expectedHeadRefName);
    return found ? found.number : null;
  }
  const found = open.find((c) => {
    if (c.baseRefName !== ctx.baseBranch) return false;
    const createdAt = Date.parse(c.createdAt);
    return !Number.isNaN(createdAt) && createdAt >= ctx.startedAt && createdAt <= ctx.now;
  });
  return found ? found.number : null;
}

function prMissingComment(worktreeId: string, output: string, cloud: boolean): string {
  const stateSection = cloud
    ? [
        "## 状態の確認",
        "- クラウドセッションは作業ブランチ名を自身で決めるため、ローカルからは名前が分かりません。claude.ai のセッション画面で作業ブランチと push 状況を確認してください",
      ]
    : [
        "## 状態の確認",
        `- 変更が push 済みの場合はリモートブランチ \`${worktreeId}\` が残っています。内容を確認し、必要なら手動でPRを作成してください`,
      ];
  return [
    "## PR未作成のまま自動実行が終了しました（要人手確認）",
    cloud
      ? "exec-issue のセッションは正常終了（exit 0）しましたが、本Issueを closing 参照するPRが見つかりませんでした。PR作成前にセッションが終了した可能性があります。"
      : `exec-issue のセッションは正常終了（exit 0）しましたが、この実行の作業ブランチ（\`${worktreeId}\`）を head とするPRも、本Issueを closing 参照するPRも見つかりませんでした。PR作成前にセッションが終了した可能性があります。`,
    "",
    "## PRを作成しなかった理由（セッションの最終報告）",
    formatSessionReport(output),
    "",
    ...stateSection,
    "",
    "## 対応後の進め方",
    "- 自動実行をやり直す場合: `cc-need-human-check` ラベルを外し、`cc-exec-issue` ラベルを付け直してください",
    "- 手動でPRを作成した場合など対応済みの場合: `cc-need-human-check` ラベルを外してください",
  ].join("\n");
}

export async function verifyPrCreated(
  issueNumber: number,
  worktreeId: string,
  output: string,
  ctx: { cloud: boolean; baseBranch: string; startedAt: number },
): Promise<boolean | void> {
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
  // ローカル実行: 作業ブランチ（worktreeId）を head とするPRを第一に、ブランチが変えられた
  // ケースの保険として closing 参照PR（headRefName一致）も探す。
  // クラウド実行: worktreeId のブランチは存在しないため findPrNumberByHeadRef は使わず、
  // closing 参照PRの所有権（base一致＋起動時刻以降の作成）だけを根拠にする。
  const ownership = {
    cloud: ctx.cloud,
    expectedHeadRefName: worktreeId,
    baseBranch: ctx.baseBranch,
    startedAt: ctx.startedAt,
    now: Date.now(),
  };
  let prNumber: number | null = null;
  if (!ctx.cloud) {
    prNumber = await findPrNumberByHeadRef(worktreeId, "all");
  }
  if (prNumber === null) {
    prNumber = selectOwnedClosingPr(await listPrsClosingIssue(issueNumber), ownership);
  }
  // GitHub は base がデフォルトブランチでない PR に closing reference を作らないため、Epic 配下
  // （base: cc-epic-<N>）の PR は body に `Closes #N` があっても上の経路には現れない。クラウド実行は
  // 作業ブランチ名も分からずここまでの判定材料が尽きるので、timeline の cross-referenced から拾い直す。
  // 採用したら明示的に紐付け、次回以降は closing reference 側の一次判定が効くようにする。
  if (prNumber === null) {
    const candidates = await listPrsCrossReferencingIssue(issueNumber).catch((err) => {
      console.error(`[exec-issue] listPrsCrossReferencingIssue failed for #${issueNumber}: ${err}`);
      return [];
    });
    prNumber = selectOwnedClosingPr(candidates, ownership);
    if (prNumber !== null) {
      await linkClosingPr(issueNumber, prNumber).catch((err) =>
        console.error(`[exec-issue] linkClosingPr failed for #${issueNumber} -> #${prNumber}: ${err}`),
      );
    }
  }
  if (prNumber !== null) {
    await addLabel("issue", issueNumber, "cc-pr-created");
    return;
  }
  console.error(
    `[exec-issue] #${issueNumber}: session exited without a PR (branch: ${worktreeId}); marking cc-need-human-check`,
  );
  await addLabel("issue", issueNumber, "cc-need-human-check");
  await commentOnIssue(issueNumber, prMissingComment(worktreeId, output, ctx.cloud)).catch((err) =>
    console.error(`[exec-issue] commentOnIssue failed for #${issueNumber}: ${err}`),
  );
  return false;
}

export const execIssueWorker = (opts: { epicFilters?: number[]; labelFilters?: string[] } = {}) =>
  createIssuePollingWorker({
    name: "exec-issue",
    command: "/claude-task-worker:exec-issue",
    triggerLabels: ["cc-exec-issue"],
    epicFilters: opts.epicFilters,
    labelFilters: opts.labelFilters,
    onCompleted: verifyPrCreated,
  })();
