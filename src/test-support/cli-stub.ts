import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// test/stubs/*.mjs は src/**/*.test.ts の npm test glob に掛からないよう、
// リポジトリの test/ 配下に置いてある。ここから見た絶対パスを import.meta.url から解決する
// （テスト実行時の cwd に依存させないため）。
const STUBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "stubs");

export interface CliStubOptions {
  claude?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };
  herdr?: {
    agentStatuses?: string[];
    paneOutput?: string;
  };
}

export interface StubRecord {
  command: "claude" | "herdr";
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface InstalledCliStubs {
  dir: string;
  recordFile: string;
  records(): StubRecord[];
  cleanup(): void;
}

// 拡張子なしの実行可能ファイルを直接 node に食わせると、リポジトリ外の一時ディレクトリでは
// package.json の "type":"module" が効かず CJS 判定になってしまう。シェルラッパー経由で
// node へ .mjs を明示的に渡すことで、常に ESM として実行されるようにする。
function writeWrapper(path: string, stubScriptPath: string): void {
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${stubScriptPath}" "$@"\n`);
  chmodSync(path, 0o755);
}

// `process.env` の1エントリを差し替えつつ、元の値（未設定なら undefined）を返す。
function swapEnv(key: string, value: string | undefined): string | undefined {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return previous;
}

// `claude` / `herdr` をテスト用スタブへ差し替える。PATH の先頭にスタブ用ディレクトリを
// 挿すだけで、コマンド名で起動される両バイナリ（src/claude-args.ts の CLAUDE_COMMAND /
// src/herdr.ts の execFile("herdr", ...)）を実バイナリなしで検証できる。
export function installCliStubs(options?: CliStubOptions): InstalledCliStubs {
  const dir = mkdtempSync(join(tmpdir(), "ctw-cli-stub-"));
  const recordFile = join(dir, "records.jsonl");

  writeWrapper(join(dir, "claude"), join(STUBS_DIR, "claude-stub.mjs"));
  writeWrapper(join(dir, "herdr"), join(STUBS_DIR, "herdr-stub.mjs"));

  const previousEnv = new Map<string, string | undefined>();
  const setEnv = (key: string, value: string | undefined): void => {
    previousEnv.set(key, swapEnv(key, value));
  };

  const previousPath = process.env.PATH ?? "";
  process.env.PATH = `${dir}:${previousPath}`;

  setEnv("CTW_STUB_RECORD_FILE", recordFile);
  setEnv("CTW_STUB_CLAUDE_STDOUT", options?.claude?.stdout);
  setEnv("CTW_STUB_CLAUDE_STDERR", options?.claude?.stderr);
  setEnv(
    "CTW_STUB_CLAUDE_EXIT_CODE",
    options?.claude?.exitCode === undefined ? undefined : String(options.claude.exitCode),
  );
  setEnv("CTW_STUB_HERDR_AGENT_STATUSES", options?.herdr?.agentStatuses?.join(","));
  setEnv("CTW_STUB_HERDR_PANE_OUTPUT", options?.herdr?.paneOutput);

  return {
    dir,
    recordFile,
    records(): StubRecord[] {
      let content: string;
      try {
        content = readFileSync(recordFile, "utf8");
      } catch {
        return [];
      }
      return content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as StubRecord);
    },
    cleanup(): void {
      process.env.PATH = previousPath;
      for (const [key, value] of previousEnv) swapEnv(key, value);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
