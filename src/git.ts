import { execSync, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let running = false;

export function syncDefaultBranch(branch: string): void {
  if (running) return;
  running = true;
  try {
    execSync(
      `git worktree prune && git checkout ${branch} && git add -A && git reset --hard && git fetch origin ${branch} && git reset --hard origin/${branch}`,
      { stdio: "pipe" },
    );
  } finally {
    running = false;
  }
}

/**
 * epic ブランチの remote-tracking ref (refs/remotes/origin/<epicBranch>) を
 * ローカルに用意する。remote に epic ブランチが無ければ defaultBranch から派生させて push する。
 * 完了時点で origin/<epicBranch> が必ず解決できることを保証する（できなければ throw）。
 */
export async function ensureEpicBranch(epicBranch: string, defaultBranch: string): Promise<void> {
  try {
    await fetchRemoteTracking(epicBranch);
    await assertRemoteTrackingExists(epicBranch);
    return;
  } catch (error) {
    // remote に epic ブランチが存在しない場合のみ派生作成に進む。
    // それ以外（ネットワーク・認証・ロック競合など）は握りつぶさず throw する。
    if (!isMissingRemoteRefError(error)) {
      throw error;
    }
  }

  // defaultBranch を「一意な名前の」remote-tracking ref に明示 dst で取り込み、
  // それを push source にして epic ブランチを作成する。
  // FETCH_HEAD のような共有スロットを避けることで、並行実行時に別 fetch が
  // source を上書きして誤コミットを push してしまう競合を防ぐ。
  await fetchRemoteTracking(defaultBranch);
  await execFileAsync("git", ["push", "origin", `refs/remotes/origin/${defaultBranch}:refs/heads/${epicBranch}`]);
  await fetchRemoteTracking(epicBranch);

  // ここまで来ても remote-tracking ref が無ければ worktree add に進ませない。
  await assertRemoteTrackingExists(epicBranch);
}

/**
 * origin/<branch> を refs/remotes/origin/<branch> に force で取り込む（標準の remote-tracking と同じ挙動）。
 * fetch.prune=true 環境で短縮形 src はリモート広告 ref（完全名）とリテラル比較され
 * 「消えたブランチ」と誤判定されて dst が prune 削除されるため、
 * src は refs/heads/ で完全修飾し、さらに --no-prune で prune 自体を無効化する。
 */
async function fetchRemoteTracking(branch: string): Promise<void> {
  await execFileAsync("git", ["fetch", "--no-prune", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

/** fetch エラーが「remote に該当 ref が無い」ことによるものかを判定する。 */
function isMissingRemoteRefError(error: unknown): boolean {
  const stderr = String((error as { stderr?: unknown } | null | undefined)?.stderr ?? "");
  return /couldn't find remote ref/i.test(stderr);
}

/** refs/remotes/origin/<epicBranch> がローカルに存在することを保証する（無ければ throw）。 */
async function assertRemoteTrackingExists(epicBranch: string): Promise<void> {
  await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${epicBranch}`]);
}
