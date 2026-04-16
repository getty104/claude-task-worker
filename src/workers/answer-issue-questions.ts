import { getCurrentUser, getRepoInfo, listIssuesByLabel, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";
const POLLING_INTERVAL_MS = 30 * 1000;

export async function answerIssueQuestionsWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[answer-issue-questions] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      const issues = await listIssuesByLabel(user, "cc-answer-questions");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (!issue.labels.some(l => l.name === "cc-triage-scope")) continue;
        if (isRunning(issue.number)) continue;
        if (isWorkerAtCapacity("answer-issue-questions")) break;

        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        await addLabel("issue", issue.number, "cc-in-progress");
        syncDefaultBranch(defaultBranch);
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", `/base-tools:answer-questions\n ${issue.number}`, "--worktree", worktreeId],
          issue.number,
          issue.title,
          "answer-issue-questions",
          worktreeId,
          async (status, output) => {
            try {
              if (status === "completed") {
                await addLabel("issue", issue.number, "cc-update-issue");
                await notifyTaskCompleted("answer-issue-questions", name, issue.number, issue.title, issueUrl);
              } else {
                await notifyTaskFailed("answer-issue-questions", name, issue.number, issue.title, issueUrl, output);
              }
            } catch (err) {
              console.error(`[answer-issue-questions] post-task error for #${issue.number}: ${err}`);
            } finally {
              await removeLabel("issue", issue.number, "cc-answer-questions").catch(err => console.error(`[answer-issue-questions] removeLabel cc-answer-questions failed for #${issue.number}: ${err}`));
              await removeLabel("issue", issue.number, "cc-in-progress").catch(err => console.error(`[answer-issue-questions] removeLabel cc-in-progress failed for #${issue.number}: ${err}`));
              await removeWorktree(worktreeId).catch(err => console.error(`[answer-issue-questions] removeWorktree failed for #${issue.number}: ${err}`));
            }
          },
        );
      }
    } catch (err) {
      console.error(`[answer-issue-questions] tick error: ${err}`);
      await notifyError("answer-issue-questions", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
