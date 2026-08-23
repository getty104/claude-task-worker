import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { styleText } from "node:util";

const REGISTRY_URL = "https://registry.npmjs.org/claude-task-worker/latest";
const FETCH_TIMEOUT_MS = 3000;

export function localVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return pkg.version ?? "unknown";
}

// npm の dist-tag latest がローカルより新しいかを判定する。
// 単純な文字列比較にしないのは、publish 前のローカルビルド（package.json が npm より先行する）で
// 毎回「新しいバージョンがある」と誤通知しないため。数値化できない値は通知しない側へ倒す。
export function isOutdated(current: string, latest: string): boolean {
  const parse = (v: string) => v.split("-")[0].split(".").map(Number);
  const a = parse(current);
  const b = parse(latest);
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x !== y) return y > x;
  }
  return false;
}

// 最新版があればその旨と update コマンドを案内する。
// ネットワーク不通・レジストリ障害でコマンド実行を妨げないよう、失敗は全て黙って無視する。
export async function notifyIfOutdated(): Promise<void> {
  try {
    const current = localVersion();
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return;
    const { version: latest } = (await res.json()) as { version?: string };
    if (!latest || !isOutdated(current, latest)) return;
    // styleText は NO_COLOR / 非TTY を自動で判定して色を落とすため、自前の判定は持たない
    console.log(
      styleText("yellow", "[update] A new version of claude-task-worker is available: ") +
        styleText("dim", current) +
        styleText("yellow", " -> ") +
        styleText(["green", "bold"], latest) +
        styleText("yellow", ". Run ") +
        styleText("cyan", '"claude-task-worker update"') +
        styleText("yellow", " to update."),
    );
  } catch {
    // オフライン・レジストリ障害時は通知しない
  }
}

export function version(): void {
  try {
    console.log(localVersion());
  } catch (err) {
    console.error(`[version] Failed to read version: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
