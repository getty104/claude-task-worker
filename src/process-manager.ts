import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { getWorkerConfig } from "./config.js";
import { getDisplayWidth, truncateToWidth, padToWidth } from "./table.js";
import { TASK_TIMEOUT_MS, STDERR_TAIL_LIMIT, buildTaskResult } from "./task-result.js";

type TaskStatus = "running" | "completed" | "failed";

const childProcesses = new Map<number, ChildProcess>();

interface TaskEntry {
  id: number;
  title: string;
  status: TaskStatus;
  workerName: string;
  path?: string;
  startedAt: Date;
  finishedAt?: Date;
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

function formatDuration(start: Date, end: Date = new Date()): string {
  const diffMs = end.getTime() - start.getTime();
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0");
  const m = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function renderTable(): void {
  const entries = [...tasks.values()];
  if (entries.length === 0) return;

  const runningTasks = entries.filter((t) => t.status === "running");
  const finishedTasks = entries.filter((t) => t.status !== "running");

  const maxTitleWidth = 40;
  const maxPathWidth = 40;

  const allRows = [
    ...runningTasks.map((t) => ({
      id: `#${t.id}`,
      title: getDisplayWidth(t.title) > maxTitleWidth ? truncateToWidth(t.title, maxTitleWidth) : t.title,
      worker: t.workerName,
      path: t.path ? (t.path.length > maxPathWidth ? truncateToWidth(t.path, maxPathWidth) : t.path) : "",
      status: t.status,
      time: formatTime(t.startedAt),
      duration: formatDuration(t.startedAt),
    })),
    ...finishedTasks.map((t) => ({
      id: `#${t.id}`,
      title: getDisplayWidth(t.title) > maxTitleWidth ? truncateToWidth(t.title, maxTitleWidth) : t.title,
      worker: t.workerName,
      path: t.path ? (t.path.length > maxPathWidth ? truncateToWidth(t.path, maxPathWidth) : t.path) : "",
      status: t.status,
      time: formatTime(t.finishedAt ?? t.startedAt),
      duration: formatDuration(t.startedAt, t.finishedAt),
    })),
  ];

  const hasPath = allRows.some((r) => r.path !== "");

  const colWidths = {
    id: Math.max(3, ...allRows.map((r) => r.id.length)),
    title: Math.max(5, ...allRows.map((r) => getDisplayWidth(r.title))),
    worker: Math.max(6, ...allRows.map((r) => r.worker.length)),
    ...(hasPath ? { path: Math.max(8, ...allRows.map((r) => r.path.length)) } : {}),
    status: Math.max(6, ...allRows.map((r) => r.status.length)),
    time: Math.max(4, ...allRows.map((r) => r.time.length)),
    duration: Math.max(8, ...allRows.map((r) => r.duration.length)),
  };

  const pad = (s: string, w: number, useDisplayWidth = false) =>
    useDisplayWidth ? padToWidth(s, w) : s + " ".repeat(w - s.length);
  const cols = hasPath
    ? [
        colWidths.id,
        colWidths.title,
        colWidths.worker,
        colWidths.path!,
        colWidths.status,
        colWidths.time,
        colWidths.duration,
      ]
    : [colWidths.id, colWidths.title, colWidths.worker, colWidths.status, colWidths.time, colWidths.duration];
  const line = (l: string, m: string, r: string, f: string) => `${l}${cols.map((w) => f.repeat(w + 2)).join(m)}${r}`;

  const row = (
    id: string,
    title: string,
    worker: string,
    path: string,
    status: string,
    time: string,
    duration: string,
  ) =>
    hasPath
      ? `│ ${pad(id, colWidths.id)} │ ${pad(title, colWidths.title, true)} │ ${pad(worker, colWidths.worker)} │ ${pad(path, colWidths.path!)} │ ${pad(status, colWidths.status)} │ ${pad(time, colWidths.time)} │ ${pad(duration, colWidths.duration)} │`
      : `│ ${pad(id, colWidths.id)} │ ${pad(title, colWidths.title, true)} │ ${pad(worker, colWidths.worker)} │ ${pad(status, colWidths.status)} │ ${pad(time, colWidths.time)} │ ${pad(duration, colWidths.duration)} │`;

  const lines: string[] = [];
  lines.push(line("┌", "┬", "┐", "─"));
  lines.push(row("#", "Title", "Worker", "Worktree", "Status", "Time", "Duration"));
  lines.push(line("├", "┼", "┤", "─"));

  for (const r of allRows.filter((r) => r.status === "running")) {
    lines.push(row(r.id, r.title, r.worker, r.path, r.status, r.time, r.duration));
  }

  if (runningTasks.length > 0 && finishedTasks.length > 0) {
    lines.push(line("├", "┼", "┤", "─"));
  }

  for (const r of allRows.filter((r) => r.status !== "running")) {
    lines.push(row(r.id, r.title, r.worker, r.path, r.status, r.time, r.duration));
  }

  lines.push(line("└", "┴", "┘", "─"));

  console.clear();
  console.log(lines.join("\n"));
}

let renderInterval: ReturnType<typeof setInterval> | undefined;

function ensureRenderInterval(): void {
  if (renderInterval) return;
  renderInterval = setInterval(renderTable, 1000);
  renderInterval.unref();
}

export function run(
  command: string,
  args: string[],
  id: number,
  title: string,
  workerName: string,
  path?: string,
  onComplete?: (status: "completed" | "failed", output: string) => Promise<void>,
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

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    console.error(`[worker] task #${id} timed out after ${TASK_TIMEOUT_MS / 1000}s, terminating`);
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  }, TASK_TIMEOUT_MS);
  timeoutHandle.unref();

  child.on("close", async (code) => {
    clearTimeout(timeoutHandle);
    const { status: finalStatus, output } = buildTaskResult(
      code,
      timedOut,
      Buffer.concat(outputChunks).toString("utf-8"),
      Buffer.concat(stderrChunks).toString("utf-8").slice(-STDERR_TAIL_LIMIT),
    );
    try {
      await Promise.race([
        onComplete?.(finalStatus, output) ?? Promise.resolve(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("onComplete timed out after 120s")), 120_000).unref(),
        ),
      ]);
    } catch (err) {
      console.error(`[worker] onComplete error for #${id}: ${err}`);
    }
    const task = tasks.get(id);
    if (task) {
      task.status = finalStatus;
      task.finishedAt = new Date();
    }
    childProcesses.delete(id);
    renderTable();
  });

  child.on("error", async (err) => {
    clearTimeout(timeoutHandle);
    console.error(`[worker] failed to spawn process for #${id}: ${err.message}`);
    try {
      await Promise.race([
        onComplete?.("failed", err.message) ?? Promise.resolve(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("onComplete timed out after 120s")), 120_000).unref(),
        ),
      ]);
    } catch (callbackErr) {
      console.error(`[worker] onComplete error for #${id}: ${callbackErr}`);
    }
    const task = tasks.get(id);
    if (task) {
      task.status = "failed";
      task.finishedAt = new Date();
    }
    childProcesses.delete(id);
    renderTable();
  });
}

export function waitForAllProcesses(): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (childProcesses.size === 0) {
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
}
