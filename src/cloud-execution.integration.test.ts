import { after, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
// A / N / O. クラウド happy path（exec-issue, --cloud）
// ============================================================
// セッション作成は `script(1)` 経由の spawn 1本へ統合されており、herdr のペインに依存しない。
// そのため経路は `mode` に依らず1本で、A（herdr）と N（default）は mode 以外まったく同じ
// 期待値になる。両者が同じ assert を通ることをヘルパーの共有で構造的に担保する。
async function runCloudHappyPath(
  t: TestContext,
  options: { mode: "default" | "herdr"; cloudOutput: string },
): Promise<void> {
  const stubs = installCliStubs({
    gh: ISSUE_GH_SCENARIO,
    // 作成コマンドの stdout からセッションIDを取得するため、実測の出力形状（`View:` の URL）を
    // 含めておく。含めないと作成フェーズが失敗する。あわせて claude スタブが cc-cloud-done を
    // 付与する（実際のクラウドセッションが最後の操作として行う付与の模倣）。
    claude: {
      stdout: "[stub] exec-issue cloud report",
      cloudOutput: options.cloudOutput,
      cloudComplete: { type: "issue", number: 501 },
    },
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: options.mode },
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
  // default モードでもプロンプトが空にならないこと（`-p` を落とす代わりに `--cloud` の値へ
  // 載せる経路が両モードで働いていること）。
  assert.ok(
    description.includes("exec-issue"),
    "作成コマンドの初期プロンプトにスキル呼び出しが含まれていない（プロンプトが渡っていない）",
  );

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
}

const CLEAN_CLOUD_OUTPUT =
  "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubA?from=cli&m=0";

test(
  "A: exec-issue のクラウド実行（herdr）が --cloud/--ref を付け、worktree を作らない",
  { timeout: 75_000 },
  async (t) => {
    await runCloudHappyPath(t, { mode: "herdr", cloudOutput: CLEAN_CLOUD_OUTPUT });
  },
);

// mode: "default" でも同じ経路（runViaCloud）を通ることの担保。dispatch が
// `getRunMode() === "herdr"` の内側に閉じていると、ここで素の spawn（TTY 無しの
// `claude --cloud`）に落ちて cc-cloud-done の完了検知まで進めない。
test(
  "N: exec-issue のクラウド実行が mode: default でも herdr と同一の経路・結果になる",
  { timeout: 75_000 },
  async (t) => {
    await runCloudHappyPath(t, { mode: "default", cloudOutput: CLEAN_CLOUD_OUTPUT });
  },
);

// script(1) の擬似 pty 出力には ANSI エスケープと CR が混ざる。normalizePtyOutput の単体
// テストは herdr-runner.test.ts にあるが、それが作成フェーズへ実際に組み込まれていることは
// 結合経路でしか示せない（正規化が外れると happy path がセッションID未取得で失敗する）。
test(
  "O: pty 由来の制御文字を含む作成コマンド出力からでもセッションIDを抽出して完了する",
  { timeout: 75_000 },
  async (t) => {
    await runCloudHappyPath(t, {
      mode: "herdr",
      cloudOutput:
        "\u001b[?25lCreated cloud session: ctw:demo:#501\r\n" +
        "View: https://claude.ai/\u001b[0mcode/session_stubO?from=cli&m=0\u001b[?25h\r\n",
    });
  },
);

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
// C. 定期ワーカーのクラウド起動（update-coding-guidelines, herdr, --cloud）
// ============================================================
// 定期ワーカーは対象 Issue/PR を持たないため、実行記録PR（ctw-last-run-<worker>）を
// cc-cloud-done の置き先に使う。ここではスタブ環境で記録PRを作れないため置き先は無いが、
// 起動そのものはクラウド経路（--cloud + --ref、worktree なし）へ乗ることを確認する。
test(
  "C: 定期ワーカーが --cloud 下でクラウド実行になる（worktree を作らず --ref を付ける）",
  { timeout: 30_000 },
  async (t) => {
    const stubs = installCliStubs({
      gh: { login: "octocat", repo: { owner: "acme", name: "demo", defaultBranch: "main" } },
      claude: {
        cloudOutput: "Created cloud session: ctw:demo:#0\nView: https://claude.ai/code/session_stubC?from=cli&m=0",
      },
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

    await handle.waitFor((records) => findCreateRecord(records) !== undefined, 20_000);

    const records = stubs.records();
    const create = findCreateRecord(records)!;
    assert.equal(argValue(create.argv, "--ref"), "main");
    assert.ok(!create.argv.includes("--on-branch"), "定期ワーカーは --on-branch を付けてはいけない");
    assert.equal(
      findRecord(records, "herdr", "tab", "create"),
      undefined,
      "クラウド実行では herdr のタスクタブを作らない",
    );
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

// resolveScriptAvailable() は `which script` の成否で scriptAvailable を決める。テスト環境の
// PATH には実 script(1) がほぼ確実に存在するため、installCliStubs の PATH 先頭（dir）へ常に
// 失敗する which スタブを置いて scriptAvailable: false を強制する（E1 / K が共有）。
function makeScriptUnavailable(dir: string): void {
  const whichPath = join(dir, "which");
  writeFileSync(whichPath, "#!/bin/sh\nexit 1\n");
  chmodSync(whichPath, 0o755);
}

// ============================================================
// E. 起動拒否
// ============================================================
test("E1: script が利用できない環境で --cloud を渡すと起動せず終了コード1", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({ gh: ISSUE_GH_SCENARIO });
  makeScriptUnavailable(stubs.dir);
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: {} },
    // mode は checkCloudConfig の拒否理由ではなくなった（script 利用不可のみが理由）。
    // 既定の default のままにして、mode 差が結果に影響しないことも兼ねて確認する。
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
  assert.ok(handle.stdout().includes("script"), "エラーメッセージが script(1) の不可用を案内していない");
});

// 許可リストは撤去済み。--cloud を付けたプロセスでは resolve-conflict のような
// PR 系ワーカーもクラウド実行になる（worktree を作らず --on-branch で PR ブランチから始める）。
test("E2: --cloud 下では resolve-conflict もクラウド実行になる", { timeout: 45_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: {
      login: "octocat",
      repo: { owner: "acme", name: "demo", defaultBranch: "main" },
      prList: [
        { number: 801, headRefName: "conflict-branch", labels: [{ name: "cc-resolve-conflict" }], title: "Fix" },
      ],
      view: { "801": { checks: [] } },
    },
    claude: {
      cloudOutput: "Created cloud session: ctw:demo:#801\nView: https://claude.ai/code/session_stubE2?from=cli&m=0",
    },
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

  await handle.waitFor((records) => findCreateRecord(records) !== undefined, 30_000);

  const records = stubs.records();
  const create = findCreateRecord(records)!;
  assert.equal(argValue(create.argv, "--on-branch"), "conflict-branch");
  assert.ok(!create.argv.includes("--ref"), "PR系ワーカーは --ref を付けてはいけない");
  assert.equal(
    findRecord(records, "herdr", "tab", "create"),
    undefined,
    "クラウド実行では herdr のタスクタブを作らない",
  );
});

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
  makeScriptUnavailable(stubs.dir);
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: {},
    // script 利用不可（E1 参照）で checkCloudConfig が拒否するが、assertCloudAvailable の
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

// ============================================================
// M. クラウドセッション作成（ID抽出）待機中のシャットダウンで "shutdown" 理由になる（Issue #372）
// ============================================================
test(
  "M: セッションID抽出待機中のシャットダウンで shutdown 理由の孤立セッションコメントを残す",
  { timeout: 60_000 },
  async (t) => {
    const slack = await startSlackCapture();
    t.after(() => slack.close());

    const stubs = installCliStubs({
      gh: ISSUE_GH_SCENARIO,
      // cloudOutput を与えずセッションIDが一度も出ないまま作成コマンドを滞留させる
      // （createCloudSession の Promise は abort フラグを見るまで解決しない）。
      claude: { cloudLinger: true },
    });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workers: { "exec-issue": { pollingIntervalSeconds: 3600 } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      // タイムアウトより先に abort が発生するよう十分大きく取る。
      env: { CTW_CLOUD_SESSION_TIMEOUT_MS: "60000", CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
      extraArgs: ["--cloud"],
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });

    // クラウドセッションの作成コマンド起動（ID抽出待ちフェーズへ入ったこと）を確認する。
    await handle.waitFor((records) => findCreateRecord(records) !== undefined);

    // src/index.ts の SIGINT ハンドラは2段階（J と同じ理由）。1回目で "Stopping new tasks"
    // が出るのを待ってから2回目を送り、herdrAbortSignal を確実に立てる。
    handle.child.kill("SIGINT");
    await waitForStdout(handle, (out) => out.includes("Stopping new tasks"));
    handle.child.kill("SIGINT");

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
    assert.ok(
      commentBody!.includes("ワーカーのシャットダウンで待機を打ち切りました"),
      "shutdown 理由の文面が含まれていない（session-id 理由に固定されている可能性）",
    );
    assert.ok(
      !commentBody!.includes("セッションIDの抽出に失敗して待機を打ち切りました"),
      "session-id 理由の文面が混入している（修正前の固定 reason のバグが再発している）",
    );
    assert.ok(
      commentBody!.includes("セッションURL不明（ID抽出に失敗）"),
      "セッションIDが取れない場合のプレースホルダがコメントに含まれていない",
    );
  },
);
