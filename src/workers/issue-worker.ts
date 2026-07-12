import { getWorkerConfig } from "../config";
import { getCurrentUser, getRepoInfo, listIssuesByLabel, listIssuesByNumbers, removeLabel, addLabel } from "../gh";
import type { Issue } from "../gh";
import { syncDefaultBranch, ensureEpicBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { removeWorktree, createWorktreeFromBranch, getWorktreePath } from "../worktree";

const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

// preflight を持つワーカー（現状は epic-issue）は、古い順の先頭候補が preflight で
// skip され続けると後続の実行可能 Issue が取得枠から溢れて飢餓する。取得件数を
// 同時実行数と切り離し、固定バッファ件数を取得するための上限。
const PREFLIGHT_SEARCH_LIMIT = 5;

export type PreflightResult = "proceed" | "skip" | "mark-pr-created";

interface IssueWorkerConfig {
  name: string;
  command: string;
  triggerLabels: string[];
  excludeLabels?: string[];
  epicFilters?: number[];
  ownNumberFilters?: number[];
  labelFilters?: string[];
  preflight?: (issue: Issue) => Promise<PreflightResult>;
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
        const epicFilter =
          config.epicFilters && config.epicFilters.length > 0
            ? { owner, repo: name, numbers: config.epicFilters }
            : undefined;
        const labels =
          config.labelFilters && config.labelFilters.length > 0
            ? [...config.triggerLabels, ...config.labelFilters]
            : config.triggerLabels;
        const { maxConcurrentTasks } = getWorkerConfig(config.name);
        const searchLimit = config.preflight ? PREFLIGHT_SEARCH_LIMIT : maxConcurrentTasks;
        const candidates =
          config.ownNumberFilters && config.ownNumberFilters.length > 0
            ? await listIssuesByNumbers(user, labels, excludeLabels, config.ownNumberFilters)
            : await listIssuesByLabel(user, labels, excludeLabels, epicFilter, searchLimit);

        for (const issue of candidates) {
          if (isRunning(issue.number)) continue;
          if (isWorkerAtCapacity(config.name)) break;

          if (config.preflight) {
            const action = await config.preflight(issue);
            if (action === "skip") continue;
            if (action === "mark-pr-created") {
              await addLabel("issue", issue.number, "cc-pr-created").catch((err) =>
                console.error(`[${config.name}] addLabel cc-pr-created failed for #${issue.number}: ${err}`),
              );
              continue;
            }
          }

          const hadTriageScope = issue.labels.some((l) => l.name === LABEL_TRIAGE_SCOPE);
          await addLabel("issue", issue.number, "cc-in-progress");

          const worktreeId = generateWorktreeName();
          try {
            const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
            syncDefaultBranch(defaultBranch);
            const { model, effort, skill } = getWorkerConfig(config.name);
            const command = skill || config.command;

            const parentNumber = issue.parent?.number;
            const claudeArgs: string[] = [
              "-p",
              `${command} ${issue.number}`,
              "--dangerously-skip-permissions",
              "--model",
              model,
              "--effort",
              effort,
            ];

            // claude CLI の --worktree は locked な worktree を作り、異常終了時に
            // 削除不能な残骸（幽霊エントリ・checkout済み扱いのブランチ）を残すため使わない。
            // epic の有無に関わらずワーカー自身が worktree を生成して cwd として渡す。
            let baseBranch = defaultBranch;
            if (parentNumber !== undefined) {
              baseBranch = `cc-epic-${parentNumber}`;
              await ensureEpicBranch(baseBranch, defaultBranch);
            }
            await createWorktreeFromBranch(worktreeId, baseBranch);
            const cwd = getWorktreePath(worktreeId);
            console.log(`[${config.name}] #${issue.number}: created worktree ${worktreeId} from ${baseBranch}`);

            run(
              "claude",
              claudeArgs,
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
              cwd,
            );
          } catch (err) {
            console.error(`[${config.name}] setup error for #${issue.number}: ${err}`);
            await removeLabel("issue", issue.number, "cc-in-progress").catch(() => {});
            await removeWorktree(worktreeId).catch(() => {});
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
