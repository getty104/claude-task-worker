import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type * as CliStubModule from "./test-support/cli-stub";
import type { StubRecord } from "./test-support/cli-stub";
import type * as WorkerHarnessModule from "./test-support/worker-harness";
import type * as ClaudeArgsModule from "./claude-args";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする（既存テストと同じパターン）。
const { installCliStubs } = (await import("./test-support/cli-stub.ts")) as typeof CliStubModule;
const { startWorker } = (await import("./test-support/worker-harness.ts")) as typeof WorkerHarnessModule;
const { CLOUD_REPORT_HEADING } = (await import("./claude-args")) as typeof ClaudeArgsModule;

// テスト内で使い捨ての HTTP サーバを立て、Slack Webhook 宛の POST 本文（text）を集める。
async function startSlackCapture(): Promise<{ url: string; texts: () => string[]; close: () => Promise<void> }> {
  const texts: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf-8");
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { text?: string };
        if (typeof parsed.text === "string") texts.push(parsed.text);
      } catch {
        // 非JSONの本文は無視する。
      }
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    texts: () => texts,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const execFileAsync = promisify(execFile);

// buildTokenLimitText()（src/slack.ts）は完了/失敗通知のたびに使用状況APIへ実アクセスし、
// 未キャッシュだと macOS Keychain（security find-generic-password）まで読みに行く。
// タスク完了まで進めるテスト（A/D）はこれを踏むため、/tmp の共有キャッシュへ十分新しい
// タイムスタンプのダミー値を書いておき、ネットワーク・Keychainアクセスを迂回する
// （キャッシュパスは src/slack.ts 側で固定されておりテストからは変更できない）。
function seedUsageCache(): void {
  const payload = {
    timestamp: Date.now(),
    data: {
      fiveHourUtilization: 1,
      fiveHourResetsAt: new Date(Date.now() + 3600_000).toISOString(),
      sevenDayUtilization: 1,
      sevenDayResetsAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  };
  writeFileSync(USAGE_CACHE_PATH, JSON.stringify(payload));
}

// ダミー値を書きっぱなしにすると開発機のステータス表示（RunCat / statusline）が
// キャッシュTTLの間だけ嘘の使用率を出すため、元の内容を控えて全テスト後に戻す。
const USAGE_CACHE_PATH = "/tmp/claude-usage-cache.json";
const previousUsageCache = existsSync(USAGE_CACHE_PATH) ? readFileSync(USAGE_CACHE_PATH, "utf-8") : undefined;
seedUsageCache();
after(() => {
  if (previousUsageCache === undefined) rmSync(USAGE_CACHE_PATH, { force: true });
  else writeFileSync(USAGE_CACHE_PATH, previousUsageCache);
});

function findRecord(
  records: StubRecord[],
  command: StubRecord["command"],
  sub: string,
  action: string,
): StubRecord | undefined {
  return records.find((r) => r.command === command && r.argv[0] === sub && r.argv[1] === action);
}

// `herdr agent start <name> --kind claude --pane <id> --timeout <ms> -- <claude args...>` から
// claude のフラグ部分（`--` の後ろ）だけを取り出す。ローカル実行（herdr モード・cloud 未指定）は
// 引き続きこの経路（runViaHerdr）を使うため残す。
function extractAgentStartArgs(record: StubRecord): string[] {
  const idx = record.argv.indexOf("--");
  assert.ok(idx >= 0, `agent start の argv に "--" が見つからない: ${JSON.stringify(record.argv)}`);
  return record.argv.slice(idx + 1);
}

// クラウド実行の作成コマンドは script(1) 経由で `claude --cloud <desc> ...` を直接起動する。
// claude スタブが記録する argv は claude のフラグそのもの。
function findCreateRecord(records: StubRecord[]): StubRecord | undefined {
  return records.find((r) => r.command === "claude" && r.argv.includes("--cloud"));
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

// `gh issue comment <n> --body <text>` の記録を探し、本文（--body の値）を取り出す。
function findCommentBody(records: StubRecord[], type: "issue" | "pr", number: number): string | undefined {
  const record = records.find(
    (r) => r.command === "gh" && r.argv[0] === type && r.argv[1] === "comment" && r.argv[2] === String(number),
  );
  return record ? argValue(record.argv, "--body") : undefined;
}

// 固定 sleep ではなく stdout の内容をポーリングして待つ。SIGINT の2段階ハンドラ
// （src/index.ts）は1回目の受信で state を同期的に確定させてからログを出すため、
// このログの出現を「1回目のシグナルの効果が確定した」ことの確実な合図として使う。
async function waitForStdout(
  handle: { stdout(): string },
  predicate: (out: string) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate(handle.stdout())) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for stdout condition.\n--- stdout ---\n${handle.stdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function gitBranchList(repoDir: string): Promise<string[]> {
  const { stdout } = await execFileAsync("git", ["branch", "--list"], { cwd: repoDir });
  return stdout
    .split("\n")
    .map((l) => l.replace(/^\*?\s*/, "").trim())
    .filter(Boolean);
}

const BASE_ISSUE = {
  number: 501,
  title: "Add feature",
  labels: [{ name: "cc-exec-issue" }],
  parent: null,
};

const ISSUE_GH_SCENARIO = {
  login: "octocat",
  repo: { owner: "acme", name: "demo", defaultBranch: "main" },
  issues: [BASE_ISSUE],
  view: { "501": { blockedBy: { nodes: [] }, state: "OPEN", labels: [] } },
  closingPrs: [],
};

// ============================================================
// A. Issue系ワーカーのクラウド起動引数・env・cwd（exec-issue, herdr, --cloud）
// ============================================================
test("A: exec-issue のクラウド実行が --cloud/--ref を付け、worktree を作らない", { timeout: 75_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: ISSUE_GH_SCENARIO,
    // 作成コマンドの stdout からセッションIDを取得するため、実測の出力形状（`View:` の URL）を
    // 含めておく。含めないと作成フェーズが失敗する。あわせて claude スタブが cc-cloud-done を
    // 付与する（実際のクラウドセッションが最後の操作として行う付与の模倣）。
    claude: {
      stdout: "[stub] exec-issue cloud report",
      cloudOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubA?from=cli&m=0",
      cloudComplete: { type: "issue", number: 501 },
    },
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  // タスク完了（cc-in-progress の除去）を待つ。readFinalReport() の transcript 総なめが
  // 実開発機では時間を要することがあるため長めに取る。
  await handle.waitFor(
    (records) =>
      records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "edit" &&
          r.argv.includes("--remove-label") &&
          r.argv.includes("cc-in-progress"),
      ),
    45_000,
  );

  const records = stubs.records();
  const create = findCreateRecord(records);
  assert.ok(create, "クラウドセッション作成コマンド（claude --cloud）の記録が見つからない");
  assert.equal(create!.cwd, realpathSync(handle.repoDir), "作成コマンドがリポジトリルートで起動されていない");
  assert.equal(
    create!.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
    "1",
    "作成コマンドの env に CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 が届いていない",
  );
  assert.equal(
    create!.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS,
    undefined,
    "env に CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS が含まれてはいけない",
  );

  // セッション作成は spawn 1本なので、タスクタブの作成・ペイン操作・agent 起動はいずれも
  // 発生しない（`tab list` は herdr モードの起動時疎通確認なので対象外）。
  assert.deepEqual(
    records
      .filter((r) => r.command === "herdr" && ["pane", "agent"].includes(r.argv[0]))
      .concat(records.filter((r) => r.command === "herdr" && r.argv[0] === "tab" && r.argv[1] !== "list"))
      .map((r) => r.argv.slice(0, 2).join(" ")),
    [],
    "クラウド実行でタスクタブ・ペイン操作・agent 起動が行われている",
  );

  assert.equal(argValue(create!.argv, "--ref"), "main");
  assert.ok(!create!.argv.includes("--on-branch"), "--on-branch が付いてはいけない");
  assert.ok(!create!.argv.includes("-p"), "-p が付いてはいけない（クラウド作成コマンドは常に非付与）");
  assert.ok(create!.argv.includes("--permission-mode"), "実装は cloud でも --permission-mode を付ける");
  assert.ok(create!.argv.includes("--disallowedTools"), "実装は cloud でも --disallowedTools を付ける");

  // 1コマンド方式では --cloud の値がクラウドセッションの初期プロンプトそのもの
  // （cc-cloud-done の投稿指示を含む）になる。投函コマンドは存在しないため、
  // 作成コマンドの description を直接検証する。
  const description = create!.argv[create!.argv.indexOf("--cloud") + 1];
  assert.ok(
    description.includes("cc-cloud-done"),
    "作成コマンドの初期プロンプトに cc-cloud-done ラベル付与の指示が含まれていない",
  );
  assert.ok(description.includes("501"), "作成コマンドの初期プロンプトに対象 Issue 番号が含まれていない");

  const removeCloudDone = records.filter(
    (r) =>
      r.command === "gh" &&
      r.argv[0] === "issue" &&
      r.argv[1] === "edit" &&
      r.argv.includes("--remove-label") &&
      r.argv.includes("cc-cloud-done"),
  );
  assert.ok(
    removeCloudDone.length >= 2,
    `--remove-label cc-cloud-done の記録が2回以上ない（起動前の残骸掃除＋完了検知後の除去）: ${removeCloudDone.length}件`,
  );

  assert.ok(!existsSync(join(handle.repoDir, ".claude", "worktrees")), "worktree ディレクトリが作られている");
  const branches = await gitBranchList(handle.repoDir);
  assert.ok(
    branches.every((b) => !/^[a-z]+-[a-z]+-\d{4}$/.test(b)),
    `生成名ローカルブランチが残っている: ${branches.join(", ")}`,
  );
});

// ============================================================
// B. PR系ワーカーのクラウド起動引数（fix-review-point, herdr, --cloud）
// ============================================================
test("B: fix-review-point のクラウド実行が --on-branch を付け、--ref を付けない", { timeout: 60_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: {
      login: "octocat",
      repo: { owner: "acme", name: "demo", defaultBranch: "main" },
      prList: [{ number: 701, headRefName: "feature-x", labels: [{ name: "cc-fix-onetime" }], title: "Fix bug" }],
      view: { "701": { checks: [] } },
    },
    claude: {
      stdout: "[stub] fix-review-point cloud report",
      cloudOutput: "Created cloud session: ctw:demo:#701\nView: https://claude.ai/code/session_stubB?from=cli&m=0",
    },
  });
  const handle = await startWorker({
    worker: "fix-review-point",
    workerConfig: { workers: { "fix-review-point": { pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  await handle.waitFor((records) => findCreateRecord(records) !== undefined);

  const create = findCreateRecord(stubs.records())!;
  assert.equal(argValue(create.argv, "--on-branch"), "feature-x");
  assert.ok(!create.argv.includes("--ref"), "PR系ワーカーは --ref を付けてはいけない");
});

// ============================================================
// C. 定期ワーカーは --cloud 下でもローカル実行に落ちる（update-coding-guidelines, herdr, --cloud）
// ============================================================
// 定期ワーカーは CLOUD_ALLOWED_WORKERS（src/config.ts）に含まれないため、isCloudWorker() が false を
// 返しローカル実行になる（対象 Issue/PR を持たず cc-cloud-done を置く先が無く完了検知できないため。
// Phase 1 の制約）。新仕様では --cloud はプロセス単位のフラグなので起動時エラーにはならない。
test(
  "C: 定期ワーカーは --cloud 下でも起動時エラーにならずローカル実行になる（worktree 生成・--cloud 未付与）",
  { timeout: 30_000 },
  async (t) => {
    const stubs = installCliStubs({
      gh: { login: "octocat", repo: { owner: "acme", name: "demo", defaultBranch: "main" } },
      herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] update-coding-guidelines local report" },
    });
    const handle = await startWorker({
      worker: "update-coding-guidelines",
      workerConfig: { workers: {} },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      extraArgs: ["--cloud"],
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });

    await handle.waitFor((records) => findRecord(records, "herdr", "agent", "start") !== undefined, 20_000);

    const records = stubs.records();
    const tabCreate = findRecord(records, "herdr", "tab", "create")!;
    const cwdArg = argValue(tabCreate.argv, "--cwd")!;
    assert.ok(
      cwdArg.startsWith(`${join(realpathSync(handle.repoDir), ".claude", "worktrees")}${sep}`),
      `worktree 配下の cwd になっていない: ${cwdArg}`,
    );

    const agentStart = findRecord(records, "herdr", "agent", "start")!;
    const claudeArgs = extractAgentStartArgs(agentStart);
    assert.ok(!claudeArgs.includes("--cloud"), "定期ワーカーが --cloud 付きで起動している");
  },
);

// ============================================================
// D. 失敗時の cleanup（exec-issue, --cloud, タスク失敗）
// ============================================================
test(
  "D: exec-issue のクラウド実行がセッションID抽出失敗でも cc-in-progress を除去し PR ラベルを付けない",
  { timeout: 45_000 },
  async (t) => {
    const slack = await startSlackCapture();
    t.after(() => slack.close());

    const stubs = installCliStubs({
      gh: ISSUE_GH_SCENARIO,
      // 作成コマンドの stdout からセッションIDを抽出できないケース（セッションIDパターンを
      // 含めない出力）で失敗を作る。ID未出力のまま exit した時点で失敗が確定するため、
      // CTW_CLOUD_SESSION_TIMEOUT_MS の満了は待たない。
      claude: { cloudOutput: "[stub] no session id in this launch output" },
    });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      env: { CTW_CLOUD_SESSION_TIMEOUT_MS: "500", CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
      extraArgs: ["--cloud"],
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });

    await handle.waitFor(
      (records) =>
        records.some(
          (r) =>
            r.command === "gh" &&
            r.argv[0] === "issue" &&
            r.argv[1] === "edit" &&
            r.argv.includes("--remove-label") &&
            r.argv.includes("cc-in-progress"),
        ),
      30_000,
    );

    const records = stubs.records();
    assert.ok(
      !records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "edit" &&
          r.argv.includes("--add-label") &&
          r.argv.includes("cc-pr-created"),
      ),
      "失敗したタスクに cc-pr-created が付いている",
    );
    assert.ok(findCreateRecord(records), "クラウドセッション作成コマンドが起動されていない");
    assert.ok(!existsSync(join(handle.repoDir, ".claude", "worktrees")), "worktree ディレクトリが作られている");

    // セッションID抽出失敗（catch経路）は孤立クラウドセッションの可能性があるため、
    // cc-need-human-check を付けて人手確認へ回す（flagOrphanedCloudSession の "session-id" 経路）。
    assert.ok(
      records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "edit" &&
          r.argv.includes("--add-label") &&
          r.argv.includes("cc-need-human-check"),
      ),
      "cc-need-human-check が付与されていない",
    );
    const commentBody = findCommentBody(records, "issue", 501);
    assert.ok(commentBody, "孤立クラウドセッションのコメントが記録されていない");
    assert.ok(commentBody!.includes("孤立クラウドセッションの可能性"));
    assert.ok(
      commentBody!.includes("セッションURL不明（ID抽出に失敗）"),
      "セッションIDが取れない場合のプレースホルダがコメントに含まれていない",
    );

    await handle.waitFor(
      () => slack.texts().some((text) => text.includes("セッションURL不明（ID抽出に失敗）")),
      20_000,
    );
  },
);

// ============================================================
// E. 起動拒否
// ============================================================
test("E1: mode default で --cloud を渡すと起動せず終了コード1", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({ gh: ISSUE_GH_SCENARIO });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: {} },
    userConfig: { mode: "default" },
    records: stubs.records,
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  const code = await handle.waitForExit(15_000);
  assert.equal(code, 1);

  const records = stubs.records();
  assert.equal(findRecord(records, "herdr", "tab", "create"), undefined);
  assert.equal(findRecord(records, "herdr", "agent", "start"), undefined);
  assert.equal(
    records.filter((r) => r.command === "claude" && r.argv.includes("--cloud")).length,
    0,
    "クラウドフラグ付きの claude 起動が記録されている",
  );
  // console.error はステータステーブル描画用にキャプチャされ stdout 側のログテーブルへ
  // 流れる（src/table.ts の captureConsole()）ため、stderr ではなく stdout を見る。
  assert.ok(handle.stdout().includes("--cloud"), "エラーメッセージが --cloud を指していない");
  assert.ok(handle.stdout().includes("herdr"), "エラーメッセージが herdr モードへの切り替えを案内していない");
});

// resolve-conflict は CLOUD_ALLOWED_WORKERS（src/config.ts）に含まれないため、--cloud 下でも
// 起動時エラーにならずローカル実行（worktree あり・--cloud なしの claude 起動）に落ちる。
test(
  "E2: 許可リスト外のワーカー（resolve-conflict）は --cloud 下でもローカル実行に落ちる",
  { timeout: 45_000 },
  async (t) => {
    const stubs = installCliStubs({
      gh: {
        login: "octocat",
        repo: { owner: "acme", name: "demo", defaultBranch: "main" },
        prList: [
          { number: 801, headRefName: "conflict-branch", labels: [{ name: "cc-resolve-conflict" }], title: "Fix" },
        ],
        view: { "801": { checks: [] } },
      },
      herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] resolve-conflict local report" },
    });
    const handle = await startWorker({
      worker: "resolve-conflict",
      workerConfig: { workers: {} },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      extraArgs: ["--cloud"],
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });

    await handle.waitFor((records) => findRecord(records, "herdr", "agent", "start") !== undefined, 30_000);

    const records = stubs.records();
    const tabCreate = findRecord(records, "herdr", "tab", "create")!;
    const cwdArg = argValue(tabCreate.argv, "--cwd")!;
    assert.ok(
      cwdArg.startsWith(`${join(realpathSync(handle.repoDir), ".claude", "worktrees")}${sep}`),
      `worktree 配下の cwd になっていない: ${cwdArg}`,
    );

    const agentStart = findRecord(records, "herdr", "agent", "start")!;
    const claudeArgs = extractAgentStartArgs(agentStart);
    assert.ok(!claudeArgs.includes("--cloud"), "denied ワーカーが --cloud 付きで起動している");
    assert.ok(!claudeArgs.includes("--on-branch"));
  },
);

test("E3: 未サインイン（claude auth status）だと起動せず終了コード1", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({
    claude: { authStatus: { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" } },
    gh: ISSUE_GH_SCENARIO,
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: {} },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  const code = await handle.waitForExit(15_000);
  assert.equal(code, 1);

  const records = stubs.records();
  assert.equal(findRecord(records, "herdr", "tab", "create"), undefined);
  assert.equal(findRecord(records, "herdr", "agent", "start"), undefined);
  assert.equal(
    records.filter((r) => r.command === "claude" && r.argv.includes("--cloud")).length,
    0,
    "クラウドフラグ付きの claude 起動が記録されている",
  );
});

// ============================================================
// F. ローカル実行の不変性（cloud 未指定、mode herdr）
// ============================================================
test("F: exec-issue のローカル実行は --cloud/--ref/-p を付けず worktree を作る", { timeout: 60_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: ISSUE_GH_SCENARIO,
    herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] exec-issue local report" },
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  await handle.waitFor((records) => findRecord(records, "herdr", "agent", "start") !== undefined);

  const records = stubs.records();
  const tabCreate = findRecord(records, "herdr", "tab", "create")!;
  const cwdArg = argValue(tabCreate.argv, "--cwd")!;
  assert.ok(
    cwdArg.startsWith(`${join(realpathSync(handle.repoDir), ".claude", "worktrees")}${sep}`),
    `worktree 配下の cwd になっていない: ${cwdArg}`,
  );

  const agentStart = findRecord(records, "herdr", "agent", "start")!;
  const claudeArgs = extractAgentStartArgs(agentStart);
  assert.ok(!claudeArgs.includes("--cloud"));
  assert.ok(!claudeArgs.includes("--ref"));
  assert.ok(!claudeArgs.includes("--on-branch"));
  assert.ok(!claudeArgs.includes("-p"), "-p が付いてはいけない（herdr モード）");

  // --cloud 未指定時は buildClaudeEnv(mode, cloud) の cloud 引数が false のままなので、
  // クラウド専用の CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC が注入されてはいけない
  // （--cloud 未指定時に env がまったく変わらないことの固定）。
  assert.ok(
    !tabCreate.argv.some((a) => a.startsWith("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=")),
    "--cloud 未指定なのに CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC が --env に含まれている",
  );
});

// ============================================================
// G. cc-cloud-done 検知 → ラベル除去 → レポートコメント取得 → Slack 通知本文への反映
// ============================================================
test("G: クラウド完了検知後にレポートコメントを取得し Slack 通知本文へ反映する", { timeout: 75_000 }, async (t) => {
  const slack = await startSlackCapture();
  t.after(() => slack.close());

  const stubs = installCliStubs({
    gh: ISSUE_GH_SCENARIO,
    claude: {
      stdout: "[stub] exec-issue cloud report",
      cloudOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubG?from=cli&m=0",
      cloudComplete: {
        type: "issue",
        number: 501,
        report: `${CLOUD_REPORT_HEADING}\n\n[stub] 最終報告本文`,
      },
    },
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    env: { CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  await handle.waitFor(
    (records) =>
      records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "edit" &&
          r.argv.includes("--remove-label") &&
          r.argv.includes("cc-in-progress"),
      ),
    45_000,
  );

  const records = stubs.records();
  assert.ok(
    records.some(
      (r) => r.command === "gh" && r.argv[0] === "api" && /issues\/501\/comments\?since=/.test(r.argv[1] ?? ""),
    ),
    "レポートコメント取得（gh api .../comments?since=）の記録が見つからない",
  );

  const removeCloudDone = records.filter(
    (r) =>
      r.command === "gh" &&
      r.argv[0] === "issue" &&
      r.argv[1] === "edit" &&
      r.argv.includes("--remove-label") &&
      r.argv.includes("cc-cloud-done"),
  );
  assert.ok(removeCloudDone.length >= 2, `--remove-label cc-cloud-done が2回以上ない: ${removeCloudDone.length}件`);

  await handle.waitFor(() => slack.texts().some((text) => text.includes("[stub] 最終報告本文")), 20_000);
});

// ============================================================
// H. CLOUD_TASK_TIMEOUT_MS 超過で cc-need-human-check 付与＋失敗通知
// ============================================================
test(
  "H: クラウド完了待機がタイムアウトすると cc-need-human-check を付け失敗通知する",
  { timeout: 60_000 },
  async (t) => {
    const slack = await startSlackCapture();
    t.after(() => slack.close());

    const stubs = installCliStubs({
      gh: ISSUE_GH_SCENARIO,
      claude: {
        stdout: "[stub] exec-issue cloud report",
        cloudOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubH?from=cli&m=0",
      },
    });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      env: { CTW_CLOUD_TASK_TIMEOUT_MS: "1", CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
      extraArgs: ["--cloud"],
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });

    // cc-need-human-check の付与は finishTask()（cc-in-progress の除去）より前に起きるため、
    // 後者を待てば両方の記録が揃っている。
    await handle.waitFor(
      (records) =>
        records.some(
          (r) =>
            r.command === "gh" &&
            r.argv[0] === "issue" &&
            r.argv[1] === "edit" &&
            r.argv.includes("--remove-label") &&
            r.argv.includes("cc-in-progress"),
        ),
      45_000,
    );

    const records = stubs.records();
    assert.ok(
      records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "edit" &&
          r.argv.includes("--add-label") &&
          r.argv.includes("cc-need-human-check"),
      ),
      "cc-need-human-check が付与されていない",
    );

    await handle.waitFor(
      () => slack.texts().some((text) => text.includes("timed out waiting for the cc-cloud-done label")),
      20_000,
    );
  },
);

// ============================================================
// I. 完了待機中に isRunning() が再起動を抑止する
// ============================================================
test("I: クラウド完了待機中はトリガーラベルが再装填されても投函が重複しない", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: {
      login: "octocat",
      repo: { owner: "acme", name: "demo", defaultBranch: "main" },
      prList: [{ number: 701, headRefName: "feature-x", labels: [{ name: "cc-fix-onetime" }], title: "Fix bug" }],
      view: { "701": { checks: [] } },
    },
    claude: {
      stdout: "[stub] fix-review-point cloud report",
      cloudOutput: "Created cloud session: ctw:demo:#701\nView: https://claude.ai/code/session_stubI?from=cli&m=0",
    },
  });
  const handle = await startWorker({
    worker: "fix-review-point",
    workerConfig: { workers: { "fix-review-point": { pollingIntervalSeconds: 1 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  await handle.waitFor((records) => findCreateRecord(records) !== undefined);

  // ポーリング2周分以上（4〜5秒）待って、trigger label が静的シナリオ由来で毎周再装填されて
  // いても作成コマンドが重複起動されないことを確認する。
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const createCount = stubs.records().filter((r) => r.command === "claude" && r.argv.includes("--cloud")).length;
  assert.equal(createCount, 1, `クラウドセッション作成コマンドが複数回起動されている: ${createCount}件`);
});

// ============================================================
// J. クラウド完了待機中のシャットダウン（aborted）で cc-need-human-check を付ける
// ============================================================
test(
  "J: クラウド完了待機中のシャットダウンで cc-need-human-check を付けコメントを残す",
  { timeout: 60_000 },
  async (t) => {
    const slack = await startSlackCapture();
    t.after(() => slack.close());

    const stubs = installCliStubs({
      gh: ISSUE_GH_SCENARIO,
      // cloudComplete を設定しないため cc-cloud-done は自発的に付かず、
      // ワーカーは waitForCloudTask() の待機に入ったままになる（aborted 経路を確実に踏むため）。
      claude: {
        cloudOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubJ?from=cli&m=0",
      },
    });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      env: { CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
      extraArgs: ["--cloud"],
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });

    // クラウドセッションの作成コマンド起動を確認してから完了待機フェーズへ進ませる。
    await handle.waitFor((records) => findCreateRecord(records) !== undefined);

    // src/index.ts の SIGINT ハンドラは2段階: 1回目は graceful shutdown へ入るだけで
    // herdrAbortSignal は立たない（waitForCloudTask は timeout まで解決しない）。2回目で
    // 初めて shutdown("SIGKILL") が呼ばれ aborted が確定する。1回目のログ（"Stopping new tasks"）
    // の出現を待ってから2回目を送ることで、1回目のハンドラの状態確定前に2回目が素通りする
    // レースを避ける。
    handle.child.kill("SIGINT");
    await waitForStdout(handle, (out) => out.includes("Stopping new tasks"));
    handle.child.kill("SIGINT");

    // flagOrphanedCloudSession() はラベル付与 → コメント投稿の順に実行するため、
    // ラベルの記録だけを待つと後続のコメント assert がまだ届いていない状態で走りうる。
    // 後発のコメントを待てばラベル付与の完了も含意される。
    await handle.waitFor((records) => findCommentBody(records, "issue", 501) !== undefined, 30_000);

    const records = stubs.records();
    assert.ok(
      records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "edit" &&
          r.argv.includes("--add-label") &&
          r.argv.includes("cc-need-human-check"),
      ),
      "cc-need-human-check が付与されていない",
    );
    const commentBody = findCommentBody(records, "issue", 501);
    assert.ok(commentBody, "孤立クラウドセッションのコメントが記録されていない");
    assert.ok(commentBody!.includes("孤立クラウドセッションの可能性"));
    assert.ok(commentBody!.includes("https://claude.ai/code/session_stubJ"), "セッションURLがコメントに含まれていない");

    // finishTask() 経由の失敗通知（notifyTaskFailed）はシャットダウン中でも抑止されないため、
    // Slack 側でも aborted 経路の文言を確認できる。
    await handle.waitFor(() => slack.texts().some((text) => text.includes("The session may still be running")), 20_000);
  },
);

// ============================================================
// K. init 未再実行の既存リポジトリでも cc-cloud-done ラベルを保証する
// ============================================================
test("K: --cloud 指定時は起動時に cc-cloud-done ラベルを作成する", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({ gh: ISSUE_GH_SCENARIO });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: {},
    // mode: "default" は --cloud 指定として無効（E1 参照）だが、assertCloudAvailable の
    // ラベル作成は checkCloudConfig の妥当性判定より前に行われるため、この組み合わせでも
    // 素早く（起動失敗を待つだけで）ラベル作成の記録を確認できる。
    userConfig: { mode: "default" },
    records: stubs.records,
    extraArgs: ["--cloud"],
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  const code = await handle.waitForExit(15_000);
  assert.equal(code, 1);

  const records = stubs.records();
  const labelCreate = findRecord(records, "gh", "label", "create");
  assert.ok(labelCreate, "cc-cloud-done ラベル作成（gh label create）の記録が見つからない");
  assert.equal(labelCreate!.argv[2], "cc-cloud-done");
  assert.ok(labelCreate!.argv.includes("--force"), "--force が付いていない（未作成リポジトリで冪等に作成できない）");
});

test("L: --cloud を指定しなければ cc-cloud-done ラベルを作成しない", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({ gh: ISSUE_GH_SCENARIO });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "default" },
    records: stubs.records,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  // 起動が通常どおり進んだこと（gh repo view の記録）を待ってから判定する。
  // 起動直後の記録なしとラベル未作成を区別するため。
  await handle.waitFor((records) => findRecord(records, "gh", "repo", "view") !== undefined);

  const records = stubs.records();
  assert.equal(
    findRecord(records, "gh", "label", "create"),
    undefined,
    "cloud ワーカーが無いのにラベルが作成されている",
  );
});
