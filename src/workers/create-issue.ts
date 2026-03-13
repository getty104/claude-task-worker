import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel, getIssueBody, closeIssue } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { generateWorktreeName } from "../random-name.js";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack.js";

const execFileAsync = promisify(execFile);
const POLLING_INTERVAL_MS = 30 * 1000;

export async function createIssueWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[create-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const issues = await listIssues(user, "cc-create-issue");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (isRunning(issue.number)) continue;

        await addLabel("issue", issue.number, "cc-in-progress");

        const body = await getIssueBody(issue.number);
        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", `/base-tools:create-issue ${body}`, "--worktree", worktreeId],
          issue.number,
          issue.title,
          async (status, output) => {
            await execFileAsync("git", ["worktree", "remove", "--force", `.claude/worktrees/${worktreeId}`]);
            try {
              await removeLabel("issue", issue.number, "cc-create-issue");
              await removeLabel("issue", issue.number, "cc-in-progress");
              await closeIssue(issue.number);
            } catch (err) {
              console.error(`[create-issue] Failed to close issue #${issue.number}: ${err}`);
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
