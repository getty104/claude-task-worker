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

/**
 * 罫線付きテーブルを組み立てる汎用ヘルパー。列幅はヘッダーと全行の表示幅から算出し、
 * 全角を幅2として桁揃えする。`groups` は行グループの配列で、空でないグループの境目に
 * 区切り罫線を引く（タスクテーブルの実行中/完了セクションの区切りに使う）。
 */
function renderBoxTable(headers: string[], groups: string[][][]): string[] {
  const allRows = groups.flat();
  const widths = headers.map((h, i) =>
    Math.max(1, getDisplayWidth(h), ...allRows.map((r) => getDisplayWidth(r[i] ?? ""))),
  );

  const border = (l: string, m: string, r: string) => `${l}${widths.map((w) => "─".repeat(w + 2)).join(m)}${r}`;
  const row = (cells: string[]) => `│ ${cells.map((c, i) => padToWidth(c ?? "", widths[i])).join(" │ ")} │`;

  const lines: string[] = [];
  lines.push(border("┌", "┬", "┐"));
  lines.push(row(headers));
  lines.push(border("├", "┼", "┤"));

  const nonEmpty = groups.filter((g) => g.length > 0);
  nonEmpty.forEach((group, gi) => {
    if (gi > 0) lines.push(border("├", "┼", "┤"));
    for (const r of group) lines.push(row(r));
  });

  lines.push(border("└", "┴", "┘"));
  return lines;
}

/** タスクテーブル/ログテーブルで表示する既定の最大件数。 */
export const TASK_DISPLAY_LIMIT = 20;
export const LOG_DISPLAY_LIMIT = 20;

/** タスクの「直近さ」の基準時刻。完了は finishedAt、実行中は startedAt。 */
function taskRecency(t: TaskTableEntry): number {
  return (t.finishedAt ?? t.startedAt).getTime();
}

/**
 * 表示するタスクを「直近 limit 件」に絞り込む純粋関数。同じ Issue/PR（id）は
 * 呼び出し元の Map で既に一意化されている前提だが、二重登録に備えて id で重複排除し
 * 最新のものだけを残す。実行中タスクを先頭に、その下を直近順（新しい順）に並べ、
 * 合計 limit 件で打ち切る。
 */
export function selectRecentTasks(entries: TaskTableEntry[], limit: number = TASK_DISPLAY_LIMIT): TaskTableEntry[] {
  // id で重複排除（後勝ち＝最新を残す）
  const byId = new Map<number, TaskTableEntry>();
  for (const e of entries) byId.set(e.id, e);
  const unique = [...byId.values()];

  const running = unique.filter((t) => t.status === "running").sort((a, b) => taskRecency(b) - taskRecency(a));
  const finished = unique.filter((t) => t.status !== "running").sort((a, b) => taskRecency(b) - taskRecency(a));

  return [...running, ...finished].slice(0, limit);
}

/** ステータステーブルの各行を組み立てる。副作用を持たないのでそのままテストできる。 */
export function buildTaskTableLines(entries: TaskTableEntry[], now: Date = new Date()): string[] {
  if (entries.length === 0) return [];

  const runningTasks = entries.filter((t) => t.status === "running");
  const finishedTasks = entries.filter((t) => t.status !== "running");

  const maxTitleWidth = 40;
  const maxPathWidth = 40;

  const truncTitle = (s: string) => (getDisplayWidth(s) > maxTitleWidth ? truncateToWidth(s, maxTitleWidth) : s);
  const truncPath = (p?: string) =>
    p ? (getDisplayWidth(p) > maxPathWidth ? truncateToWidth(p, maxPathWidth) : p) : "";

  const hasPath = entries.some((t) => truncPath(t.path) !== "");

  // status 文字列は herdr モードで `running:working` のように装飾されるため、
  // 表示値ではなく status フィールドで実行中/完了のセクション振り分けを行う。
  const runningRows = runningTasks.map((t) =>
    taskRow(
      t,
      truncTitle(t.title),
      truncPath(t.path),
      hasPath,
      t.agentStatus ? `${t.status}:${t.agentStatus}` : t.status,
      formatTime(t.startedAt),
      formatDuration(t.startedAt, now),
    ),
  );
  const finishedRows = finishedTasks.map((t) =>
    taskRow(
      t,
      truncTitle(t.title),
      truncPath(t.path),
      hasPath,
      t.status,
      formatTime(t.finishedAt ?? t.startedAt),
      formatDuration(t.startedAt, t.finishedAt ?? now),
    ),
  );

  const headers = hasPath
    ? ["#", "Title", "Worker", "Worktree", "Status", "Time", "Duration"]
    : ["#", "Title", "Worker", "Status", "Time", "Duration"];

  return renderBoxTable(headers, [runningRows, finishedRows]);
}

function taskRow(
  t: TaskTableEntry,
  title: string,
  path: string,
  hasPath: boolean,
  status: string,
  time: string,
  duration: string,
): string[] {
  return hasPath
    ? [`#${t.id}`, title, t.workerName, path, status, time, duration]
    : [`#${t.id}`, title, t.workerName, status, time, duration];
}

/** ログテーブル1行分。実行中タスクの標準出力/エラー出力の1行に対応する。 */
export interface LogTableEntry {
  id: number;
  stream: string;
  text: string;
  time: Date;
}

// ANSI エスケープ・制御文字はテーブルの桁揃えを壊すため除去する。
// eslint-disable-next-line no-control-regex -- ANSI/制御文字を意図的に対象にする
const CONTROL_CHARS = /\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f]/g;

function sanitizeLogText(text: string): string {
  return text.replace(CONTROL_CHARS, " ").replace(/\t/g, " ");
}

/** 実行中タスクの標準出力/エラー出力のログをテーブルに組み立てる純粋関数。 */
export function buildLogTableLines(entries: LogTableEntry[]): string[] {
  if (entries.length === 0) return [];

  const maxTextWidth = 100;
  const rows = entries.map((e) => {
    const text = sanitizeLogText(e.text);
    return [
      formatTime(e.time),
      `#${e.id}`,
      e.stream,
      getDisplayWidth(text) > maxTextWidth ? truncateToWidth(text, maxTextWidth) : text,
    ];
  });

  return renderBoxTable(["Time", "#", "Stream", "Log"], [rows]);
}
