import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

export interface TabInfo {
  tabId: string;
  label: string;
  workspaceId: string;
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

export async function tabCreate({ label, cwd }: { label: string; cwd: string }): Promise<{
  paneId: string;
  tabId: string;
}> {
  const result = (await execHerdr(["tab", "create", "--label", label, "--cwd", cwd, "--no-focus"])) as
    | { root_pane?: { pane_id?: string }; tab?: { tab_id?: string } }
    | null
    | undefined;
  const paneId = result?.root_pane?.pane_id;
  const tabId = result?.tab?.tab_id;
  if (!paneId || !tabId) {
    throw new Error("Failed to create tab: invalid response structure from herdr");
  }
  return { paneId, tabId };
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
