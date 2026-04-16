import { getCurrentUser, getRepoInfo, listIssuesByLabel, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";
const POLLING_INTERVAL_MS = 30 * 1000;
const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

export async function createIssueWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[create-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      const issues = await listIssuesByLabel(user, "cc-create-issue");

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
            try {
              if (status === "completed") {
                await notifyTaskCompleted("create-issue", name, issue.number, issue.title, issueUrl);
              } else {
                await notifyTaskFailed("create-issue", name, issue.number, issue.title, issueUrl, output);
              }
            } catch (err) {
              console.error(`[create-issue] post-task error for #${issue.number}: ${err}`);
            } finally {
              await addLabel("issue", issue.number, LABEL_TRIAGE_SCOPE).catch(err => console.error(`[create-issue] addLabel ${LABEL_TRIAGE_SCOPE} failed for #${issue.number}: ${err}`));
              await removeLabel("issue", issue.number, "cc-create-issue").catch(err => console.error(`[create-issue] removeLabel cc-create-issue failed for #${issue.number}: ${err}`));
              await removeLabel("issue", issue.number, "cc-in-progress").catch(err => console.error(`[create-issue] removeLabel cc-in-progress failed for #${issue.number}: ${err}`));
              await removeWorktree(worktreeId).catch(err => console.error(`[create-issue] removeWorktree failed for #${issue.number}: ${err}`));
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
