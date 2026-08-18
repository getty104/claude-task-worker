import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeLastRun } from "./config";
import { addLabel, createPullRequest, findOpenPrNumberByHeadRef } from "./gh";
import { createWorktreeFromBranch, getWorktreePath, removeWorktree } from "./worktree";

const execFileAsync = promisify(execFile);

const TRIAGE_LABEL = "cc-triage-scope";
const CONFIG_FILE = "claude-task-worker.json";

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
    `マージされることで次回実行の抑止が恒久化するため、内容の確認は不要です。`,
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
 */
export async function publishLastRunPr(workerName: string, defaultBranch: string, at: Date): Promise<void> {
  const branch = lastRunBranchName(workerName);
  const cwd = getWorktreePath(branch);
  try {
    await createWorktreeFromBranch(branch, defaultBranch);
    writeLastRun(cwd, workerName, at);
    if (!hasLastRunChange(await git(cwd, ["status", "--porcelain", CONFIG_FILE]))) {
      console.log(`[${workerName}] lastRun unchanged, skipping PR`);
      return;
    }
    await git(cwd, ["add", CONFIG_FILE]);
    await git(cwd, ["commit", "-m", lastRunPrTitle(workerName)]);
    await git(cwd, ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);

    const existing = await findOpenPrNumberByHeadRef(branch);
    if (existing !== null) {
      console.log(`[${workerName}] updated existing lastRun PR #${existing}`);
      return;
    }
    const prNumber = await createPullRequest(
      defaultBranch,
      branch,
      lastRunPrTitle(workerName),
      lastRunPrBody(workerName, at),
    );
    await addLabel("pr", prNumber, TRIAGE_LABEL);
    console.log(`[${workerName}] created lastRun PR #${prNumber}`);
  } finally {
    await removeWorktree(branch).catch((err) => console.error(`[${workerName}] removeWorktree failed: ${err}`));
  }
}
