import { getCurrentUser, getRepoInfo, listTriageScopeIssues } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isShuttingDown, run } from "../process-manager";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { config } from "../config.js";

const INTERVAL_MINUTE = 10;
const POLLING_INTERVAL_MS = INTERVAL_MINUTE * 60 * 1000;
const TASK_ID = -1;

export async function triageIssuesWorker(): Promise<void> {
  const assignee = await getCurrentUser();
  const { owner, name, defaultBranch } = await getRepoInfo();
  console.log(`[triage-issues] Polling issues every ${INTERVAL_MINUTE} minutes for ${name}`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      if (isRunning(TASK_ID)) return;

      const issues = await listTriageScopeIssues(assignee, config.maxConcurrentTasks);
      const EXCLUDE_LABELS = ["cc-create-issue", "cc-update-issue", "cc-exec-issue", "cc-pr-created"];
      const candidates = issues.filter(
        issue => !issue.labels.some(l => EXCLUDE_LABELS.includes(l.name))
      );

      if (candidates.length === 0) return;

      const repoUrl = `https://github.com/${owner}/${name}`;
      syncDefaultBranch(defaultBranch);
      run("claude", ["--dangerously-skip-permissions", "-p", `/base-tools:triage-issues ${config.maxConcurrentTasks}`], TASK_ID, "Triage Issues", "triage-issues", undefined, async (status, output) => {
        try {
          if (status === "completed") {
            await notifyTaskCompleted("triage-issues", name, TASK_ID, "Triage Issues", repoUrl);
          } else {
            await notifyTaskFailed("triage-issues", name, TASK_ID, "Triage Issues", repoUrl, output);
          }
        } catch (err) {
          console.error(`[triage-issues] post-task error: ${err}`);
        }
      });
    } catch (err) {
      console.error(`[triage-issues] tick error: ${err}`);
      await notifyError("triage-issues", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
