import { runCommand } from "./run-command.js";

const PLUGIN_NAME = "claude-task-worker";
const MARKETPLACE_NAME = "claude-task-worker";
const MARKETPLACE_SOURCE = "getty104/claude-task-worker";

async function addMarketplace(): Promise<void> {
  console.log(`[install] Adding marketplace: ${MARKETPLACE_SOURCE}...`);
  try {
    await runCommand("claude", ["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
    console.log("[install] Marketplace added.");
  } catch (err) {
    console.error(
      `[install] Failed to add marketplace (already added is expected and safe to ignore): ${(err as Error).message}`,
    );
  }
}

async function installPlugin(): Promise<boolean> {
  console.log(`[install] Installing plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}...`);
  try {
    await runCommand("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    console.log("[install] Plugin installed. Restart your Claude Code session to apply.");
    return true;
  } catch (err) {
    console.error(`[install] Failed to install plugin: ${(err as Error).message}`);
    return false;
  }
}

async function installCli(): Promise<boolean> {
  console.log("[install] Installing claude-task-worker CLI (npm install -g claude-task-worker@latest)...");
  try {
    await runCommand("npm", ["install", "-g", "claude-task-worker@latest"]);
    console.log("[install] claude-task-worker CLI installed.");
    return true;
  } catch (err) {
    console.error(`[install] Failed to install claude-task-worker CLI: ${(err as Error).message}`);
    return false;
  }
}

export async function install(): Promise<void> {
  console.log("[install] Starting install...");
  await addMarketplace();
  const pluginOk = await installPlugin();
  const cliOk = await installCli();
  if (!pluginOk || !cliOk) {
    process.exitCode = 1;
  }
  console.log("[install] Done.");
}
