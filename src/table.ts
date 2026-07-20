export function getDisplayWidth(str: string): number {
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

export function truncateToWidth(str: string, maxWidth: number): string {
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

export function padToWidth(str: string, targetWidth: number): string {
  const currentWidth = getDisplayWidth(str);
  const padding = targetWidth - currentWidth;
  return padding > 0 ? str + " ".repeat(padding) : str;
}

/** ステータステーブル1行分のタスク情報。process-manager の TaskEntry を構造的に受け取る。 */
export interface TaskTableEntry {
  id: number;
  title: string;
  status: string;
  workerName: string;
  path?: string;
  startedAt: Date;
  finishedAt?: Date;
  // herdr モードのみ。working / blocked 等の agent ステータス。
  agentStatus?: string;
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

/** ステータステーブルの各行を組み立てる。副作用を持たないのでそのままテストできる。 */
export function buildTaskTableLines(entries: TaskTableEntry[], now: Date = new Date()): string[] {
  if (entries.length === 0) return [];

  const runningTasks = entries.filter((t) => t.status === "running");
  const finishedTasks = entries.filter((t) => t.status !== "running");

  const maxTitleWidth = 40;
  const maxPathWidth = 40;

  const runningRows = runningTasks.map((t) => ({
    id: `#${t.id}`,
    title: getDisplayWidth(t.title) > maxTitleWidth ? truncateToWidth(t.title, maxTitleWidth) : t.title,
    worker: t.workerName,
    path: t.path ? (t.path.length > maxPathWidth ? truncateToWidth(t.path, maxPathWidth) : t.path) : "",
    // herdr モードでは agent ステータス（working / blocked 等）を併記し、
    // 人の介入が必要な blocked にも気づけるようにする。
    status: t.agentStatus ? `${t.status}:${t.agentStatus}` : t.status,
    time: formatTime(t.startedAt),
    duration: formatDuration(t.startedAt, now),
  }));

  const finishedRows = finishedTasks.map((t) => ({
    id: `#${t.id}`,
    title: getDisplayWidth(t.title) > maxTitleWidth ? truncateToWidth(t.title, maxTitleWidth) : t.title,
    worker: t.workerName,
    path: t.path ? (t.path.length > maxPathWidth ? truncateToWidth(t.path, maxPathWidth) : t.path) : "",
    status: t.status,
    time: formatTime(t.finishedAt ?? t.startedAt),
    duration: formatDuration(t.startedAt, t.finishedAt ?? now),
  }));

  // 列幅の算出は全行を対象にするが、セクションの振り分けには使わない。
  // status 文字列は herdr モードで `running:working` のように装飾されるため、
  // 表示値で running か否かを判定すると実行中タスクが完了セクションへ紛れ込む。
  const allRows = [...runningRows, ...finishedRows];

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

  for (const r of runningRows) {
    lines.push(row(r.id, r.title, r.worker, r.path, r.status, r.time, r.duration));
  }

  if (runningRows.length > 0 && finishedRows.length > 0) {
    lines.push(line("├", "┼", "┤", "─"));
  }

  for (const r of finishedRows) {
    lines.push(row(r.id, r.title, r.worker, r.path, r.status, r.time, r.duration));
  }

  lines.push(line("└", "┴", "┘", "─"));

  return lines;
}
