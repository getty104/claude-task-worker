import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
// runcat.ts 側の slack.ts への import は type-only なので、実行時の循環参照は発生しない
import { writeRuncatUsage } from "./runcat";
import { CLOUD_FAILURE_GUIDANCE } from "./task-result";

const execAsync = promisify(exec);

const WEBHOOK_URL = process.env.CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL;
const USAGE_CACHE_PATH = "/tmp/claude-usage-cache.json";
/** `usage` コマンドが利用状況をポーリングする間隔 */
export const USAGE_POLL_INTERVAL_SECONDS = 600;
const USAGE_CACHE_TTL_SECONDS = 360;
const USAGE_BACKOFF_PATH = "/tmp/claude-usage-backoff.json";
const USAGE_RATE_LIMIT_DEFAULT_BACKOFF_SECONDS = 600;

export async function send(payload: Record<string, unknown>): Promise<void> {
  if (!WEBHOOK_URL) return;

  try {
    await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`[slack] Failed to send notification: ${err}`);
  }
}

// プラン（Ultra 等）によっては API が five_hour / seven_day を null で返す。その窓は null として扱う
export interface UsageInfo {
  fiveHourUtilization: number | null;
  fiveHourResetsAt: string | null;
  sevenDayUtilization: number | null;
  sevenDayResetsAt: string | null;
}

interface UsageWindow {
  utilization?: number | null;
  resets_at?: string | null;
}

/** usage API のレスポンスを UsageInfo へ。欠けている窓は null にする（throw しない） */
export function parseUsageResponse(body: {
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
}): UsageInfo {
  return {
    fiveHourUtilization: body.five_hour?.utilization ?? null,
    fiveHourResetsAt: body.five_hour?.resets_at ?? null,
    sevenDayUtilization: body.seven_day?.utilization ?? null,
    sevenDayResetsAt: body.seven_day?.resets_at ?? null,
  };
}

interface CredentialPayload {
  claudeAiOauth?: { accessToken?: string; expiresAt?: number };
  oauth_token?: string;
  access_token?: string;
}

export interface OAuthCredential {
  token: string;
  // ミリ秒のエポック。Claude Code の credentials（claudeAiOauth.expiresAt）にだけある
  expiresAt?: number;
}

export function extractCredential(credentials: CredentialPayload | string): OAuthCredential {
  if (typeof credentials === "string") return { token: credentials };
  return {
    token: credentials.claudeAiOauth?.accessToken ?? credentials.oauth_token ?? credentials.access_token ?? "",
    expiresAt: credentials.claudeAiOauth?.expiresAt,
  };
}

async function getOAuthCredential(): Promise<OAuthCredential> {
  // `claude setup-token` で発行した長期トークン。Keychain / credentials の短期トークンより優先する
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) return { token: envToken };
  try {
    const { stdout } = await execAsync('security find-generic-password -s "Claude Code-credentials" -w');
    return extractCredential(JSON.parse(stdout.trim()));
  } catch {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    return extractCredential(JSON.parse(raw));
  }
}

function readUsageCache(): UsageInfo | null {
  try {
    const raw = readFileSync(USAGE_CACHE_PATH, "utf-8");
    const cached = JSON.parse(raw);
    if (Date.now() - cached.timestamp < USAGE_CACHE_TTL_SECONDS * 1000) {
      return cached.data as UsageInfo;
    }
  } catch {
    // ignore
  }
  return null;
}

function writeUsageCache(data: UsageInfo): void {
  try {
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }));
  } catch {
    // ignore
  }
}

/**
 * 429 後に API を叩かない期間（ミリ秒）。Retry-After（秒 or HTTP-date）を優先し、
 * 無い・読めないときは既定値。失敗のたびに叩き直すと制限が明けないため
 */
export function rateLimitBackoffMs(retryAfter: string | null, now = Date.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date) && date > now) return date - now;
  }
  return USAGE_RATE_LIMIT_DEFAULT_BACKOFF_SECONDS * 1000;
}

// 複数のワーカープロセスで共有するため、キャッシュと同じくファイルに置く
function readBackoffUntil(): number {
  try {
    return Number(JSON.parse(readFileSync(USAGE_BACKOFF_PATH, "utf-8")).until) || 0;
  } catch {
    return 0;
  }
}

function writeBackoffUntil(until: number): void {
  try {
    writeFileSync(USAGE_BACKOFF_PATH, JSON.stringify({ until }));
  } catch {
    // ignore
  }
}

async function fetchUsageInfo(fresh: boolean): Promise<UsageInfo | null> {
  // fresh は `usage` の定期取得用。キャッシュの経過時間（取得完了時刻）に左右されず毎回取り直す
  const cached = fresh ? null : readUsageCache();
  if (cached) return cached;

  // fresh でもバックオフ中は叩かない（制限中に叩くと明けるのが遅れる）
  const backoffUntil = readBackoffUntil();
  if (Date.now() < backoffUntil) {
    console.error(`[slack] Usage API rate limited; skipping until ${new Date(backoffUntil).toISOString()}`);
    return null;
  }

  try {
    const { token, expiresAt } = await getOAuthCredential();
    if (!token) {
      console.error("[slack] No OAuth token found (set CLAUDE_CODE_OAUTH_TOKEN or sign in to Claude Code)");
      return null;
    }
    // 短期トークンは claude 本体が動いたときにしか更新されないため、期限切れなら 401 を待たずに止める
    if (expiresAt !== undefined && expiresAt <= Date.now()) {
      console.error(
        `[slack] OAuth token expired at ${new Date(expiresAt).toISOString()} (it is refreshed when claude runs; or set CLAUDE_CODE_OAUTH_TOKEN)`,
      );
      return null;
    }
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 500);
      if (res.status === 429) {
        const until = Date.now() + rateLimitBackoffMs(res.headers.get("retry-after"));
        writeBackoffUntil(until);
        console.error(`[slack] Usage API returned 429; backing off until ${new Date(until).toISOString()}: ${body}`);
      } else {
        console.error(`[slack] Usage API returned ${res.status}: ${body}`);
      }
      return null;
    }
    const data = parseUsageResponse(await res.json());
    writeUsageCache(data);
    return data;
  } catch (err) {
    console.error(`[slack] Failed to fetch usage info: ${err}`);
    return null;
  }
}

function utilizationEmoji(value: number): string {
  if (value < 50) return "🟢";
  if (value < 80) return "🟡";
  return "🔴";
}

function formatResetTimeJST(isoString: string): string {
  const date = new Date(isoString);
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatWindow(label: string, utilization: number | null, resetsAt: string | null): string | null {
  if (utilization === null) return null;
  const reset = resetsAt ? ` (reset: ${formatResetTimeJST(resetsAt)})` : "";
  return `${label}: ${utilization.toFixed(1)}%${reset}`;
}

/** 返ってきた窓だけを並べる。どちらも無ければ空文字 */
export function formatTokenLimitText(usage: UsageInfo): string {
  const parts = [
    formatWindow("5h", usage.fiveHourUtilization, usage.fiveHourResetsAt),
    formatWindow("7d", usage.sevenDayUtilization, usage.sevenDayResetsAt),
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return "";
  const values = [usage.fiveHourUtilization, usage.sevenDayUtilization].filter((v): v is number => v !== null);
  return ` | ${utilizationEmoji(Math.max(...values))} ${parts.join(" / ")}`;
}

/**
 * 現在の利用状況を取得し、RunCat Neo 用スナップショットを更新したうえで通知に添えるテキストを返す。
 * ワーカーの完了/失敗通知はすべてここを通るため、タスクが終わるたびに RunCat 側も最新化される
 * （Slack webhook 未設定でも通知が no-op になるだけで、スナップショットの更新は行われる）。
 * 取得に失敗したときだけ null を返す（どの枠も返らない正常応答は空文字）。
 */
export async function buildTokenLimitText(fresh = false): Promise<string | null> {
  const usage = await fetchUsageInfo(fresh);
  if (!usage) return null;
  writeRuncatUsage(usage);
  return formatTokenLimitText(usage);
}

/**
 * 通知本文へ載せる output を末尾1000文字に切り詰める。
 * 案内文（CLOUD_FAILURE_GUIDANCE）は appendCloudFailureGuidance が output の先頭に
 * 付けるが、単純な末尾切り出しだと長いエラー本文で先頭の案内文ごと消えてしまう。
 * 先頭一致で検出できた場合は案内文を切り出し領域の外に確保し、残りだけを末尾切り出しする。
 */
export function truncateOutputForNotification(output: string): string {
  if (output.length <= 1000) return output;
  if (output.startsWith(CLOUD_FAILURE_GUIDANCE)) {
    const rest = output.slice(CLOUD_FAILURE_GUIDANCE.length);
    return `${CLOUD_FAILURE_GUIDANCE}…${rest.slice(-1000)}`;
  }
  return `…${output.slice(-1000)}`;
}

/**
 * 完了/失敗通知の本文を組み立てる純粋関数。
 * cloud が渡された（＝クラウド実行）場合のみ先頭行を出す: sessionId が非空ならセッションURL、
 * 空ならID抽出失敗を明記する（Slack側で通知の最初の一行だけが折りたたみ表示でも見えるため、先頭に置く）。
 * ローカル実行（cloud 省略）では先頭行を出さない。
 */
export function buildTaskNotificationText(params: {
  status: "completed" | "failed";
  workerName: string;
  repoName: string;
  id: number;
  title: string;
  url: string;
  tokenText: string;
  output?: string;
  cloud?: { sessionId?: string };
}): string {
  const { status, workerName, repoName, id, title, url, tokenText, output, cloud } = params;
  const emoji = status === "completed" ? "✅" : "❌";
  const label = status === "completed" ? "completed" : "failed";
  const truncatedOutput = output ? truncateOutputForNotification(output) : output;
  const outputBlock = truncatedOutput ? `\n\`\`\`${truncatedOutput}\`\`\`` : "";
  const body = `${emoji} [${workerName}] ${repoName} | Task ${label}: <${url}|#${id} ${title}>${tokenText}${outputBlock}`;
  let sessionUrlPrefix = "";
  if (cloud) {
    sessionUrlPrefix = cloud.sessionId?.trim()
      ? `https://claude.ai/code/${cloud.sessionId.trim()}\n`
      : "セッションURL不明（ID抽出に失敗）\n";
  }
  return `${sessionUrlPrefix}${body}`;
}

export async function notifyTaskCompleted(
  workerName: string,
  repoName: string,
  id: number,
  title: string,
  url: string,
  output?: string,
  cloud?: { sessionId?: string },
): Promise<void> {
  const tokenText = (await buildTokenLimitText()) ?? "";
  await send({
    text: buildTaskNotificationText({
      status: "completed",
      workerName,
      repoName,
      id,
      title,
      url,
      tokenText,
      output,
      cloud,
    }),
  });
}

export async function notifyTaskFailed(
  workerName: string,
  repoName: string,
  id: number,
  title: string,
  url: string,
  output?: string,
  cloud?: { sessionId?: string },
): Promise<void> {
  const tokenText = (await buildTokenLimitText()) ?? "";
  await send({
    text: buildTaskNotificationText({
      status: "failed",
      workerName,
      repoName,
      id,
      title,
      url,
      tokenText,
      output,
      cloud,
    }),
  });
}

export async function notifyError(workerName: string, repoName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await send({
    text: `🚨 [${workerName}] ${repoName} | Error: ${message}`,
  });
}
