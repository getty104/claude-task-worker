import { getWorkerConfig } from "../config";
import { getCurrentUser, getRepoInfo, listIssuesByLabel, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";

const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

interface IssueWorkerConfig {
  name: string;
  command: string;
  triggerLabels: string[];
  excludeLabels?: string[];
  onCompleted?: (issueNumber: number) => Promise<void>;
}

export function createIssuePollingWorker(config: IssueWorkerConfig): () => Promise<void> {
  return async () => {
    const { owner, name, defaultBranch } = await getRepoInfo();
    const user = await getCurrentUser();
    const { pollingIntervalSeconds, cooldownSeconds } = getWorkerConfig(config.name);
    const pollingIntervalMs = pollingIntervalSeconds * 1000;
    const cooldownMs = cooldownSeconds * 1000;
    console.log(
      `[${config.name}] Polling issues every ${pollingIntervalSeconds} seconds for ${owner}/${name} (assignee: ${user})`,
    );

    let lastCompletionAt = 0;

    const tick = async () => {
      if (isShuttingDown()) return;
      if (cooldownMs > 0 && lastCompletionAt > 0 && Date.now() - lastCompletionAt < cooldownMs) return;
      try {
        const excludeLabels = ["cc-in-progress", "cc-need-human-check", ...(config.excludeLabels ?? [])];
        const candidates = await listIssuesByLabel(user, config.triggerLabels, excludeLabels);

        for (const issue of candidates) {
          if (isRunning(issue.number)) continue;
          if (isWorkerAtCapacity(config.name)) break;

          const hadTriageScope = issue.labels.some((l) => l.name === LABEL_TRIAGE_SCOPE);
          await addLabel("issue", issue.number, "cc-in-progress");

          try {
            const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
            const worktreeId = generateWorktreeName();
            syncDefaultBranch(defaultBranch);
            const { model, effort } = getWorkerConfig(config.name);
            run(
              "claude",
              [
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
