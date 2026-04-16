import { getCurrentUser, getRepoInfo, listIssuesByLabel, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";
const POLLING_INTERVAL_MS = 30 * 1000;
const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

export async function execIssueWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[exec-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      const issues = await listIssuesByLabel(user, "cc-exec-issue");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (isRunning(issue.number)) continue;
        if (isWorkerAtCapacity("exec-issue")) break;

        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        await addLabel("issue", issue.number, "cc-in-progress");
        syncDefaultBranch(defaultBranch);
        run("claude", ["--dangerously-skip-permissions", "-p", `/base-tools:exec-issue ${issue.number} --triage-scope`, "--worktree", worktreeId], issue.number, issue.title, "exec-issue", worktreeId, async (status, output) => {
          try {
            if (status === "completed") {
              await addLabel("issue", issue.number, "cc-pr-created");
              await notifyTaskCompleted("exec-issue", name, issue.number, issue.title, issueUrl);
            } else {
              await notifyTaskFailed("exec-issue", name, issue.number, issue.title, issueUrl, output);
            }
          } catch (err) {
            console.error(`[exec-issue] post-task error for #${issue.number}: ${err}`);
          } finally {
            await addLabel("issue", issue.number, LABEL_TRIAGE_SCOPE).catch(err => console.error(`[exec-issue] addLabel ${LABEL_TRIAGE_SCOPE} failed for #${issue.number}: ${err}`));
            await removeLabel("issue", issue.number, "cc-exec-issue").catch(err => console.error(`[exec-issue] removeLabel cc-exec-issue failed for #${issue.number}: ${err}`));
            await removeLabel("issue", issue.number, "cc-in-progress").catch(err => console.error(`[exec-issue] removeLabel cc-in-progress failed for #${issue.number}: ${err}`));
            await removeWorktree(worktreeId);
          }
        });
      }
    } catch (err) {
      console.error(`[exec-issue] tick error: ${err}`);
      await notifyError("exec-issue", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
