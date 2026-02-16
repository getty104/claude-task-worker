import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel, getIssueBody, closeIssue } from "../gh.js";
import { isRunning, run } from "../process-manager.js";

const POLLING_INTERVAL_MS = 30 * 1000;

export async function createIssueWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[create-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const issues = await listIssues(user, "create-issue");

      for (const issue of issues) {
        if (isRunning(issue.number)) continue;

        await removeLabel("issue", issue.number, "create-issue");
        await addLabel("issue", issue.number, "in-progress");

        const body = await getIssueBody(issue.number);
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", `/create-issue ${body}`],
          issue.number,
          issue.title,
          async () => {
            try {
              await removeLabel("issue", issue.number, "in-progress");
              await closeIssue(issue.number);
            } catch (err) {
              console.error(`[create-issue] Failed to close issue #${issue.number}: ${err}`);
            }
          },
        );
      }
    } catch (err) {
      console.error(`[create-issue] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
