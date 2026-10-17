import type * as RunCommandModule from "./run-command";

// codegraph.ts と同じ理由で動的import（node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する）。
async function loadRunCommand(): Promise<typeof RunCommandModule> {
  return (await import("./run-command.ts")) as typeof RunCommandModule;
}

// `install-deps`（システムライブラリの導入）だけに使うパッケージ。`playwright` ではなく `playwright-core` を叩くのは、
// `playwright` の postinstall が chromium / firefox / webkit を無条件に全部落とすため。
export const PLAYWRIGHT_CORE_PACKAGE = "playwright-core";

// ブラウザ本体は MCP サーバー自身の `install-browser` で取得する。@playwright/mcp は playwright-core を
// アルファ版に固定しており、`playwright-core@latest` で落とした chromium とリビジョンがずれると
// MCP が見つけられず起動に失敗する（実測: MCP は v1247 を要求、playwright-core@latest は v1248 を取得）。
// `--no-shell` は headless shell を落とさないため（`--browser chromium` の MCP は通常の chromium を使う）。
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp";
const INSTALL_BROWSER_ARGS = ["-y", `${PLAYWRIGHT_MCP_PACKAGE}@latest`, "install-browser", "--no-shell", "chromium"];

/**
 * `install-deps`（chromium が要求するシステムライブラリの導入）の実行コマンドを組み立てる。
 *
 * root（コンテナなど）では `sudo` を使わない。sudo バイナリ自体が入っていない環境が普通にあり、
 * root なら昇格は不要なため。非 root では `sudo` を前置する（パスワードを求められうる）。
 */
export function buildInstallDepsCommand(uid: number | undefined): { command: string; args: string[] } {
  const npxArgs = ["-y", `${PLAYWRIGHT_CORE_PACKAGE}@latest`, "install-deps", "chromium"];
  return uid === 0 ? { command: "npx", args: npxArgs } : { command: "sudo", args: ["npx", ...npxArgs] };
}

/**
 * Playwright MCP が使うブラウザ（chromium）をインストールする。
 *
 * MCP サーバー本体（`@playwright/mcp`）は `plugin/.mcp.json` が `npx -y ...@latest` で起動するため
 * 事前導入が不要だが、ブラウザバイナリは共有キャッシュ（macOS なら `~/Library/Caches/ms-playwright`）へ
 * 落としておく必要がある。未取得だと MCP ツールの初回呼び出しが実行時に失敗する。
 *
 * Linux ではさらにシステムライブラリ（`install-deps`）が必要なため、続けて実行する。同コマンドは
 * apt 等を叩くので非 root では `sudo` 経由になり、パスワード入力を求められうる。
 *
 * どちらも冪等（取得済み・導入済みならスキップされる）なので install / update で分岐しない。
 *
 * ponytail: chromium のみ。firefox / webkit や `--browser chrome`（ブランドChannel）が要るように
 * なったら browsers 引数を増やす。
 */
export async function installPlaywrightBrowsers(logPrefix: string): Promise<boolean> {
  const { runCommand } = await loadRunCommand();
  console.log(
    `[${logPrefix}] Installing Playwright browsers (npx ${INSTALL_BROWSER_ARGS.join(" ")})...`,
  );
  try {
    await runCommand("npx", INSTALL_BROWSER_ARGS);
    console.log(`[${logPrefix}] Playwright browsers installed.`);
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install Playwright browsers: ${(err as Error).message}`);
    return false;
  }

  // install-deps は Linux 専用（macOS / Windows では何もしない）。
  if (process.platform !== "linux") return true;

  const { command, args } = buildInstallDepsCommand(process.getuid?.());
  console.log(`[${logPrefix}] Installing Playwright browser dependencies (${command} ${args.join(" ")})...`);
  try {
    await runCommand(command, args);
    console.log(`[${logPrefix}] Playwright browser dependencies installed.`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install Playwright browser dependencies: ${(err as Error).message}`);
    console.error(
      `[${logPrefix}] Run \`${command} ${args.join(" ")}\` manually if the Playwright MCP cannot start a browser.`,
    );
    return false;
  }
}
