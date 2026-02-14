import { getRepoInfo, listPullRequests, hasUnresolvedReviews, addLabel } from "../gh.js";
import { isRunning, run } from "../process-manager.js";

export async function fixReviewPointWorker(intervalMinutes: number): Promise<void> {
  const { owner, name } = await getRepoInfo();
  console.log(`[fix-review-point] Polling PRs every ${intervalMinutes} minutes for ${owner}/${name}`);

  const tick = async () => {
    try {
      const prs = await listPullRequests();
      const candidates = prs.filter((pr) => !pr.labels.some((l) => l.name === "in-progress"));

      for (const pr of candidates) {
        if (isRunning(pr.number)) continue;

        const unresolved = await hasUnresolvedReviews(owner, name, pr.number);
        if (!unresolved) continue;

        console.log(`[fix-review-point] Processing PR #${pr.number} (branch: ${pr.headRefName})`);
        await addLabel("pr", pr.number, "in-progress");
        run("claude", ["-p", "/fix-review-point", pr.headRefName], pr.number, `PR #${pr.number} (${pr.headRefName})`);
      }
    } catch (err) {
      console.error(`[fix-review-point] tick error: ${err}`);
    }
  };

  await tick();
  setInterval(tick, intervalMinutes * 60 * 1000);
}
