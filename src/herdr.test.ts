import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import type * as HerdrModule from "./herdr";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

const herdrModulePath = ["./herdr", "ts"].join(".");
const { tabCreate, tabList, paneProcessInfo } = (await import(herdrModulePath)) as typeof HerdrModule;

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

function mockExecFile(t: TestContext, stdout: string, stderr: string): void {
  t.mock.method(childProcess, "execFile", (_command: string, _args: string[], callback: ExecFileCallback) => {
    callback(null, stdout, stderr);
  });
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
