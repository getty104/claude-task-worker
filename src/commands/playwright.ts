import type * as RunCommandModule from "./run-command";

// codegraph.ts と同じ理由で動的import（node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する）。
async function loadRunCommand(): Promise<typeof RunCommandModule> {
  return (await import("./run-command.ts")) as typeof RunCommandModule;
}

// ブラウザのダウンロードだけに使うパッケージ。`playwright` ではなく `playwright-core` を叩くのは、
// `playwright` の postinstall が chromium / firefox / webkit を無条件に全部落とすため（必要なのは chromium だけ）。
// `npm install -g` せず npx で呼ぶのは、CLI 自体を常駐させる必要がなく、MCP サーバー本体
// （`npx -y @playwright/mcp@latest`）と同じくその都度 npx で解決される側だから。
export const PLAYWRIGHT_CORE_PACKAGE = "playwright-core";

/**
 * Playwright MCP が使うブラウザ（chromium）をインストールする。
 *
 * MCP サーバー本体（`@playwright/mcp`）は `plugin/.mcp.json` が `npx -y ...@latest` で起動するため
 * 事前導入が不要だが、ブラウザバイナリは共有キャッシュ（macOS なら `~/Library/Caches/ms-playwright`）へ
 * 落としておく必要がある。未取得だと MCP ツールの初回呼び出しが実行時に失敗する。
 *
 * ダウンロードは冪等（取得済みならスキップされる）なので install / update で分岐しない。
 *
 * ponytail: chromium のみ。firefox / webkit や `--browser chrome`（ブランドChannel。Linux では
 * sudo が必要）が要るようになったら browsers 引数を増やす。
 */
export async function installPlaywrightBrowsers(logPrefix: string): Promise<boolean> {
  console.log(`[${logPrefix}] Installing Playwright browsers (npx ${PLAYWRIGHT_CORE_PACKAGE}@latest install chromium)...`);
  try {
    const { runCommand } = await loadRunCommand();
    await runCommand("npx", ["-y", `${PLAYWRIGHT_CORE_PACKAGE}@latest`, "install", "chromium"]);
    console.log(`[${logPrefix}] Playwright browsers installed.`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install Playwright browsers: ${(err as Error).message}`);
    return false;
  }
}
