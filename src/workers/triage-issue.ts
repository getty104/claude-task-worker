import { getCurrentUser, getRepoInfo, listIssuesByLabel, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";
const POLLING_INTERVAL_MS = 30 * 1000;

export async function triageIssueWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[triage-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      const issues = await listIssuesByLabel(user, "cc-triage");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (!issue.labels.some(l => l.name === "cc-triage-scope")) continue;
        if (isRunning(issue.number)) continue;
        if (isWorkerAtCapacity("triage-issue")) break;

        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        await addLabel("issue", issue.number, "cc-in-progress");
        syncDefaultBranch(defaultBranch);
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", `/base-tools:triage-issues ${issue.number}`, "--worktree", worktreeId],
          issue.number,
          issue.title,
          "triage-issue",
          worktreeId,
          async (status, output) => {
            try {
              if (status === "completed") {
                await notifyTaskCompleted("triage-issue", name, issue.number, issue.title, issueUrl);
              } else {
                await notifyTaskFailed("triage-issue", name, issue.number, issue.title, issueUrl, output);
              }
            } catch (err) {
              console.error(`[triage-issue] post-task error for #${issue.number}: ${err}`);
            } finally {
              await removeLabel("issue", issue.number, "cc-triage").catch(err => console.error(`[triage-issue] removeLabel cc-triage failed for #${issue.number}: ${err}`));
              await removeLabel("issue", issue.number, "cc-in-progress").catch(err => console.error(`[triage-issue] removeLabel cc-in-progress failed for #${issue.number}: ${err}`));
              await removeWorktree(worktreeId).catch(err => console.error(`[triage-issue] removeWorktree failed for #${issue.number}: ${err}`));
            }
          },
        );
      }
    } catch (err) {
      console.error(`[triage-issue] tick error: ${err}`);
      await notifyError("triage-issue", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
