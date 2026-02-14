import { spawn } from "node:child_process";

type TaskStatus = "running" | "completed" | "failed";

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
  startedAt: Date;
  finishedAt?: Date;
}

const tasks = new Map<number, TaskEntry>();

export function isRunning(id: number): boolean {
  const task = tasks.get(id);
  return task?.status === "running";
}

function formatDuration(start: Date, end: Date = new Date()): string {
  const diffMs = end.getTime() - start.getTime();
  const totalSeconds = Math.floor(diffMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function renderTable(): void {
  const entries = [...tasks.values()];
  if (entries.length === 0) return;

  const runningTasks = entries.filter((t) => t.status === "running");
  const finishedTasks = entries.filter((t) => t.status !== "running");

  const maxTitleWidth = 40;

  const allRows = [
    ...runningTasks.map((t) => ({
      id: `#${t.id}`,
      title: getDisplayWidth(t.title) > maxTitleWidth ? truncateToWidth(t.title, maxTitleWidth) : t.title,
      status: t.status,
      duration: formatDuration(t.startedAt),
    })),
    ...finishedTasks.map((t) => ({
      id: `#${t.id}`,
      title: getDisplayWidth(t.title) > maxTitleWidth ? truncateToWidth(t.title, maxTitleWidth) : t.title,
      status: t.status,
      duration: formatDuration(t.startedAt, t.finishedAt),
    })),
  ];

  const colWidths = {
    id: Math.max(3, ...allRows.map((r) => r.id.length)),
    title: Math.max(5, ...allRows.map((r) => getDisplayWidth(r.title))),
    status: Math.max(6, ...allRows.map((r) => r.status.length)),
    duration: Math.max(8, ...allRows.map((r) => r.duration.length)),
  };

  const pad = (s: string, w: number, useDisplayWidth = false) =>
    useDisplayWidth ? padToWidth(s, w) : s + " ".repeat(w - s.length);
  const line = (l: string, m: string, r: string, f: string) =>
    `${l}${f.repeat(colWidths.id + 2)}${m}${f.repeat(colWidths.title + 2)}${m}${f.repeat(colWidths.status + 2)}${m}${f.repeat(colWidths.duration + 2)}${r}`;

  const row = (id: string, title: string, status: string, duration: string) =>
    `│ ${pad(id, colWidths.id)} │ ${pad(title, colWidths.title, true)} │ ${pad(status, colWidths.status)} │ ${pad(duration, colWidths.duration)} │`;

  const lines: string[] = [];
  lines.push(line("┌", "┬", "┐", "─"));
  lines.push(row("#", "Title", "Status", "Duration"));
  lines.push(line("├", "┼", "┤", "─"));

  for (const r of allRows.filter((r) => r.status === "running")) {
    lines.push(row(r.id, r.title, r.status, r.duration));
  }

  if (runningTasks.length > 0 && finishedTasks.length > 0) {
    lines.push(line("├", "┼", "┤", "─"));
  }

  for (const r of allRows.filter((r) => r.status !== "running")) {
    lines.push(row(r.id, r.title, r.status, r.duration));
  }

  lines.push(line("└", "┴", "┘", "─"));

  console.clear();
  console.log(lines.join("\n"));
}

let renderInterval: ReturnType<typeof setInterval> | undefined;

function ensureRenderInterval(): void {
  if (renderInterval) return;
  renderInterval = setInterval(renderTable, 5000);
  renderInterval.unref();
}

export function run(command: string, args: string[], id: number, title: string, onComplete?: () => void): void {
  tasks.set(id, {
    id,
    title,
    status: "running",
    startedAt: new Date(),
  });

  ensureRenderInterval();
  renderTable();

  const child = spawn(command, args, { stdio: "inherit" });

  child.on("close", (code) => {
    const task = tasks.get(id);
    if (task) {
      task.status = code === 0 ? "completed" : "failed";
      task.finishedAt = new Date();
    }
    renderTable();
    onComplete?.();
  });

  child.on("error", (err) => {
    const task = tasks.get(id);
    if (task) {
      task.status = "failed";
      task.finishedAt = new Date();
    }
    console.error(`[worker] failed to spawn process for #${id}: ${err.message}`);
    renderTable();
  });
}
