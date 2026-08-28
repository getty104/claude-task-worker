import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const PLUGIN_KEY = "claude-task-worker@claude-task-worker";

interface InstalledPluginEntry {
  scope?: string;
  installPath?: string;
}

// `~/.claude/plugins/installed_plugins.json` の内容から本プラグインの installPath を
// 取り出す純粋関数。ファイル I/O から分離してテスト可能にしてある。
export function resolveInstallPath(installedPluginsJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(installedPluginsJson);
  } catch {
    return undefined;
  }
  const entries = (parsed as { plugins?: Record<string, InstalledPluginEntry[]> } | null)?.plugins?.[PLUGIN_KEY];
  if (!entries || entries.length === 0) return undefined;
  const entry = entries.find((e) => e.scope === "user") ?? entries[0];
  return entry?.installPath || undefined;
}

// npm パッケージ（`dist` のみ同梱、プラグインは同梱しない）から、インストール済み
// プラグインのスクリプトへの絶対パスを解決する。解決できない場合は例外を投げず undefined を返す。
export function resolvePluginScriptPath(fileName: string): string | undefined {
  const installedPluginsPath = path.join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installedPluginsPath)) return undefined;
  let content: string;
  try {
    content = readFileSync(installedPluginsPath, "utf8");
  } catch {
    return undefined;
  }
  const installPath = resolveInstallPath(content);
  if (!installPath) return undefined;
  return path.join(installPath, "scripts", fileName);
}
