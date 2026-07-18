import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rm, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { isWorktreeInUse } from "./process-manager";
import { isGeneratedWorktreeName } from "./random-name";

const execFileAsync = promisify(execFile);

const WORKTREES_DIR = ".claude/worktrees";

interface WorktreeEntry {
  path: string;
  branch?: string;
  locked: boolean;
}

function isManagedWorktreePath(path: string): boolean {
  return resolve(path).startsWith(resolve(WORKTREES_DIR) + sep);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function forceRemoveIfExists(path: string): Promise<void> {
  if (!isManagedWorktreePath(path)) {
    console.error(`[worktree] Refusing to remove path outside ${WORKTREES_DIR}: ${path}`);
    return;
  }
  if (!(await pathExists(path))) return;
  try {
    await rm(path, { recursive: true, force: true });
    console.log(`[worktree] Force removed remaining directory: ${path}`);
  } catch (error) {
    console.error(`[worktree] Failed to remove directory ${path}:`, error);
  }
}

async function listWorktreeEntries(): Promise<WorktreeEntry[]> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"]);
  return stdout
    .replace(/\r\n/g, "\n")
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((entry) => {
      const lines = entry.split("\n");
      const worktreeLine = lines.find((l) => l.startsWith("worktree "));
      const branchLine = lines.find((l) => l.startsWith("branch refs/heads/"));
      return {
        path: worktreeLine ? worktreeLine.slice("worktree ".length) : "",
        branch: branchLine?.slice("branch refs/heads/".length),
        locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      };
    })
    .filter((e) => e.path !== "");
}

/**
 * worktree を登録から外して実体ディレクトリも削除する。
 * claude CLI が残した locked worktree や、ディレクトリだけ消えた幽霊エントリも
 * `--force --force` で管理メタデータごと除去できる（locked は force 1回では削除できない）。
 */
async function removeRegisteredWorktree(worktreePath: string): Promise<void> {
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", "--force", worktreePath]);
  } catch (error) {
    console.error(`[worktree] Failed to remove worktree ${worktreePath}:`, error);
  }
  await forceRemoveIfExists(worktreePath);
}

const PROTECTED_BRANCHES = new Set(["main", "master", "develop"]);

/** origin/HEAD からデフォルトブランチ名を取得する（未設定などで取得できない場合は undefined）。 */
async function getDefaultBranchName(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    return stdout.trim().replace(/^origin\//, "");
  } catch {
    return undefined;
  }
}

/**
 * ローカルブランチを削除する。worktree 削除後のブランチ残留（リーク）防止用。
 * 存在しないブランチは黙って無視し、他の worktree で checkout 中などの失敗のみログする。
 */
export async function deleteLocalBranch(branchName: string): Promise<void> {
  const defaultBranch = await getDefaultBranchName();
  if (PROTECTED_BRANCHES.has(branchName) || branchName === defaultBranch) {
    console.log(`[worktree] Skipping deletion of protected branch: ${branchName}`);
    return;
  }
  try {
    await execFileAsync("git", ["branch", "-D", branchName]);
    console.log(`[worktree] Deleted local branch: ${branchName}`);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown } | null | undefined)?.stderr ?? "");
    if (/not found/i.test(stderr)) return;
    console.error(`[worktree] Failed to delete local branch ${branchName}: ${stderr.trim()}`);
  }
}

/**
 * ローカルブランチが存在するかを返す。
 * deleteLocalBranch が「他の worktree で checkout 中」などの理由で削除に失敗しても
 * エラーはログに留まるため、削除後に本当に消えたかはこの関数で確認する。
 */
export async function localBranchExists(branchName: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

export function getWorktreePath(worktreeId: string): string {
  return `${WORKTREES_DIR}/${worktreeId}`;
}

export async function createWorktreeFromBranch(worktreeId: string, baseBranch: string): Promise<void> {
  const worktreePath = getWorktreePath(worktreeId);
  // detached HEAD だと後段の commit-push スキルの `git push origin HEAD` が
  // refspec を解決できず失敗するため、worktreeId と同名のブランチを切って checkout する。
  // -B を使うことで孤児ブランチが残っていても origin/${baseBranch} から強制再作成して安全に回復できる。
  // --track で upstream に origin/${baseBranch} を明示記録する（branch.autoSetupMerge=false 環境でも保証）。
  // create-pr スキルはこの upstream をPRベースブランチの確定的導出に使うため、省略すると
  // merge-base 距離推定に落ちて無関係な cc-epic-* ブランチをベースに選ぶことがある。
  await execFileAsync("git", ["worktree", "add", "--track", "-B", worktreeId, worktreePath, `origin/${baseBranch}`]);
}

export async function removeWorktree(worktreeId: string): Promise<void> {
  const worktreePath = getWorktreePath(worktreeId);

  let entry: WorktreeEntry | undefined;
  try {
    entry = (await listWorktreeEntries()).find((e) => resolve(e.path) === resolve(worktreePath));
  } catch (error) {
    console.error(`[worktree] Failed to list worktrees:`, error);
  }

  if (entry) {
    await removeRegisteredWorktree(worktreePath);
  } else {
    // 登録が無くてもディレクトリだけ残っているケース（作成途中の失敗など）を回収する
    await forceRemoveIfExists(worktreePath);
  }

  // worktree 削除ではブランチは消えないため、checkout されていたブランチと
  // worktreeId と同名のブランチ（createWorktreeFromBranch が作成）を明示的に削除する
  const branches = new Set([entry?.branch, worktreeId]);
  for (const branch of branches) {
    if (!branch) continue;
    await deleteLocalBranch(branch);
  }
}

export async function removeWorktreeByBranch(branchName: string): Promise<void> {
  try {
    const entries = await listWorktreeEntries();
    for (const entry of entries) {
      if (entry.branch !== branchName) continue;
      if (!isManagedWorktreePath(entry.path)) {
        console.log(`[worktree] Skipping unmanaged worktree for branch ${branchName}: ${entry.path}`);
        continue;
      }
      // 実行中タスクが使用している worktree を破壊しない（PR 作成元タスクがまだ動いているケース）
      const worktreeId = basename(entry.path);
      if (isWorktreeInUse(worktreeId)) {
        console.log(`[worktree] Skipping worktree in use by a running task for branch ${branchName}: ${entry.path}`);
        continue;
      }
      // locked かつ実体が残っている worktree はアクティブな claude セッションの可能性があるため触らない
      // （ディレクトリが消えている locked エントリは幽霊なので回収する）
      if (entry.locked && (await pathExists(entry.path))) {
        console.log(`[worktree] Skipping locked worktree for branch ${branchName}: ${entry.path}`);
        continue;
      }
      await removeRegisteredWorktree(entry.path);
      console.log(`[worktree] Removed worktree for branch ${branchName}: ${entry.path}`);
    }
  } catch (error) {
    console.error(`[worktree] Failed to remove worktree for branch ${branchName}:`, error);
  }
}

/**
 * 前回のクラッシュ・強制終了などで残った worktree を起動時に一括回収する。
 * generateWorktreeName() 形式（adj-noun-4桁）の名前だけを対象にすることで、
 * ユーザーが対話セッションで使用中の claude worktree を誤って削除しない。
 */
export async function removeStaleWorktrees(): Promise<void> {
  const worktreeIds = new Set<string>();

  try {
    for (const name of await readdir(WORKTREES_DIR)) {
      if (isGeneratedWorktreeName(name)) worktreeIds.add(name);
    }
  } catch {
    // ディレクトリが無ければディスク上の残骸は無い
  }

  try {
    for (const entry of await listWorktreeEntries()) {
      if (!isManagedWorktreePath(entry.path)) continue;
      const worktreeId = basename(entry.path);
      if (isGeneratedWorktreeName(worktreeId)) worktreeIds.add(worktreeId);
    }
  } catch (error) {
    console.error(`[worktree] Failed to list worktrees:`, error);
  }

  for (const worktreeId of worktreeIds) {
    if (isWorktreeInUse(worktreeId)) continue;
    console.log(`[worktree] Removing stale worktree: ${worktreeId}`);
    await removeWorktree(worktreeId);
  }
}
