import { CODEGRAPH_PACKAGE, installCodegraphCli } from "./codegraph.js";
import { DESIGN_MD_PACKAGE, installDesignMdCli } from "./design-md";
import { PEN_PACKAGE, installPenCli } from "./pen";
import { npmInstallGlobalLatest, runCommand } from "./run-command.js";

export const PLUGIN_NAME = "claude-task-worker";
export const MARKETPLACE_NAME = "claude-task-worker";
export const MARKETPLACE_SOURCE = "getty104/claude-task-worker";

/** `npm install -g` で入れるパッケージ一覧（インストール後にバージョンを表示する対象）。 */
export const GLOBAL_NPM_PACKAGES = [PLUGIN_NAME, CODEGRAPH_PACKAGE, DESIGN_MD_PACKAGE, PEN_PACKAGE];

/**
 * `npm install -g` したパッケージのバージョンを表示する。
 *
 * npm は `changed N packages` としか出さず、どのパッケージがどのバージョンになったかを
 * 一切表示しない（`claude plugin update` / `codegraph upgrade` は自前で出す）。
 * install / update の結果を目視確認できるよう、最後に一括で列挙する。
 */
export async function printGlobalPackageVersions(logPrefix: string): Promise<void> {
  console.log(`[${logPrefix}] Installed versions:`);
  try {
    await runCommand("npm", ["ls", "-g", "--depth=0", ...GLOBAL_NPM_PACKAGES]);
  } catch (err) {
    // 未インストールのパッケージがあると npm ls は非0で終わるが、一覧自体は出力済みなので続行する。
    console.error(`[${logPrefix}] Some packages are missing from the global install: ${(err as Error).message}`);
  }
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
    await npmInstallGlobalLatest(PLUGIN_NAME);
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
  const codegraphOk = await installCodegraphCli("install");
  const designMdOk = await installDesignMdCli("install");
  const penOk = await installPenCli("install");
  await printGlobalPackageVersions("install");
  if (!pluginOk || !cliOk || !codegraphOk || !designMdOk || !penOk) {
    process.exitCode = 1;
  }
  console.log("[install] Done.");
}
