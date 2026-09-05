import { buildClaudeEnv, buildClaudeExecution } from "../claude-args";
import { CLOUD_DONE_LABEL, getLastRunAt, getRemoteEnvId, getWorkerConfig, isCloudWorker } from "../config";
import { addLabel, getRepoInfo, removeLabel } from "../gh";
import { syncDefaultBranch } from "../git";
import { publishLastRunPr } from "../last-run-pr";
import { isRunning, isShuttingDown, run } from "../process-manager";
import { generateWorktreeName } from "../random-name";
import { notifyError, notifyTaskCompleted, notifyTaskFailed } from "../slack";
import { getPermissionMode, getRunMode, isAdvisorEnabled } from "../user-config";
import { createWorktreeFromBranch, getWorktreePath, removeWorktree } from "../worktree";

// 定期ワーカーの実行間隔。スキルへ渡す収集期間（日数）もここから導出するため、
// 「24時間おきに、直近24時間を対象に走る」が常に一致する。
export const SCHEDULE_INTERVAL_HOURS = 24;
const SCHEDULE_INTERVAL_MS = SCHEDULE_INTERVAL_HOURS * 60 * 60 * 1000;
const SCOPE_DAYS = SCHEDULE_INTERVAL_HOURS / 24;

// 実行記録PRをクラウドタスクの完了検知に使う間、同PRを PR 系ワーカー（triage-pr）から
// 隠すためのラベル。pr-worker.ts と同じ値で、同ワーカーの excludeLabels に入っている。
// 付けないと triage-pr が同じPRをクラウドで処理し、そちらのセッションが付けた
// cc-cloud-done を定期ワーカーの完了と誤検知する（同じ PR 番号・同じラベルを待つため）。
const LABEL_IN_PROGRESS = "cc-in-progress";

export interface ScheduledWorkerConfig {
  name: string;
  command: string;
  // process-manager の台帳・ステータステーブルのキー。Issue / PR 番号（正数）と
  // 衝突しないよう負値を割り当てる。
  taskId: number;
  // false を返す間はスキルを起動しない（設定でオプトアウトされたワーカー用）。
  enabled?: () => boolean;
}

// Issue / PR のポーリングではなく、時刻だけを条件にスキルを起動するワーカー。
//
// 最終実行時刻は claude-task-worker.json の `lastRun` に持つ。書き込み・コミット・PR作成は
// すべてワーカーの責務（publishLastRunPr）で、スキルは同ファイルに一切触らない。成果物とは
// 別PRに分けているのは、材料が無くてスキルがPRを作らない日でも記録を残すため。
// 記録が恒久化するのはそのPRがマージされた時点で、それまでは下記の起動時刻（プロセス内）が
// 二重実行を止める。設定ファイルへ寄せているのは、実行間隔をリポジトリの状態として
// 追跡・レビューできるようにするため。
export function createScheduledWorker(config: ScheduledWorkerConfig): () => Promise<void> {
  return async () => {
    const { owner, name: repoName, defaultBranch } = await getRepoInfo();
    const { pollingIntervalSeconds } = getWorkerConfig(config.name);
    console.log(
      `[${config.name}] Checking every ${pollingIntervalSeconds} seconds (runs at most once per ${SCHEDULE_INTERVAL_HOURS}h for ${owner}/${repoName})`,
    );

    // 設定ファイルの lastRun が更新されるのはPRのマージ後なので、それだけを見ると
    // マージまでの間は毎ポーリングで再起動してしまう。プロセス内の起動時刻を併用して塞ぐ。
    let startedAt = 0;

    const tick = async () => {
      if (isShuttingDown()) return;
      if (config.enabled && !config.enabled()) return;
      if (isRunning(config.taskId)) return;

      const now = Date.now();
      const lastRunAt = Math.max(getLastRunAt(config.name) ?? 0, startedAt);
      if (lastRunAt > 0 && now - lastRunAt < SCHEDULE_INTERVAL_MS) return;

      const worktreeId = generateWorktreeName();
      startedAt = now;
      let cloud = false;
      try {
        syncDefaultBranch(defaultBranch);
        const { model, effort, skill, advisorModel } = getWorkerConfig(config.name);
        cloud = isCloudWorker(config.name);
        const command = skill || config.command;
        const mode = getRunMode();
        const execution = buildClaudeExecution({
          mode,
          prompt: `${command} ${SCOPE_DAYS}`,
          model,
          effort,
          advisorModel: isAdvisorEnabled() ? advisorModel : "",
          permissionMode: getPermissionMode(),
          ...(cloud ? { cloud: true, baseRef: defaultBranch, remoteEnvId: getRemoteEnvId() ?? "" } : {}),
        });

        // 実行記録は成果物とは別PRでワーカー自身が出す。材料が無くてスキルがPRを
        // 作らない日でも lastRun がマージで恒久化するようにするため、スキル側の手順には
        // 載せない。失敗してもスキルの起動は止めない（次回ポーリングで作り直せる）。
        // クラウド実行では、この実行記録PRが cc-cloud-done の置き先も兼ねる。定期ワーカーは
        // Issue/PR を起点に走らないため、セッションが完了を知らせられる対象が他に無い。
        const lastRunPr = await publishLastRunPr(config.name, defaultBranch, new Date(now)).catch((err) => {
          console.error(`[${config.name}] publishLastRunPr failed: ${err}`);
          return null;
        });
        if (cloud && lastRunPr === null) {
          console.warn(
            `[${config.name}] no lastRun PR to carry the cc-cloud-done label; the cloud session will be reported as completed as soon as it is created`,
          );
        }
        if (cloud && lastRunPr !== null) {
          // 実行記録PRは固定ブランチで再利用されるため、前回の残骸（cc-cloud-done）が残って
          // いると起動直後に完了と誤検知する。Issue/PR 系ワーカーと同じく起動前に外す。
          await removeLabel("pr", lastRunPr, CLOUD_DONE_LABEL).catch((err) =>
            console.error(`[${config.name}] removeLabel ${CLOUD_DONE_LABEL} failed for PR #${lastRunPr}: ${err}`),
          );
          // 待機中は triage-pr に同PRを拾わせない（上記 LABEL_IN_PROGRESS のコメント参照）。
          await addLabel("pr", lastRunPr, LABEL_IN_PROGRESS).catch((err) =>
            console.error(`[${config.name}] addLabel ${LABEL_IN_PROGRESS} failed for PR #${lastRunPr}: ${err}`),
          );
        }

        let cwd: string | undefined;
        if (cloud) {
          console.log(`[${config.name}] cloud execution, running without worktree on ${defaultBranch}`);
        } else {
          await createWorktreeFromBranch(worktreeId, defaultBranch);
          cwd = getWorktreePath(worktreeId);
          console.log(`[${config.name}] created worktree ${worktreeId} from ${defaultBranch}`);
        }

        const repoUrl = `https://github.com/${owner}/${repoName}`;
        run(
          execution.command,
          execution.args,
          config.taskId,
          config.name,
          config.name,
          cloud ? undefined : worktreeId,
          async (status, output) => {
            try {
              if (status === "completed") {
                await notifyTaskCompleted(config.name, repoName, config.taskId, config.name, repoUrl, output);
              } else {
                await notifyTaskFailed(config.name, repoName, config.taskId, config.name, repoUrl, output);
              }
            } catch (err) {
              console.error(`[${config.name}] post-task error: ${err}`);
            } finally {
              if (cloud && lastRunPr !== null) {
                await removeLabel("pr", lastRunPr, LABEL_IN_PROGRESS).catch((err) =>
                  console.error(
                    `[${config.name}] removeLabel ${LABEL_IN_PROGRESS} failed for PR #${lastRunPr}: ${err}`,
                  ),
                );
              }
              if (!cloud) {
                await removeWorktree(worktreeId).catch((err) =>
                  console.error(`[${config.name}] removeWorktree failed: ${err}`),
                );
              }
            }
          },
          cwd,
          buildClaudeEnv(mode, cloud),
          execution.prompt,
          cloud,
          cloud && lastRunPr !== null ? { type: "pr" as const, number: lastRunPr } : undefined,
          model,
        );
      } catch (err) {
        console.error(`[${config.name}] setup error: ${err}`);
        if (!cloud) {
          await removeWorktree(worktreeId).catch(() => {});
        }
        await notifyError(config.name, repoName, err);
      }
    };

    await tick();
    setInterval(tick, pollingIntervalSeconds * 1000);
  };
}
