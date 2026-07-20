import { buildClaudeEnv, buildClaudeExecution } from "../claude-args.js";
import { getWorkerConfig } from "../config";
import {
  type PullRequestWithChecks,
  getCurrentUser,
  getRepoInfo,
  listPullRequestsWithChecks,
  addLabel,
  removeLabel,
} from "../gh";
import { syncDefaultBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { getHeadroomEnabled, getRunMode } from "../user-config";
import {
  createWorktreeFromBranch,
  deleteLocalBranch,
  getWorktreePath,
  localBranchExists,
  removeWorktree,
  removeWorktreeByBranch,
} from "../worktree";

const LABEL_IN_PROGRESS = "cc-in-progress";
const LABEL_TRIAGE_SCOPE = "cc-triage-scope";

interface PrWorkerConfig {
  name: string;
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
    const { pollingIntervalSeconds, cooldownSeconds } = getWorkerConfig(config.name);
    const pollingIntervalMs = pollingIntervalSeconds * 1000;
    const cooldownMs = cooldownSeconds * 1000;
    console.log(
      `[${config.name}] Polling PRs every ${pollingIntervalSeconds} seconds for ${owner}/${name} (assignee: ${user})`,
    );

    let lastCompletionAt = 0;

    const tick = async () => {
      if (isShuttingDown()) return;
      if (cooldownMs > 0 && lastCompletionAt > 0 && Date.now() - lastCompletionAt < cooldownMs) return;
      try {
        const excludeLabels = [LABEL_IN_PROGRESS, ...(config.excludeLabels ?? [])];
        const candidates = await listPullRequestsWithChecks(user, config.triggerLabel, excludeLabels);

        for (const pr of candidates) {
          if (isRunning(pr.number)) continue;
          if (isWorkerAtCapacity(config.name)) break;

          const prUrl = `https://github.com/${owner}/${name}/pull/${pr.number}`;
          const hadTriageScope = pr.labels.some((l) => l.name === LABEL_TRIAGE_SCOPE);

          await addLabel("pr", pr.number, LABEL_IN_PROGRESS);
          const worktreeId = generateWorktreeName();
          try {
            // PRブランチを掴んでいる過去の worktree と、残留しているローカルブランチを掃除する。
            // ローカルブランチが古いまま残っているとスキル内の `gh pr checkout` が
            // fast-forward できずに失敗するため、リモートを正として作り直させる。
            await removeWorktreeByBranch(pr.headRefName);
            await deleteLocalBranch(pr.headRefName);
            // 削除できずにブランチが残っている＝locked worktree・実行中タスク・管理外
            // worktree などが checkout 中。この状態で claude を起動してもスキル内の
            // `gh pr checkout` が "is already used by worktree" で失敗し、モデル未起動の
            // まま exit 0 する空振りセッションになるだけなので、この tick はスキップして
            // ブロッカーが消えた後のポーリングで自然に再開させる。
            if (await localBranchExists(pr.headRefName)) {
              console.error(
                `[${config.name}] PR #${pr.number}: branch ${pr.headRefName} is still checked out by another worktree; skipping this tick`,
              );
              await removeLabel("pr", pr.number, LABEL_IN_PROGRESS).catch(() => {});
              continue;
            }
            syncDefaultBranch(defaultBranch);
            // claude CLI の --worktree は locked な worktree を作り、異常終了時に
            // 削除不能な残骸を残すため使わない。ワーカー自身が worktree を生成して cwd として渡す。
            await createWorktreeFromBranch(worktreeId, defaultBranch);
            const cwd = getWorktreePath(worktreeId);
            const { model, effort, skill } = getWorkerConfig(config.name);
            const command = skill || config.command;
            const mode = getRunMode();
            const execution = buildClaudeExecution({
              mode,
              prompt: `${command} ${pr.number}`,
              model,
              effort,
              headroom: getHeadroomEnabled(),
            });
            run(
              execution.command,
              execution.args,
              pr.number,
              `PR #${pr.number} (${pr.headRefName})`,
              config.name,
              worktreeId,
              async (status, output) => {
                lastCompletionAt = Date.now();
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
                  await removeLabel("pr", pr.number, config.triggerLabel).catch((err) =>
                    console.error(
                      `[${config.name}] removeLabel ${config.triggerLabel} failed for PR #${pr.number}: ${err}`,
                    ),
                  );
                  if (hadTriageScope) {
                    await addLabel("pr", pr.number, LABEL_TRIAGE_SCOPE).catch((err) =>
                      console.error(
                        `[${config.name}] addLabel ${LABEL_TRIAGE_SCOPE} failed for PR #${pr.number}: ${err}`,
                      ),
                    );
                  }
                  if (config.onFinally) {
                    await config
                      .onFinally(pr)
                      .catch((err) => console.error(`[${config.name}] onFinally failed for PR #${pr.number}: ${err}`));
                  }
                  await removeLabel("pr", pr.number, LABEL_IN_PROGRESS).catch((err) =>
                    console.error(
                      `[${config.name}] removeLabel ${LABEL_IN_PROGRESS} failed for PR #${pr.number}: ${err}`,
                    ),
                  );
                  await removeWorktree(worktreeId).catch((err) =>
                    console.error(`[${config.name}] removeWorktree failed for PR #${pr.number}: ${err}`),
                  );
                }
              },
              cwd,
              buildClaudeEnv(mode),
            );
          } catch (err) {
            console.error(`[${config.name}] setup error for PR #${pr.number}: ${err}`);
            await removeLabel("pr", pr.number, LABEL_IN_PROGRESS).catch(() => {});
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
