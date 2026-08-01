import type * as RunCommandModule from "./run-command";

// codegraph.ts と同じ理由で動的import（node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する）。
async function loadRunCommand(): Promise<typeof RunCommandModule> {
  return (await import("./run-command.ts")) as typeof RunCommandModule;
}

export const DESIGN_MD_PACKAGE = "@google/design.md";

/**
 * DESIGN.md CLI（`@google/design.md`）をグローバルインストール／更新する。
 *
 * CodeGraph と違い自前の self-upgrade 機構を持たないため、install も update も
 * `npm install -g <pkg>@latest` の同じ手段になる（冪等なので install/update で分岐しない）。
 *
 * 提供される bin は `design.md` と `designmd` の2つ。`.` を含む前者は Windows PowerShell の
 * 拡張子関連付けと衝突するため、スキル側は `designmd` を既定で使う。
 */
export async function installDesignMdCli(logPrefix: string): Promise<boolean> {
  console.log(`[${logPrefix}] Installing DESIGN.md CLI (npm install -g ${DESIGN_MD_PACKAGE}@latest)...`);
  try {
    const { runCommand } = await loadRunCommand();
    await runCommand("npm", ["install", "-g", `${DESIGN_MD_PACKAGE}@latest`]);
    console.log(`[${logPrefix}] DESIGN.md CLI installed.`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install DESIGN.md CLI: ${(err as Error).message}`);
    return false;
  }
}
