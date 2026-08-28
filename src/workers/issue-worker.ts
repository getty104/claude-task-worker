import { buildClaudeEnv, buildClaudeExecution } from "../claude-args.js";
import { getWorkerConfig } from "../config";
import {
  getCurrentUser,
  getRepoInfo,
  hasOpenBlockers,
  listIssuesByLabel,
  listIssuesByNumbers,
  removeLabel,
  addLabel,
} from "../gh";
import type { Issue } from "../gh";
import { syncDefaultBranch, ensureEpicBranch } from "../git";
import { isRunning, isWorkerAtCapacity, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyTaskCompleted, notifyTaskFailed, notifyError } from "../slack";
import { getPermissionMode, getRunMode, isAdvisorEnabled } from "../user-config";
import { removeWorktree, createWorktreeFromBranch, getWorktreePath } from "../worktree";

// Issue のライフサイクル状態を表すマーカーラベル。ワーカー実行で消費されるトリガーではなく、
// トリアージ済み（cc-triage-scope）/ 分析済み（cc-issue-created）という事実を保持する。
// triage-created-issue はこの2つをトリガー（AND条件）に使うが、完了時に外すと
// タスク失敗時にマーカーごと失われ、create-issue が分析済み Issue を再分析 →
// cc-issue-created 再付与 → 再トリアージ、のループに入る。よって除去対象から外す。
const STICKY_LABELS = ["cc-triage-scope", "cc-issue-created"];

export const consumableTriggerLabels = (triggerLabels: string[]): string[] =>
  triggerLabels.filter((label) => !STICKY_LABELS.includes(label));

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
  // exit 0 でも期待成果物（PR等）を検証できなかった場合は false を返す。
  // その場合ワーカーは完了通知ではなく失敗通知を送る。void / true は完了扱い。
  onCompleted?: (
    issueNumber: number,
    worktreeId: string,
    output: string,
    ctx: { cloud: boolean; baseBranch: string; startedAt: number },
  ) => Promise<boolean | void>;
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

          // 検索側の -is:blocked は検索インデックス経由で取りこぼしうるため、起動直前に
          // 実体を引き直す。取得に失敗した場合は検索側のガードに委ねて続行する
          // （gh の一時障害で全ワーカーが止まる方が影響が大きい）。
          let blocked = false;
          try {
            blocked = await hasOpenBlockers(issue.number);
          } catch (err) {
            console.error(`[${config.name}] hasOpenBlockers failed for #${issue.number}: ${err}`);
          }
          if (blocked) {
            console.log(`[${config.name}] #${issue.number}: skipped (blocked by an open issue)`);
            continue;
          }

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

          await addLabel("issue", issue.number, "cc-in-progress");

          const worktreeId = generateWorktreeName();
          const { cloud } = getWorkerConfig(config.name);
          try {
            const issueUrl = `https://github.com/${owner}/${name}/issues/${issue.number}`;
            syncDefaultBranch(defaultBranch);
            const { model, effort, skill, advisorModel } = getWorkerConfig(config.name);
            const command = skill || config.command;

            const parentNumber = issue.parent?.number;
            const mode = getRunMode();

            // ベースブランチは buildClaudeExecution() の baseRef に渡すため、worktree 生成より
            // 先に確定させる。ensureEpicBranch() はクラウド実行でも必要（cc-epic-<N> をリモートへ
            // 用意する処理で、クラウドセッションが --ref で参照する前提になる）。
            let baseBranch = defaultBranch;
            if (parentNumber !== undefined) {
              baseBranch = `cc-epic-${parentNumber}`;
              await ensureEpicBranch(baseBranch, defaultBranch);
            }

            const execution = buildClaudeExecution({
              mode,
              prompt: `${command} ${issue.number}`,
              model,
              effort,
              // config.json の advisor が false なら advisorModel の指定に関わらず渡さない。
              advisorModel: isAdvisorEnabled() ? advisorModel : "",
              permissionMode: getPermissionMode(),
              ...(cloud ? { cloud: true, baseRef: baseBranch } : {}),
            });

            let cwd: string | undefined;
            if (cloud) {
              console.log(
                `[${config.name}] #${issue.number}: cloud execution, running without worktree on ${baseBranch}`,
              );
            } else {
              // claude CLI の --worktree は locked な worktree を作り、異常終了時に
              // 削除不能な残骸（幽霊エントリ・checkout済み扱いのブランチ）を残すため使わない。
              // epic の有無に関わらずワーカー自身が worktree を生成して cwd として渡す。
              await createWorktreeFromBranch(worktreeId, baseBranch);
              cwd = getWorktreePath(worktreeId);
              console.log(`[${config.name}] #${issue.number}: created worktree ${worktreeId} from ${baseBranch}`);
            }

            const startedAt = Date.now();
            run(
              execution.command,
              execution.args,
              issue.number,
              issue.title,
              config.name,
              worktreeId,
              async (status, output, cloudSessionId) => {
                lastCompletionAt = Date.now();
                for (const label of consumableTriggerLabels(config.triggerLabels)) {
                  await removeLabel("issue", issue.number, label).catch((err) =>
                    console.error(`[${config.name}] removeLabel ${label} failed for #${issue.number}: ${err}`),
                  );
                }
                try {
                  if (status === "completed") {
                    const verified =
                      (await config.onCompleted?.(issue.number, worktreeId, output, {
                        cloud,
                        baseBranch,
                        startedAt,
                      })) ?? true;
                    if (verified === false) {
                      await notifyTaskFailed(
                        config.name,
                        name,
                        issue.number,
                        issue.title,
                        issueUrl,
                        output,
                        cloudSessionId,
                      );
                    } else {
                      await notifyTaskCompleted(
                        config.name,
                        name,
                        issue.number,
                        issue.title,
                        issueUrl,
                        output,
                        cloudSessionId,
                      );
                    }
                  } else {
                    await notifyTaskFailed(
                      config.name,
                      name,
                      issue.number,
                      issue.title,
                      issueUrl,
                      output,
                      cloudSessionId,
                    );
                  }
                } catch (err) {
                  console.error(`[${config.name}] post-task error for #${issue.number}: ${err}`);
                  await notifyTaskFailed(
                    config.name,
                    name,
                    issue.number,
                    issue.title,
                    issueUrl,
                    output,
                    cloudSessionId,
                  ).catch((notifyErr) =>
                    console.error(`[${config.name}] notifyTaskFailed failed for #${issue.number}: ${notifyErr}`),
                  );
                } finally {
                  await removeLabel("issue", issue.number, "cc-in-progress").catch((err) =>
                    console.error(`[${config.name}] removeLabel cc-in-progress failed for #${issue.number}: ${err}`),
                  );
                  if (!cloud) {
                    await removeWorktree(worktreeId).catch((err) =>
                      console.error(`[${config.name}] removeWorktree failed for #${issue.number}: ${err}`),
                    );
                  }
                }
              },
              cwd,
              buildClaudeEnv(mode),
              execution.prompt,
              cloud,
            );
          } catch (err) {
            console.error(`[${config.name}] setup error for #${issue.number}: ${err}`);
            await removeLabel("issue", issue.number, "cc-in-progress").catch(() => {});
            if (!cloud) {
              await removeWorktree(worktreeId).catch(() => {});
            }
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
