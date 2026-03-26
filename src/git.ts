import { execSync } from "node:child_process";

let running = false;

export function syncDefaultBranch(branch: string): void {
  if (running) return;
  running = true;
  try {
    execSync(`git worktree prune && git checkout ${branch} && git add -A && git reset --hard && git pull origin ${branch}`, { stdio: "pipe" });
  } finally {
    running = false;
  }
}
