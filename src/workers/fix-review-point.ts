import { getCurrentUser, getRepoInfo, listPullRequestsWithChecks, isCICompleted, addLabel, removeLabel } from "../gh.js";
import { syncDefaultBranch } from "../git.js";
import { isRunning, isWorkerAtCapacity, isWorkerRunning, isShuttingDown, run } from "../process-manager.js";
import { generateWorktreeName } from "../random-name.js";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack.js";
import { removeWorktree } from "../worktree.js";
const POLLING_INTERVAL_MS = 30 * 1000;
const LABEL_FIX_ONETIME = "cc-fix-onetime";
const LABEL_FIX_REPEAT = "cc-fix-repeat";
const LABEL_IN_PROGRESS = "cc-in-progress";

export async function fixReviewPointWorker(): Promise<void> {
  const { owner, name, defaultBranch } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[fix-review-point] Polling PRs every 30 seconds for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    if (isShuttingDown()) return;
    try {
      if (isWorkerRunning("triage-prs")) return;

      const prs = await listPullRequestsWithChecks(user);
      const candidates = prs.filter((pr) => {
        const labels = pr.labels.map((l) => l.name);
        if (labels.includes(LABEL_IN_PROGRESS)) return false;
        if (!isCICompleted(pr.statusCheckRollup)) return false;
        return labels.includes(LABEL_FIX_ONETIME) || labels.includes(LABEL_FIX_REPEAT);
      });

      for (const pr of candidates) {
        if (isRunning(pr.number)) continue;
        if (isWorkerAtCapacity("fix-review-point")) break;

        const isOnetime = pr.labels.some((l) => l.name === LABEL_FIX_ONETIME);
        const prUrl = `https://github.com/${owner}/${name}/pull/${pr.number}`;

        const worktreeId = generateWorktreeName();
        await addLabel("pr", pr.number, LABEL_IN_PROGRESS);
        syncDefaultBranch(defaultBranch);
        run("claude", ["--dangerously-skip-permissions", "-p", `/base-tools:fix-review-point ${pr.headRefName}`, "--worktree", worktreeId], pr.number, `PR #${pr.number} (${pr.headRefName})`, "fix-review-point", worktreeId, async (status, output) => {
          await removeWorktree(worktreeId);
          if (isOnetime) await removeLabel("pr", pr.number, LABEL_FIX_ONETIME);
          await removeLabel("pr", pr.number, LABEL_IN_PROGRESS);
          if (status === "completed") {
            await notifyTaskCompleted("fix-review-point", name, pr.number, pr.title, prUrl);
          } else {
            await notifyTaskFailed("fix-review-point", name, pr.number, pr.title, prUrl, output);
          }
        });
      }
    } catch (err) {
      console.error(`[fix-review-point] tick error: ${err}`);
      await notifyError("fix-review-point", name, err);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
