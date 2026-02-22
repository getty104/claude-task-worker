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
    projectedUsage: number;
    status: string;
  };
  endTime: string;
}

async function getActiveBlockInfo(): Promise<ActiveBlockInfo | null> {
  try {
    const { stdout } = await execAsync("ccusage blocks --token-limit max --active --json");
    const data = JSON.parse(stdout);
    const activeBlock = data.blocks?.find((b: { isActive: boolean }) => b.isActive);
    if (!activeBlock?.tokenLimitStatus) return null;
    return { tokenLimitStatus: activeBlock.tokenLimitStatus, endTime: activeBlock.endTime };
  } catch {
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
  return ` | ${emoji} Token: ${status.percentUsed.toFixed(1)}% (${formatTokenCount(status.projectedUsage)} / ${formatTokenCount(status.limit)}) | Ends: ${formatEndTimeJST(endTime)}`;
}

export async function notifyTaskCompleted(workerName: string, id: number, title: string, url: string): Promise<void> {
  const tokenText = await buildTokenLimitText();
  await send({
    text: `✅ [${workerName}] Task completed: <${url}|#${id} ${title}>${tokenText}`,
  });
}

export async function notifyTaskFailed(workerName: string, id: number, title: string, url: string): Promise<void> {
  const tokenText = await buildTokenLimitText();
  await send({
    text: `❌ [${workerName}] Task failed: <${url}|#${id} ${title}>${tokenText}`,
  });
}
