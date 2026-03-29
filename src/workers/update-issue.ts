import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel, getLastIssueComment } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";
const POLLING_INTERVAL_MS = 30 * 1000;

export async function updateIssueWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[update-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      const issues = await listIssues(user, "cc-update-issue");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (isRunning(issue.number)) continue;
        if (isWorkerAtCapacity("update-issue")) break;

        await addLabel("issue", issue.number, "cc-in-progress");

        const lastComment = await getLastIssueComment(issue.number);
        if (!lastComment) {
          await removeLabel("issue", issue.number, "cc-update-issue");
          await removeLabel("issue", issue.number, "cc-in-progress");
          continue;
        }

        const prompt = `/base-tools:update-issue\nIssue番号: ${issue.number}\n依頼内容: \n${lastComment.body}`;
        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        syncDefaultBranch(defaultBranch);
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", prompt, "--worktree", worktreeId],
          issue.number,
          issue.title,
          "update-issue",
          worktreeId,
          async (status, output) => {
            await removeWorktree(worktreeId);
            try {
              await removeLabel("issue", issue.number, "cc-update-issue");
              await removeLabel("issue", issue.number, "cc-in-progress");
            } catch (err) {
              console.error(`[update-issue] Failed to finalize issue #${issue.number}: ${err}`);
            }
            if (status === "completed") {
              await notifyTaskCompleted("update-issue", name, issue.number, issue.title, issueUrl);
            } else {
              await notifyTaskFailed("update-issue", name, issue.number, issue.title, issueUrl, output);
            }
          },
        );
      }
    } catch (err) {
      console.error(`[update-issue] tick error: ${err}`);
      await notifyError("update-issue", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
