import { createRequire } from "node:module";
import { resolve as resolvePath } from "node:path";
import type * as ChildProcess from "node:child_process";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

export interface TabInfo {
  tabId: string;
  label: string;
  workspaceId: string;
}

export interface WorkspaceInfo {
  workspaceId: string;
  label: string;
  // herdr の UI が現在表示しているワークスペースかどうか。workspace close が
  // フォーカスを別ワークスペースへ移してしまうため、閉じる前後の復元判定に使う
  // （dispatcher.ts の restoreWorkspaceFocus 参照）。
  focused: boolean;
}

export interface CreatedWorkspace {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

// herdr が claude の実行状態として保持する値（`herdr api schema` の AgentStatus と一致させる）。
// TUI セッションはタスク完了後もプロセスが生き続けるため、herdr モードではこのステータスが
// 完了シグナルになる。
//
// `done` は「作業を終えたが、ユーザーがまだそのペインを見ていない」未確認完了の状態。
// herdr は working から idle へ落ちたペインが非フォーカスだと idle ではなく done を返し、
// ユーザーがタブを開いた時点で idle に落とす（`agent explain` の検出結果自体は idle のまま）。
// この値を知らないと、誰もタブを見ないワーカーのタスクは永久に完了扱いにならない。
export type AgentStatus = "working" | "idle" | "blocked" | "done" | "unknown";

export interface AgentInfo {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agentStatus: AgentStatus;
  // claude のセッションID（`agent_session.kind === "id"` のときのみ）。
  // `~/.claude/projects/*/<sessionId>.jsonl` の transcript を引く鍵に使う。
  sessionId?: string;
}

export interface PaneProcessInfo {
  foregroundProcesses: {
    name: string;
    argv: string[];
    cmdline: string;
    pid: number;
  }[];
}

interface HerdrErrorPayload {
  code: string;
  message: string;
}

interface HerdrResponse {
  result?: unknown;
  error?: HerdrErrorPayload;
}

export class HerdrUnavailableError extends Error {
  readonly reason: "not-installed" | "server-unreachable";

  constructor(message: string, reason: "not-installed" | "server-unreachable") {
    super(message);
    this.name = "HerdrUnavailableError";
    this.reason = reason;
  }
}

export class HerdrError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

interface HerdrRawResult {
  execError: NodeJS.ErrnoException | null;
  parsed: HerdrResponse | undefined;
  // stdout ではなく stderr 側にエラーエンベロープが乗っていた場合の中身。
  stderrError?: HerdrErrorPayload;
  stdout: string;
  stderr: string;
}

export const HERDR_TIMEOUT_MS = 15 * 1000;

// herdr は error 発生時も終了コード0を返すため、execFile の成否ではなく
// stdout の JSON パース結果（parsed）と error.code の両方を呼び出し側で判定させる。
function runHerdr(args: string[]): Promise<HerdrRawResult> {
  return new Promise((resolve) => {
    childProcess.execFile(
      "herdr",
      args,
      { timeout: HERDR_TIMEOUT_MS, killSignal: "SIGKILL" },
      (error, stdout, stderr) => {
        const parsed = parseHerdrResponse(stdout);
        // 大半のコマンドは終了コード0＋stdoutにJSONを返すが、一部（実測では
        // 存在しないタブへの `tab close`）は終了コード非0＋stderrにJSONを返す。
        // stdout から error を取れなかった場合に限り stderr も見て、どちらの形でも
        // エラーコードを取り出せるようにする（取り出せないと "tab_not_found は正常系"
        // のような code 判定が効かず、グレースフル終了のたびに偽のエラーログが出る）。
        // 結果（result）の取得元はあくまで stdout のみ。
        const stderrError = parsed?.error ? undefined : parseHerdrResponse(stderr)?.error;
        resolve({ execError: error as NodeJS.ErrnoException | null, parsed, stderrError, stdout, stderr });
      },
    );
  });
}

function parseHerdrResponse(output: string): HerdrResponse | undefined {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as HerdrResponse;
  } catch {
    return undefined;
  }
}

// allowEmptyResult: `pane send-text` / `pane send-keys` など結果を返さない
// fire-and-forget 系コマンド専用のフラグ。これらは成功時に空stdout・空stderr・
// 終了コード0を返すため、空応答を正常完了として扱えるようにする。
async function execHerdr(args: string[], options?: { allowEmptyResult?: boolean }): Promise<unknown> {
  const { execError, parsed, stderrError, stdout, stderr } = await runHerdr(args);
  const stderrSuffix = stderr.trim() ? `: ${stderr.trim()}` : "";
  // 有効な error JSON が乗っているケースは execFile の失敗より優先して扱う
  // （stdout・stderr のどちらに出ていても HerdrError にして code 判定を効かせる）。
  const errorPayload = parsed?.error ?? stderrError;
  if (errorPayload) {
    throw new HerdrError(
      `herdr ${args.join(" ")} failed: [${errorPayload.code}] ${errorPayload.message}`,
      errorPayload.code,
    );
  }
  if (execError) {
    throw new Error(`herdr ${args.join(" ")} failed: ${execError.message}${stderrSuffix}`);
  }
  if (!parsed) {
    // fire-and-forget 系コマンド（allowEmptyResult 指定時）に限り、stdout も stderr も
    // 空なら「結果なしの正常応答」とみなす。stderr に出力がある場合は exit 0 でも
    // 失敗を握りつぶさないようエラーにする。JSONを返すべき他コマンド（tab list/create 等）
    // では空stdoutを従来どおり invalid JSON 扱いにする。
    if (options?.allowEmptyResult && stdout.trim() === "" && stderr.trim() === "") {
      return undefined;
    }
    throw new Error(`herdr ${args.join(" ")} failed: invalid JSON output${stderrSuffix}`);
  }
  return parsed.result;
}

// `--env KEY=VALUE` の可変長指定を組み立てる。
function envArgs(env?: Record<string, string>): string[] {
  if (!env) return [];
  return Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

// `--cwd` は herdr サーバー（別プロセス）側で解決されるため、相対パスを渡すと
// ワーカーのcwdではなく herdr サーバーのcwd（実測でホームディレクトリ）を基準に
// 解決されてしまう。しかもエラーにはならず黙ってホームで起動するため、
// worktree を渡したつもりのタスクがリポジトリ外で走る。
// 相対パスを herdr へ渡す経路を塞ぐため、境界であるここで必ず絶対パス化する
// （getWorktreePath() は `.claude/worktrees/<id>` の相対パスを返す。default モードの
// spawn({cwd}) はワーカーのcwd基準で解決されるため、この差が herdr モードでだけ牙をむく）。
function cwdArgs(cwd: string): string[] {
  return ["--cwd", resolvePath(cwd)];
}

export async function tabCreate({
  label,
  cwd,
  workspaceId,
  env,
}: {
  label: string;
  cwd: string;
  workspaceId?: string;
  env?: Record<string, string>;
}): Promise<{
  paneId: string;
  tabId: string;
}> {
  const result = (await execHerdr([
    "tab",
    "create",
    ...(workspaceId ? ["--workspace", workspaceId] : []),
    "--label",
    label,
    ...cwdArgs(cwd),
    ...envArgs(env),
    "--no-focus",
  ])) as { root_pane?: { pane_id?: string }; tab?: { tab_id?: string } } | null | undefined;
  const paneId = result?.root_pane?.pane_id;
  const tabId = result?.tab?.tab_id;
  if (!paneId || !tabId) {
    throw new Error("Failed to create tab: invalid response structure from herdr");
  }
  return { paneId, tabId };
}

export async function tabRename(tabId: string, label: string): Promise<void> {
  await execHerdr(["tab", "rename", tabId, label]);
}

export async function paneClose(paneId: string): Promise<void> {
  await execHerdr(["pane", "close", paneId]);
}

// ペインの存在確認に使う。消えている場合は HerdrError（code: "pane_not_found"）を投げる。
export async function paneGet(paneId: string): Promise<{ paneId: string; tabId: string }> {
  const result = (await execHerdr(["pane", "get", paneId])) as
    | { pane?: { pane_id?: string; tab_id?: string } }
    | null
    | undefined;
  const pane = result?.pane;
  if (!pane?.pane_id) {
    throw new Error(`Failed to get pane ${paneId}: invalid response structure from herdr`);
  }
  return { paneId: pane.pane_id, tabId: pane.tab_id ?? "" };
}

export async function tabClose(tabId: string): Promise<void> {
  await execHerdr(["tab", "close", tabId]);
}

export async function tabList(): Promise<TabInfo[]> {
  const result = (await execHerdr(["tab", "list"])) as
    | { tabs?: { tab_id: string; label: string; workspace_id: string }[] }
    | null
    | undefined;
  if (!result || !Array.isArray(result.tabs)) {
    return [];
  }
  return result.tabs.map((tab) => ({
    tabId: tab.tab_id,
    label: tab.label,
    workspaceId: tab.workspace_id,
  }));
}

export async function workspaceCreate({
  label,
  cwd,
  env,
}: {
  label: string;
  cwd: string;
  env?: Record<string, string>;
}): Promise<CreatedWorkspace> {
  const result = (await execHerdr([
    "workspace",
    "create",
    "--label",
    label,
    ...cwdArgs(cwd),
    ...envArgs(env),
    "--no-focus",
  ])) as
    | { workspace?: { workspace_id?: string }; root_pane?: { pane_id?: string; tab_id?: string } }
    | null
    | undefined;
  const workspaceId = result?.workspace?.workspace_id;
  const paneId = result?.root_pane?.pane_id;
  const tabId = result?.root_pane?.tab_id;
  if (!workspaceId || !paneId || !tabId) {
    throw new Error("Failed to create workspace: invalid response structure from herdr");
  }
  return { workspaceId, paneId, tabId };
}

export async function workspaceList(): Promise<WorkspaceInfo[]> {
  const result = (await execHerdr(["workspace", "list"])) as
    | { workspaces?: { workspace_id: string; label?: string; focused?: boolean }[] }
    | null
    | undefined;
  if (!result || !Array.isArray(result.workspaces)) {
    return [];
  }
  return result.workspaces.map((workspace) => ({
    workspaceId: workspace.workspace_id,
    label: workspace.label ?? "",
    focused: workspace.focused === true,
  }));
}

export async function workspaceClose(workspaceId: string): Promise<void> {
  await execHerdr(["workspace", "close", workspaceId]);
}

// 指定ワークスペースを herdr の UI 上でアクティブにする。workspace close が奪った
// フォーカスを元へ戻すために使う（dispatcher.ts の restoreWorkspaceFocus 参照）。
export async function workspaceFocus(workspaceId: string): Promise<void> {
  await execHerdr(["workspace", "focus", workspaceId]);
}

// argv をシェルで安全に実行できる1行へ組み立てる。各トークンをシングルクォートで囲み、
// 内部の `'` だけを `'\''` でエスケープする。シングルクォート内はあらゆる文字が literal に
// なるため、SYSTEM_PROMPT のようなバッククォート・`$`・改行を含む引数もシェルに解釈されず
// そのまま claude へ渡る（`launchAgentInPane` が send-text でこの1行をシェルへ流し込む）。
export function shellQuoteArgv(argv: string[]): string {
  return argv.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(" ");
}

// 既存ペイン（タスクタブのルートシェル）へ起動コマンドを流し込んで claude(TUI) を起動する。
//
// **`agent start` は使わない**。新しい herdr（0.7 系）の `agent start` は
// `--kind <KIND>` の**正規実行ファイル**（claude なら PATH 上の `claude`）しか起動できず、
// `headroom wrap claude ...` のようなラッパー経由の起動ができない（`--workspace`/`--tab`/
// `--cwd`/`--env` も廃止され、`unknown option: --workspace` で失敗する）。
// そこでルートペインのシェルへ `send-text` で起動コマンドを送り、`send-keys enter` で実行する。
// claude は herdr の**自動エージェント検出**でそのまま agent として捕捉されるため、
// `agent start` による明示登録は不要で、`agentGet(paneId)` が状態・セッションIDを返す
// （cwd と env は tabCreate の `--cwd` / `--env` でシェルへ渡してあり、そこから起動する
// claude が継承する）。シェル初期化中に送ると入力が捨てられるレースがあるため、
// 呼び出し側は送信前にプロンプト描画を待つこと（herdr-runner の waitForPaneReady 参照）。
export async function launchAgentInPane(paneId: string, argv: string[]): Promise<void> {
  await paneSendText(paneId, shellQuoteArgv(argv));
  await paneSendKeys(paneId, "enter");
}

function toAgentStatus(value: unknown): AgentStatus {
  return value === "working" || value === "idle" || value === "blocked" || value === "done" ? value : "unknown";
}

// ペインで動いているエージェントの状態を取得する。ペインが消えている場合は
// HerdrError（code: "pane_not_found" 等）が投げられる。
export async function agentGet(target: string): Promise<AgentInfo> {
  const result = (await execHerdr(["agent", "get", target])) as
    | {
        agent?: {
          pane_id?: string;
          tab_id?: string;
          workspace_id?: string;
          agent_status?: unknown;
          agent_session?: { kind?: unknown; value?: unknown };
        };
      }
    | null
    | undefined;
  const agent = result?.agent;
  if (!agent?.pane_id) {
    throw new Error(`Failed to get agent info for ${target}: invalid response structure from herdr`);
  }
  // agent_session は `kind: "id"` のときだけ claude のセッションIDが入る
  // （`kind: "path"` などセッションIDでない形も返しうるため種別で絞る）。
  const session = agent.agent_session;
  const sessionId = session?.kind === "id" && typeof session.value === "string" ? session.value : undefined;
  return {
    paneId: agent.pane_id,
    tabId: agent.tab_id ?? "",
    workspaceId: agent.workspace_id ?? "",
    agentStatus: toAgentStatus(agent.agent_status),
    sessionId,
  };
}

// herdr は各ペインの環境に HERDR_WORKSPACE_ID / HERDR_TAB_ID / HERDR_PANE_ID を
// 自動注入する。herdr の外で起動された場合は undefined を返す。
export function getCurrentWorkspaceId(): string | undefined {
  const id = process.env.HERDR_WORKSPACE_ID;
  return id && id.length > 0 ? id : undefined;
}

export type PaneReadSource = "visible" | "recent" | "recent-unwrapped";

const PANE_READ_ERROR_ALLOWED_KEYS = new Set(["code", "message"]);

// 端末内容自体が `{code: ...}` のような任意のJSON風テキストを表示している場合に
// 誤ってエラー扱いしないよう、キー構成・型まで herdr のエラーペイロード形状と一致する
// 場合のみ HerdrErrorPayload とみなす。
function isPaneReadErrorPayload(value: unknown): value is HerdrErrorPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !PANE_READ_ERROR_ALLOWED_KEYS.has(key))) {
    return false;
  }
  const payload = value as { code?: unknown; message?: unknown };
  if (typeof payload.code !== "string") {
    return false;
  }
  if ("message" in payload && typeof payload.message !== "string") {
    return false;
  }
  return true;
}

// `pane read` は他コマンドと異なり JSON エンベロープではなく端末内容の生テキストを
// stdout に返す（失敗時のみ {"code","message"} 形式のJSONを返し、`error` キーでは包まない）。
// そのため execHerdr のJSONパース経路は通さず、stdout をそのまま端末内容として扱う。
export async function paneRead(paneId: string, options?: { source?: PaneReadSource; lines?: number }): Promise<string> {
  const args = ["pane", "read", paneId, "--source", options?.source ?? "visible"];
  if (options?.lines !== undefined) {
    args.push("--lines", String(options.lines));
  }
  const { execError, stdout, stderr } = await runHerdr(args);
  const trimmed = stdout.trim();
  // 端末内容自体が `{` で始まりうるため、JSONとして解釈でき かつ herdr のエラー形状に
  // 厳密一致する場合のみエラー扱いする。
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = undefined;
    }
    if (isPaneReadErrorPayload(parsed)) {
      throw new HerdrError(
        `herdr ${args.join(" ")} failed: [${parsed.code}] ${parsed.message ?? ""}`.trim(),
        parsed.code,
      );
    }
  }
  if (execError) {
    const stderrSuffix = stderr.trim() ? `: ${stderr.trim()}` : "";
    throw new Error(`herdr ${args.join(" ")} failed: ${execError.message}${stderrSuffix}`);
  }
  return stdout;
}

export async function paneSendText(paneId: string, text: string): Promise<void> {
  await execHerdr(["pane", "send-text", paneId, text], { allowEmptyResult: true });
}

export async function paneSendKeys(paneId: string, ...keys: string[]): Promise<void> {
  await execHerdr(["pane", "send-keys", paneId, ...keys], { allowEmptyResult: true });
}

export async function paneProcessInfo(paneId: string): Promise<PaneProcessInfo> {
  const result = (await execHerdr(["pane", "process-info", "--pane", paneId])) as
    | {
        process_info?: {
          foreground_processes?: { name: string; argv: string[]; cmdline: string; pid: number }[];
        };
      }
    | null
    | undefined;
  const foregroundProcesses = result?.process_info?.foreground_processes ?? [];
  return {
    foregroundProcesses: foregroundProcesses.map((process) => ({
      name: process.name,
      argv: process.argv,
      cmdline: process.cmdline,
      pid: process.pid,
    })),
  };
}

export async function checkHerdrAvailable(): Promise<void> {
  const { execError, parsed } = await runHerdr(["tab", "list"]);
  if (execError?.code === "ENOENT") {
    throw new HerdrUnavailableError(
      "herdrがインストールされていません。herdr CLIをインストールしてください。",
      "not-installed",
    );
  }
  if (!parsed) {
    throw new HerdrUnavailableError(
      "herdrサーバーに接続できませんでした。`herdr status` 等で起動状態を確認してください。",
      "server-unreachable",
    );
  }
  // parsed に error キーがあっても herdr 自体は稼働中（疎通OK）とみなし、例外を投げない。
}
