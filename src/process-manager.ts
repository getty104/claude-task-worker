import { spawn, ChildProcess } from "node:child_process";
import { config } from "./config.js";

type TaskStatus = "running" | "completed" | "failed";

const childProcesses = new Map<number, ChildProcess>();

function getDisplayWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    const code = char.codePointAt(0)!;
    if (
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0x303e) ||
      (code >= 0x3040 && code <= 0x33bf) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) ||
      (code >= 0x20000 && code <= 0x2fffd) ||
      (code >= 0x30000 && code <= 0x3fffd)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function truncateToWidth(str: string, maxWidth: number): string {
  let width = 0;
  let i = 0;
  const chars = [...str];
  while (i < chars.length) {
    const charWidth = getDisplayWidth(chars[i]);
    if (width + charWidth > maxWidth - 3) {
      return chars.slice(0, i).join("") + "...";
    }
    width += charWidth;
    i++;
  }
  return str;
}

function padToWidth(str: string, targetWidth: number): string {
  const currentWidth = getDisplayWidth(str);
  const padding = targetWidth - currentWidth;
  return padding > 0 ? str + " ".repeat(padding) : str;
}

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


export function isWorkerAtCapacity(workerName: string): boolean {
  let count = 0;
  for (const task of tasks.values()) {
    if (task.workerName === workerName && task.status === "running") {
      count++;
    }
  }
  return count >= config.maxConcurrentTasks;
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
    ? [colWidths.id, colWidths.title, colWidths.worker, colWidths.path!, colWidths.status, colWidths.time, colWidths.duration]
    : [colWidths.id, colWidths.title, colWidths.worker, colWidths.status, colWidths.time, colWidths.duration];
  const line = (l: string, m: string, r: string, f: string) =>
    `${l}${cols.map((w) => f.repeat(w + 2)).join(m)}${r}`;

  const row = (id: string, title: string, worker: string, path: string, status: string, time: string, duration: string) =>
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

export function run(command: string, args: string[], id: number, title: string, workerName: string, path?: string, onComplete?: (status: "completed" | "failed", output: string) => Promise<void>): void {
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

  const child = spawn(command, args, { stdio: ["ignore", "pipe", "inherit"], detached: true });
  childProcesses.set(id, child);

  const outputChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    outputChunks.push(chunk);
  });

  child.on("close", async (code) => {
    childProcesses.delete(id);
    const output = Buffer.concat(outputChunks).toString("utf-8");
    const finalStatus = code === 0 ? "completed" : "failed";
    try {
      await onComplete?.(finalStatus, output);
    } catch (err) {
      console.error(`[worker] onComplete error for #${id}: ${err}`);
    }
    const task = tasks.get(id);
    if (task) {
      task.status = finalStatus;
      task.finishedAt = new Date();
    }
    renderTable();
  });

  child.on("error", async (err) => {
    childProcesses.delete(id);
    console.error(`[worker] failed to spawn process for #${id}: ${err.message}`);
    try {
      await onComplete?.("failed", err.message);
    } catch (callbackErr) {
      console.error(`[worker] onComplete error for #${id}: ${callbackErr}`);
    }
    const task = tasks.get(id);
    if (task) {
      task.status = "failed";
      task.finishedAt = new Date();
    }
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

export function shutdown(): void {
  for (const [id, child] of childProcesses) {
    child.kill("SIGTERM");
    childProcesses.delete(id);
  }
}
