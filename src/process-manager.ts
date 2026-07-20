import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { basename } from "node:path";
import { getWorkerConfig } from "./config.js";
import type { AgentStatus } from "./herdr.js";
import type { HerdrTask } from "./herdr-runner.js";
import { buildTaskTableLines } from "./table.js";
import { STDERR_TAIL_LIMIT, buildTaskResult } from "./task-result.js";
import type { TaskResult } from "./task-result.js";
import { findProjectNameByPath, getRunMode } from "./user-config.js";

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
  const lines = buildTaskTableLines([...tasks.values()]);
  if (lines.length === 0) return;

  console.clear();
  console.log(lines.join("\n"));
}

let renderInterval: ReturnType<typeof setInterval> | undefined;

function ensureRenderInterval(): void {
  if (renderInterval) return;
  renderInterval = setInterval(renderTable, 1000);
  renderInterval.unref();
}

type OnComplete = (status: "completed" | "failed", output: string) => Promise<void>;

// onComplete の実行と台帳・テーブルの更新。default モード（プロセス終了）と
// herdr モード（agent ステータス）で完了検知の手段は違うが、その後の処理は共通にする。
async function finishTask(id: number, result: TaskResult, onComplete?: OnComplete): Promise<void> {
  try {
    await Promise.race([
      onComplete?.(result.status, result.output) ?? Promise.resolve(),
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

// herdr モードのタスク実行。claude を herdr のタスク専用タブで TUI 起動し、
// agent ステータスで完了を検知する。
async function runViaHerdr(
  command: string,
  args: string[],
  id: number,
  onComplete?: OnComplete,
  cwd?: string,
  env?: Record<string, string>,
): Promise<void> {
  const { startHerdrTask, stopHerdrTask, taskTabLabel, waitForHerdrTask } = await import("./herdr-runner.ts");
  const { getCurrentWorkspaceId } = await import("./herdr.ts");

  const label = taskTabLabel(resolveProjectName(), id);
  let task: HerdrTask | undefined;
  let result: TaskResult;

  // 起動が完了する前にシャットダウンが走っても waitForAllProcesses() が
  // 「実行中タスクなし」と誤判定しないよう、ペイン確定前から台帳に載せておく
  // （default モードの spawn は同期なので childProcesses が即座に埋まるのと同じ扱い）。
  herdrTasks.set(id, { paneId: "", tabId: "" });

  try {
    task = await startHerdrTask({
      label,
      cwd: cwd ?? process.cwd(),
      argv: [command, ...args],
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
): void {
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
    void runViaHerdr(command, args, id, onComplete, cwd, env);
    return;
  }

  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    ...(cwd ? { cwd } : {}),
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  childProcesses.set(id, child);

  const outputChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    outputChunks.push(chunk);
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
  });

  child.on("close", async (code) => {
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
