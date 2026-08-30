import { mkdir, writeFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// クラウドセッションの既定権限モード。
//
// クラウド実行（`--cloud`）では `--permission-mode` は**受理されるが VM 側に反映されない**
// （`--disallowedTools` / `--append-system-prompt-file` と同じ。Issue #307）。加えて
// bypassPermissions はクラウドのモード一覧に無く、既定の acceptEdits（「編集を受け入れる」）へ
// 落ちる。ローカル実行（default / herdr）はワーカーが `--permission-mode` フラグを渡し、
// フラグが settings に勝つため、ここでの設定はクラウドにしか効かない。
export const CLOUD_DEFAULT_PERMISSION_MODE = "auto";

// 同ファイルへ書き出すトップレベル設定。タスクセッションは応答するユーザーが常駐しない
// 自律実行なので、確認を挟まず進む Proactive を既定にする。language は成果物
// （Issueコメント・PR本文・最終報告）の言語を揃えるため。
export const CLOUD_SETTINGS_DEFAULTS = {
  outputStyle: "Proactive",
  language: "Japanese",
} as const;

// 書き込み先はユーザースコープの settings ファイル（クラウド VM 上の `~/.claude/settings.json`）。
//
// リポジトリの `.claude/settings.json` ではなくこちらへ書くのは、対象リポジトリに
// claude-task-worker 都合の設定ファイルを生成したくないため。ユーザースコープの設定は
// 「そのマシンに閉じる」ので、クラウド VM 上で書けばそのVMのセッションにだけ効く
// （ローカル開発機の `~/.claude/settings.json` は無関係のまま）。
//
// クラウド環境のセットアップスクリプトは root で走り、その書き込みは環境キャッシュ
// （ファイルシステムのスナップショット）に残るため、以降のセッションでも効き続ける。
// CLAUDE_CONFIG_DIR が設定されている場合は claude 本体がそちらを見るので合わせる。
export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  return join(dir && dir.length > 0 ? dir : join(homedir(), ".claude"), "settings.json");
}

// settings ファイルへ `permissions.defaultMode` と CLOUD_SETTINGS_DEFAULTS を差し込んだ
// 内容を返す。変更不要（すべて指定済みで force なし）なら null。
//
// 既存ファイルを丸ごと上書きしないのは、書き込み先に hooks・enabledPlugins・
// permissions.allow など無関係な設定が同居しうるため（セットアップスクリプトは
// 環境キャッシュの再構築で何度も走るので、実行のたびに他の設定を消してはいけない）。
// JSON として読めない・`permissions` がオブジェクトでない場合は書き換えずに投げ、
// 呼び出し側がスキップして人へ委ねる。
export function withCloudDefaults(existing: string | null, force: boolean): string | null {
  const parsed: unknown = existing === null ? {} : JSON.parse(existing);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  const settings = { ...(parsed as Record<string, unknown>) };
  const current = settings["permissions"] ?? {};
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("`permissions` is not an object");
  }
  const permissions = { ...(current as Record<string, unknown>) };
  let changed = false;
  // 既に指定がある場合は人の選択を尊重して触らない（--force のときだけ上書きする）。
  const set = (target: Record<string, unknown>, key: string, value: string): void => {
    if (key in target && !force) return;
    if (target[key] === value) return;
    target[key] = value;
    changed = true;
  };
  set(permissions, "defaultMode", CLOUD_DEFAULT_PERMISSION_MODE);
  for (const [key, value] of Object.entries(CLOUD_SETTINGS_DEFAULTS)) set(settings, key, value);
  if (!changed) return null;
  return `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`;
}

async function writeClaudeSettings(force: boolean): Promise<void> {
  const path = claudeSettingsPath();
  let existing: string | null;
  try {
    existing = await readFile(path, "utf-8");
  } catch {
    existing = null;
  }
  let next: string | null;
  try {
    next = withCloudDefaults(existing, force);
  } catch (e) {
    console.log(`[cloud-setup] Skipped: ${path} (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (next === null) {
    console.log(`[cloud-setup] Already set: ${path}`);
    return;
  }
  try {
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, next, "utf-8");
  } catch (e) {
    console.log(`[cloud-setup] Failed to write ${path}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  console.log(`[cloud-setup] ${existing === null ? "Created" : "Updated"}: ${path}`);
}

// クラウド環境（Claude Code on the web）のセットアップスクリプトから呼ぶ想定のコマンド。
// VM 側でしか意味を持たない準備をここへ集約する（現状は settings ファイルの書き込みのみ）。
//
// セットアップスクリプトは非0終了でセッションの起動ごと失敗するため、個々のステップは
// 例外を投げずログのみで終える（このコマンドは常に正常終了する）。環境キャッシュの再構築で
// 何度も走るので、各ステップは冪等であること。
export async function cloudSetup(options: { force?: boolean } = {}): Promise<void> {
  await writeClaudeSettings(options.force ?? false);
  console.log("[cloud-setup] Done.");
}
