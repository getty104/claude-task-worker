import { execSync } from "node:child_process";

let running = false;

export function syncDefaultBranch(branch: string): void {
  if (running) return;
  running = true;
  try {
    execSync(`git checkout ${branch} && git pull origin ${branch}`, { stdio: "pipe" });
  } finally {
    running = false;
  }
}
