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

// クラウド実行の作成コマンドは `herdr pane send-text <paneId> "claude --cloud <desc> ..."`
// としてシェルへ送出される（クォート済みの1文字列）。argv[2] が paneId、argv[3] がその文字列。
function extractCreateCommand(record: StubRecord): string {
  return record.argv[3] ?? "";
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
}

// クォート済みのシェルコマンド文字列から `--flag <value>` の値を取り出す。トークンはすべて
// shellQuote() でシングルクォートされているため、フラグ自身も `'--flag'` の形で現れる。
function commandFlagValue(command: string, flag: string): string | undefined {
  const match = new RegExp(`'${flag}' '([^']*)'`).exec(command);
  return match?.[1];
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
// A. Issue系ワーカーのクラウド起動引数・env・cwd（exec-issue, herdr, cloud: true）
// ============================================================
test("A: exec-issue のクラウド実行が --cloud/--ref を付け、worktree を作らない", { timeout: 75_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: ISSUE_GH_SCENARIO,
    // 作成フェーズがペイン内容をポーリングしてセッションIDを取得するため、実測の出力形状
    // （`View:` の URL）を含めておく。含めないと作成フェーズがタイムアウトする。
    herdr: {
      paneOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubA?from=cli&m=0",
    },
    // claude スタブが投函コマンド実行時に cc-cloud-done を付与する（実際のクラウドセッションが
    // 最後の操作として行う付与を模倣）。静的な cloudDone 分岐は撤去したため、この付与タイミングで
    // 起動前ポーリングと投函後ポーリングを区別できる。
    claude: { stdout: "[stub] exec-issue cloud report", cloudComplete: { type: "issue", number: 501 } },
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { cloud: true, pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
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
  const tabCreate = findRecord(records, "herdr", "tab", "create");
  assert.ok(tabCreate, "tab create の記録が見つからない");
  assert.equal(argValue(tabCreate!.argv, "--cwd"), realpathSync(handle.repoDir));
  assert.ok(!tabCreate!.argv.includes("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"));
  assert.ok(
    !tabCreate!.argv.some((a) => a.startsWith("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=")),
    "--env に CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS が含まれてはいけない",
  );

  assert.equal(findRecord(records, "herdr", "agent", "start"), undefined, "クラウド実行で agent start が呼ばれている");

  const sendText = findRecord(records, "herdr", "pane", "send-text");
  assert.ok(sendText, "作成コマンドの pane send-text 記録が見つからない");
  const createCommand = extractCreateCommand(sendText!);
  assert.ok(createCommand.includes("'--cloud'"), "--cloud が付いていない");
  assert.equal(commandFlagValue(createCommand, "--ref"), "main");
  assert.ok(!createCommand.includes("'--on-branch'"), "--on-branch が付いてはいけない");
  assert.ok(!createCommand.includes("'-p'"), "-p が付いてはいけない（クラウド作成コマンドは常に非付与）");
  assert.ok(createCommand.includes("'--permission-mode'"), "実装は cloud でも --permission-mode を付ける");
  assert.ok(createCommand.includes("'--disallowedTools'"), "実装は cloud でも --disallowedTools を付ける");

  // 1コマンド方式では --cloud の値がクラウドセッションの初期プロンプトそのもの
  // （cc-cloud-done の投稿指示を含む）になる。投函コマンドは存在しないため、
  // 作成コマンドの description を直接検証する。
  assert.ok(
    createCommand.includes("cc-cloud-done"),
    "作成コマンドの初期プロンプトに cc-cloud-done ラベル付与の指示が含まれていない",
  );
  assert.ok(createCommand.includes("501"), "作成コマンドの初期プロンプトに対象 Issue 番号が含まれていない");
  assert.equal(
    records.filter((r) => r.command === "claude" && r.argv.includes("--cloud")).length,
    0,
    "1コマンド化後は claude バイナリが --cloud 付きで直接起動されてはいけない（投函コマンドは廃止済み）",
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
});

// ============================================================
// B. PR系ワーカーのクラウド起動引数（triage-pr, herdr, cloud: true）
// ============================================================
test("B: triage-pr のクラウド実行が --on-branch を付け、--ref を付けない", { timeout: 60_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: {
      login: "octocat",
      repo: { owner: "acme", name: "demo", defaultBranch: "main" },
      prList: [{ number: 701, headRefName: "feature-x", labels: [{ name: "cc-triage-scope" }], title: "Fix bug" }],
      view: { "701": { checks: [] } },
    },
    herdr: {
      paneOutput: "Created cloud session: ctw:demo:#701\nView: https://claude.ai/code/session_stubB?from=cli&m=0",
    },
    claude: { stdout: "[stub] triage-pr cloud report" },
  });
  const handle = await startWorker({
    worker: "triage-pr",
    workerConfig: { workers: { "triage-pr": { cloud: true, pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  await handle.waitFor((records) => findRecord(records, "herdr", "pane", "send-text") !== undefined);

  const sendText = findRecord(stubs.records(), "herdr", "pane", "send-text")!;
  const createCommand = extractCreateCommand(sendText);
  assert.equal(commandFlagValue(createCommand, "--on-branch"), "feature-x");
  assert.ok(!createCommand.includes("'--ref'"), "PR系ワーカーは --ref を付けてはいけない");
  assert.ok(createCommand.includes("'--cloud'"));
});

// ============================================================
// C. 定期ワーカーの起動拒否（update-coding-guidelines, herdr, cloud: true）
// ============================================================
// 定期ワーカーは CLOUD_DENIED_WORKERS（src/config.ts）に含まれるため cloud: true を拒否する。
// 対象 Issue/PR を持たず cc-cloud-done を置く先が無く、完了検知できないため（Phase 1 の制約）。
test("C: 定期ワーカーに cloud: true があると起動せず終了コード1", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: { login: "octocat", repo: { owner: "acme", name: "demo", defaultBranch: "main" } },
  });
  const handle = await startWorker({
    worker: "update-coding-guidelines",
    workerConfig: { workers: { "update-coding-guidelines": { cloud: true } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  const code = await handle.waitForExit(15_000);
  assert.equal(code, 1);

  const records = stubs.records();
  assert.equal(findRecord(records, "herdr", "tab", "create"), undefined);
  assert.equal(findRecord(records, "herdr", "pane", "send-text"), undefined);
});

// ============================================================
// D. 失敗時の cleanup（exec-issue, cloud: true, タスク失敗）
// ============================================================
test(
  "D: exec-issue のクラウド実行がセッションID抽出失敗でも cc-in-progress を除去し PR ラベルを付けない",
  { timeout: 45_000 },
  async (t) => {
    const stubs = installCliStubs({
      gh: ISSUE_GH_SCENARIO,
      // 1コマンド方式には投函コマンドが存在しないため、作成コマンドの出力から
      // セッションIDを抽出できないケース（pane 出力にセッションIDパターンを
      // 含めない）で失敗を作る。CTW_CLOUD_SESSION_TIMEOUT_MS でタイムアウトを
      // テスト時間内に収まるよう短縮する。
      herdr: { paneOutput: "[stub] no session id present in this pane" },
    });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workers: { "exec-issue": { cloud: true, pollingIntervalSeconds: 3600 } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      env: { CTW_CLOUD_SESSION_TIMEOUT_MS: "500" },
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
    assert.equal(
      records.filter((r) => r.command === "claude" && r.argv.includes("--cloud")).length,
      0,
      "1コマンド化後は claude バイナリが --cloud 付きで直接起動されてはいけない",
    );
    assert.ok(!existsSync(join(handle.repoDir, ".claude", "worktrees")), "worktree ディレクトリが作られている");
  },
);

// ============================================================
// E. 起動拒否
// ============================================================
test("E1: mode default で cloud: true のワーカーがあると起動せず終了コード1", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({ gh: ISSUE_GH_SCENARIO });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { cloud: true } } },
    userConfig: { mode: "default" },
    records: stubs.records,
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

test(
  "E2: mode herdr で CLOUD_DENIED_WORKERS に cloud: true があると起動せず終了コード1",
  { timeout: 30_000 },
  async (t) => {
    const stubs = installCliStubs({ gh: ISSUE_GH_SCENARIO });
    const handle = await startWorker({
      worker: "exec-issue",
      // resolve-conflict は CLOUD_DENIED_WORKERS（src/config.ts）に含まれる。
      workerConfig: { workers: { "resolve-conflict": { cloud: true } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
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
  },
);

test("E3: 未サインイン（claude auth status）だと起動せず終了コード1", { timeout: 30_000 }, async (t) => {
  const stubs = installCliStubs({
    claude: { authStatus: { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" } },
    gh: ISSUE_GH_SCENARIO,
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { cloud: true } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
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
});

// ============================================================
// G. cc-cloud-done 検知 → ラベル除去 → レポートコメント取得 → Slack 通知本文への反映
// ============================================================
test("G: クラウド完了検知後にレポートコメントを取得し Slack 通知本文へ反映する", { timeout: 75_000 }, async (t) => {
  const slack = await startSlackCapture();
  t.after(() => slack.close());

  const stubs = installCliStubs({
    gh: ISSUE_GH_SCENARIO,
    herdr: {
      paneOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubG?from=cli&m=0",
    },
    claude: {
      stdout: "[stub] exec-issue cloud report",
      cloudComplete: {
        type: "issue",
        number: 501,
        report: `${CLOUD_REPORT_HEADING}\n\n[stub] 最終報告本文`,
      },
    },
  });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { cloud: true, pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    env: { CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
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
      herdr: {
        paneOutput: "Created cloud session: ctw:demo:#501\nView: https://claude.ai/code/session_stubH?from=cli&m=0",
      },
      claude: { stdout: "[stub] exec-issue cloud report" },
    });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workers: { "exec-issue": { cloud: true, pollingIntervalSeconds: 3600 } } },
      userConfig: { mode: "herdr" },
      records: stubs.records,
      env: { CTW_CLOUD_TASK_TIMEOUT_MS: "1", CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL: slack.url },
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
      prList: [{ number: 701, headRefName: "feature-x", labels: [{ name: "cc-triage-scope" }], title: "Fix bug" }],
      view: { "701": { checks: [] } },
    },
    herdr: {
      paneOutput: "Created cloud session: ctw:demo:#701\nView: https://claude.ai/code/session_stubI?from=cli&m=0",
    },
    claude: { stdout: "[stub] triage-pr cloud report" },
  });
  const handle = await startWorker({
    worker: "triage-pr",
    workerConfig: { workers: { "triage-pr": { cloud: true, pollingIntervalSeconds: 1 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  await handle.waitFor((records) => findRecord(records, "herdr", "pane", "send-text") !== undefined);

  // ポーリング2周分以上（4〜5秒）待って、trigger label が静的シナリオ由来で毎周再装填されて
  // いても投函が重複しないことを確認する。
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const records = stubs.records();
  const sendTextCount = records.filter(
    (r) => r.command === "herdr" && r.argv[0] === "pane" && r.argv[1] === "send-text",
  ).length;
  assert.equal(sendTextCount, 1, `作成コマンドの pane send-text が複数回記録されている: ${sendTextCount}件`);

  // 1コマンド方式では作成コマンドが唯一のクラウドセッション起動操作であり、
  // claude バイナリが --cloud 付きで直接（再）起動されることはない
  // （投函コマンドという別経路自体が存在しない）。
  const cloudClaudeInvocations = records.filter((r) => r.command === "claude" && r.argv.includes("--cloud")).length;
  assert.equal(cloudClaudeInvocations, 0, `claude --cloud の直接起動が記録されている: ${cloudClaudeInvocations}件`);
});
