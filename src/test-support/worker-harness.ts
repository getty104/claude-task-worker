import type { ChildProcessByStdio } from "node:child_process";
import { execFile, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { StubRecord } from "./cli-stub";

const execFileAsync = promisify(execFile);

// リポジトリルート（src/test-support/ の2つ上）。src/index.ts / scripts/test-resolver.mjs の
// 絶対パス解決に使う（テスト実行時の cwd に依存させないため import.meta.url から求める）。
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX_TS_PATH = join(REPO_ROOT, "src", "index.ts");
const TEST_RESOLVER_URL = pathToFileURL(join(REPO_ROOT, "scripts", "test-resolver.mjs")).href;

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

// user.name/user.email はコマンドラインで都度与える（ユーザーのグローバル設定に
// 依存させないため）。
async function gitAsUser(cwd: string, args: string[]): Promise<void> {
  await git(cwd, ["-c", "user.name=Test Worker", "-c", "user.email=test-worker@example.com", ...args]);
}

/**
 * `git init --bare` の origin と、そこから clone した作業リポジトリを一時ディレクトリに作る。
 * デフォルトブランチは main。初期コミットを1つ置き origin へ push しておく
 * （src/git.ts の syncDefaultBranch() が `git fetch origin main && git reset --hard origin/main`
 * を実行するため、これが通る状態にする）。
 */
async function initTempRepo(root: string): Promise<{ originDir: string; repoDir: string }> {
  const originDir = join(root, "origin.git");
  const repoDir = join(root, "repo");
  mkdirSync(originDir, { recursive: true });
  await git(originDir, ["init", "--bare", "--initial-branch=main"]);
  await git(root, ["clone", originDir, repoDir]);
  writeFileSync(join(repoDir, "README.md"), "# test repo\n");
  await gitAsUser(repoDir, ["add", "README.md"]);
  await gitAsUser(repoDir, ["commit", "-m", "initial commit"]);
  await git(repoDir, ["push", "-u", "origin", "main"]);
  return { originDir, repoDir };
}

export interface StartWorkerOptions {
  /** claude-task-worker <worker> に渡すワーカー名（例: "exec-issue"）。 */
  worker: string;
  /** リポジトリ直下 claude-task-worker.json の内容（workers セクション等）。 */
  workerConfig: Record<string, unknown>;
  /** 一時 XDG_CONFIG_HOME 配下 claude-task-worker/config.json の内容（mode 等）。 */
  userConfig: Record<string, unknown>;
  /**
   * 作業リポジトリの .claude/settings.json の内容。省略時はプラグイン宣言済みの
   * 既定値を書く。null を渡すとファイル自体を作らない（未宣言状態を再現するため）。
   */
  projectSettings?: Record<string, unknown> | null;
  /** installCliStubs() 等が返す records()（StubRecord[] を返す関数）。 */
  records: () => StubRecord[];
  /** テストタイムアウトに引っかからないよう、待機系関数の既定タイムアウトを調整できる。 */
  defaultTimeoutMs?: number;
}

export interface WorkerHandle {
  repoDir: string;
  originDir: string;
  xdgConfigHome: string;
  child: ChildProcessByStdio<null, Readable, Readable>;
  stdout(): string;
  stderr(): string;
  /** records() が predicate を満たすまでポーリングして待つ。 */
  waitFor(predicate: (records: StubRecord[]) => boolean, timeoutMs?: number): Promise<void>;
  /** 子プロセスの自然終了（起動拒否テスト用）を待ち、exit code を返す。 */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  cleanup(): Promise<void>;
}

const DEFAULT_WAIT_TIMEOUT_MS = 20_000;

/**
 * ワーカーを子プロセスとして起動する command-level テストハーネス。
 * 一時 git リポジトリ・一時 XDG_CONFIG_HOME・claude-task-worker.json / .claude/settings.json を
 * 用意してから `node --experimental-strip-types src/index.ts <worker>` を spawn する。
 * `claude` / `herdr` / `gh` は呼び出し側が事前に installCliStubs() で PATH スタブへ差し替えて
 * おくこと（このハーネスはスタブの導入自体は行わない。records() だけを受け取る）。
 */
export async function startWorker(options: StartWorkerOptions): Promise<WorkerHandle> {
  const root = mkdtempSync(join(tmpdir(), "ctw-worker-harness-"));
  const { originDir, repoDir } = await initTempRepo(root);

  writeFileSync(join(repoDir, "claude-task-worker.json"), JSON.stringify(options.workerConfig, null, 2));

  if (options.projectSettings !== null) {
    const settingsDir = join(repoDir, ".claude");
    mkdirSync(settingsDir, { recursive: true });
    const settings = options.projectSettings ?? {
      extraKnownMarketplaces: { "claude-task-worker": {} },
      enabledPlugins: { "claude-task-worker@claude-task-worker": true },
    };
    writeFileSync(join(settingsDir, "settings.json"), JSON.stringify(settings, null, 2));
  }

  // これらの設定ファイルは origin へコミット・push しておく。src/git.ts の
  // syncDefaultBranch() は各ワーカーの tick 冒頭で `git reset --hard origin/<branch>` を
  // 実行するため、コミットせず作業ツリーへ書いただけだと最初の tick で消えてしまう
  // （実際、未コミットのままだと config.json 由来の cloud/model 等が既定値へ巻き戻る事故になる）。
  await gitAsUser(repoDir, ["add", "-A"]);
  await gitAsUser(repoDir, ["commit", "-m", "test: configure worker"]);
  await git(repoDir, ["push", "origin", "main"]);

  const xdgConfigHome = mkdtempSync(join(tmpdir(), "ctw-worker-harness-xdg-"));
  const configDir = join(xdgConfigHome, "claude-task-worker");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify(options.userConfig, null, 2));

  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--import", TEST_RESOLVER_URL, INDEX_TS_PATH, options.worker],
    {
      cwd: repoDir,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: xdgConfigHome,
        NO_COLOR: "1",
        // 開発者のシェル環境に本物の Slack webhook が設定されていることがある。
        // src/slack.ts の send() はこれが truthy だと実際に fetch する（完了/失敗通知の
        // たびに呼ばれる）ため、テストが実チャンネルへ通知を飛ばさないよう必ず空にする。
        CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf-8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf-8");
  });

  let exited = false;
  let exitCode: number | null = null;
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolve();
    });
  });

  async function cleanup(): Promise<void> {
    if (!exited) {
      child.kill("SIGKILL");
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(xdgConfigHome, { recursive: true, force: true });
  }

  async function waitFor(predicate: (records: StubRecord[]) => boolean, timeoutMs?: number): Promise<void> {
    const deadline = Date.now() + (timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
    for (;;) {
      if (predicate(options.records())) return;
      if (exited) {
        throw new Error(
          `worker process exited (code ${String(exitCode)}) before the expected condition was met.\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out after ${timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS}ms waiting for condition.\n` +
            `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
        );
      }
      await sleep(100);
    }
  }

  async function waitForExit(timeoutMs?: number): Promise<number | null> {
    const timeout = timeoutMs ?? options.defaultTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    await Promise.race([
      exitPromise,
      new Promise((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `timed out after ${timeout}ms waiting for process exit.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
              ),
            ),
          timeout,
        ),
      ),
    ]);
    return exitCode;
  }

  return {
    repoDir,
    originDir,
    xdgConfigHome,
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    waitFor,
    waitForExit,
    cleanup,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
