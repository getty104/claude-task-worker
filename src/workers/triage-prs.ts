import { getCurrentUser, getRepoInfo, listPullRequestsWithChecks } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isShuttingDown, run } from "../process-manager";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeAllAgentWorktrees } from "../worktree";
import { config } from "../config.js";

const INTERVAL_MINUTE = 10;
const POLLING_INTERVAL_MS = INTERVAL_MINUTE * 60 * 1000;
const TASK_ID = -2;

export async function triagePrsWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[triage-prs] Polling PRs every ${INTERVAL_MINUTE} minutes for ${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      if (isRunning(TASK_ID)) return;

      const candidates = await listPullRequestsWithChecks(user, { triageScope: true });

      if (candidates.length === 0) return;

      const repoUrl = `https://github.com/${owner}/${name}`;
      syncDefaultBranch(defaultBranch);
      run("claude", ["--dangerously-skip-permissions", "-p", `/base-tools:triage-prs ${config.maxConcurrentTasks}`], TASK_ID, "Triage PRs", "triage-prs", undefined, async (status, output) => {
        try {
          await removeAllAgentWorktrees();
          if (status === "completed") {
            await notifyTaskCompleted("triage-prs", name, TASK_ID, "Triage PRs", repoUrl);
          } else {
            await notifyTaskFailed("triage-prs", name, TASK_ID, "Triage PRs", repoUrl, output);
          }
        } catch (err) {
          console.error(`[triage-prs] post-task error: ${err}`);
        }
      });
    } catch (err) {
      console.error(`[triage-prs] tick error: ${err}`);
      await notifyError("triage-prs", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
