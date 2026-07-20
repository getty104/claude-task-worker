import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Claude Code のセッション transcript（JSONL）から最終レポートを取り出す。
 *
 * herdr モードには `claude -p` の stdout に相当するものが無いため、かつては
 * `herdr pane read` で回収した端末内容をそのまま Slack 通知に載せていた。しかし
 * TUI のペインは「会話ログ + 空行パディング + 入力ボックス + ステータスバー」で
 * 構成されており、通知は末尾1000文字だけを切り出すため、実際に届くのは
 * 罫線・`❯` プロンプト・`ctx 7% │ 5h 26%` といった TUI の装飾だけになる。
 *
 * 一方 Claude Code は会話を `~/.claude/projects/<エンコード済みcwd>/<session-id>.jsonl`
 * へ書き出しており、そこには整形前の最終アシスタントメッセージがそのまま入っている。
 * herdr は `agent get` でペインの claude セッションIDを返すため、それを鍵に
 * transcript を引けば TUI をパースせずに正確な最終レポートが得られる。
 */

// cwd のエンコード規則（`/` と `.` と `_` の扱い）は Claude Code の実装依存で、
// 実測でも `dementia_app` が `dementia-app` になるなど不可逆。ディレクトリ名を
// 再現しようとせず、UUID であるセッションIDでディレクトリを総なめする。
export function transcriptRoot(): string {
  return join(homedir(), ".claude", "projects");
}

export function findTranscriptPath(sessionId: string, root: string = transcriptRoot()): string | null {
  if (sessionId === "") return null;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const candidate = join(root, entry, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface TranscriptEntry {
  type?: unknown;
  isSidechain?: unknown;
  message?: { role?: unknown; content?: unknown };
}

function textOf(entry: TranscriptEntry): string {
  const content = entry.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

/**
 * transcript の最終アシスタント発言（テキスト部分）を返す。
 *
 * - サブエージェントの発言（`isSidechain: true`）は除外する。メインエージェントの
 *   完了報告こそが `claude -p` の stdout 相当であり、サブエージェントの報告は途中経過
 * - テキストブロックを持たないエントリ（tool_use だけのターン）は飛ばす
 * - 壊れた行は無視する（書き込み途中の末尾行など）
 */
export function extractFinalAssistantText(jsonl: string): string {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || entry.isSidechain === true) continue;
    const text = textOf(entry);
    if (text !== "") return text;
  }
  return "";
}

/** セッションIDから最終レポートを読む。見つからない・空なら空文字列を返す。 */
export function readFinalReport(sessionId: string | undefined, root: string = transcriptRoot()): string {
  if (!sessionId) return "";
  const path = findTranscriptPath(sessionId, root);
  if (!path) return "";
  try {
    return extractFinalAssistantText(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`[transcript] failed to read ${path}: ${err}`);
    return "";
  }
}
