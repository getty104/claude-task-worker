import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const WEBHOOK_URL = process.env.CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL;
const USAGE_CACHE_PATH = "/tmp/claude-usage-cache.json";
const USAGE_CACHE_TTL_SECONDS = 360;

async function send(payload: Record<string, unknown>): Promise<void> {
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

interface UsageInfo {
  fiveHourUtilization: number;
  sevenDayUtilization: number;
}

async function getOAuthToken(): Promise<string> {
  const { stdout } = await execAsync(
    'security find-generic-password -s "Claude Code-credentials" -w'
  );
  const credentials = JSON.parse(stdout.trim());
  return credentials.oauth_token ?? credentials.access_token ?? credentials;
}

function readUsageCache(): UsageInfo | null {
  try {
    const raw = readFileSync(USAGE_CACHE_PATH, "utf-8");
    const cached = JSON.parse(raw);
    if (Date.now() - cached.timestamp < USAGE_CACHE_TTL_SECONDS * 1000) {
      return cached.data as UsageInfo;
    }
  } catch {
    // cache miss
  }
  return null;
}

function writeUsageCache(data: UsageInfo): void {
  try {
    writeFileSync(USAGE_CACHE_PATH, JSON.stringify({ timestamp: Date.now(), data }));
  } catch {
    // ignore write errors
  }
}

async function fetchUsageInfo(): Promise<UsageInfo | null> {
  const cached = readUsageCache();
  if (cached) return cached;

  try {
    const token = await getOAuthToken();
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      console.error(`[slack] Usage API returned ${res.status}`);
      return null;
    }
    const body = await res.json();
    const data: UsageInfo = {
      fiveHourUtilization: body.five_hour.utilization,
      sevenDayUtilization: body.seven_day.utilization,
    };
    writeUsageCache(data);
    return data;
  } catch (err) {
    console.error(`[slack] Failed to fetch usage info: ${err}`);
    return null;
  }
}

function utilizationEmoji(value: number): string {
  if (value < 0.5) return "🟢";
  if (value < 0.8) return "🟡";
  return "🔴";
}

async function buildTokenLimitText(): Promise<string> {
  const usage = await fetchUsageInfo();
  if (!usage) return "";

  const fiveH = (usage.fiveHourUtilization * 100).toFixed(1);
  const sevenD = (usage.sevenDayUtilization * 100).toFixed(1);
  const emoji = utilizationEmoji(Math.max(usage.fiveHourUtilization, usage.sevenDayUtilization));
  return ` | ${emoji} 5h: ${fiveH}% / 7d: ${sevenD}%`;
}

export async function notifyTaskCompleted(workerName: string, repoName: string, id: number, title: string, url: string): Promise<void> {
  const tokenText = await buildTokenLimitText();
  await send({
    text: `✅ [${workerName}] ${repoName} | Task completed: <${url}|#${id} ${title}>${tokenText}`,
  });
}

export async function notifyTaskFailed(workerName: string, repoName: string, id: number, title: string, url: string): Promise<void> {
  const tokenText = await buildTokenLimitText();
  await send({
    text: `❌ [${workerName}] ${repoName} | Task failed: <${url}|#${id} ${title}>${tokenText}`,
  });
}
