import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";
const POLLING_INTERVAL_MS = 30 * 1000;

export async function createIssueWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[create-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      const issues = await listIssues(user, "cc-create-issue");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (isRunning(issue.number)) continue;
        if (isWorkerAtCapacity("create-issue")) break;

        await addLabel("issue", issue.number, "cc-in-progress");

        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        syncDefaultBranch(defaultBranch);
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", `/base-tools:create-issue #${issue.number}`, "--worktree", worktreeId],
          issue.number,
          issue.title,
          "create-issue",
          worktreeId,
          async (status, output) => {
            await removeWorktree(worktreeId);
            try {
              await removeLabel("issue", issue.number, "cc-create-issue");
              await removeLabel("issue", issue.number, "cc-in-progress");
              await addLabel("issue", issue.number, "cc-issue-created");
            } catch (err) {
              console.error(`[create-issue] Failed to cleanup labels for issue #${issue.number}: ${err}`);
            }
            if (status === "completed") {
              await notifyTaskCompleted("create-issue", name, issue.number, issue.title, issueUrl);
            } else {
              await notifyTaskFailed("create-issue", name, issue.number, issue.title, issueUrl, output);
            }
          },
        );
      }
    } catch (err) {
      console.error(`[create-issue] tick error: ${err}`);
      await notifyError("create-issue", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
