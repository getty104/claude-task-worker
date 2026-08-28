import { buildClaudeEnv, buildClaudeExecution } from "../claude-args";
import { getLastRunAt, getWorkerConfig } from "../config";
import { getRepoInfo } from "../gh";
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
        const { model, effort, skill, advisorModel, cloud: workerCloud } = getWorkerConfig(config.name);
        cloud = workerCloud;
        const command = skill || config.command;
        const mode = getRunMode();
        const execution = buildClaudeExecution({
          mode,
          prompt: `${command} ${SCOPE_DAYS}`,
          model,
          effort,
          advisorModel: isAdvisorEnabled() ? advisorModel : "",
          permissionMode: getPermissionMode(),
          ...(cloud ? { cloud: true, baseRef: defaultBranch } : {}),
        });

        // 実行記録は成果物とは別PRでワーカー自身が出す。材料が無くてスキルがPRを
        // 作らない日でも lastRun がマージで恒久化するようにするため、スキル側の手順には
        // 載せない。失敗してもスキルの起動は止めない（次回ポーリングで作り直せる）。
        await publishLastRunPr(config.name, defaultBranch, new Date(now)).catch((err) =>
          console.error(`[${config.name}] publishLastRunPr failed: ${err}`),
        );

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
          async (status, output, cloudSessionId) => {
            try {
              if (status === "completed") {
                await notifyTaskCompleted(
                  config.name,
                  repoName,
                  config.taskId,
                  config.name,
                  repoUrl,
                  output,
                  cloudSessionId,
                );
              } else {
                await notifyTaskFailed(
                  config.name,
                  repoName,
                  config.taskId,
                  config.name,
                  repoUrl,
                  output,
                  cloudSessionId,
                );
              }
            } catch (err) {
              console.error(`[${config.name}] post-task error: ${err}`);
            } finally {
              if (!cloud) {
                await removeWorktree(worktreeId).catch((err) =>
                  console.error(`[${config.name}] removeWorktree failed: ${err}`),
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
