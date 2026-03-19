import { getCurrentUser, getRepoInfo, listAllIssues } from "../gh.js";
import { syncDefaultBranch } from "../git.js";
import { isRunning, run } from "../process-manager.js";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack.js";

const POLLING_INTERVAL_MS = 10 * 60 * 1000;
const TASK_ID = -1;

export async function triageIssuesWorker(options?: { waitForFirstRun?: boolean }): Promise<void> {
  const assignee = await getCurrentUser();
  const { owner, name, defaultBranch } = await getRepoInfo();
  console.log(`[triage-issues] Polling issues every 10 minutes for ${name}`);

  let firstRunResolve: (() => void) | undefined;
  const firstRunPromise = options?.waitForFirstRun
    ? new Promise<void>(resolve => { firstRunResolve = resolve; })
    : undefined;

  const tick = async () => {
    try {
      if (isRunning(TASK_ID)) return;

      const issues = await listAllIssues(assignee);
      const EXCLUDE_LABELS = ["cc-create-issue", "cc-update-issue", "cc-exec-issue", "cc-pr-created"];
      const candidates = issues.filter(
        issue => !issue.labels.some(l => EXCLUDE_LABELS.includes(l.name))
      );

      if (candidates.length === 0) {
        firstRunResolve?.();
        firstRunResolve = undefined;
        return;
      }

      const repoUrl = `https://github.com/${owner}/${name}`;
      syncDefaultBranch(defaultBranch);
      run("claude", ["--dangerously-skip-permissions", "-p", "/base-tools:triage-issues"], TASK_ID, "Triage Issues", "triage-issues", async (status, output) => {
        if (status === "completed") {
          await notifyTaskCompleted("triage-issues", name, TASK_ID, "Triage Issues", repoUrl);
        } else {
          await notifyTaskFailed("triage-issues", name, TASK_ID, "Triage Issues", repoUrl, output);
        }
        firstRunResolve?.();
        firstRunResolve = undefined;
      });
    } catch (err) {
      console.error(`[triage-issues] tick error: ${err}`);
      await notifyError("triage-issues", name, err);
      firstRunResolve?.();
      firstRunResolve = undefined;
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
  if (firstRunPromise) await firstRunPromise;
}
