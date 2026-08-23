import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOOK_FILE = "pen-baseuri-fix.mjs";

// NODE_OPTIONS は空白区切りで、値の中の空白をエスケープする手段が無い。
// file:// URL は空白を %20 へエンコードするため、パスに空白を含む環境でも安全に渡せる。
export function buildPencilNodeOptions(existing: string | undefined, hookUrl: string): string {
  return [`--import ${hookUrl}`, existing?.trim()].filter(Boolean).join(" ");
}

export function pencil(args: string[]): void {
  const hookPath = join(dirname(fileURLToPath(import.meta.url)), HOOK_FILE);
  const child = spawn("pencil", args, {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_OPTIONS: buildPencilNodeOptions(process.env.NODE_OPTIONS, pathToFileURL(hookPath).href),
    },
  });
  child.on("error", (err) => {
    console.error(`[pencil] Failed to run pencil: ${err.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : (code ?? 1));
  });
}
