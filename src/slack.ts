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

export async function notifyTaskCompleted(workerName: string, id: number, title: string, url: string): Promise<void> {
  await send({
    text: `✅ [${workerName}] Task completed: <${url}|#${id} ${title}>`,
  });
}

export async function notifyTaskFailed(workerName: string, id: number, title: string, url: string): Promise<void> {
  await send({
    text: `❌ [${workerName}] Task failed: <${url}|#${id} ${title}>`,
  });
}
