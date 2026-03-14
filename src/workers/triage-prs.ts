import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentUser, getRepoInfo, listPullRequestsWithChecks, isCICompleted } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { generateWorktreeName } from "../random-name.js";
import { notifyError } from "../slack.js";

const execFileAsync = promisify(execFile);

const POLLING_INTERVAL_MS = 10 * 60 * 1000;
const TASK_ID = -2;

export async function triagePrsWorker(): Promise<void> {
  const { name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[triage-prs] Polling PRs every 10 minutes for ${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      if (isRunning(TASK_ID)) return;

      const prs = await listPullRequestsWithChecks(user);
      const candidates = prs.filter(
        pr =>
          !pr.labels.some(l => l.name === "cc-in-progress") &&
          isCICompleted(pr.statusCheckRollup)
      );

      if (candidates.length === 0) return;

      const worktreeId = generateWorktreeName();
      run("claude", ["--dangerously-skip-permissions", "-p", "/base-tools:triage-prs", "--worktree", worktreeId], TASK_ID, "Triage PRs", "triage-prs", async () => {
        await execFileAsync("git", ["worktree", "remove", "--force", `.claude/worktrees/${worktreeId}`]);
      });
    } catch (err) {
      console.error(`[triage-prs] tick error: ${err}`);
      await notifyError("triage-prs", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
