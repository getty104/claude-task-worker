import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import type * as HerdrModule from "./herdr";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

const { tabCreate, tabList, paneProcessInfo, paneSendText, paneSendKeys, paneRead, HerdrError } =
  (await import("./herdr.ts")) as typeof HerdrModule;

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

function mockExecFileError(t: TestContext, error: NodeJS.ErrnoException): void {
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      callback(error, "", "");
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
