import { getCurrentUser, getRepoInfo, listIssues, removeLabel, addLabel, getLastIssueComment, commentOnIssue } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { notifyTaskCompleted, notifyTaskFailed } from "../slack.js";

const POLLING_INTERVAL_MS = 30 * 1000;

export async function updateIssueWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[update-issue] Polling issues every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const issues = await listIssues(user, "update-issue");

      for (const issue of issues) {
        if (isRunning(issue.number)) continue;

        await removeLabel("issue", issue.number, "update-issue");
        await addLabel("issue", issue.number, "in-progress");

        const lastComment = await getLastIssueComment(issue.number);
        if (!lastComment) {
          await removeLabel("issue", issue.number, "in-progress");
          continue;
        }

        const prompt = `/update-issue\nIssue番号: ${issue.number}\n依頼内容: \n${lastComment.body}`;
        const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
        run(
          "claude",
          ["--dangerously-skip-permissions", "-p", prompt],
          issue.number,
          issue.title,
          async (status) => {
            try {
              await removeLabel("issue", issue.number, "in-progress");
              await commentOnIssue(issue.number, `@${lastComment.author} Updated`);
            } catch (err) {
              console.error(`[update-issue] Failed to finalize issue #${issue.number}: ${err}`);
            }
            if (status === "completed") {
              await notifyTaskCompleted("update-issue", issue.number, issue.title, issueUrl);
            } else {
              await notifyTaskFailed("update-issue", issue.number, issue.title, issueUrl);
            }
          },
        );
      }
    } catch (err) {
      console.error(`[update-issue] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
