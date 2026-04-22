import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, rm, stat } from "node:fs/promises";

const execFileAsync = promisify(execFile);

async function forceRemoveIfExists(path: string): Promise<void> {
  try {
    await stat(path);
  } catch {
    return;
  }
  await rm(path, { recursive: true, force: true });
  console.log(`[worktree] Force removed remaining directory: ${path}`);
}

export async function removeWorktree(worktreeId: string): Promise<void> {
  const worktreePath = `.claude/worktrees/${worktreeId}`;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    console.error(`[worktree] Failed to remove worktree ${worktreeId}:`, error);
  }
  await forceRemoveIfExists(worktreePath);
}

export async function removeWorktreeByBranch(branchName: string): Promise<void> {
  try {
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"]);
    const entries = stdout.trim().split("\n\n").filter(Boolean);
    for (const entry of entries) {
      const branchLine = entry.split("\n").find(l => l.startsWith("branch "));
      if (!branchLine) continue;
      const branch = branchLine.replace("branch refs/heads/", "");
      if (branch !== branchName) continue;
      const worktreeLine = entry.split("\n").find(l => l.startsWith("worktree "));
      if (!worktreeLine) continue;
      const worktreePath = worktreeLine.replace("worktree ", "");
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
        console.log(`[worktree] Removed worktree for branch ${branchName}: ${worktreePath}`);
      } catch (error) {
        console.error(`[worktree] Failed to remove worktree for branch ${branchName}:`, error);
      }
      await forceRemoveIfExists(worktreePath);
    }
  } catch (error) {
    console.error(`[worktree] Failed to remove worktree for branch ${branchName}:`, error);
  }
}

export async function removeAllAgentWorktrees(): Promise<void> {
  const worktreesDir = ".claude/worktrees";
  let entries: string[];
  try {
    entries = await readdir(worktreesDir);
  } catch {
    return;
  }
  const agentDirs = entries.filter(e => e.startsWith("agent-"));
  for (const dir of agentDirs) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", `${worktreesDir}/${dir}`]);
      console.log(`[worktree] Removed agent worktree: ${dir}`);
    } catch (error) {
      console.error(`[worktree] Failed to remove agent worktree ${dir}:`, error);
    }
  }
}
