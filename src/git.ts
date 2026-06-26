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

export async function ensureEpicBranch(epicBranch: string, defaultBranch: string): Promise<void> {
  try {
    await execFileAsync("git", ["fetch", "origin", `${epicBranch}:refs/remotes/origin/${epicBranch}`]);
    return;
  } catch {
    // remote に epicBranch が無い → defaultBranch から派生作成して push
  }
  await execFileAsync("git", ["fetch", "origin", defaultBranch]);
  await execFileAsync("git", [
    "push",
    "origin",
    `refs/remotes/origin/${defaultBranch}:refs/heads/${epicBranch}`,
  ]);
  await execFileAsync("git", ["fetch", "origin", `${epicBranch}:refs/remotes/origin/${epicBranch}`]);
}
