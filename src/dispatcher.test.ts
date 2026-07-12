import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type * as ChildProcess from "node:child_process";
import type * as DispatcherModule from "./dispatcher";
import type * as HerdrModule from "./herdr";
import type { ResolvedProject } from "./projects-config";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const { runDispatcher, pollOnce, monitorSessions, shutdownDispatcher, createDispatcherShutdownHandler } =
  (await import("./dispatcher.ts")) as typeof DispatcherModule;
const { HerdrError } = (await import("./herdr.ts")) as typeof HerdrModule;

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

interface HerdrScenario {
  existingLabels?: string[];
  brokenCreateLabels?: string[];
  brokenPaneLabels?: string[];
}

function mockHerdr(t: TestContext, scenario: HerdrScenario, closedTabIds?: string[]): void {
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
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
    },
  );
}

function mockHerdrUnavailable(t: TestContext): void {
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
      const error = new Error("spawn herdr ENOENT") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      callback(error, "", "");
    },
  );
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

test("registers the session immediately after tabCreate, before awaiting paneSendText/paneSendKeys (regression guard against tab leak on shutdown)", async () => {
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const tabCreateIndex = source.indexOf("await tabCreate(");
  const sessionsSetIndex = source.indexOf("sessions.set(", tabCreateIndex);
  const paneSendTextIndex = source.indexOf("await paneSendText(", tabCreateIndex);
  assert.ok(tabCreateIndex !== -1 && sessionsSetIndex !== -1 && paneSendTextIndex !== -1);
  assert.ok(
    sessionsSetIndex < paneSendTextIndex,
    "sessions.set() must run right after tabCreate() resolves, before the paneSendText/paneSendKeys awaits, so a SIGINT/SIGTERM arriving during those awaits still sees the tab in the SessionRegistry",
  );
});

test("closes the dangling tab and removes the leaked session when paneSendKeys (the second await) fails after paneSendText already succeeded", async (t) => {
  const closedTabIds: string[] = [];
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (args[0] === "tab" && args[1] === "list") {
        callback(null, JSON.stringify({ result: { tabs: [] } }), "");
        return;
      }
      if (args[0] === "tab" && args[1] === "create") {
        const labelIndex = args.indexOf("--label");
        const label = args[labelIndex + 1];
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
        closedTabIds.push(args[2]);
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "pane" && args[1] === "send-text") {
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "pane" && args[1] === "send-keys") {
        callback(null, JSON.stringify({ error: { code: "internal", message: "send-keys boom" } }), "");
        return;
      }
      callback(new Error(`unexpected herdr args: ${args.join(" ")}`), "", "");
    },
  );
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const projects: ResolvedProject[] = [{ name: "my-app", path: "/tmp/my-app" }];
  const sessions = await runDispatcher(projects, "claude-task-worker all");

  assert.equal(sessions.size, 0);
  assert.deepEqual(closedTabIds, ["tab-my-app"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "my-app"')));
});

function mockTabClose(t: TestContext, closedTabIds: string[]): void {
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (args[0] === "tab" && args[1] === "close") {
        closedTabIds.push(args[2]);
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      callback(new Error(`unexpected herdr args: ${args.join(" ")}`), "", "");
    },
  );
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

test("pollOnce treats a foreground process with a missing cmdline as not alive instead of throwing", async (t) => {
  const closedTabIds: string[] = [];
  mockTabClose(t, closedTabIds);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: undefined as unknown as string, pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await assert.doesNotReject(pollOnce(sessions, fakeHerdr));

  assert.equal(sessions.size, 0);
  assert.deepEqual(closedTabIds, ["tab-my-app"]);
  assert.equal(errorLogs.length, 0);
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

test("monitorSessions does not unref its intervals, so --project keeps the process alive to render the status table (regression guard)", async () => {
  // 監視インターバルを unref すると、--project ディスパッチ後に他へ生存を委ねる参照が無く
  // イベントループが空になりプロセスが即終了する（ステータステーブルが表示されない）。
  // 稼働セッションが残る限りループを生かし続けるため、両インターバルは unref しない。
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const monitorSessionsIndex = source.indexOf("export function monitorSessions(");
  assert.ok(monitorSessionsIndex !== -1);
  const monitorSessionsBody = source.slice(monitorSessionsIndex);
  assert.ok(
    !/(pollInterval|renderInterval)\.unref\(\)/.test(monitorSessionsBody),
    "monitorSessions must NOT call unref() on pollInterval/renderInterval; otherwise the --project dispatcher process exits immediately instead of monitoring sessions and rendering the status table",
  );
});

function mockProcessExit(t: TestContext): number[] {
  const exitCodes: number[] = [];
  t.mock.method(process, "exit", ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);
  return exitCodes;
}

function makeShutdownFakeHerdr(options: {
  ctrlCThreshold?: Record<string, number>;
  ctrlCCounts: Record<string, number>;
  closedTabIds: string[];
}): typeof HerdrModule {
  const { ctrlCThreshold = {}, ctrlCCounts, closedTabIds } = options;
  return {
    HerdrError,
    paneSendKeys: async (paneId: string) => {
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
    },
    paneProcessInfo: async (paneId: string) => {
      const threshold = ctrlCThreshold[paneId] ?? 1;
      const isAlive = (ctrlCCounts[paneId] ?? 0) < threshold;
      return {
        foregroundProcesses: isAlive
          ? [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }]
          : [{ name: "zsh", argv: [], cmdline: "zsh", pid: 123 }],
      };
    },
    tabClose: async (tabId: string) => {
      closedTabIds.push(tabId);
    },
  } as unknown as typeof HerdrModule;
}

test("shutdownDispatcher: 全セッションが1回目のctrl-c送信後にタイムアウト前に終了する", async (t) => {
  const exitCodes = mockProcessExit(t);
  // pollOnce の removeSession は herdr パラメータを無視して実際の herdr バイナリを
  // 呼び出すため、テストでは実プロセス起動を避けるべく execFile をモックする。
  mockTabClose(t, []);
  const ctrlCCounts: Record<string, number> = {};
  const closedTabIds: string[] = [];
  const fakeHerdr = makeShutdownFakeHerdr({ ctrlCCounts, closedTabIds });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 200,
    retryTimeoutMs: 200,
    tabCloseTimeoutMs: 50,
  });

  assert.equal(ctrlCCounts[session.paneId], 1);
  assert.equal(sessions.size, 0);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: 1回目タイムアウト後、生存paneにのみ再送1回して短縮タイムアウトで再待機する", async (t) => {
  const exitCodes = mockProcessExit(t);
  mockTabClose(t, []);
  const ctrlCCounts: Record<string, number> = {};
  const closedTabIds: string[] = [];
  const fakeHerdr = makeShutdownFakeHerdr({
    ctrlCCounts,
    closedTabIds,
    ctrlCThreshold: { "pane-my-app": 2 },
  });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    retryTimeoutMs: 200,
    tabCloseTimeoutMs: 50,
  });

  assert.equal(ctrlCCounts[session.paneId], 2);
  assert.equal(sessions.size, 0);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: 同時に2回呼んでも二重送信・二重待機・二重tabCloseが起きない", async (t) => {
  const exitCodes = mockProcessExit(t);
  mockTabClose(t, []);
  const ctrlCCounts: Record<string, number> = {};
  const closedTabIds: string[] = [];
  const fakeHerdr = makeShutdownFakeHerdr({ ctrlCCounts, closedTabIds });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const shutdownOptions = {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 200,
    retryTimeoutMs: 200,
    tabCloseTimeoutMs: 50,
  };

  const p1 = shutdownDispatcher(sessions, undefined, shutdownOptions);
  const p2 = shutdownDispatcher(sessions, undefined, shutdownOptions);
  await Promise.all([p1, p2]);

  assert.equal(ctrlCCounts[session.paneId], 1);
  assert.deepEqual(closedTabIds, []);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: monitorHandleが渡された場合stop()/done経由で先に停止してから待機に切り替わる", async (t) => {
  const exitCodes = mockProcessExit(t);
  mockTabClose(t, []);
  const order: string[] = [];
  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const monitorHandle: DispatcherModule.MonitorHandle = {
    stop: () => {
      order.push("stop");
      setTimeout(() => {
        order.push("done-resolved");
        resolveDone();
      }, 5);
    },
    done,
  };

  const ctrlCCounts: Record<string, number> = {};
  const closedTabIds: string[] = [];
  const fakeHerdr = {
    ...makeShutdownFakeHerdr({ ctrlCCounts, closedTabIds }),
    paneSendKeys: async (paneId: string) => {
      order.push("sendCtrlC");
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
    },
  } as unknown as typeof HerdrModule;

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, monitorHandle, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 200,
    retryTimeoutMs: 200,
    tabCloseTimeoutMs: 50,
  });

  assert.deepEqual(order, ["stop", "done-resolved", "sendCtrlC"]);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: 残っている全タブがtabCloseで閉じられ、失敗しても他のcloseとプロセス終了がブロックされない", async (t) => {
  const exitCodes = mockProcessExit(t);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const closedTabIds: string[] = [];
  const sessionA = makeSession({ name: "app-a", tabId: "tab-a", paneId: "pane-a" });
  const sessionB = makeSession({ name: "app-b", tabId: "tab-b", paneId: "pane-b" });
  const sessions: DispatcherModule.SessionRegistry = new Map([
    [sessionA.name, sessionA],
    [sessionB.name, sessionB],
  ]);

  const fakeHerdr = {
    HerdrError,
    paneSendKeys: async () => {},
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
    tabClose: async (tabId: string) => {
      if (tabId === "tab-a") {
        throw new Error("tabClose boom");
      }
      closedTabIds.push(tabId);
    },
  } as unknown as typeof HerdrModule;

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    retryTimeoutMs: 20,
    tabCloseTimeoutMs: 50,
  });

  assert.deepEqual(closedTabIds, ["tab-b"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to close tab "tab-a"')));
  assert.deepEqual(exitCodes, [1]);
});

test("shutdownDispatcher: 全タブのcloseに成功してもセッションが最終的に終了しなければexit(1)する", async (t) => {
  const exitCodes = mockProcessExit(t);
  const closedTabIds: string[] = [];
  const ctrlCCounts: Record<string, number> = {};
  const fakeHerdr = {
    HerdrError,
    paneSendKeys: async (paneId: string) => {
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
    },
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
    tabClose: async (tabId: string) => {
      closedTabIds.push(tabId);
    },
  } as unknown as typeof HerdrModule;

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    retryTimeoutMs: 20,
    tabCloseTimeoutMs: 50,
  });

  assert.deepEqual(closedTabIds, [session.tabId]);
  assert.deepEqual(exitCodes, [1]);
});

test("shutdownDispatcher: forceKill:true を指定した2回目の呼び出しは1回目の完了を待たず強制的にctrl-c再送・tabClose・exit(1)を行う", async (t) => {
  const exitCodes = mockProcessExit(t);
  const ctrlCCounts: Record<string, number> = {};
  const closedTabIds: string[] = [];
  const fakeHerdr = {
    HerdrError,
    paneSendKeys: async (paneId: string) => {
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
    },
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
    tabClose: async (tabId: string) => {
      closedTabIds.push(tabId);
    },
  } as unknown as typeof HerdrModule;

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  const firstShutdown = shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 50,
    retryTimeoutMs: 50,
    tabCloseTimeoutMs: 50,
  });

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    tabCloseTimeoutMs: 50,
    forceKill: true,
  });

  assert.ok((ctrlCCounts[session.paneId] ?? 0) >= 1);
  assert.ok(closedTabIds.includes(session.tabId));
  assert.ok(exitCodes.includes(1));

  await firstShutdown;
});

test("createDispatcherShutdownHandler: 1回目のシグナルは forceKill なしで shutdown を呼び isShuttingDown を true にする", async () => {
  const calls: (DispatcherModule.ShutdownOptions | undefined)[] = [];
  const controller = createDispatcherShutdownHandler(async (options) => {
    calls.push(options);
  });

  assert.equal(controller.isShuttingDown(), false);
  await controller.handle();

  assert.equal(controller.isShuttingDown(), true);
  assert.deepEqual(calls, [undefined]);
});

test("createDispatcherShutdownHandler: 2回目のシグナルは { forceKill: true } 付きで shutdown を呼ぶ（ダブルCtrl-Cでforce-kill）", async () => {
  const calls: (DispatcherModule.ShutdownOptions | undefined)[] = [];
  const controller = createDispatcherShutdownHandler(async (options) => {
    calls.push(options);
  });

  await controller.handle();
  await controller.handle();

  assert.equal(calls.length, 2);
  assert.equal(calls[0], undefined);
  assert.deepEqual(calls[1], { forceKill: true });
});

test("createDispatcherShutdownHandler: 1回目の shutdown が in-flight のまま2回目・3回目のシグナルが届いても shutdown は高々2回しか呼ばれない（flag は await 前に同期セットされる保証）", async () => {
  const calls: (DispatcherModule.ShutdownOptions | undefined)[] = [];
  let releaseShutdown!: () => void;
  const shutdownGate = new Promise<void>((resolve) => {
    releaseShutdown = resolve;
  });
  const controller = createDispatcherShutdownHandler(async (options) => {
    calls.push(options);
    await shutdownGate;
  });

  // 3回とも await せず起動する。shutdownGate 未解決のため1回目の shutdown() は in-flight のまま。
  // handle() も shutdown() も、フラグ更新と calls.push を最初の await より前に同期実行するため、
  // この3行を実行し終えた時点で calls は同期的に確定している。
  const p1 = controller.handle();
  const p2 = controller.handle();
  const p3 = controller.handle();

  // in-flight 状態での検証: 1回目=graceful(undefined) / 2回目=forceKill / 3回目は無視。
  // もしフラグ更新が await の後に移動するリグレッションが入ると、2回目・3回目が
  // graceful パスを重複実行し calls が [undefined, undefined, ...] になって検出できる。
  assert.deepEqual(calls, [undefined, { forceKill: true }]);
  assert.equal(controller.isShuttingDown(), true);

  releaseShutdown();
  await Promise.all([p1, p2, p3]);

  // ゲート解放後も追加の shutdown 呼び出しは発生しない。
  assert.deepEqual(calls, [undefined, { forceKill: true }]);
});

test("createDispatcherShutdownHandler: graceful shutdown が reject した場合はログ出力して process.exit(1) し、未処理rejectionにしない", async (t) => {
  const exitCodes = mockProcessExit(t);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const controller = createDispatcherShutdownHandler(async () => {
    throw new Error("shutdown boom");
  });

  await assert.doesNotReject(controller.handle());

  assert.deepEqual(exitCodes, [1]);
  assert.ok(errorLogs.some((line) => line.startsWith("[dispatcher] shutdown failed")));
});

test("createDispatcherShutdownHandler: force-kill shutdown が reject した場合もログ出力して process.exit(1) する", async (t) => {
  const exitCodes = mockProcessExit(t);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const controller = createDispatcherShutdownHandler(async (options) => {
    if (options?.forceKill) {
      throw new Error("force-kill boom");
    }
  });

  await controller.handle();
  await assert.doesNotReject(controller.handle());

  assert.deepEqual(exitCodes, [1]);
  assert.ok(errorLogs.some((line) => line.startsWith("[dispatcher] force-kill shutdown failed")));
});
