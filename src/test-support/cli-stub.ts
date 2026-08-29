import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// test/stubs/*.mjs は src/**/*.test.ts の npm test glob に掛からないよう、
// リポジトリの test/ 配下に置いてある。ここから見た絶対パスを import.meta.url から解決する
// （テスト実行時の cwd に依存させないため）。
const STUBS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "stubs");

export interface GhScenario {
  /** `gh api user --jq .login` の応答（生文字列） */
  login?: string;
  /** `gh repo view --json owner,name,defaultBranchRef` の応答 */
  repo?: { owner: string; name: string; defaultBranch: string };
  /** `gh issue list ...` の応答（Issue[] 相当） */
  issues?: unknown[];
  /**
   * `gh issue view <n> --json <fields>` / `gh pr view <n> --json <fields>` の応答。
   * キーは Issue/PR 番号の文字列。値は返したいフィールドをまとめたオブジェクト
   * （要求フィールドで絞り込まず、そのまま JSON として返してよい）。未登録番号は {} を返す。
   */
  view?: Record<string, Record<string, unknown>>;
  /** `gh pr list ...` の応答 */
  prList?: unknown[];
  /** `gh api graphql`（listPrsClosingIssue）が返す closedByPullRequestsReferences.nodes */
  closingPrs?: unknown[];
}

export interface CliStubOptions {
  claude?: {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    authStatus?: unknown;
    /**
     * クラウドセッション作成コマンドの送出時に、appendCloudDoneInstruction() の指示
     * （報告コメント投稿 → cc-cloud-done 付与）を gh スタブの状態ファイルへ模倣書き込み
     * させる。1コマンド方式では claude バイナリが直接起動されないため、検知は herdr
     * スタブの `pane send-text`（`--cloud` を含む送出テキスト）側で行う。
     */
    cloudComplete?: { type: "issue" | "pr"; number: number; report?: string };
  };
  herdr?: {
    agentStatuses?: string[];
    paneOutput?: string;
  };
  gh?: GhScenario;
}

export interface StubRecord {
  command: "claude" | "herdr" | "gh";
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
  writeWrapper(join(dir, "gh"), join(STUBS_DIR, "gh-stub.mjs"));

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
  setEnv(
    "CTW_STUB_CLAUDE_AUTH_STATUS",
    options?.claude?.authStatus === undefined ? undefined : JSON.stringify(options.claude.authStatus),
  );
  setEnv(
    "CTW_STUB_CLAUDE_CLOUD_COMPLETE",
    options?.claude?.cloudComplete === undefined ? undefined : JSON.stringify(options.claude.cloudComplete),
  );
  setEnv("CTW_STUB_GH_SCENARIO", options?.gh === undefined ? undefined : JSON.stringify(options.gh));

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
