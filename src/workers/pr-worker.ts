import { getWorkerConfig } from "../config";
import { type PullRequestWithChecks, getCurrentUser, getRepoInfo, listPullRequestsWithChecks, addLabel, removeLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree, removeWorktreeByBranch } from "../worktree";

const LABEL_IN_PROGRESS = "cc-in-progress";
const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

interface PrWorkerConfig {
  name: string;
  pollingIntervalMs: number;
  command: string;
  triggerLabel: string;
  excludeLabels?: string[];
  onCompleted?: (pr: PullRequestWithChecks) => Promise<void>;
  onFinally?: (pr: PullRequestWithChecks) => Promise<void>;
}

export function createPrPollingWorker(config: PrWorkerConfig): () => Promise<void> {
  return async () => {
    const { owner, name, defaultBranch } = await getRepoInfo();
    const user = await getCurrentUser();
    console.log(`[${config.name}] Polling PRs every ${Math.round(config.pollingIntervalMs / 1000)} seconds for ${owner}/${name} (assignee: ${user})`);

    const tick = async () => {
      if (isShuttingDown()) return;
      try {
        const prs = await listPullRequestsWithChecks(user);
        const candidates = prs.filter((pr) => {
          const names = pr.labels.map((l) => l.name);
          return names.includes(config.triggerLabel) && !config.excludeLabels?.some((label) => names.includes(label));
        });

        for (const pr of candidates) {
          if (pr.labels.some((l) => l.name === LABEL_IN_PROGRESS)) continue;
          if (isRunning(pr.number)) continue;
          if (isWorkerAtCapacity(config.name)) break;

          const prUrl = `https://github.com/${owner}/${name}/pull/${pr.number}`;
          const hadTriageScope = pr.labels.some((l) => l.name === LABEL_TRIAGE_SCOPE);

          await addLabel("pr", pr.number, LABEL_IN_PROGRESS);
          try {
            await removeWorktreeByBranch(pr.headRefName);
            const worktreeId = generateWorktreeName();
            syncDefaultBranch(defaultBranch);
            const { model, effort } = getWorkerConfig(config.name);
            run(
            "claude",
            ["--dangerously-skip-permissions", "--model", model, "--effort", effort, "-p", `${config.command} ${pr.number}`, "--worktree", worktreeId],
            pr.number,
            `PR #${pr.number} (${pr.headRefName})`,
            config.name,
            worktreeId,
            async (status, output) => {
              try {
                if (status === "completed") {
                  await config.onCompleted?.(pr);
                  await notifyTaskCompleted(config.name, name, pr.number, pr.title, prUrl, output);
                } else {
                  await notifyTaskFailed(config.name, name, pr.number, pr.title, prUrl, output);
                }
              } catch (err) {
                console.error(`[${config.name}] post-task error for PR #${pr.number}: ${err}`);
              } finally {
                await removeLabel("pr", pr.number, config.triggerLabel).catch((err) => console.error(`[${config.name}] removeLabel ${config.triggerLabel} failed for PR #${pr.number}: ${err}`));
                if (hadTriageScope) {
                  await addLabel("pr", pr.number, LABEL_TRIAGE_SCOPE).catch((err) => console.error(`[${config.name}] addLabel ${LABEL_TRIAGE_SCOPE} failed for PR #${pr.number}: ${err}`));
                }
                if (config.onFinally) {
                  await config.onFinally(pr).catch((err) => console.error(`[${config.name}] onFinally failed for PR #${pr.number}: ${err}`));
                }
                await removeLabel("pr", pr.number, LABEL_IN_PROGRESS).catch((err) => console.error(`[${config.name}] removeLabel ${LABEL_IN_PROGRESS} failed for PR #${pr.number}: ${err}`));
                await removeWorktree(worktreeId).catch((err) => console.error(`[${config.name}] removeWorktree failed for PR #${pr.number}: ${err}`));
              }
            },
          );
          } catch (err) {
            console.error(`[${config.name}] setup error for PR #${pr.number}: ${err}`);
            await removeLabel("pr", pr.number, LABEL_IN_PROGRESS).catch(() => {});
            await notifyError(config.name, name, err);
          }
        }
      } catch (err) {
        console.error(`[${config.name}] tick error: ${err}`);
        await notifyError(config.name, name, err);
      }
    };

    await tick();
    setInterval(tick, config.pollingIntervalMs);
  };
}
