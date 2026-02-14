import { getCurrentUser, listIssues, removeLabel, addLabel } from "../gh.js";
import { isRunning, run } from "../process-manager.js";

const POLLING_INTERVAL_MS = 30 * 1000;

export async function execIssueWorker(): Promise<void> {
  const user = await getCurrentUser();
  console.log(`[exec-issue] Polling issues every 30 seconds for user ${user}`);

  const tick = async () => {
    try {
      const issues = await listIssues(user, "dev-ready");

      for (const issue of issues) {
        if (isRunning(issue.number)) continue;

        console.log(`[exec-issue] Processing issue #${issue.number}: ${issue.title}`);
        await removeLabel("issue", issue.number, "dev-ready");
        await addLabel("issue", issue.number, "in-progress");
        run("claude", ["--dangerously-skip-permissions", "-p", `/exec-issue ${issue.number}`], issue.number, issue.title);
      }
    } catch (err) {
      console.error(`[exec-issue] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
