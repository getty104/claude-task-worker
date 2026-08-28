import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import type * as CliStubModule from "./test-support/cli-stub";
import type { StubRecord } from "./test-support/cli-stub";
import type * as WorkerHarnessModule from "./test-support/worker-harness";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする（既存テストと同じパターン）。
const { installCliStubs } = (await import("./test-support/cli-stub.ts")) as typeof CliStubModule;
const { startWorker } = (await import("./test-support/worker-harness.ts")) as typeof WorkerHarnessModule;

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
// claude のフラグ部分（`--` の後ろ）だけを取り出す。
function extractAgentStartArgs(record: StubRecord): string[] {
  const idx = record.argv.indexOf("--");
  assert.ok(idx >= 0, `agent start の argv に "--" が見つからない: ${JSON.stringify(record.argv)}`);
  return record.argv.slice(idx + 1);
}

function argValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx >= 0 ? argv[idx + 1] : undefined;
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
    herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] exec-issue cloud report" },
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

  const agentStart = findRecord(records, "herdr", "agent", "start");
  assert.ok(agentStart, "agent start の記録が見つからない");
  const claudeArgs = extractAgentStartArgs(agentStart!);
  assert.ok(claudeArgs.includes("--cloud"), "--cloud が付いていない");
  assert.equal(argValue(claudeArgs, "--ref"), "main");
  assert.ok(!claudeArgs.includes("--on-branch"), "--on-branch が付いてはいけない");
  assert.ok(!claudeArgs.includes("-p"), "-p が付いてはいけない（herdr モードは常に非付与）");
  // 実測: buildClaudeArgs() は cloud 実行でも --permission-mode / --disallowedTools を
  // 常に付ける（cloud で省く実装にはなっていない）。現行実装の実測値を正としてテストする。
  assert.ok(claudeArgs.includes("--permission-mode"), "実装は cloud でも --permission-mode を付ける");
  assert.ok(claudeArgs.includes("--disallowedTools"), "実装は cloud でも --disallowedTools を付ける");

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
    herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] triage-pr cloud report" },
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

  await handle.waitFor((records) => findRecord(records, "herdr", "agent", "start") !== undefined);

  const agentStart = findRecord(stubs.records(), "herdr", "agent", "start")!;
  const claudeArgs = extractAgentStartArgs(agentStart);
  assert.equal(argValue(claudeArgs, "--on-branch"), "feature-x");
  assert.ok(!claudeArgs.includes("--ref"), "PR系ワーカーは --ref を付けてはいけない");
  assert.ok(claudeArgs.includes("--cloud"));
});

// ============================================================
// C. 定期ワーカーのクラウド起動引数（update-coding-guidelines, herdr, cloud: true）
// ============================================================
test("C: update-coding-guidelines のクラウド実行が --ref を付ける", { timeout: 60_000 }, async (t) => {
  const stubs = installCliStubs({
    gh: { login: "octocat", repo: { owner: "acme", name: "demo", defaultBranch: "main" } },
    herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] scheduled cloud report" },
  });
  const handle = await startWorker({
    worker: "update-coding-guidelines",
    workerConfig: { workers: { "update-coding-guidelines": { cloud: true, pollingIntervalSeconds: 3600 } } },
    userConfig: { mode: "herdr" },
    records: stubs.records,
    defaultTimeoutMs: 40_000,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });

  // publishLastRunPr() が worktree/commit/push/pr-create を行ってから run() に進むため、
  // 他ケースよりタイムアウトを長めに取る。
  await handle.waitFor((records) => findRecord(records, "herdr", "agent", "start") !== undefined, 40_000);

  const agentStart = findRecord(stubs.records(), "herdr", "agent", "start")!;
  const claudeArgs = extractAgentStartArgs(agentStart);
  assert.equal(argValue(claudeArgs, "--ref"), "main");
  assert.ok(claudeArgs.includes("--cloud"));
});

// ============================================================
// D. 失敗時の cleanup（exec-issue, cloud: true, タスク失敗）
// ============================================================
test(
  "D: exec-issue のクラウド実行が空振り失敗しても cc-in-progress を除去し PR ラベルを付けない",
  { timeout: 75_000 },
  async (t) => {
    const stubs = installCliStubs({
      gh: ISSUE_GH_SCENARIO,
      // paneOutput を空にすると buildHerdrTaskResult() が空振り（失敗）と判定する。
      herdr: { agentStatuses: ["working", "done"], paneOutput: "" },
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

    // readFinalReport() が ~/.claude/projects/*/*.jsonl を総なめするため、実開発機の
    // transcript 件数によっては既定タイムアウト内に収まらないことがある。長めに取る。
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
