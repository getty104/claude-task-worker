import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ProcessManagerModule from "./process-manager";
import type * as ClaudeArgsModule from "./claude-args";
import type * as UserConfigModule from "./user-config";
import type * as CliStubModule from "./test-support/cli-stub";
import type { StubRecord } from "./test-support/cli-stub";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする（既存テストと同じパターン）。
const { run } = (await import("./process-manager")) as typeof ProcessManagerModule;
const { buildClaudeArgs, buildClaudeExecution, buildClaudeEnv } =
  (await import("./claude-args")) as typeof ClaudeArgsModule;
const { resetRunModeCache } = (await import("./user-config")) as typeof UserConfigModule;
const { installCliStubs } = (await import("./test-support/cli-stub")) as typeof CliStubModule;

const PROMPT = "/claude-task-worker:exec-issue 123";

type OnComplete = (status: "completed" | "failed", output: string, cloudSessionId?: string) => Promise<void>;

// run() は fire-and-forget なので、onComplete の解決を Promise で待てるようにする。
// cloudSessionId（第3引数）はクラウドセッションID伝播ケースのために受け取る。
function waitForOnComplete(): {
  onComplete: OnComplete;
  result: Promise<{ status: string; output: string; cloudSessionId?: string }>;
} {
  let resolve!: (value: { status: string; output: string; cloudSessionId?: string }) => void;
  const result = new Promise<{ status: string; output: string; cloudSessionId?: string }>((r) => {
    resolve = r;
  });
  const onComplete: OnComplete = async (status, output, cloudSessionId) => {
    resolve({ status, output, cloudSessionId });
  };
  return { onComplete, result };
}

// herdr モードの追加ケース共通のセットアップ（一時 XDG_CONFIG_HOME に mode: herdr の
// config.json を書き、resetRunModeCache する）。cleanup は呼び出し側の t.after() に委ねる。
function setupHerdrConfig(): { xdgHome: string; previousXdg: string | undefined } {
  const xdgHome = mkdtempSync(join(tmpdir(), "ctw-xdg-config-"));
  const configDir = join(xdgHome, "claude-task-worker");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ mode: "herdr" }));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgHome;
  resetRunModeCache();
  return { xdgHome, previousXdg };
}

function teardownHerdrConfig(xdgHome: string, previousXdg: string | undefined): void {
  if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = previousXdg;
  resetRunModeCache();
  rmSync(xdgHome, { recursive: true, force: true });
}

// records() の中から herdr サブコマンド1件を見つける。
function findHerdrRecord(records: StubRecord[], sub: string, action: string): StubRecord | undefined {
  return records.find((r) => r.command === "herdr" && r.argv[0] === sub && r.argv[1] === action);
}

test("default モード: run() が claude スタブへ期待どおりの argv/cwd/env を渡す", async (t) => {
  const configDir = mkdtempSync(join(tmpdir(), "ctw-xdg-config-"));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configDir;
  resetRunModeCache();

  const stubs = installCliStubs({ claude: { stdout: "[stub] claude report for default mode" } });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctw-task-cwd-")));

  t.after(() => {
    stubs.cleanup();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    resetRunModeCache();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const invocation: ClaudeArgsModule.ClaudeInvocation = {
    mode: "default",
    prompt: PROMPT,
    model: "opus",
    effort: "high",
  };
  const execution = buildClaudeExecution(invocation);
  const env = buildClaudeEnv("default");
  const { onComplete, result } = waitForOnComplete();

  run(execution.command, execution.args, 9001, "#123", "exec-issue", undefined, onComplete, cwd, env, execution.prompt);

  const { status, output } = await result;
  assert.equal(status, "completed");
  assert.ok(output.includes("[stub] claude report for default mode"));

  const records = stubs.records();
  const claudeRecord = records.find((r) => r.command === "claude");
  assert.ok(claudeRecord, "claude スタブの記録が見つからない");
  assert.deepEqual(claudeRecord.argv, execution.args);
  assert.equal(claudeRecord.cwd, cwd);
  assert.equal(claudeRecord.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(claudeRecord.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS, "0");
});

test("herdr モード: run() が herdr スタブ経由で tab create → agent start → agent prompt → 完了まで進む", async (t) => {
  const xdgHome = mkdtempSync(join(tmpdir(), "ctw-xdg-config-"));
  const configDir = join(xdgHome, "claude-task-worker");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ mode: "herdr" }));
  const previousXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = xdgHome;
  resetRunModeCache();

  // ensurePromptAccepted の初回ポーリングで working を、waitForHerdrTask の初回ポーリングで
  // done を観測させ、既定3秒のポーリングを待たずに1周で完了させる。
  const stubs = installCliStubs({
    herdr: { agentStatuses: ["working", "done"], paneOutput: "[stub] pane output for herdr mode" },
  });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctw-task-cwd-")));

  t.after(() => {
    stubs.cleanup();
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
    resetRunModeCache();
    rmSync(xdgHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const invocation: ClaudeArgsModule.ClaudeInvocation = {
    mode: "herdr",
    prompt: PROMPT,
    model: "opus",
    effort: "high",
  };
  const execution = buildClaudeExecution(invocation);
  const env = buildClaudeEnv("herdr");
  const { onComplete, result } = waitForOnComplete();

  run(execution.command, execution.args, 9002, "#123", "exec-issue", undefined, onComplete, cwd, env, execution.prompt);

  const { status } = await result;
  assert.equal(status, "completed");

  const records = stubs.records().filter((r) => r.command === "herdr");
  const subcommands = records.map((r) => `${r.argv[0]} ${r.argv[1]}`);

  // 順序の検証は「その部分列が現れること」に留め、agent get / pane read の回数までは固定しない。
  const expectedSequence = [
    "tab create",
    "agent start",
    "agent prompt",
    "agent get",
    "pane read",
    "pane send-keys",
    "tab close",
  ];
  let cursor = 0;
  for (const sub of subcommands) {
    if (cursor < expectedSequence.length && sub === expectedSequence[cursor]) cursor++;
  }
  assert.equal(cursor, expectedSequence.length, `期待した部分列が現れなかった: ${subcommands.join(", ")}`);

  const tabCreate = findHerdrRecord(records, "tab", "create");
  assert.ok(tabCreate);
  assert.ok(tabCreate.argv.includes("--cwd"));
  assert.ok(tabCreate.argv.includes(cwd));
  assert.ok(tabCreate.argv.includes("--env"));
  assert.ok(tabCreate.argv.includes("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1"));

  const agentStart = findHerdrRecord(records, "agent", "start");
  assert.ok(agentStart);
  const separatorIndex = agentStart.argv.indexOf("--");
  assert.ok(separatorIndex >= 0);
  const claudeArgsAfterSeparator = agentStart.argv.slice(separatorIndex + 1);
  assert.deepEqual(claudeArgsAfterSeparator, buildClaudeArgs(invocation));
  assert.ok(!claudeArgsAfterSeparator.includes("-p"), "herdr モードの起動引数にプロンプトを含めてはいけない");

  const agentPrompt = findHerdrRecord(records, "agent", "prompt");
  assert.ok(agentPrompt);
  assert.ok(agentPrompt.argv.includes(PROMPT));
});

test("herdr モード: working 観測後の idle で完了する（起動直後の working 単独では完了しない）", async (t) => {
  // ["working","idle"] の2値だと、起動確認（ensurePromptAccepted）のポーリングが
  // 唯一の working を消費してしまい、waitForHerdrTask 側の tracker は一度も working を
  // 観測できないまま idle に張り付いて完了しない（実機で確認済み）。waitForHerdrTask 自身の
  // tracker が working を観測できるよう working を2回連続させ、「working 観測後の idle」を
  // 検証できる列にしてある。
  const { xdgHome, previousXdg } = setupHerdrConfig();
  const stubs = installCliStubs({
    herdr: { agentStatuses: ["working", "working", "idle"], paneOutput: "[stub] pane output for idle case" },
  });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctw-task-cwd-")));

  t.after(() => {
    stubs.cleanup();
    teardownHerdrConfig(xdgHome, previousXdg);
    rmSync(cwd, { recursive: true, force: true });
  });

  const invocation: ClaudeArgsModule.ClaudeInvocation = {
    mode: "herdr",
    prompt: PROMPT,
    model: "opus",
    effort: "high",
  };
  const execution = buildClaudeExecution(invocation);
  const env = buildClaudeEnv("herdr");
  const { onComplete, result } = waitForOnComplete();

  run(execution.command, execution.args, 9003, "#123", "exec-issue", undefined, onComplete, cwd, env, execution.prompt);

  const { status } = await result;
  assert.equal(status, "completed");
});

test("herdr モード: 起動直後の idle/unknown を完了と誤判定せず、working 観測後の done で完了する", async (t) => {
  const { xdgHome, previousXdg } = setupHerdrConfig();
  const stubs = installCliStubs({
    herdr: {
      agentStatuses: ["idle", "unknown", "working", "done"],
      paneOutput: "[stub] pane output for idle/unknown case",
    },
  });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctw-task-cwd-")));

  t.after(() => {
    stubs.cleanup();
    teardownHerdrConfig(xdgHome, previousXdg);
    rmSync(cwd, { recursive: true, force: true });
  });

  const invocation: ClaudeArgsModule.ClaudeInvocation = {
    mode: "herdr",
    prompt: PROMPT,
    model: "opus",
    effort: "high",
  };
  const execution = buildClaudeExecution(invocation);
  const env = buildClaudeEnv("herdr");
  const { onComplete, result } = waitForOnComplete();

  run(execution.command, execution.args, 9004, "#123", "exec-issue", undefined, onComplete, cwd, env, execution.prompt);

  const { status } = await result;
  assert.equal(status, "completed");

  // 3件以上の agent get 記録は、idle/unknown を観測した時点では完了と即断せずポーリングを
  // 継続した証拠（即断していれば working/done へ到達する前に完了してしまい記録は1〜2件で終わる）。
  const agentGetCount = stubs
    .records()
    .filter((r) => r.command === "herdr" && r.argv[0] === "agent" && r.argv[1] === "get").length;
  assert.ok(agentGetCount >= 3, `agent get の記録件数が不足している: ${agentGetCount}`);
});

test("herdr モード: blocked を完了扱いせず待機を継続し、working 経由の done で完了する", async (t) => {
  const { xdgHome, previousXdg } = setupHerdrConfig();
  const stubs = installCliStubs({
    herdr: { agentStatuses: ["blocked", "working", "done"], paneOutput: "[stub] pane output for blocked case" },
  });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctw-task-cwd-")));

  t.after(() => {
    stubs.cleanup();
    teardownHerdrConfig(xdgHome, previousXdg);
    rmSync(cwd, { recursive: true, force: true });
  });

  const invocation: ClaudeArgsModule.ClaudeInvocation = {
    mode: "herdr",
    prompt: PROMPT,
    model: "opus",
    effort: "high",
  };
  const execution = buildClaudeExecution(invocation);
  const env = buildClaudeEnv("herdr");
  const { onComplete, result } = waitForOnComplete();

  run(execution.command, execution.args, 9005, "#123", "exec-issue", undefined, onComplete, cwd, env, execution.prompt);

  const { status } = await result;
  assert.equal(status, "completed");

  const agentGetCount = stubs
    .records()
    .filter((r) => r.command === "herdr" && r.argv[0] === "agent" && r.argv[1] === "get").length;
  assert.ok(agentGetCount >= 3, `agent get の記録件数が不足している: ${agentGetCount}`);
});

test("herdr モード（クラウド実行）: 1コマンド作成でクラウドセッションIDが onComplete まで伝播する", async (t) => {
  const { xdgHome, previousXdg } = setupHerdrConfig();
  const stubs = installCliStubs({
    // 作成コマンドは script(1) 経由で claude スタブを直接起動し、その stdout から
    // セッションIDを拾う。実測の出力形状に合わせる（`Created cloud session:` の後ろは
    // description であり、`View:` の URL がID本体）。
    claude: {
      stdout: "[stub] cloud dispatch report",
      cloudOutput: "Created cloud session: ctw:my-app:#123\nView: https://claude.ai/code/session_stubABC?from=cli&m=0",
    },
  });
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "ctw-task-cwd-")));

  t.after(() => {
    stubs.cleanup();
    teardownHerdrConfig(xdgHome, previousXdg);
    rmSync(cwd, { recursive: true, force: true });
  });

  const invocation: ClaudeArgsModule.ClaudeInvocation = {
    mode: "herdr",
    prompt: PROMPT,
    model: "opus",
    effort: "high",
    cloud: true,
  };
  const execution = buildClaudeExecution(invocation);
  const env = buildClaudeEnv("herdr");
  const { onComplete, result } = waitForOnComplete();

  run(
    execution.command,
    execution.args,
    9006,
    "#123",
    "exec-issue",
    undefined,
    onComplete,
    cwd,
    env,
    execution.prompt,
    true,
  );

  const { status, cloudSessionId } = await result;
  assert.equal(status, "completed");
  assert.equal(cloudSessionId, "session_stubABC");

  const records = stubs.records();
  const create = records.find((r) => r.command === "claude" && r.argv.includes("--cloud"));
  assert.ok(create, "クラウドセッション作成コマンド（claude --cloud）の記録が見つからない");
  // --cloud の値がタスクの初期プロンプトそのもの（cloudTarget 未指定のためそのまま PROMPT）。
  assert.ok(
    create.argv[create.argv.indexOf("--cloud") + 1].includes(PROMPT),
    "作成コマンドの description に初期プロンプトが含まれていない",
  );
  assert.equal(create.cwd, cwd, "作成コマンドが指定した cwd で起動されていない");

  const herdrRecords = records.filter((r) => r.command === "herdr");
  assert.deepEqual(
    herdrRecords.map((r) => r.argv.slice(0, 2).join(" ")),
    [],
    "クラウド実行で herdr のコマンドを呼んではいけない（セッション作成は spawn 1本）",
  );
});
