import { runCommand } from "./run-command.js";

export const AGENT_BROWSER_PACKAGE = "agent-browser";

/**
 * agent-browser CLI をグローバルインストールする。
 *
 * `npx skills add vercel-labs/agent-browser`（上流のスキル配布）はあえて実行しない。
 * ブラウザ操作スキルは本プラグインの `plugin/skills/agent-browser/` が配布しており、
 * 両方入れると同名スキルが二重登録されるため。CLI の導入だけをここで行う。
 */
export async function installAgentBrowserCli(logPrefix: string): Promise<boolean> {
  console.log(`[${logPrefix}] Installing agent-browser CLI (npm install -g ${AGENT_BROWSER_PACKAGE}@latest)...`);
  try {
    await runCommand("npm", ["install", "-g", `${AGENT_BROWSER_PACKAGE}@latest`]);
    console.log(`[${logPrefix}] agent-browser CLI installed.`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install agent-browser CLI: ${(err as Error).message}`);
    return false;
  }
}

/**
 * `agent-browser` コマンドが利用可能かを判定する。
 *
 * `spawn` の `ENOENT` だけを見る方式は使わない。`runCommand()` は Windows では `shell: true` で
 * 起動するため、「コマンドが存在しない」がシェルの非0終了として返り `ENOENT` にならない。
 * `--version` の成否で見ればどのプラットフォームでも同じ判定になる。
 */
export async function isAgentBrowserInstalled(): Promise<boolean> {
  try {
    await runCommand("agent-browser", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * agent-browser CLI を更新する。導入済みなら agent-browser 自身が持つ `agent-browser upgrade` を使う
 * （インストール方法（npm / Homebrew / Cargo）を検出して適切な更新コマンドを走らせてくれるため、
 * `npm install -g` で外から上書きするより確実。CodeGraph と同じ方針）。
 *
 * **未インストールなら upgrade を試さず `installAgentBrowserCli()` で新規インストールする**。
 * `claude-task-worker update` は agent-browser 導入前のマシンでも実行されうるため、ここで
 * 打ち切らずに導入まで済ませる。事前判定を挟むのは、未導入マシンで upgrade を叩くと
 * 「更新に失敗した」という誤解を招くエラーログが必ず出るため（実際は未導入なだけ）。
 *
 * 導入済みなのに upgrade が失敗した場合（ネットワーク障害・壊れたインストール等）も、
 * 復旧手段として `npm install -g` によるインストールへフォールバックする。
 */
export async function upgradeAgentBrowserCli(logPrefix: string): Promise<boolean> {
  if (!(await isAgentBrowserInstalled())) {
    console.log(`[${logPrefix}] agent-browser CLI not found; installing it instead of upgrading.`);
    return installAgentBrowserCli(logPrefix);
  }

  console.log(`[${logPrefix}] Updating agent-browser CLI (agent-browser upgrade)...`);
  try {
    await runCommand("agent-browser", ["upgrade"]);
    console.log(`[${logPrefix}] agent-browser CLI updated.`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] agent-browser upgrade failed (${(err as Error).message}); installing instead...`);
    return installAgentBrowserCli(logPrefix);
  }
}

/**
 * `agent-browser install` でブラウザバイナリ（Chrome）を取得する。
 *
 * CLI の導入とブラウザの取得は別コマンドに分かれており、これを踏まないと
 * 最初のブラウザ操作コマンドが実行時に失敗する。既に取得済みなら何もしないので冪等。
 * CLI 更新後にも呼ぶ（新バージョンが要求する Chrome が未取得のケースを埋める）。
 */
export async function runAgentBrowserInstall(logPrefix: string): Promise<boolean> {
  console.log(`[${logPrefix}] Installing agent-browser browser binaries (agent-browser install)...`);
  try {
    await runCommand("agent-browser", ["install"]);
    console.log(`[${logPrefix}] agent-browser browser binaries ready.`);
    return true;
  } catch (err) {
    console.error(
      `[${logPrefix}] Failed to run agent-browser install (install the CLI with \`claude-task-worker install\`): ${(err as Error).message}`,
    );
    return false;
  }
}
