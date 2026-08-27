import type * as RunCommandModule from "./run-command";

// codegraph.ts と同じ理由で動的import（node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する）。
async function loadRunCommand(): Promise<typeof RunCommandModule> {
  return (await import("./run-command.ts")) as typeof RunCommandModule;
}

export const PEN_PACKAGE = "@pen.dev/cli";
// 0.3.x で `@pen.dev/cli` へ改称される前の旧パッケージ。bin 名 `pencil` が新パッケージと衝突する。
export const LEGACY_PEN_PACKAGE = "@pencil.dev/cli";

/**
 * Pen CLI（`@pen.dev/cli`）をグローバルインストール／更新する。
 *
 * DESIGN.md CLI と同じく self-upgrade 機構を持たないため、install も update も
 * `npm install -g <pkg>@latest` の同じ手段になる（冪等なので install/update で分岐しない）。
 *
 * 新パッケージの前に旧 `@pencil.dev/cli` を必ずアンインストールする。両者は同じ bin 名
 * `pencil` を提供するため同居させると解決先が不定になり、旧 0.2.x を掴んだ環境では
 * ツール構成が違う（`batch_design` 等の廃止済みツール）ため `edit-pencil-design` /
 * `inspect-pencil-node` / `resolve-pencil-conflict` の各スキルが動かない。削除 → 導入の順に
 * することで `pencil` が確実に新パッケージへリンクされる。
 */
export async function installPenCli(logPrefix: string): Promise<boolean> {
  console.log(`[${logPrefix}] Removing legacy Pen CLI (npm uninstall -g ${LEGACY_PEN_PACKAGE})...`);
  const { runCommand, npmInstallGlobalLatest } = await loadRunCommand();
  try {
    await runCommand("npm", ["uninstall", "-g", LEGACY_PEN_PACKAGE]);
  } catch (err) {
    // 未インストールなら失敗しうるが、その場合は削除の目的が既に達成されているので続行する。
    console.error(`[${logPrefix}] Skipped removing legacy Pen CLI: ${(err as Error).message}`);
  }

  console.log(`[${logPrefix}] Installing Pen CLI (npm install -g ${PEN_PACKAGE}@latest)...`);
  try {
    await npmInstallGlobalLatest(PEN_PACKAGE);
    console.log(`[${logPrefix}] Pen CLI installed.`);
  } catch (err) {
    console.error(`[${logPrefix}] Failed to install Pen CLI: ${(err as Error).message}`);
    return false;
  }

  await warnIfPenLoggedOut(logPrefix);
  return true;
}

/**
 * Pen CLI が未ログインならログイン手順を案内する。
 *
 * `pencil status` は未認証のとき終了コード 1 を返す（認証済みなら 0）。ログインしていないと
 * `.pen` を扱うスキルが実行時に失敗するため、install / update の時点で気づけるようにする。
 * 案内するだけで、ログイン自体は対話が必要なのでユーザーに委ねる（失敗扱いにもしない）。
 */
async function warnIfPenLoggedOut(logPrefix: string): Promise<void> {
  const { runCommand } = await loadRunCommand();
  try {
    await runCommand("pencil", ["status"]);
  } catch {
    console.log(
      `[${logPrefix}] Pen CLI is not authenticated. Run \`pencil login\` (or set PEN_CLI_KEY) before using .pen designs.`,
    );
  }
}
