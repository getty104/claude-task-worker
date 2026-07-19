import { installCodegraphCli } from "./codegraph.js";
import { runCommand } from "./run-command.js";

const PLUGIN_NAME = "claude-task-worker";
const MARKETPLACE_NAME = "claude-task-worker";

async function updateMarketplace(): Promise<boolean> {
  console.log(`[update] Updating marketplace: ${MARKETPLACE_NAME}...`);
  try {
    await runCommand("claude", ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
    console.log("[update] Marketplace updated.");
    return true;
  } catch (err) {
    console.error(`[update] Failed to update marketplace: ${(err as Error).message}`);
    return false;
  }
}

async function updatePlugin(): Promise<boolean> {
  console.log(`[update] Updating plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}...`);
  try {
    await runCommand("claude", ["plugin", "update", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    console.log("[update] Plugin updated. Restart your Claude Code session to apply the update.");
    return true;
  } catch (err) {
    console.error(`[update] Failed to update plugin: ${(err as Error).message}`);
    return false;
  }
}

async function updateCli(): Promise<boolean> {
  console.log("[update] Updating claude-task-worker CLI (npm install -g claude-task-worker@latest)...");
  try {
    await runCommand("npm", ["install", "-g", "claude-task-worker@latest"]);
    console.log("[update] claude-task-worker CLI updated.");
    return true;
  } catch (err) {
    console.error(`[update] Failed to update claude-task-worker CLI: ${(err as Error).message}`);
    return false;
  }
}

export async function update(): Promise<void> {
  console.log("[update] Starting update...");
  const marketplaceOk = await updateMarketplace();
  const pluginOk = await updatePlugin();
  const cliOk = await updateCli();
  const codegraphOk = await installCodegraphCli("update", "update");
  if (!marketplaceOk || !pluginOk || !cliOk || !codegraphOk) {
    process.exitCode = 1;
  }
  console.log("[update] Done.");
}
