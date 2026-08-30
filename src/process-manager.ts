import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { buildCloudCreateArgs, buildCloudPrompt, buildScriptCommand, CLOUD_REPORT_HEADING } from "./claude-args";
import { CLOUD_DONE_LABEL, getWorkerConfig } from "./config";
import { addLabel, commentOnIssue, commentOnPR, findCommentSince, listNumbersWithLabel, removeLabel } from "./gh";
import type { AgentStatus } from "./herdr";
import type { HerdrTask } from "./herdr-runner";
import {
  TASK_DISPLAY_LIMIT,
  buildLogTableLines,
  buildTaskTableLines,
  logLines,
  pushLogLine,
  selectRecentTasks,
  writeScreen,
} from "./table";
import { STDERR_TAIL_LIMIT, appendCloudFailureGuidance, buildTaskResult } from "./task-result";
import type { TaskResult } from "./task-result";
import { findProjectNameByPath, getRunMode } from "./user-config";

type TaskStatus = "running" | "completed" | "failed";

const childProcesses = new Map<number, ChildProcess>();

// herdr モードで実行中のタスク（pane/tab）。default モードの childProcesses に相当する。
const herdrTasks = new Map<number, HerdrTask>();

// force kill 時に herdr タスクの待機ループを抜けさせるためのフラグ。
const herdrAbortSignal = { aborted: false };

export interface TaskEntry {
  id: number;
  title: string;
  status: TaskStatus;
  workerName: string;
  path?: string;
  startedAt: Date;
  finishedAt?: Date;
  // herdr モードのみ。ステータステーブルへ working / blocked を出すために保持する。
  agentStatus?: AgentStatus;
}

const tasks = new Map<number, TaskEntry>();

// 実行中タスクの標準出力/エラー出力の直近ログ（ワーカー自身の console 出力と同じ
// ローリングバッファを共有する）。default モードの子プロセスの stdout/stderr を行単位で溜める。
// herdr モードは TUI 起動で stdout をストリームしないため、ここには載らない。
export { logLines };

function pushTaskLogLine(id: number, stream: "stdout" | "stderr", text: string): void {
  pushLogLine({ id, stream, text: text.replace(/\r$/, ""), time: new Date() });
}

// chunk 境界が行の途中で割れても正しく1行ずつ拾えるよう、未確定の末尾を持ち越す。
// マルチバイト文字が chunk 境界で分断される場合に備え、バイト単位ではなく StringDecoder で
// デコードする（chunk.toString("utf-8") だと分断されたバイト列が U+FFFD に化ける）。
export function makeLogFeeder(id: number, stream: "stdout" | "stderr") {
  let partial = "";
  const decoder = new StringDecoder("utf-8");
  return {
    feed(chunk: Buffer): void {
      partial += decoder.write(chunk);
      const parts = partial.split("\n");
      partial = parts.pop() ?? "";
      for (const part of parts) pushTaskLogLine(id, stream, part);
    },
    flush(): void {
      partial += decoder.end();
      if (partial.length > 0) {
        pushTaskLogLine(id, stream, partial);
        partial = "";
      }
    },
  };
}

// 完了タスクの台帳を直近 TASK_DISPLAY_LIMIT 件に刈り込む（実行中タスクは常に保持）。
// 表示は selectRecentTasks が別途上限を課すが、長時間稼働で Map が無制限に膨らむのを防ぐ。
function pruneTaskHistory(): void {
  const finished = [...tasks.values()]
    .filter((t) => t.status !== "running")
    .sort((a, b) => (b.finishedAt ?? b.startedAt).getTime() - (a.finishedAt ?? a.startedAt).getTime());
  for (const t of finished.slice(TASK_DISPLAY_LIMIT)) tasks.delete(t.id);
}

let shuttingDown = false;

export function setShuttingDown(): void {
  shuttingDown = true;
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

export function isRunning(id: number): boolean {
  const task = tasks.get(id);
  return task?.status === "running";
}

export function isWorktreeInUse(worktreeId: string): boolean {
  for (const task of tasks.values()) {
    if (task.status === "running" && task.path === worktreeId) {
      return true;
    }
  }
  return false;
}

export function isWorkerAtCapacity(workerName: string): boolean {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.workerName === workerName && task.status === "running") {
      count++;
    }
  }
  return count >= getWorkerConfig(workerName).maxConcurrentTasks;
}

function renderTable(): void {
  const taskLines = buildTaskTableLines(selectRecentTasks([...tasks.values()]));
  const logTableLines = buildLogTableLines(logLines);
  if (taskLines.length === 0 && logTableLines.length === 0) return;

  const lines = [...taskLines];
  if (logTableLines.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Logs", ...logTableLines);
  }

  writeScreen(lines);
}

let renderInterval: ReturnType<typeof setInterval> | undefined;

// タスク起動前の console 出力（起動時のエラー等）もテーブルに載せるため、
// ワーカー起動時にも呼ぶ。多重呼び出しは無視される。
export function ensureRenderInterval(): void {
  if (renderInterval) return;
  renderInterval = setInterval(renderTable, 1000);
  renderInterval.unref();
}

type OnComplete = (status: "completed" | "failed", output: string, cloudSessionId?: string) => Promise<void>;

// onComplete の実行と台帳・テーブルの更新。default モード（プロセス終了）と
// herdr モード（agent ステータス）で完了検知の手段は違うが、その後の処理は共通にする。
async function finishTask(id: number, result: TaskResult, onComplete?: OnComplete): Promise<void> {
  try {
    await Promise.race([
      onComplete?.(result.status, result.output, result.cloudSessionId) ?? Promise.resolve(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("onComplete timed out after 120s")), 120_000).unref(),
      ),
    ]);
  } catch (err) {
    console.error(`[worker] onComplete error for #${id}: ${err}`);
  }
  const task = tasks.get(id);
  if (task) {
    task.status = result.status;
    task.finishedAt = new Date();
    task.agentStatus = undefined;
  }
  pruneTaskHistory();
  renderTable();
}

// herdr モードのタスクタブに使うプロジェクト名。ディスパッチャーが注入する
// CTW_PROJECT_NAME を最優先し、次に config.json の projects をカレントディレクトリで
// 逆引きし、どちらも無ければディレクトリ名（＝通常はリポジトリ名）にフォールバックする。
export function resolveProjectName(cwd: string = process.cwd()): string {
  const injected = process.env.CTW_PROJECT_NAME;
  if (injected && injected.length > 0) return injected;
  return findProjectNameByPath(cwd) ?? basename(cwd);
}

// herdr モードのタスク実行（ローカル専用経路）。claude を herdr のタスク専用タブで
// TUI 起動し、agent ステータスで完了を検知する。
async function runViaHerdr(
  args: string[],
  prompt: string,
  id: number,
  onComplete?: OnComplete,
  cwd?: string,
  env?: Record<string, string>,
): Promise<void> {
  const { startHerdrTask, stopHerdrTask, taskTabLabel, waitForHerdrTask } = await import("./herdr-runner");
  const { getCurrentWorkspaceId } = await import("./herdr");

  const label = taskTabLabel(resolveProjectName(), id);
  let task: HerdrTask | undefined;
  let result: TaskResult;

  // 起動が完了する前にシャットダウンが走っても waitForAllProcesses() が
  // 「実行中タスクなし」と誤判定しないよう、ペイン確定前から台帳に載せておく
  // （default モードの spawn は同期なので childProcesses が即座に埋まるのと同じ扱い）。
  herdrTasks.set(id, { paneId: "", tabId: "" });

  try {
    // args は claude のフラグのみ（実行ファイル claude は agent start の `--kind` が供給し、
    // プロンプトは起動後に agent prompt で投入する）。
    task = await startHerdrTask({
      label,
      cwd: cwd ?? process.cwd(),
      args,
      prompt,
      env,
      workspaceId: getCurrentWorkspaceId(),
    });
    herdrTasks.set(id, task);
    result = await waitForHerdrTask(task.paneId, {
      signal: herdrAbortSignal,
      onBlocked: () => console.warn(`[worker] #${id} is blocked and waiting for input in herdr tab "${label}"`),
      onStatus: (status) => {
        const task = tasks.get(id);
        if (task && task.status === "running") task.agentStatus = status;
      },
    });
  } catch (err) {
    console.error(`[worker] failed to run #${id} via herdr: ${err}`);
    result = { status: "failed", output: `[worker] failed to run the task via herdr: ${err}` };
  } finally {
    if (task) {
      // claude がまだ worktree を掴んだままだと onComplete の worktree 削除に失敗しうるため、
      // 完了コールバックより先にセッションを終了してタブを閉じる。
      await stopHerdrTask(task);
    }
  }

  // 台帳からの削除は onComplete の完了後（default モードの childProcesses と同じ扱い）。
  await finishTask(id, result, onComplete);
  herdrTasks.delete(id);
}

// クラウドセッション作成コマンドの起動出力からセッションIDが読めるようになるまでの上限。
// 作業ツリーのアップロードを伴うため default モードより長めに取る。
// テストから短縮できるよう CTW_CLOUD_SESSION_TIMEOUT_MS で上書き可能にしてある。
export const CLOUD_SESSION_TIMEOUT_MS = Number(process.env.CTW_CLOUD_SESSION_TIMEOUT_MS) || 120 * 1000;
export const CLOUD_SESSION_POLL_INTERVAL_MS = 1000;

// クラウドタスクの完了（cc-cloud-done ラベル）を確認するポーリング間隔。
export const CLOUD_POLL_INTERVAL_MS = 30 * 1000;
// クラウドタスクの打ち切り上限。これを超えたら failed として人手確認へ回す。
// タイムアウトに落ちる典型: AskUserQuestion で停止したセッション・VM 側クラッシュ・
// プラグイン未導入による空振り・ラベル付与自体の失敗。
// テストから短縮できるよう CTW_CLOUD_TASK_TIMEOUT_MS で上書き可能にしてある。
export const CLOUD_TASK_TIMEOUT_MS = Number(process.env.CTW_CLOUD_TASK_TIMEOUT_MS) || 4 * 60 * 60 * 1000;

type CloudTargetType = "issue" | "pr";

interface CloudWaiter {
  type: CloudTargetType;
  deadline: number;
  settle: (outcome: "completed" | "timeout" | "aborted") => void;
}

// キーは `${type}:${number}`（issue #N と PR #N の番号衝突を避ける）。
const cloudWaiters = new Map<string, CloudWaiter>();
let cloudPollLoopRunning = false;

// 実行中のクラウドタスク全体を1回のポーリングで判定する共有ポーラー。個別タスクごとに
// `gh issue view` を叩かず、type ごとに `listNumbersWithLabel` を1クエリだけ呼ぶ。
function ensureCloudPollLoop(): void {
  if (cloudPollLoopRunning) return;
  cloudPollLoopRunning = true;
  void (async () => {
    // 例外でループを抜けた場合も cloudPollLoopRunning を戻す。立てっぱなしにすると
    // 以降どのタスクもポーラーを起動できず、待機が永久に解決しなくなる。
    try {
      await pollCloudWaiters();
    } finally {
      cloudPollLoopRunning = false;
    }
  })();
}

async function pollCloudWaiters(): Promise<void> {
  while (cloudWaiters.size > 0) {
    if (herdrAbortSignal.aborted) {
      for (const waiter of cloudWaiters.values()) waiter.settle("aborted");
      cloudWaiters.clear();
      break;
    }

    const pendingTypes = new Set<CloudTargetType>();
    for (const waiter of cloudWaiters.values()) pendingTypes.add(waiter.type);

    const doneKeys = new Map<CloudTargetType, Set<number>>();
    for (const type of pendingTypes) {
      try {
        const numbers = await listNumbersWithLabel(type, CLOUD_DONE_LABEL);
        doneKeys.set(type, new Set(numbers));
      } catch (err) {
        console.error(`[worker] failed to poll ${CLOUD_DONE_LABEL} for ${type}: ${err}`);
      }
    }

    const now = Date.now();
    for (const [key, waiter] of [...cloudWaiters.entries()]) {
      const done = doneKeys.get(waiter.type);
      const number = Number(key.split(":")[1]);
      if (done?.has(number)) {
        waiter.settle("completed");
        cloudWaiters.delete(key);
      } else if (now >= waiter.deadline) {
        waiter.settle("timeout");
        cloudWaiters.delete(key);
      }
    }

    if (cloudWaiters.size === 0) break;

    // シャットダウン応答性のため 30 秒丸ごと眠らず 1 秒刻みで abort を確認する。
    for (let waited = 0; waited < CLOUD_POLL_INTERVAL_MS; waited += 1000) {
      if (herdrAbortSignal.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

export function waitForCloudTask(id: number, type: CloudTargetType): Promise<"completed" | "timeout" | "aborted"> {
  return new Promise((resolve) => {
    cloudWaiters.set(`${type}:${id}`, {
      type,
      deadline: Date.now() + CLOUD_TASK_TIMEOUT_MS,
      settle: resolve,
    });
    ensureCloudPollLoop();
  });
}

// クラウドセッションはローカル側の失敗確定後も独立して稼働し続けうる（孤立セッション）。
// ワーカーの onComplete の失敗経路は cc-need-human-check を付けないため、ここで確実に
// 付けてポーリング対象から外す（同ラベルは issue-worker/pr-worker 共通の除外ラベル）。
// cc-in-progress を残す案は採らない: finally で無条件に外されるため残すには分岐追加が要り、
// かつ「実行中に見えるが実行していない」状態を作ってしまう。
async function flagOrphanedCloudSession(
  target: CloudTargetType,
  id: number,
  reason: "session-id" | "shutdown",
  cloudSessionId?: string,
): Promise<void> {
  await addLabel(target, id, "cc-need-human-check").catch((err: unknown) => {
    console.error(`[worker] failed to add cc-need-human-check to ${target} #${id}: ${err}`);
  });

  const causeLine =
    reason === "session-id"
      ? "セッションIDの抽出に失敗して待機を打ち切りました。プロンプトは投入済みで、" +
        "クラウドセッションは独立して稼働している可能性があります。"
      : "ワーカーのシャットダウンで待機を打ち切りました。クラウドセッションは継続している可能性が高いです。";
  const sessionLine = cloudSessionId ? `https://claude.ai/code/${cloudSessionId}` : "セッションURL不明（ID抽出に失敗）";
  const body =
    `## 孤立クラウドセッションの可能性\n\n` +
    `**原因**: ${causeLine}\n\n` +
    `**セッションURL**: ${sessionLine}\n\n` +
    `**再開方法**: 孤立セッションの成果物が届いていないか確認したうえで、\`cc-need-human-check\` ラベルを外すとポーリング対象に戻ります。`;

  const commentFn = target === "issue" ? commentOnIssue : commentOnPR;
  await commentFn(id, body).catch((err: unknown) => {
    console.error(`[worker] failed to comment on ${target} #${id} about the orphaned cloud session: ${err}`);
  });
}

// クラウドセッションの作成コマンド（`claude --cloud <prompt> ...`）を起動し、標準出力へ
// 現れるセッションIDを返す。TTY が無いと claude が print モード扱いで `--cloud` を拒否する
// ため script(1) 経由で疑似ptyを割り当てる（buildScriptCommand）。作成後すぐ exit する
// 短命プロセスなので常駐管理はせず、ID を拾うか終了するかのどちらかで決着させる。
async function createCloudSession(
  args: string[],
  initialPrompt: string,
  cwd?: string,
  env?: Record<string, string>,
): Promise<string> {
  const { extractCloudSessionId, normalizePtyOutput } = await import("./herdr-runner");
  const spec = buildScriptCommand("claude", buildCloudCreateArgs(args, initialPrompt));
  const child = spawn(spec.command, spec.args, {
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });

  let output = "";
  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error, sessionId?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(abortCheck);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolve(sessionId as string);
      }
    };
    // pty 出力には ANSI/OSC エスケープが混ざるため、抽出前に必ず正規化する。
    const scan = (): void => {
      const sessionId = extractCloudSessionId(normalizePtyOutput(output));
      if (sessionId) finish(undefined, sessionId);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf-8");
      scan();
    });
    child.on("error", (err) => finish(new Error(`failed to spawn the cloud session command: ${err.message}`)));
    // ID を出さないまま終了した場合はタイムアウトを待たずに失敗を確定させる。
    child.on("close", () => {
      scan();
      finish(new Error(`the cloud session command exited without a session id (output tail: ${output.slice(-1000)})`));
    });

    const timer = setTimeout(
      () => finish(new Error(`timed out waiting for the cloud session id (output tail: ${output.slice(-1000)})`)),
      CLOUD_SESSION_TIMEOUT_MS,
    );
    const abortCheck = setInterval(() => {
      if (herdrAbortSignal.aborted) {
        finish(new Error("the worker is shutting down before the cloud session could be created"));
      }
    }, CLOUD_SESSION_POLL_INTERVAL_MS);
  });
}

// クラウド実行（workers.<name>.cloud）のタスク実行。`claude --cloud <prompt> ...`
// 1コマンドでセッション作成と初期プロンプトの実行を同時に行う（description が
// そのまま初期プロンプトとして即実行されるため）。作成後は cc-cloud-done ラベルの
// ポーリングでタスク完了を検知する（#284）。
async function runViaCloud(
  args: string[],
  prompt: string,
  id: number,
  onComplete?: OnComplete,
  cwd?: string,
  env?: Record<string, string>,
  cloudTarget?: CloudTargetType,
  model?: string,
): Promise<void> {
  // 起動が完了する前にシャットダウンが走っても waitForAllProcesses() が
  // 「実行中タスクなし」と誤判定しないよう、セッション確定前から台帳に載せておく
  // （runViaHerdr と同じ狙い）。クラウドセッションはローカルに pane/tab を持たないため
  // 空のエントリを置くだけで、abort フラグの効き方は変わらない。
  herdrTasks.set(id, { paneId: "", tabId: "" });

  // 作成コマンドの description はクラウドセッションの初期プロンプトそのもの。
  // cc-cloud-done の投稿指示に加え、クラウドでは反映されない
  // システムプロンプト・ツール制限もここへ本文として含めておく（渡した瞬間に実行される
  // ため、後から追加投函する余地は無い）。
  const initialPrompt = buildCloudPrompt(
    prompt,
    model ?? "",
    cloudTarget ? { type: cloudTarget, number: id } : undefined,
  );
  let result: TaskResult;
  let cloudSessionId: string | undefined;

  try {
    cloudSessionId = await createCloudSession(args, initialPrompt, cwd, env);

    // 1コマンド方式のため投函フェーズは無い。ここに到達した時点でセッションは作成済みで、
    // 初期プロンプト（＝タスク本体）の実行が既に始まっている。
    const createOutput = `[worker] created cloud session ${cloudSessionId} with the task's initial prompt`;

    if (!cloudTarget) {
      // 定期ワーカーは CLOUD_ALLOWED_WORKERS 外のため実際には到達しない。
      console.warn(`[worker] #${id} has no completion-detection target, treating session creation as completion`);
      result = { status: "completed", output: createOutput };
    } else {
      // 待機中も台帳エントリを running のまま維持する（finishTask はここより後で呼ぶ）。
      // herdrTasks はセッション作成後も残るため waitForAllProcesses()/shutdown() の
      // abort フラグは引き続き効く。
      const outcome = await waitForCloudTask(id, cloudTarget);

      if (outcome === "completed") {
        await removeLabel(cloudTarget, id, CLOUD_DONE_LABEL).catch((err: unknown) => {
          console.error(`[worker] failed to remove ${CLOUD_DONE_LABEL} from ${cloudTarget} #${id}: ${err}`);
        });
        // 完了検知後に1回だけ、セッションが投稿した最終報告コメントを回収する。
        // 取得できなければ従来どおりの定型文のまま completed を維持する（通知を落とさない）。
        let reportBody: string | null = null;
        const startedAt = tasks.get(id)?.startedAt;
        if (startedAt) {
          try {
            reportBody = await findCommentSince(id, startedAt, CLOUD_REPORT_HEADING);
          } catch (err) {
            console.error(`[worker] failed to fetch the cloud report comment for ${cloudTarget} #${id}: ${err}`);
          }
        }
        result = {
          status: "completed",
          output: reportBody ?? `${createOutput}\n[worker] detected completion via the ${CLOUD_DONE_LABEL} label`,
        };
      } else if (outcome === "timeout") {
        // タイムアウト打ち切りを人手確認へ確実に回すためここで cc-need-human-check を付ける。
        // ワーカーの onComplete の失敗経路は同ラベルを付けないため。
        await addLabel(cloudTarget, id, "cc-need-human-check").catch((err: unknown) => {
          console.error(`[worker] failed to add cc-need-human-check to ${cloudTarget} #${id}: ${err}`);
        });
        result = {
          status: "failed",
          output:
            `${createOutput}\n[worker] timed out waiting for the ${CLOUD_DONE_LABEL} label after ` +
            `${CLOUD_TASK_TIMEOUT_MS / 1000 / 60} minutes. Possible causes: the session stopped on ` +
            `AskUserQuestion, the cloud VM crashed, the plugin was not installed, or label assignment itself failed.`,
        };
      } else {
        // aborted: ワーカー側の停止でありタスクの失敗ではないが、クラウドセッションは
        // 継続稼働しうる（孤立セッション）ため timeout と同じく cc-need-human-check を付ける。
        // タスクの失敗か否かの区別はラベルではなく output/コメントの文面で行う。
        await flagOrphanedCloudSession(cloudTarget, id, "shutdown", cloudSessionId);
        result = {
          status: "failed",
          output:
            `${createOutput}\n[worker] shutdown aborted the wait for the ${CLOUD_DONE_LABEL} label. ` +
            "The session may still be running; added cc-need-human-check.",
        };
      }
    }
    result.cloudSessionId = cloudSessionId;
  } catch (err) {
    console.error(`[worker] failed to run #${id} via cloud: ${err}`);
    let orphanNote =
      "[worker] note: with the 1-command launch, the cloud session may already have started " +
      "working independently even though this task is being reported as failed locally (orphaned session).";
    if (cloudTarget) {
      await flagOrphanedCloudSession(cloudTarget, id, "session-id", cloudSessionId);
      orphanNote += " added cc-need-human-check so a human can verify whether it completed on its own.";
    }
    result = {
      status: "failed",
      output: `[worker] failed to run the task via cloud: ${err}\n${orphanNote}`,
      ...(cloudSessionId ? { cloudSessionId } : {}),
    };
  }

  result = appendCloudFailureGuidance(result, true);

  await finishTask(id, result, onComplete);
  herdrTasks.delete(id);
}

export function run(
  command: string,
  args: string[],
  id: number,
  title: string,
  workerName: string,
  path?: string,
  onComplete?: OnComplete,
  cwd?: string,
  env?: Record<string, string>,
  // herdr モードで起動後に投入するプロンプト（`buildClaudeExecution` の `prompt`）。
  // default モードでは args に含まれるため不要。
  prompt?: string,
  // クラウド実行フラグ（workers.<name>.cloud）。herdr モードのときだけ実行経路を
  // runViaCloud（`claude --cloud <prompt> ...` の1コマンド方式）へ切り替える。
  // `cloud: true` かつ `mode: "default"` は起動時ガード（assertCloudAvailable）で
  // 弾かれるためここでは扱わない。
  cloud?: boolean,
  // クラウド実行時に cc-cloud-done を探す対象の種別。番号は id を使う。
  cloudTarget?: "issue" | "pr",
  // クラウド実行時のプロンプト本文組み立て（buildCloudPrompt）に使う `--model` の値。
  // default/herdr（非cloud）では未使用。
  model?: string,
): void {
  // 同じ Issue/PR を再実行したときは古いエントリを削除してから入れ直し、
  // Map の挿入順で「最新に繰り上げる」（selectRecentTasks の直近順表示と揃える）。
  tasks.delete(id);
  tasks.set(id, {
    id,
    title,
    status: "running",
    workerName,
    path,
    startedAt: new Date(),
  });

  ensureRenderInterval();
  renderTable();

  if (getRunMode() === "herdr") {
    if (cloud) {
      void runViaCloud(args, prompt ?? "", id, onComplete, cwd, env, cloudTarget, model);
      return;
    }
    // herdr モードは agent start の `--kind` が実行ファイル（claude）を供給するため、
    // command は渡さず claude のフラグ（args）とプロンプトを渡す。
    void runViaHerdr(args, prompt ?? "", id, onComplete, cwd, env);
    return;
  }

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  childProcesses.set(id, child);

  // 標準出力/エラー出力の直近ログをステータステーブル下に表示するための行フィーダー。
  const stdoutFeeder = makeLogFeeder(id, "stdout");
  const stderrFeeder = makeLogFeeder(id, "stderr");

  const outputChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    outputChunks.push(chunk);
    stdoutFeeder.feed(chunk);
  });

  // stderr は末尾 STDERR_TAIL_LIMIT 分だけ保持する（失敗時の通知に含める）
  const stderrChunks: Buffer[] = [];
  let stderrLen = 0;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrLen += chunk.length;
    while (stderrChunks.length > 1 && stderrLen - stderrChunks[0].length >= STDERR_TAIL_LIMIT) {
      stderrLen -= stderrChunks[0].length;
      stderrChunks.shift();
    }
    stderrFeeder.feed(chunk);
  });

  child.on("close", async (code) => {
    stdoutFeeder.flush();
    stderrFeeder.flush();
    const result = buildTaskResult(
      code,
      Buffer.concat(outputChunks).toString("utf-8"),
      Buffer.concat(stderrChunks).toString("utf-8").slice(-STDERR_TAIL_LIMIT),
    );
    // 台帳からの削除は onComplete（ラベル操作・worktree 削除）の完了後に行う。
    // 先に削除すると waitForAllProcesses() が後片付けの途中でプロセスの終了を許してしまう。
    await finishTask(id, result, onComplete);
    childProcesses.delete(id);
  });

  child.on("error", async (err) => {
    console.error(`[worker] failed to spawn process for #${id}: ${err.message}`);
    await finishTask(id, { status: "failed", output: err.message }, onComplete);
    childProcesses.delete(id);
  });
}

export function waitForAllProcesses(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (childProcesses.size === 0 && herdrTasks.size === 0) {
        resolve();
      } else {
        setTimeout(check, 500);
      }
    };
    check();
  });
}

export function shutdown(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const [, child] of childProcesses) {
    if (!child.pid) continue;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // ignore
      }
    }
  }

  // herdr モードのタスクにはシグナルを送る相手のプロセスハンドルが無いため、
  // 待機ループを抜けさせるフラグを立てる。ペインの ctrl-c 送信とタブのクローズは
  // 各タスクの finally（stopHerdrTask）が行う。
  if (herdrTasks.size > 0) {
    herdrAbortSignal.aborted = true;
  }
}
