import { spawn } from "node:child_process";

type TaskStatus = "running" | "completed" | "failed";

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

  const allRows = [
    ...runningTasks.map((t) => ({
      id: `#${t.id}`,
      title: t.title.length > 40 ? t.title.slice(0, 37) + "..." : t.title,
      status: t.status,
      duration: formatDuration(t.startedAt),
    })),
    ...finishedTasks.map((t) => ({
      id: `#${t.id}`,
      title: t.title.length > 40 ? t.title.slice(0, 37) + "..." : t.title,
      status: t.status,
      duration: formatDuration(t.startedAt, t.finishedAt),
    })),
  ];

  const colWidths = {
    id: Math.max(3, ...allRows.map((r) => r.id.length)),
    title: Math.max(5, ...allRows.map((r) => r.title.length)),
    status: Math.max(6, ...allRows.map((r) => r.status.length)),
    duration: Math.max(8, ...allRows.map((r) => r.duration.length)),
  };

  const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
  const line = (l: string, m: string, r: string, f: string) =>
    `${l}${f.repeat(colWidths.id + 2)}${m}${f.repeat(colWidths.title + 2)}${m}${f.repeat(colWidths.status + 2)}${m}${f.repeat(colWidths.duration + 2)}${r}`;

  const row = (id: string, title: string, status: string, duration: string) =>
    `│ ${pad(id, colWidths.id)} │ ${pad(title, colWidths.title)} │ ${pad(status, colWidths.status)} │ ${pad(duration, colWidths.duration)} │`;

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
