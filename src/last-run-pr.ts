import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import { promisify } from "node:util";
import { writeLastRun } from "./config";
import { addAssignee, addLabel, createPullRequest, findOpenPrNumberByHeadRef, getCurrentUser } from "./gh";
import { createWorktreeFromBranch, getWorktreePath, removeWorktree } from "./worktree";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

// promisify を呼び出しのたびに行うのは、テストが childProcess.execFile を差し替えられるようにするため
// （モジュール読み込み時に束縛すると実コマンドが走る）。gh.ts の execGh と同じ理由。
const execFileAsync = (command: string, args: string[]) => promisify(childProcess.execFile)(command, args);

const CONFIG_FILE = "claude-task-worker.json";

// 記録PRのマージは triage-pr ワーカーに任せる。そのためのトリガーラベル。
const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

// ワーカーごとに固定のブランチ名。未マージのPRが残っている場合は同じブランチへ
// force-push して同一PRを進めるため、タイムスタンプPRが積み上がらない。
export function lastRunBranchName(workerName: string): string {
  return `ctw-last-run-${workerName}`;
}

// `git status --porcelain <file>` の出力から、コミットすべき差分があるかを判定する。
// 同じ時刻を2回書いた場合など、差分ゼロで commit すると git がエラーになるため先に見る。
export function hasLastRunChange(porcelain: string): boolean {
  return porcelain.trim().length > 0;
}

export function lastRunPrTitle(workerName: string): string {
  return `chore: ${workerName} の実行記録を更新`;
}

export function lastRunPrBody(workerName: string, at: Date): string {
  return [
    `\`claude-task-worker\` の \`${workerName}\` ワーカーが、定期実行の記録（\`lastRun.${workerName}\`）を更新しました。`,
    "",
    `- 実行時刻: ${at.toISOString()}`,
    "",
    `このPRは実行記録のみを更新します（成果物の変更は同ワーカーが起動したスキルが別PRで出します）。`,
    `マージは \`triage-pr\` ワーカーが行います。`,
  ].join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args]);
  return stdout;
}

/**
 * 定期ワーカーの最終実行時刻（`lastRun`）だけを更新するPRを作る。
 *
 * スキルの成果物PRとは独立させている。材料が無くてスキルがPRを作らなかった日でも
 * `lastRun` をマージで恒久化する必要があり、それをスキル本文の手順（＝モデルの遵守）に
 * 依存させると、材料ゼロの早期終了パスで黙って落ちる。
 *
 * 返り値のPR番号は、クラウド実行の完了検知（cc-cloud-done）の置き先としても使う。
 * 定期ワーカーは Issue/PR を起点に走らないため、他に検知対象になるものが無い。
 * PRを作らなかった場合（差分なし・失敗）は null。
 */
export async function publishLastRunPr(workerName: string, defaultBranch: string, at: Date): Promise<number | null> {
  const branch = lastRunBranchName(workerName);
  const cwd = getWorktreePath(branch);
  try {
    await createWorktreeFromBranch(branch, defaultBranch);
    writeLastRun(cwd, workerName, at);
    if (!hasLastRunChange(await git(cwd, ["status", "--porcelain", CONFIG_FILE]))) {
      console.log(`[${workerName}] lastRun unchanged, skipping PR`);
      return null;
    }
    await git(cwd, ["add", CONFIG_FILE]);
    await git(cwd, ["commit", "-m", lastRunPrTitle(workerName)]);
    await git(cwd, ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);

    // 前回のPRが（マージ前に次の実行が来たなどで）残っていれば、force-push でタイムスタンプを
    // 進めたそのPRをそのまま使う。記録PRが積み上がらない。
    const existing = await findOpenPrNumberByHeadRef(branch);
    const prNumber =
      existing ??
      (await createPullRequest(defaultBranch, branch, lastRunPrTitle(workerName), lastRunPrBody(workerName, at)));
    console.log(`[${workerName}] ${existing !== null ? "updated" : "opened"} lastRun PR #${prNumber}`);

    // マージは triage-pr ワーカーに任せる。ワーカーが直接マージすると必須チェック・ブランチ
    // 保護をすり抜けるため。同ワーカーは cc-triage-scope と Assignee の**両方**で候補を絞るので、
    // どちらが欠けても記録PRは永久に拾われない。
    //
    // 付与を `gh pr create --label/--assignee` に任せず毎回付け直すのは、固定ブランチのPRでは
    // 一度欠けると自力で復旧できないため。gh はラベル・Assignee をPR作成後の別ミューテーションで
    // 付けるため、そこが落ちると非0終了なのにメタデータ無しのPRだけが残る（実測: 記録PR2件が
    // ラベルもAssigneeも無い状態で作られ、うち1件は誰にも拾われず未マージのままクローズされた）。
    // 以降の実行は existing 経路（PR再利用）に入り create を通らないので、二度と付かない。
    // addLabel / addAssignee はどちらも冪等なので、毎回叩けば壊れたPRも次の実行で復旧する。
    await addLabel("pr", prNumber, LABEL_TRIAGE_SCOPE).catch((err) =>
      console.error(`[${workerName}] addLabel ${LABEL_TRIAGE_SCOPE} failed for PR #${prNumber}: ${err}`),
    );
    await addAssignee("pr", prNumber, await getCurrentUser()).catch((err) =>
      console.error(`[${workerName}] addAssignee failed for PR #${prNumber}: ${err}`),
    );
    return prNumber;
  } finally {
    await removeWorktree(branch).catch((err) => console.error(`[${workerName}] removeWorktree failed: ${err}`));
  }
}
