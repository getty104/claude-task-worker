import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import type * as HerdrModule from "./herdr";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

const {
  tabCreate,
  tabList,
  paneProcessInfo,
  paneSendText,
  paneSendKeys,
  paneRead,
  agentStart,
  workspaceCreate,
  HerdrError,
} = (await import("./herdr.ts")) as typeof HerdrModule;

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function mockExecFile(t: TestContext, stdout: string, stderr: string): void {
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(null, stdout, stderr);
    },
  );
}

// herdr へ実際に渡された argv を検査するためのモック。
function captureExecFileArgs(t: TestContext, stdout: string): { args: string[][] } {
  const captured: string[][] = [];
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      captured.push(args);
      callback(null, stdout, "");
    },
  );
  return { args: captured };
}

function cwdArgOf(args: string[]): string {
  return args[args.indexOf("--cwd") + 1];
}

function mockExecFileError(t: TestContext, error: NodeJS.ErrnoException, stdout = "", stderr = ""): void {
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(error, stdout, stderr);
    },
  );
}

test("execHerdr includes stderr content in the error message when stdout is invalid JSON", async (t) => {
  mockExecFile(t, "not json", "herdr: connection refused");
  await assert.rejects(tabList(), (error: Error) => {
    assert.match(error.message, /invalid JSON output/);
    assert.match(error.message, /herdr: connection refused/);
    return true;
  });
});

test("paneSendText resolves without throwing when herdr returns empty stdout and stderr on success", async (t) => {
  // herdr の `pane send-text` は成功時に空stdout・空stderr・終了コード0を返すため、
  // invalid JSON 扱いにせず正常完了させる。
  mockExecFile(t, "", "");
  await assert.doesNotReject(paneSendText("w3:pB", "claude-task-worker 'yolo'"));
});

test("paneSendKeys resolves without throwing when herdr returns empty stdout and stderr on success", async (t) => {
  mockExecFile(t, "", "");
  await assert.doesNotReject(paneSendKeys("w3:pB", "enter"));
});

test("paneSendText still throws invalid JSON when stdout is non-empty but not JSON", async (t) => {
  mockExecFile(t, "not json", "");
  await assert.rejects(paneSendText("w3:pB", "hello"), /invalid JSON output/);
});

test("paneSendText throws when stdout is empty but stderr is non-empty", async (t) => {
  // exit 0 でも stderr に出力があれば、失敗を握りつぶさずエラーにする。
  mockExecFile(t, "", "herdr: pane busy");
  await assert.rejects(paneSendText("w3:pB", "hello"), (error: Error) => {
    assert.match(error.message, /invalid JSON output/);
    assert.match(error.message, /herdr: pane busy/);
    return true;
  });
});

test("tabList rejects an empty stdout response because it must return JSON", async (t) => {
  // allowEmptyResult を指定しないコマンドでは、空stdoutを正常応答として扱わない。
  mockExecFile(t, "", "");
  await assert.rejects(tabList(), /invalid JSON output/);
});

test("tabCreate throws an explicit error when root_pane is missing from the response", async (t) => {
  mockExecFile(t, JSON.stringify({ result: { tab: { tab_id: "tab-1" } } }), "");
  await assert.rejects(
    tabCreate({ label: "test", cwd: "/tmp" }),
    /Failed to create tab: invalid response structure from herdr/,
  );
});

test("tabCreate throws an explicit error when tab is missing from the response", async (t) => {
  mockExecFile(t, JSON.stringify({ result: { root_pane: { pane_id: "pane-1" } } }), "");
  await assert.rejects(
    tabCreate({ label: "test", cwd: "/tmp" }),
    /Failed to create tab: invalid response structure from herdr/,
  );
});

test("tabList returns an empty array when tabs is not an array", async (t) => {
  mockExecFile(t, JSON.stringify({ result: { tabs: "not-an-array" } }), "");
  const result = await tabList();
  assert.deepEqual(result, []);
});

test("tabList returns an empty array when result is null", async (t) => {
  mockExecFile(t, JSON.stringify({ result: null }), "");
  const result = await tabList();
  assert.deepEqual(result, []);
});

test("paneProcessInfo returns an empty foregroundProcesses array when process_info is missing", async (t) => {
  mockExecFile(t, JSON.stringify({ result: {} }), "");
  const result = await paneProcessInfo("pane-1");
  assert.deepEqual(result, { foregroundProcesses: [] });
});

test("paneProcessInfo returns an empty foregroundProcesses array when foreground_processes is missing", async (t) => {
  mockExecFile(t, JSON.stringify({ result: { process_info: {} } }), "");
  const result = await paneProcessInfo("pane-1");
  assert.deepEqual(result, { foregroundProcesses: [] });
});

test("throws a HerdrError carrying the error code when herdr responds with an error payload", async (t) => {
  mockExecFile(t, JSON.stringify({ error: { code: "pane_not_found", message: "no such pane" } }), "");
  await assert.rejects(paneProcessInfo("pane-1"), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "pane_not_found");
    assert.match(error.message, /^herdr pane process-info --pane pane-1 failed: \[pane_not_found\] no such pane$/);
    return true;
  });
});

test("paneRead returns plain terminal text as-is when it is not JSON-shaped", async (t) => {
  mockExecFile(t, "$ ls\nfoo.txt\nbar.txt\n", "");
  const result = await paneRead("w3:pB");
  assert.equal(result, "$ ls\nfoo.txt\nbar.txt\n");
});

test("paneRead throws a HerdrError for a genuine {code, message} error response", async (t) => {
  mockExecFile(t, JSON.stringify({ code: "pane_not_found", message: "no such pane" }), "");
  await assert.rejects(paneRead("w3:pB"), (error: unknown) => {
    assert.ok(error instanceof HerdrError);
    assert.equal(error.code, "pane_not_found");
    assert.match(error.message, /\[pane_not_found\] no such pane/);
    return true;
  });
});

test("paneRead does not misclassify JSON-like terminal output with extra keys as an error", async (t) => {
  // `code` キーを持つが herdr のエラー形状（code/messageのみ）と一致しない端末出力は
  // そのままstdoutとして返す。
  mockExecFile(t, JSON.stringify({ code: "ok", extra: "field" }), "");
  const result = await paneRead("w3:pB");
  assert.equal(result, JSON.stringify({ code: "ok", extra: "field" }));
});

test("propagates a timeout error via execError when herdr hangs", async (t) => {
  const timeoutError = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGKILL" });
  mockExecFileError(t, timeoutError as NodeJS.ErrnoException);
  await assert.rejects(tabList(), (error: Error) => {
    assert.match(error.message, /Command timed out/);
    return true;
  });
});

// herdr の `tab close` は存在しないタブに対し「終了コード非0＋stderrにJSON」を返す
// （実測）。ここで code を取り出せないと stopHerdrTask の「tab_not_found は正常系」
// 判定が効かず、claude がグレースフルに終了するたびに偽のエラーログが出る。
test("surfaces a HerdrError with its code when herdr writes the error envelope to stderr and exits non-zero", async (t) => {
  const { tabClose } = (await import("./herdr.ts")) as typeof HerdrModule;
  mockExecFileError(
    t,
    new Error("Command failed: herdr tab close w1:t2") as NodeJS.ErrnoException,
    "",
    JSON.stringify({ error: { code: "tab_not_found", message: "tab w1:t2 not found" } }),
  );
  await assert.rejects(tabClose("w1:t2"), (error: Error) => {
    assert.ok(error instanceof HerdrError);
    assert.equal((error as InstanceType<typeof HerdrError>).code, "tab_not_found");
    return true;
  });
});

test("does not treat stderr as a source of successful results", async (t) => {
  // stderr 側は error エンベロープの取り出しにのみ使う。result が stdout に無ければ
  // 従来どおり invalid JSON として失敗させる。
  mockExecFileError(
    t,
    new Error("Command failed") as NodeJS.ErrnoException,
    "",
    JSON.stringify({ result: { tabs: [] } }),
  );
  await assert.rejects(tabList(), (error: Error) => {
    assert.ok(!(error instanceof HerdrError));
    return true;
  });
});

// --cwd は herdr サーバー（別プロセス）が解決するため、相対パスのまま渡すと
// ワーカーのcwdではなく herdr サーバーのcwd（＝ホームディレクトリ）基準になり、
// worktree のつもりのタスクがリポジトリ外で走る。境界で必ず絶対パス化する。
test("agentStart resolves a relative cwd to an absolute path before handing it to herdr", async (t) => {
  const captured = captureExecFileArgs(t, JSON.stringify({ result: { agent: { pane_id: "p1", tab_id: "t1" } } }));
  await agentStart({ name: "task", cwd: ".claude/worktrees/brave-otter-1234", argv: ["claude"] });
  assert.equal(cwdArgOf(captured.args[0]), `${process.cwd()}/.claude/worktrees/brave-otter-1234`);
});

test("tabCreate resolves a relative cwd to an absolute path before handing it to herdr", async (t) => {
  const captured = captureExecFileArgs(
    t,
    JSON.stringify({ result: { root_pane: { pane_id: "p1" }, tab: { tab_id: "t1" } } }),
  );
  await tabCreate({ label: "ctw:app:#1", cwd: ".claude/worktrees/brave-otter-1234" });
  assert.equal(cwdArgOf(captured.args[0]), `${process.cwd()}/.claude/worktrees/brave-otter-1234`);
});

test("workspaceCreate resolves a relative cwd to an absolute path before handing it to herdr", async (t) => {
  const captured = captureExecFileArgs(
    t,
    JSON.stringify({
      result: { workspace: { workspace_id: "w1" }, root_pane: { pane_id: "p1", tab_id: "t1" } },
    }),
  );
  await workspaceCreate({ label: "ctw:app", cwd: "." });
  assert.equal(cwdArgOf(captured.args[0]), process.cwd());
});

test("agentStart passes an absolute cwd through unchanged", async (t) => {
  const captured = captureExecFileArgs(t, JSON.stringify({ result: { agent: { pane_id: "p1", tab_id: "t1" } } }));
  await agentStart({ name: "task", cwd: "/tmp/worktree", argv: ["claude"] });
  assert.equal(cwdArgOf(captured.args[0]), "/tmp/worktree");
});

// agent は必ず「タスク専用タブ」の中で起動する。--tab を省くとワークスペースの
// アクティブタブ（ユーザーが見ているタブ）へ split で割り込んでちらつく。
test("agentStart targets the given tab so it does not split into the visible tab", async (t) => {
  const captured = captureExecFileArgs(t, JSON.stringify({ result: { agent: { pane_id: "p1", tab_id: "t9" } } }));
  await agentStart({ name: "task", cwd: "/tmp/worktree", argv: ["claude"], tabId: "w1:t9" });
  const args = captured.args[0];
  assert.equal(args[args.indexOf("--tab") + 1], "w1:t9");
});
