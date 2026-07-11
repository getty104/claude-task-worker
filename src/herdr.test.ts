import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import type * as HerdrModule from "./herdr";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

const { tabCreate, tabList, paneProcessInfo, HerdrError } = (await import("./herdr.ts")) as typeof HerdrModule;

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

test("propagates a timeout error via execError when herdr hangs", async (t) => {
  const timeoutError = Object.assign(new Error("Command timed out"), { killed: true, signal: "SIGKILL" });
  mockExecFileError(t, timeoutError as NodeJS.ErrnoException);
  await assert.rejects(tabList(), (error: Error) => {
    assert.match(error.message, /Command timed out/);
    return true;
  });
});
