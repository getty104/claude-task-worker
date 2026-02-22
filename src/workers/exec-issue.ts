import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { notifyTaskCompleted, notifyTaskFailed } from "../slack.js";

const POLLING_INTERVAL_MS = 30 * 1000;

export async function execIssueWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[exec-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const issues = await listIssues(user, "dev-ready");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "in-progress")) continue;
        if (isRunning(issue.number)) continue;

        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        await addLabel("issue", issue.number, "in-progress");
        run("claude", ["--dangerously-skip-permissions", "-p", `/base-tools:exec-issue ${issue.number}`, "--worktree"], issue.number, issue.title, async (status) => {
          await removeLabel("issue", issue.number, "dev-ready");
          await removeLabel("issue", issue.number, "in-progress");
          if (status === "completed") {
            await notifyTaskCompleted("exec-issue", issue.number, issue.title, issueUrl);
          } else {
            await notifyTaskFailed("exec-issue", issue.number, issue.title, issueUrl);
          }
        });
      }
    } catch (err) {
      console.error(`[exec-issue] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
