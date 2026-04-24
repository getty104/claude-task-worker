import { getWorkerConfig } from "../config";
import { type Issue, getCurrentUser, getRepoInfo, listIssuesByLabel, removeLabel, addLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree } from "../worktree";

const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

interface IssueWorkerConfig {
  name: string;
  pollingIntervalMs: number;
  triggerLabel: string;
  excludeLabels?: string[];
  buildPrompt: (issue: Issue) => Promise<string | null> | string | null;
  onCompleted?: (issueNumber: number) => Promise<void>;
}

export function createIssuePollingWorker(config: IssueWorkerConfig): () => Promise<void> {
  return async () => {
    const { owner, name, defaultBranch } = await getRepoInfo();
    const user = await getCurrentUser();
    console.log(`[${config.name}] Polling issues every ${Math.round(config.pollingIntervalMs / 1000)} seconds for ${owner}/${name} (assignee: ${user})`);

    const tick = async () => {
      if (isShuttingDown()) return;
      try {
        const issues = await listIssuesByLabel(user, config.triggerLabel);
        const candidates = config.excludeLabels?.length
          ? issues.filter((issue) => !issue.labels.some((l) => config.excludeLabels!.includes(l.name)))
          : issues;

        for (const issue of candidates) {
          if (issue.labels.some(l => l.name === "cc-in-progress")) continue;
          if (isRunning(issue.number)) continue;
          if (isWorkerAtCapacity(config.name)) break;

          const hadTriageScope = issue.labels.some((l) => l.name === LABEL_TRIAGE_SCOPE);
          await addLabel("issue", issue.number, "cc-in-progress");

          try {
            const prompt = await config.buildPrompt(issue);
            if (prompt === null) {
              await removeLabel("issue", issue.number, config.triggerLabel).catch(() => {});
              await removeLabel("issue", issue.number, "cc-in-progress").catch(() => {});
              continue;
            }

            const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
            const worktreeId = generateWorktreeName();
            syncDefaultBranch(defaultBranch);
            const { model, effort } = getWorkerConfig(config.name);
            run(
            "claude",
            ["--dangerously-skip-permissions", "--model", model, "--effort", effort, "-p", prompt, "--worktree", worktreeId],
            issue.number,
            issue.title,
            config.name,
            worktreeId,
            async (status, output) => {
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
                await removeLabel("issue", issue.number, config.triggerLabel).catch(err => console.error(`[${config.name}] removeLabel ${config.triggerLabel} failed for #${issue.number}: ${err}`));
                if (hadTriageScope) {
                  await addLabel("issue", issue.number, LABEL_TRIAGE_SCOPE).catch(err => console.error(`[${config.name}] addLabel ${LABEL_TRIAGE_SCOPE} failed for #${issue.number}: ${err}`));
                }
                await removeLabel("issue", issue.number, "cc-in-progress").catch(err => console.error(`[${config.name}] removeLabel cc-in-progress failed for #${issue.number}: ${err}`));
                await removeWorktree(worktreeId).catch(err => console.error(`[${config.name}] removeWorktree failed for #${issue.number}: ${err}`));
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
    setInterval(tick, config.pollingIntervalMs);
  };
}
