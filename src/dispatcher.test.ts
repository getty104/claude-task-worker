import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import type * as DispatcherModule from "./dispatcher";
import type * as HerdrModule from "./herdr";
import type { ResolvedProject } from "./projects-config";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する一方、
// tsc --noEmit（npm run build）は allowImportingTsExtensions が無効なため
// 静的import文中の .ts 拡張子指定子を許容せず失敗する。両立のため、
// TSの静的解析対象にならない動的文字列結合でパスを構築している。
const dispatcherModulePath = ["./dispatcher", "ts"].join(".");
const { runDispatcher, pollOnce, monitorSessions } = (await import(dispatcherModulePath)) as typeof DispatcherModule;
const herdrModulePath = ["./herdr", "ts"].join(".");
const { HerdrError } = (await import(herdrModulePath)) as typeof HerdrModule;

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

interface HerdrScenario {
  existingLabels?: string[];
  brokenCreateLabels?: string[];
  brokenPaneLabels?: string[];
}

function mockHerdr(t: TestContext, scenario: HerdrScenario, closedTabIds?: string[]): void {
  t.mock.method(childProcess, "execFile", (_command: string, args: string[], callback: ExecFileCallback) => {
    if (args[0] === "tab" && args[1] === "list") {
      const tabs = (scenario.existingLabels ?? []).map((label, index) => ({
        tab_id: `w1:t${index}`,
        label,
        workspace_id: "w1",
      }));
      callback(null, JSON.stringify({ result: { tabs } }), "");
      return;
    }
    if (args[0] === "tab" && args[1] === "create") {
      const labelIndex = args.indexOf("--label");
      const label = args[labelIndex + 1];
      if (scenario.brokenCreateLabels?.includes(label)) {
        callback(null, JSON.stringify({ error: { code: "internal", message: "boom" } }), "");
        return;
      }
      callback(
        null,
        JSON.stringify({
          result: {
            root_pane: { pane_id: `pane-${label}` },
            tab: { tab_id: `tab-${label}` },
          },
        }),
        "",
      );
      return;
    }
    if (args[0] === "tab" && args[1] === "close") {
      const tabId = args[2];
      closedTabIds?.push(tabId);
      callback(null, JSON.stringify({ result: null }), "");
      return;
    }
    if (args[0] === "pane" && (args[1] === "send-text" || args[1] === "send-keys")) {
      const label = args[2]?.startsWith("pane-") ? args[2].slice("pane-".length) : undefined;
      if (label && scenario.brokenPaneLabels?.includes(label)) {
        callback(null, JSON.stringify({ error: { code: "internal", message: "pane boom" } }), "");
        return;
      }
      callback(null, JSON.stringify({ result: null }), "");
      return;
    }
    callback(new Error(`unexpected herdr args: ${args.join(" ")}`), "", "");
  });
}

function mockHerdrUnavailable(t: TestContext): void {
  t.mock.method(childProcess, "execFile", (_command: string, _args: string[], callback: ExecFileCallback) => {
    const error = new Error("spawn herdr ENOENT") as NodeJS.ErrnoException;
    error.code = "ENOENT";
    callback(error, "", "");
  });
}

test("re-throws and logs when herdr is unavailable", async (t) => {
  mockHerdrUnavailable(t);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  await assert.rejects(runDispatcher([], "claude-task-worker all"), /herdr/);
  assert.ok(errorLogs.some((line) => line.startsWith("[dispatcher] ")));
});

test("logs a non-Error thrown value via String(error) when herdr availability check fails", async (t) => {
  t.mock.method(childProcess, "execFile", () => {
    throw "boom (not an Error instance)";
  });
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  await assert.rejects(runDispatcher([], "claude-task-worker all"));
  assert.ok(errorLogs.some((line) => line === "[dispatcher] boom (not an Error instance)"));
});

test("skips a project whose label already has a tab and does not create a new one", async (t) => {
  mockHerdr(t, { existingLabels: ["my-app"] });
  const warnLogs: string[] = [];
  t.mock.method(console, "warn", (message: string) => {
    warnLogs.push(message);
  });

  const projects: ResolvedProject[] = [{ name: "my-app", path: "/tmp/my-app" }];
  const sessions = await runDispatcher(projects, "claude-task-worker all");

  assert.equal(sessions.size, 0);
  assert.ok(warnLogs.some((line) => line.includes("my-app")));
});

test("registers a WorkerSession in the SessionRegistry on success", async (t) => {
  mockHerdr(t, {});

  const projects: ResolvedProject[] = [{ name: "my-app", path: "/tmp/my-app" }];
  const sessions = await runDispatcher(projects, "claude-task-worker all");

  assert.equal(sessions.size, 1);
  const session = sessions.get("my-app");
  assert.ok(session);
  assert.equal(session?.name, "my-app");
  assert.equal(session?.tabId, "tab-my-app");
  assert.equal(session?.paneId, "pane-my-app");
  assert.equal(session?.status, "running");
  assert.ok(session?.startedAt instanceof Date);
});

test("continues dispatching remaining projects when one project fails", async (t) => {
  mockHerdr(t, { brokenCreateLabels: ["broken-app"] });
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const projects: ResolvedProject[] = [
    { name: "broken-app", path: "/tmp/broken-app" },
    { name: "my-app", path: "/tmp/my-app" },
  ];
  const sessions = await runDispatcher(projects, "claude-task-worker all");

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
  assert.ok(!sessions.has("broken-app"));
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "broken-app"')));
});

test("closes the dangling tab when sending the command to a created tab fails", async (t) => {
  const closedTabIds: string[] = [];
  mockHerdr(t, { brokenPaneLabels: ["broken-app"] }, closedTabIds);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const projects: ResolvedProject[] = [
    { name: "broken-app", path: "/tmp/broken-app" },
    { name: "my-app", path: "/tmp/my-app" },
  ];
  const sessions = await runDispatcher(projects, "claude-task-worker all");

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
  assert.ok(!sessions.has("broken-app"));
  assert.deepEqual(closedTabIds, ["tab-broken-app"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "broken-app"')));
});

function mockTabClose(t: TestContext, closedTabIds: string[]): void {
  t.mock.method(childProcess, "execFile", (_command: string, args: string[], callback: ExecFileCallback) => {
    if (args[0] === "tab" && args[1] === "close") {
      closedTabIds.push(args[2]);
      callback(null, JSON.stringify({ result: null }), "");
      return;
    }
    callback(new Error(`unexpected herdr args: ${args.join(" ")}`), "", "");
  });
}

function makeSession(overrides: Partial<DispatcherModule.WorkerSession> = {}): DispatcherModule.WorkerSession {
  return {
    name: "my-app",
    tabId: "tab-my-app",
    paneId: "pane-my-app",
    startedAt: new Date(),
    status: "running",
    ...overrides,
  };
}

test("pollOnce keeps a session that still has a claude-task-worker foreground process", async () => {
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
});

test("pollOnce removes a session and closes the tab when the pane returned to the shell", async (t) => {
  const closedTabIds: string[] = [];
  mockTabClose(t, closedTabIds);
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "zsh", argv: [], cmdline: "zsh", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.equal(sessions.size, 0);
  assert.deepEqual(closedTabIds, ["tab-my-app"]);
});

test("pollOnce removes a session without closing the tab when the pane is gone", async (t) => {
  const closedTabIds: string[] = [];
  mockTabClose(t, closedTabIds);
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => {
      throw new HerdrError("herdr pane process-info failed: [pane_not_found] no such pane", "pane_not_found");
    },
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.equal(sessions.size, 0);
  assert.deepEqual(closedTabIds, []);
});

test("pollOnce keeps a session and logs on a transient error other than pane_not_found", async (t) => {
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => {
      throw new HerdrError("herdr pane process-info failed: [internal] boom", "internal");
    },
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to poll session "my-app"')));
});

test("monitorSessions resolves done once all sessions disappear", async (t) => {
  const closedTabIds: string[] = [];
  mockTabClose(t, closedTabIds);
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "zsh", argv: [], cmdline: "zsh", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  const handle = monitorSessions(sessions, fakeHerdr, { pollIntervalMs: 5, renderIntervalMs: 1000 });

  await handle.done;

  assert.equal(sessions.size, 0);
});

test("monitorSessions stop() clears intervals and resolves done", async () => {
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  const handle = monitorSessions(sessions, fakeHerdr, { pollIntervalMs: 1000, renderIntervalMs: 1000 });
  handle.stop();

  await handle.done;

  assert.equal(sessions.size, 1);
});
