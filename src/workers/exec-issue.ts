import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { generateWorktreeName } from "../random-name.js";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack.js";

const execFileAsync = promisify(execFile);
const POLLING_INTERVAL_MS = 30 * 1000;

export async function execIssueWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[exec-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const issues = await listIssues(user, "cc-exec-issue");

      for (const issue of issues) {
        if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
        if (isRunning(issue.number)) continue;

        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        const worktreeId = generateWorktreeName();
        await addLabel("issue", issue.number, "cc-in-progress");
        run("claude", ["--dangerously-skip-permissions", "-p", `/base-tools:exec-issue ${issue.number}`, "--worktree", worktreeId], issue.number, issue.title, async (status, output) => {
          await execFileAsync("git", ["worktree", "remove", "--force", `.claude/worktrees/${worktreeId}`]);
          await removeLabel("issue", issue.number, "cc-exec-issue");
          await removeLabel("issue", issue.number, "cc-in-progress");
          if (status === "completed") {
            await notifyTaskCompleted("exec-issue", name, issue.number, issue.title, issueUrl);
          } else {
            await notifyTaskFailed("exec-issue", name, issue.number, issue.title, issueUrl, output);
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
