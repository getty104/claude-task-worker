import type * as RunCommandModule from "./run-command";

// codegraph.ts と同じ理由で動的import（node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する）。
async function loadRunCommand(): Promise<typeof RunCommandModule> {
  return (await import("./run-command.ts")) as typeof RunCommandModule;
}

export const OCR_PACKAGE = "@alibaba-group/open-code-review";
export const OCR_MARKETPLACE_SOURCE = "alibaba/open-code-review";
export const OCR_MARKETPLACE_NAME = "open-code-review";
export const OCR_PLUGIN = "open-code-review@open-code-review";

/**
 * OpenCodeReview（OCR）の CLI と Claude Code プラグインを導入／更新する。
 *
 * `triage-pr` スキルが `/open-code-review:delegate-review`（OCR はファイル選定とルール解決だけを行い、
 * レビュー自体はホストの claude が行う）でPRをレビューするため、CLI（`ocr`）とプラグインの両方が要る。
 * delegate モードは OCR 側で LLM を呼ばないので、`ocr config provider` 等の LLM 設定は不要。
 *
 * CLI は self-upgrade 機構を持たないため install / update とも `npm install -g <pkg>@latest`。
 * プラグインは install ならマーケットプレイス追加 → インストール、update ならマーケットプレイス更新 →
 * プラグイン更新（未導入で更新に失敗した場合はインストールへフォールバック）。
 */
export async function installOpenCodeReview(logPrefix: "install" | "update"): Promise<boolean> {
  const { npmInstallGlobalLatest, runCommand } = await loadRunCommand();
  let ok = true;

  console.log(`[${logPrefix}] Installing OpenCodeReview CLI (npm install -g ${OCR_PACKAGE}@latest)...`);
  try {
    await npmInstallGlobalLatest(OCR_PACKAGE);
    console.log(`[${logPrefix}] OpenCodeReview CLI installed.`);
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install OpenCodeReview CLI: ${(err as Error).message}`);
    ok = false;
  }

  const addAndInstall = async (): Promise<void> => {
    try {
      await runCommand("claude", ["plugin", "marketplace", "add", OCR_MARKETPLACE_SOURCE]);
    } catch (err) {
      console.error(
        `[${logPrefix}] Failed to add marketplace ${OCR_MARKETPLACE_SOURCE} (already added is expected and safe to ignore): ${(err as Error).message}`,
      );
    }
    await runCommand("claude", ["plugin", "install", OCR_PLUGIN]);
  };

  console.log(`[${logPrefix}] ${logPrefix === "install" ? "Installing" : "Updating"} plugin: ${OCR_PLUGIN}...`);
  try {
    if (logPrefix === "install") {
      await addAndInstall();
    } else {
      try {
        await runCommand("claude", ["plugin", "marketplace", "update", OCR_MARKETPLACE_NAME]);
        await runCommand("claude", ["plugin", "update", OCR_PLUGIN]);
      } catch (err) {
        console.error(`[${logPrefix}] Failed to update ${OCR_PLUGIN}, trying install: ${(err as Error).message}`);
        await addAndInstall();
      }
    }
    console.log(`[${logPrefix}] Plugin ${OCR_PLUGIN} ready.`);
  } catch (err) {
    console.error(`[${logPrefix}] Failed to set up plugin ${OCR_PLUGIN}: ${(err as Error).message}`);
    ok = false;
  }
  return ok;
}
