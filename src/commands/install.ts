import { spawn } from "node:child_process";

const PLUGIN_NAME = "claude-task-worker";
const MARKETPLACE_NAME = "claude-task-worker";
const MARKETPLACE_SOURCE = "getty104/claude-task-worker";

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

async function installPlugin(): Promise<void> {
  console.log(`[install] Installing plugin: ${PLUGIN_NAME}@${MARKETPLACE_NAME}...`);
  try {
    await runCommand("claude", ["plugin", "install", `${PLUGIN_NAME}@${MARKETPLACE_NAME}`]);
    console.log("[install] Plugin installed. Restart your Claude Code session to apply.");
  } catch (err) {
    console.error(`[install] Failed to install plugin: ${(err as Error).message}`);
  }
}

async function installCli(): Promise<void> {
  console.log("[install] Installing claude-task-worker CLI (npm install -g claude-task-worker@latest)...");
  try {
    await runCommand("npm", ["install", "-g", "claude-task-worker@latest"]);
    console.log("[install] claude-task-worker CLI installed.");
  } catch (err) {
    console.error(`[install] Failed to install claude-task-worker CLI: ${(err as Error).message}`);
  }
}

export async function install(): Promise<void> {
  console.log("[install] Starting install...");
  await addMarketplace();
  await installPlugin();
  await installCli();
  console.log("[install] Done.");
}
