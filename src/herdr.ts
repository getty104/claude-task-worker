import { createRequire } from "node:module";
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
}

export interface CreatedWorkspace {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

// herdr が claude の実行状態として保持する値。TUI セッションはタスク完了後も
// プロセスが生き続けるため、herdr モードではこのステータスが完了シグナルになる。
export type AgentStatus = "working" | "idle" | "blocked" | "unknown";

export interface AgentInfo {
  paneId: string;
  tabId: string;
  workspaceId: string;
  agentStatus: AgentStatus;
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
        let parsed: HerdrResponse | undefined;
        try {
          parsed = JSON.parse(stdout) as HerdrResponse;
        } catch {
          parsed = undefined;
        }
        resolve({ execError: error as NodeJS.ErrnoException | null, parsed, stdout, stderr });
      },
    );
  });
}

// allowEmptyResult: `pane send-text` / `pane send-keys` など結果を返さない
// fire-and-forget 系コマンド専用のフラグ。これらは成功時に空stdout・空stderr・
// 終了コード0を返すため、空応答を正常完了として扱えるようにする。
async function execHerdr(args: string[], options?: { allowEmptyResult?: boolean }): Promise<unknown> {
  const { execError, parsed, stdout, stderr } = await runHerdr(args);
  const stderrSuffix = stderr.trim() ? `: ${stderr.trim()}` : "";
  // stdout に有効な error JSON が乗っているケースは execFile の失敗より優先して扱う。
  if (parsed?.error) {
    throw new HerdrError(
      `herdr ${args.join(" ")} failed: [${parsed.error.code}] ${parsed.error.message}`,
      parsed.error.code,
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
    "--cwd",
    cwd,
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
    "--cwd",
    cwd,
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
    | { workspaces?: { workspace_id: string; label?: string }[] }
    | null
    | undefined;
  if (!result || !Array.isArray(result.workspaces)) {
    return [];
  }
  return result.workspaces.map((workspace) => ({
    workspaceId: workspace.workspace_id,
    label: workspace.label ?? "",
  }));
}

export async function workspaceClose(workspaceId: string): Promise<void> {
  await execHerdr(["workspace", "close", workspaceId]);
}

// argv を直接実行してペインを起動する。`pane send-text` と違いシェルを経由しないため、
// シェル初期化中に入力が捨てられるレース（dispatcher.ts の waitForPaneReady 参照）が起きない。
// 起動先ワークスペース/タブの既存タブに split で入るため、専用タブが必要な場合は
// 続けて paneMoveToNewTab() を呼ぶ。
export async function agentStart({
  name,
  cwd,
  argv,
  workspaceId,
  env,
}: {
  name: string;
  cwd: string;
  argv: string[];
  workspaceId?: string;
  env?: Record<string, string>;
}): Promise<{ paneId: string; tabId: string }> {
  const result = (await execHerdr([
    "agent",
    "start",
    name,
    ...(workspaceId ? ["--workspace", workspaceId] : []),
    "--cwd",
    cwd,
    ...envArgs(env),
    "--no-focus",
    "--",
    ...argv,
  ])) as { agent?: { pane_id?: string; tab_id?: string } } | null | undefined;
  const paneId = result?.agent?.pane_id;
  const tabId = result?.agent?.tab_id;
  if (!paneId || !tabId) {
    throw new Error("Failed to start agent: invalid response structure from herdr");
  }
  return { paneId, tabId };
}

// ペインを新しいタブへ切り出す。agentStart が既存タブに split で入るため、
// 1タスク1タブにするために使う。
export async function paneMoveToNewTab(
  paneId: string,
  { label, workspaceId }: { label: string; workspaceId?: string },
): Promise<{ tabId: string }> {
  const result = (await execHerdr([
    "pane",
    "move",
    paneId,
    "--new-tab",
    ...(workspaceId ? ["--workspace", workspaceId] : []),
    "--label",
    label,
    "--no-focus",
  ])) as { move_result?: { created_tab?: { tab_id?: string } } } | null | undefined;
  const tabId = result?.move_result?.created_tab?.tab_id;
  if (!tabId) {
    throw new Error("Failed to move pane to a new tab: invalid response structure from herdr");
  }
  return { tabId };
}

function toAgentStatus(value: unknown): AgentStatus {
  return value === "working" || value === "idle" || value === "blocked" ? value : "unknown";
}

// ペインで動いているエージェントの状態を取得する。ペインが消えている場合は
// HerdrError（code: "pane_not_found" 等）が投げられる。
export async function agentGet(target: string): Promise<AgentInfo> {
  const result = (await execHerdr(["agent", "get", target])) as
    | { agent?: { pane_id?: string; tab_id?: string; workspace_id?: string; agent_status?: unknown } }
    | null
    | undefined;
  const agent = result?.agent;
  if (!agent?.pane_id) {
    throw new Error(`Failed to get agent info for ${target}: invalid response structure from herdr`);
  }
  return {
    paneId: agent.pane_id,
    tabId: agent.tab_id ?? "",
    workspaceId: agent.workspace_id ?? "",
    agentStatus: toAgentStatus(agent.agent_status),
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
