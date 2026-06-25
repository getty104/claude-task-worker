import { getWorkerConfig } from "../config";
import {
  getCurrentUser,
  getIssueProjectIds,
  getRepoInfo,
  listIssuesByLabel,
  removeLabel,
  addLabel,
} from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { needsProjectLookup, resolveBranch, type WorkerOptions } from "../worker-options";
import { removeWorktree } from "../worktree";

const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

interface IssueWorkerConfig {
  name: string;
  command: string;
  triggerLabels: string[];
  excludeLabels?: string[];
  onCompleted?: (issueNumber: number) => Promise<void>;
}

export function createIssuePollingWorker(
  config: IssueWorkerConfig,
): (options?: WorkerOptions) => Promise<void> {
  return async (options: WorkerOptions = {}) => {
    const { owner, name, defaultBranch } = await getRepoInfo();
    const user = await getCurrentUser();
    const { pollingIntervalSeconds, cooldownSeconds } = getWorkerConfig(config.name);
    const pollingIntervalMs = pollingIntervalSeconds * 1000;
    const cooldownMs = cooldownSeconds * 1000;
    const filterLog = options.projectId ? ` project=${options.projectId}` : "";
    const branchLog = options.branch ? ` branch=${options.branch}` : "";
    console.log(
      `[${config.name}] Polling issues every ${pollingIntervalSeconds} seconds for ${owner}/${name} (assignee: ${user})${filterLog}${branchLog}`,
    );

    let lastCompletionAt = 0;

    const tick = async () => {
      if (isShuttingDown()) return;
      if (cooldownMs > 0 && lastCompletionAt > 0 && Date.now() - lastCompletionAt < cooldownMs) return;
      try {
        const excludeLabels = ["cc-in-progress", "cc-need-human-check", ...(config.excludeLabels ?? [])];
        const rawCandidates = await listIssuesByLabel(user, config.triggerLabels, excludeLabels);

        const lookupRequired = needsProjectLookup(options);
        const candidates: { issue: (typeof rawCandidates)[number]; projectIds: string[] }[] = [];
        for (const issue of rawCandidates) {
          const projectIds = lookupRequired ? await getIssueProjectIds(owner, name, issue.number) : [];
          if (options.projectId && !projectIds.includes(options.projectId)) continue;
          candidates.push({ issue, projectIds });
        }

        for (const { issue, projectIds } of candidates) {
          if (isRunning(issue.number)) continue;
          if (isWorkerAtCapacity(config.name)) break;

          const hadTriageScope = issue.labels.some((l) => l.name === LABEL_TRIAGE_SCOPE);
          await addLabel("issue", issue.number, "cc-in-progress");

          try {
            const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
            const worktreeId = generateWorktreeName();
            const resolvedBranch = resolveBranch(projectIds, options.projects, options.branch, defaultBranch);
            syncDefaultBranch(resolvedBranch);
            const { model, effort } = getWorkerConfig(config.name);
            run(
              "claude",
              [
                "-p",
                `"${config.command} ${issue.number}"`,
                "--dangerously-skip-permissions",
                "--model",
                model,
                "--effort",
                effort,
                "--worktree",
                worktreeId,
              ],
              issue.number,
              issue.title,
              config.name,
              worktreeId,
              async (status, output) => {
                lastCompletionAt = Date.now();
                for (const label of config.triggerLabels) {
                  await removeLabel("issue", issue.number, label).catch((err) =>
                    console.error(`[${config.name}] removeLabel ${label} failed for #${issue.number}: ${err}`),
                  );
                }
                if (hadTriageScope) {
                  await addLabel("issue", issue.number, LABEL_TRIAGE_SCOPE).catch((err) =>
                    console.error(
                      `[${config.name}] addLabel ${LABEL_TRIAGE_SCOPE} failed for #${issue.number}: ${err}`,
                    ),
                  );
                }
                try {
                  if (status === "completed") {
                    await config.onCompleted?.(issue.number);
                    await notifyTaskCompleted(config.name, name, issue.number, issue.title, issueUrl, output);
                  } else {
                    await notifyTaskFailed(config.name, name, issue.number, issue.title, issueUrl, output);
                  }
                } catch (err) {
                  console.error(`[${config.name}] post-task error for #${issue.number}: ${err}`);
                } finally {
                  await removeLabel("issue", issue.number, "cc-in-progress").catch((err) =>
                    console.error(`[${config.name}] removeLabel cc-in-progress failed for #${issue.number}: ${err}`),
                  );
                  await removeWorktree(worktreeId).catch((err) =>
                    console.error(`[${config.name}] removeWorktree failed for #${issue.number}: ${err}`),
                  );
                }
              },
              { CC_BASE_BRANCH: resolvedBranch },
            );
          } catch (err) {
            console.error(`[${config.name}] setup error for #${issue.number}: ${err}`);
            await removeLabel("issue", issue.number, "cc-in-progress").catch(() => {});
            await notifyError(config.name, name, err);
          }
        }
      } catch (err) {
        console.error(`[${config.name}] tick error: ${err}`);
        await notifyError(config.name, name, err);
      }
    };

    await tick();
    setInterval(tick, pollingIntervalMs);
  };
}
