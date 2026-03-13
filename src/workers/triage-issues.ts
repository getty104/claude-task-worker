import { getRepoInfo, listAllIssues } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { notifyError } from "../slack.js";

const POLLING_INTERVAL_MS = 10 * 60 * 1000;
const TASK_ID = -1;

export async function triageIssuesWorker(): Promise<void> {
  const { name } = await getRepoInfo();
  console.log(`[triage-issues] Polling issues every 10 minutes for ${name}`);

  const tick = async () => {
    try {
      if (isRunning(TASK_ID)) return;

      const issues = await listAllIssues();
      const candidates = issues.filter(
        issue => !issue.labels.some(l => l.name === "cc-in-progress")
      );

      if (candidates.length === 0) return;

      run("claude", ["--dangerously-skip-permissions", "-p", "/base-tools:triage-issues"], TASK_ID, "Triage Issues");
    } catch (err) {
      console.error(`[triage-issues] tick error: ${err}`);
      await notifyError("triage-issues", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
