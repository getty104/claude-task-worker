import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const WEBHOOK_URL = process.env.CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL;

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

interface ActiveBlockInfo {
  tokenLimitStatus: {
    percentUsed: number;
    limit: number;
    currentUsage: number;
    status: string;
  };
  endTime: string;
}

async function getActiveBlockInfo(): Promise<ActiveBlockInfo | null> {
  try {
    const { stdout } = await execAsync("ccusage blocks --token-limit max --active");

    const timeRemainingMatch = stdout.match(/Time Remaining:\s+(\d+)h\s+(\d+)m/);
    if (!timeRemainingMatch) {
      console.error("[slack] Failed to parse Time Remaining from ccusage output");
      return null;
    }
    const endDate = new Date(Date.now() + (parseInt(timeRemainingMatch[1]) * 60 + parseInt(timeRemainingMatch[2])) * 60 * 1000);

    const currentUsageMatch = stdout.match(/Current Usage:\s+([\d,]+)\s+\(([\d.]+)%\)/);
    if (!currentUsageMatch) {
      console.error("[slack] Failed to parse Current Usage from ccusage output");
      return null;
    }

    const limitMatch = stdout.match(/Limit:\s+([\d,]+)\s+tokens/);
    if (!limitMatch) {
      console.error("[slack] Failed to parse Limit from ccusage output");
      return null;
    }

    const projectedStatusMatch = stdout.match(/Projected Usage:\s+[\d.]+%\s+(\w+)/);
    const statusWord = projectedStatusMatch?.[1]?.toLowerCase() ?? "ok";
    const status = statusWord === "warning" ? "warning" : statusWord === "critical" || statusWord === "error" ? "error" : "ok";

    return {
      tokenLimitStatus: {
        percentUsed: parseFloat(currentUsageMatch[2]) * 2.5,
        limit: parseInt(limitMatch[1].replace(/,/g, "")),
        currentUsage: parseInt(currentUsageMatch[1].replace(/,/g, "")),
        status,
      },
      endTime: endDate.toISOString(),
    };
  } catch (err) {
    console.error(`[slack] Failed to get active block info: ${err}`);
    return null;
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

function formatEndTimeJST(endTime: string): string {
  const date = new Date(endTime);
  return date.toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }) + " JST";
}

async function buildTokenLimitText(): Promise<string> {
  const info = await getActiveBlockInfo();
  if (!info) return "";

  const { tokenLimitStatus: status, endTime } = info;
  const emoji = status.status === "ok" ? "🟢" : status.status === "warning" ? "🟡" : "🔴";
  return ` | ${emoji} Token: ${status.percentUsed.toFixed(1)}% (${formatTokenCount(status.currentUsage)} / ${formatTokenCount(status.limit)}) | Ends: ${formatEndTimeJST(endTime)}`;
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
