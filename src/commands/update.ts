import { upgradeCodegraphCli } from "./codegraph.js";
import { printGlobalPackageVersions } from "./install";
import { installDesignMdCli } from "./design-md";
import { installPenCli } from "./pen";
import { installPlaywrightBrowsers } from "./playwright";
import { npmInstallGlobalLatest, runCommand } from "./run-command.js";

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
    await npmInstallGlobalLatest(PLUGIN_NAME);
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
  const codegraphOk = await upgradeCodegraphCli("update");
  // DESIGN.md CLI は self-upgrade 機構を持たないため、更新もインストールと同じ npm install -g @latest。
  const designMdOk = await installDesignMdCli("update");
  // Pen CLI も self-upgrade 機構を持たないため、更新はインストールと同じ関数（旧パッケージ削除込み）。
  const penOk = await installPenCli("update");
  // Playwright のブラウザ取得も冪等（取得済みならスキップ）なので install と同じ関数を呼ぶ。
  const playwrightOk = await installPlaywrightBrowsers("update");
  await printGlobalPackageVersions("update");
  if (!marketplaceOk || !pluginOk || !cliOk || !codegraphOk || !designMdOk || !penOk || !playwrightOk) {
    process.exitCode = 1;
  }
  console.log("[update] Done.");
}
