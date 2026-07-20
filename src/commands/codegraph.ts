import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type * as RunCommandModule from "./run-command";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする（herdr-runner.ts と同様）。
// 純粋関数（appendIgnoreEntry など）だけをテストから読めるようにするため、静的importにはしない。
async function loadRunCommand(): Promise<typeof RunCommandModule> {
  return (await import("./run-command.ts")) as typeof RunCommandModule;
}

export const CODEGRAPH_PACKAGE = "@colbymchenry/codegraph";
export const CODEGRAPH_IGNORE_ENTRY = ".codegraph/";

/**
 * グローバル gitignore（`~/.config/git/ignore`）のパス。
 * `XDG_CONFIG_HOME` が設定されていればその配下を優先する（git 自身と同じ解決順）。
 */
export function globalGitIgnorePath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const xdg = env.XDG_CONFIG_HOME?.trim();
  const base = xdg ? xdg : join(home, ".config");
  return join(base, "git", "ignore");
}

/**
 * gitignore の既存内容に entry を追記した結果を返す。既に登録済みなら `null`（＝書き込み不要）。
 *
 * 判定は行単位の完全一致で、`.codegraph/` と `.codegraph`（末尾スラッシュ無し）の両方を登録済みとみなす。
 * `!.codegraph/` のような否定パターンは別物なので登録済み扱いにしない（無視されない設定を意図しているため）。
 */
export function appendIgnoreEntry(current: string, entry: string): string | null {
  const bare = entry.replace(/\/$/, "");
  const alreadyListed = current
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line === entry || line === bare);
  if (alreadyListed) return null;

  if (current === "") return `${entry}\n`;
  return current.endsWith("\n") ? `${current}${entry}\n` : `${current}\n${entry}\n`;
}

/**
 * CodeGraph CLI をグローバルインストール（更新も同じコマンドで賄う）。
 *
 * `codegraph install`（エージェント設定の書き込み）はあえて実行しない。MCP サーバーの登録は
 * プラグインの `.mcp.json` が担っており、両方走らせると同じサーバーが二重登録されるため。
 */
export async function installCodegraphCli(logPrefix: string, mode: "install" | "update"): Promise<boolean> {
  const progressive = mode === "install" ? "Installing" : "Updating";
  const past = mode === "install" ? "installed" : "updated";
  console.log(`[${logPrefix}] ${progressive} CodeGraph CLI (npm install -g ${CODEGRAPH_PACKAGE}@latest)...`);
  try {
    const { runCommand } = await loadRunCommand();
    await runCommand("npm", ["install", "-g", `${CODEGRAPH_PACKAGE}@latest`]);
    console.log(`[${logPrefix}] CodeGraph CLI ${past}.`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] Failed to ${mode} CodeGraph CLI: ${(err as Error).message}`);
    return false;
  }
}

/** カレントリポジトリで `codegraph init` を実行し、`.codegraph/` インデックスを構築する。 */
export async function runCodegraphInit(logPrefix: string): Promise<boolean> {
  console.log(`[${logPrefix}] Initializing CodeGraph index (codegraph init)...`);
  try {
    const { runCommand } = await loadRunCommand();
    await runCommand("codegraph", ["init"]);
    console.log(`[${logPrefix}] CodeGraph index initialized.`);
    return true;
  } catch (err) {
    console.error(
      `[${logPrefix}] Failed to run codegraph init (install it with \`claude-task-worker install\`): ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * グローバル gitignore に `.codegraph/` を登録する。
 *
 * `.codegraph/` はプロジェクトごとのローカルインデックス（SQLite）でコミット対象ではないが、
 * 各リポジトリの `.gitignore` を汚さずに済ませたいのでユーザーグローバル側に入れる。
 */
export async function ensureCodegraphGitIgnore(logPrefix: string): Promise<boolean> {
  const path = globalGitIgnorePath();
  try {
    let current = "";
    try {
      current = await readFile(path, "utf-8");
    } catch {
      // 未作成なら空から作る
    }

    const next = appendIgnoreEntry(current, CODEGRAPH_IGNORE_ENTRY);
    if (next === null) {
      console.log(`[${logPrefix}] Already ignored: ${CODEGRAPH_IGNORE_ENTRY} (${path})`);
      return true;
    }

    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, next, "utf-8");
    console.log(`[${logPrefix}] Added ${CODEGRAPH_IGNORE_ENTRY} to ${path}`);
    return true;
  } catch (err) {
    console.error(`[${logPrefix}] Failed to update ${path}: ${(err as Error).message}`);
    return false;
  }
}
