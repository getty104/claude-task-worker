import { getCurrentUser, getRepoInfo, listPullRequests, hasUnresolvedReviews, addLabel, removeLabel } from "../gh.js";
import { isRunning, run } from "../process-manager.js";

const POLLING_INTERVAL_MS = 60 * 1000;

export async function fixReviewPointWorker(): Promise<void> {
  const { owner, name } = await getRepoInfo();
  const user = await getCurrentUser();
  console.log(`[fix-review-point] Polling PRs every 1 minute for ${owner}/${name} (assignee: ${user})`);

  const tick = async () => {
    try {
      const prs = await listPullRequests(user);
      const candidates = prs.filter((pr) => !pr.labels.some((l) => l.name === "in-progress"));

      for (const pr of candidates) {
        if (isRunning(pr.number)) continue;

        const unresolved = await hasUnresolvedReviews(owner, name, pr.number);
        if (!unresolved) continue;

        console.log(`[fix-review-point] Processing PR #${pr.number} (branch: ${pr.headRefName})`);
        await addLabel("pr", pr.number, "in-progress");
        run("claude", ["--dangerously-skip-permissions", "-p", `/fix-review-point ${pr.headRefName}`], pr.number, `PR #${pr.number} (${pr.headRefName})`, () => {
          removeLabel("pr", pr.number, "in-progress");
        });
      }
    } catch (err) {
      console.error(`[fix-review-point] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, POLLING_INTERVAL_MS);
}
