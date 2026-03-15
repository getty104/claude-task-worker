import { getCurrentUser, getRepoInfo, listPullRequestsWithChecks, isCICompleted } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack.js";

const POLLING_INTERVAL_MS = 5 * 60 * 1000;
const TASK_ID = -2;

export async function triagePrsWorker(options?: { waitForFirstRun?: boolean }): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[triage-prs] Polling PRs every 5 minutes for ${name} (assignee: ${user})`);

  let firstRunResolve: (() => void) | undefined;
  const firstRunPromise = options?.waitForFirstRun
    ? new Promise<void>(resolve => { firstRunResolve = resolve; })
    : undefined;

  const tick = async () => {
    try {
      if (isRunning(TASK_ID)) return;

      const prs = await listPullRequestsWithChecks(user);
      const candidates = prs.filter(
        pr =>
          !pr.labels.some(l => l.name === "cc-in-progress") &&
          isCICompleted(pr.statusCheckRollup)
      );

      if (candidates.length === 0) {
        firstRunResolve?.();
        firstRunResolve = undefined;
        return;
      }

      const repoUrl = `https://github.com/${owner}/${name}`;
      run("claude", ["--dangerously-skip-permissions", "-p", "/base-tools:triage-prs"], TASK_ID, "Triage PRs", "triage-prs", async (status, output) => {
        if (status === "completed") {
          await notifyTaskCompleted("triage-prs", name, TASK_ID, "Triage PRs", repoUrl);
        } else {
          await notifyTaskFailed("triage-prs", name, TASK_ID, "Triage PRs", repoUrl, output);
        }
        firstRunResolve?.();
        firstRunResolve = undefined;
      });
    } catch (err) {
      console.error(`[triage-prs] tick error: ${err}`);
      await notifyError("triage-prs", name, err);
      firstRunResolve?.();
      firstRunResolve = undefined;
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
  if (firstRunPromise) await firstRunPromise;
}
