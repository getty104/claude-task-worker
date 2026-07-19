import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const WEBHOOK_URL = process.env.CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL;
const USAGE_CACHE_PATH = "/tmp/claude-usage-cache.json";
const USAGE_CACHE_TTL_SECONDS = 360;

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

export interface UsageInfo {
  fiveHourUtilization: number;
  fiveHourResetsAt: string;
  sevenDayUtilization: number;
  sevenDayResetsAt: string;
}

interface CredentialPayload {
  claudeAiOauth?: { accessToken?: string };
  oauth_token?: string;
  access_token?: string;
}

function extractToken(credentials: CredentialPayload | string): string {
  if (typeof credentials === "string") return credentials;
  return credentials.claudeAiOauth?.accessToken ?? credentials.oauth_token ?? credentials.access_token ?? "";
}

async function getOAuthToken(): Promise<string> {
  try {
    const { stdout } = await execAsync('security find-generic-password -s "Claude Code-credentials" -w');
    return extractToken(JSON.parse(stdout.trim()));
  } catch {
    const raw = readFileSync(join(homedir(), ".claude", ".credentials.json"), "utf-8");
    return extractToken(JSON.parse(raw));
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

export async function fetchUsageInfo(): Promise<UsageInfo | null> {
  const cached = readUsageCache();
  if (cached) return cached;

  try {
    const token = await getOAuthToken();
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) {
      console.error(`[slack] Usage API returned ${res.status}`);
      return null;
    }
    const body = await res.json();
    const data: UsageInfo = {
      fiveHourUtilization: body.five_hour.utilization,
      fiveHourResetsAt: body.five_hour.resets_at,
      sevenDayUtilization: body.seven_day.utilization,
      sevenDayResetsAt: body.seven_day.resets_at,
    };
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

export function formatTokenLimitText(usage: UsageInfo): string {
  const fiveH = usage.fiveHourUtilization.toFixed(1);
  const sevenD = usage.sevenDayUtilization.toFixed(1);
  const emoji = utilizationEmoji(Math.max(usage.fiveHourUtilization, usage.sevenDayUtilization));
  const fiveHReset = formatResetTimeJST(usage.fiveHourResetsAt);
  const sevenDReset = formatResetTimeJST(usage.sevenDayResetsAt);
  return ` | ${emoji} 5h: ${fiveH}% (reset: ${fiveHReset}) / 7d: ${sevenD}% (reset: ${sevenDReset})`;
}

export async function buildTokenLimitText(): Promise<string> {
  const usage = await fetchUsageInfo();
  return usage ? formatTokenLimitText(usage) : "";
}

export async function notifyTaskCompleted(
  workerName: string,
  repoName: string,
  id: number,
  title: string,
  url: string,
  output?: string,
): Promise<void> {
  const tokenText = await buildTokenLimitText();
  const truncatedOutput = output && output.length > 1000 ? `…${output.slice(-1000)}` : output;
  const outputBlock = truncatedOutput ? `\n\`\`\`${truncatedOutput}\`\`\`` : "";
  await send({
    text: `✅ [${workerName}] ${repoName} | Task completed: <${url}|#${id} ${title}>${tokenText}${outputBlock}`,
  });
}

export async function notifyTaskFailed(
  workerName: string,
  repoName: string,
  id: number,
  title: string,
  url: string,
  output?: string,
): Promise<void> {
  const tokenText = await buildTokenLimitText();
  const truncatedOutput = output && output.length > 1000 ? `…${output.slice(-1000)}` : output;
  const outputBlock = truncatedOutput ? `\n\`\`\`${truncatedOutput}\`\`\`` : "";
  await send({
    text: `❌ [${workerName}] ${repoName} | Task failed: <${url}|#${id} ${title}>${tokenText}${outputBlock}`,
  });
}

export async function notifyError(workerName: string, repoName: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await send({
    text: `🚨 [${workerName}] ${repoName} | Error: ${message}`,
  });
}
