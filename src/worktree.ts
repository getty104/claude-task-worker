import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir } from "node:fs/promises";

const execFileAsync = promisify(execFile);

export async function removeWorktree(worktreeId: string): Promise<void> {
  const worktreePath = `.claude/worktrees/${worktreeId}`;
  try {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    console.error(`[worktree] Failed to remove worktree ${worktreeId}:`, error);
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
