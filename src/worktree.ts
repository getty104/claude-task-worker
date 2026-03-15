import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";

const execFileAsync = promisify(execFile);

export async function removeWorktree(worktreeId: string): Promise<void> {
  const worktreePath = `.claude/worktrees/${worktreeId}`;
  await setTimeout(1000);
  if (existsSync(worktreePath)) {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath]);
  }
}
