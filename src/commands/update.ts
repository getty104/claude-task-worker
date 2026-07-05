import { spawn } from "node:child_process";

const PLUGIN_NAME = "claude-task-worker";
const MARKETPLACE_NAME = "claude-task-worker";

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", (err) => {
      reject(err);
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}

async function updateMarketplace(): Promise<void> {
  console.log(`[update] Updating marketplace: ${MARKETPLACE_NAME}...`);
  try {
    await runCommand("claude", ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
    console.log("[update] Marketplace updated.");
  } catch (err) {
    console.error(`[update] Failed to update marketplace: ${(err as Error).message}`);
  }
}

async function updatePlugin(): Promise<void> {
  console.log(`[update] Updating plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}...`);
  try {
    await runCommand("claude", ["plugin", "update", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    console.log("[update] Plugin updated. Restart your Claude Code session to apply the update.");
  } catch (err) {
    console.error(`[update] Failed to update plugin: ${(err as Error).message}`);
  }
}

async function updateCli(): Promise<void> {
  console.log("[update] Updating claude-task-worker CLI (npm install -g claude-task-worker@latest)...");
  try {
    await runCommand("npm", ["install", "-g", "claude-task-worker@latest"]);
    console.log("[update] claude-task-worker CLI updated.");
  } catch (err) {
    console.error(`[update] Failed to update claude-task-worker CLI: ${(err as Error).message}`);
  }
}

export async function update(): Promise<void> {
  console.log("[update] Starting update...");
  await updateMarketplace();
  await updatePlugin();
  await updateCli();
  console.log("[update] Done.");
}
