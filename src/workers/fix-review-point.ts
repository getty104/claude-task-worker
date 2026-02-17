import { getCurrentUser, getRepoInfo, listPullRequests, hasUnresolvedReviews, addLabel, removeLabel } from "../gh.js";
import { isRunning, run } from "../process-manager.js";
import { notifyTaskCompleted, notifyTaskFailed } from "../slack.js";

const POLLING_INTERVAL_MS = 30 * 1000;
const LABEL_FIX_ONETIME = "fix-onetime";
const LABEL_FIX_REPEAT = "fix-repeat";
const LABEL_IN_PROGRESS = "in-progress";

export async function fixReviewPointWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[fix-review-point] Polling PRs every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const prs = await listPullRequests(user);
      const candidates = prs.filter((pr) => {
        const labels = pr.labels.map((l) => l.name);
        if (labels.includes(LABEL_IN_PROGRESS)) return false;
        return labels.includes(LABEL_FIX_ONETIME) || labels.includes(LABEL_FIX_REPEAT);
      });

      for (const pr of candidates) {
        if (isRunning(pr.number)) continue;

        const unresolved = await hasUnresolvedReviews(owner, name, pr.number);
        if (!unresolved) continue;

        const isOnetime = pr.labels.some((l) => l.name === LABEL_FIX_ONETIME);
        const prUrl = `https://github.com/${owner}/${name}/pull/${pr.number}`;

        await addLabel("pr", pr.number, LABEL_IN_PROGRESS);
        run("claude", ["--dangerously-skip-permissions", "-p", `/fix-review-point ${pr.headRefName}`, "--worktree"], pr.number, `PR #${pr.number} (${pr.headRefName})`, async (status) => {
          const labelsToRemove = [LABEL_IN_PROGRESS];
          if (isOnetime) labelsToRemove.push(LABEL_FIX_ONETIME);
          for (const label of labelsToRemove) {
            removeLabel("pr", pr.number, label);
          }
          if (status === "completed") {
            await notifyTaskCompleted("fix-review-point", pr.number, `PR #${pr.number} (${pr.headRefName})`, prUrl);
          } else {
            await notifyTaskFailed("fix-review-point", pr.number, `PR #${pr.number} (${pr.headRefName})`, prUrl);
          }
        });
      }
    } catch (err) {
      console.error(`[fix-review-point] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
