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

type OnComplete = (status: "completed" | "failed", output: string) => Promise<void>;

// run() は fire-and-forget なので、onComplete の解決を Promise で待てるようにする。
function waitForOnComplete(): { onComplete: OnComplete; result: Promise<{ status: string; output: string }> } {
  let resolve!: (value: { status: string; output: string }) => void;
  const result = new Promise<{ status: string; output: string }>((r) => {
    resolve = r;
  });
  const onComplete: OnComplete = async (status, output) => {
    resolve({ status, output });
  };
  return { onComplete, result };
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
