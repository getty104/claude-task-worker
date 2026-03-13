import { getRepoInfo, listPullRequestsWithChecks, isCICompleted } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { notifyError } from "../slack.js";

const POLLING_INTERVAL_MS = 5 * 60 * 1000;
const TASK_ID = -2;

export async function triagePrsWorker(): Promise<void> {
  const { name } = await getRepoInfo();
  console.log(`[triage-prs] Polling PRs every 5 minutes for ${name}`);

  const tick = async () => {
    try {
      if (isRunning(TASK_ID)) return;

      const prs = await listPullRequestsWithChecks();
      const candidates = prs.filter(
        pr =>
          !pr.labels.some(l => l.name === "cc-in-progress") &&
          isCICompleted(pr.statusCheckRollup)
      );

      if (candidates.length === 0) return;

      run("claude", ["--dangerously-skip-permissions", "-p", "/base-tools:triage-prs"], TASK_ID, "Triage PRs");
    } catch (err) {
      console.error(`[triage-prs] tick error: ${err}`);
      await notifyError("triage-prs", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
