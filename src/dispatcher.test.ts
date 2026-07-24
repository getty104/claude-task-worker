import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import type * as ChildProcess from "node:child_process";
import type * as DispatcherModule from "./dispatcher";
import type * as HerdrModule from "./herdr";
import type { ResolvedProject } from "./user-config";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const {
  runDispatcher,
  pollOnce,
  monitorSessions,
  shutdownDispatcher,
  createDispatcherShutdownHandler,
  waitForPaneReady,
  waitForWorkerStartup,
  startWorkerInPane,
} = (await import("./dispatcher")) as typeof DispatcherModule;
const { HerdrError } = (await import("./herdr")) as typeof HerdrModule;

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

interface HerdrScenario {
  existingLabels?: string[];
  brokenCreateLabels?: string[];
  brokenPaneLabels?: string[];
  // ワーカーが起動しないままのペイン（process-info がシェルのみを返す）
  neverStartingLabels?: string[];
  // `workspace list` で focused: true を返すワークスペースID（フォーカス復元の検証用）
  focusedWorkspaceId?: string;
}

// プロンプト待ち・起動確認のポーリングでテストを待たせないための短縮設定。
const FAST_TIMING = {
  paneReadyTimeoutMs: 50,
  paneReadyPollIntervalMs: 1,
  workerStartupTimeoutMs: 50,
  workerStartupPollIntervalMs: 1,
};

function mockHerdr(
  t: TestContext,
  scenario: HerdrScenario,
  closedWorkspaceIds?: string[],
  createdLabels?: string[],
  focusedWorkspaceIds?: string[],
): void {
  // 実 herdr は workspace close のたびに別ワークスペースへフォーカスを移すため、
  // その挙動を再現してディスパッチャー側のフォーカス復元を検証できるようにする。
  let currentFocusedWorkspaceId = scenario.focusedWorkspaceId;
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (args[0] === "workspace" && args[1] === "list") {
        const workspaces = (scenario.existingLabels ?? []).map((label, index) => ({
          workspace_id: `w${index}`,
          label,
          focused: `w${index}` === currentFocusedWorkspaceId,
        }));
        if (scenario.focusedWorkspaceId) {
          workspaces.push({
            workspace_id: scenario.focusedWorkspaceId,
            label: "user",
            focused: scenario.focusedWorkspaceId === currentFocusedWorkspaceId,
          });
        }
        callback(null, JSON.stringify({ result: { workspaces } }), "");
        return;
      }
      if (args[0] === "workspace" && args[1] === "focus") {
        focusedWorkspaceIds?.push(args[2]);
        currentFocusedWorkspaceId = args[2];
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      // checkHerdrAvailable は疎通確認に tab list を使う。
      if (args[0] === "tab" && args[1] === "list") {
        callback(null, JSON.stringify({ result: { tabs: [] } }), "");
        return;
      }
      if (args[0] === "tab" && args[1] === "rename") {
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "workspace" && args[1] === "create") {
        const labelIndex = args.indexOf("--label");
        const rawLabel = args[labelIndex + 1];
        createdLabels?.push(rawLabel);
        // ラベルには "ctw:" プレフィックスが付与されるため、id導出・シナリオ判定は
        // プレフィックスを剥がしたプロジェクト名ベースで行う。
        const label = rawLabel.startsWith("ctw:") ? rawLabel.slice("ctw:".length) : rawLabel;
        if (scenario.brokenCreateLabels?.includes(label)) {
          callback(null, JSON.stringify({ error: { code: "internal", message: "boom" } }), "");
          return;
        }
        callback(
          null,
          JSON.stringify({
            result: {
              workspace: { workspace_id: `ws-${label}`, label: rawLabel },
              root_pane: { pane_id: `pane-${label}`, tab_id: `tab-${label}` },
              tab: { tab_id: `tab-${label}` },
            },
          }),
          "",
        );
        return;
      }
      if (args[0] === "workspace" && args[1] === "close") {
        closedWorkspaceIds?.push(args[2]);
        currentFocusedWorkspaceId = "ws-stolen-by-herdr";
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
      // `pane read` は JSON エンベロープではなく端末内容の生テキストを返す。
      if (args[0] === "pane" && args[1] === "read") {
        callback(null, "[user:~/my-app]$ ", "");
        return;
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        const paneId = args[args.indexOf("--pane") + 1];
        const label = paneId?.startsWith("pane-") ? paneId.slice("pane-".length) : undefined;
        const foreground =
          label && scenario.neverStartingLabels?.includes(label)
            ? { name: "zsh", argv: ["-zsh"], cmdline: "-zsh", pid: 100 }
            : { name: "node", argv: [], cmdline: "node /usr/local/lib/claude-task-worker/dist/index.js all", pid: 101 };
        callback(null, JSON.stringify({ result: { process_info: { foreground_processes: [foreground] } } }), "");
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
  mockHerdr(t, { existingLabels: ["ctw:my-app"] });
  const warnLogs: string[] = [];
  t.mock.method(console, "warn", (message: string) => {
    warnLogs.push(message);
  });

  const projects: ResolvedProject[] = [{ name: "my-app", path: "/tmp/my-app" }];
  const sessions = await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.equal(sessions.size, 0);
  assert.ok(warnLogs.some((line) => line.includes("my-app")));
});

test("creates tabs with a 'ctw:' prefixed label", async (t) => {
  const createdLabels: string[] = [];
  mockHerdr(t, {}, undefined, createdLabels);

  const projects: ResolvedProject[] = [
    { name: "my-app", path: "/tmp/my-app" },
    { name: "other-app", path: "/tmp/other-app" },
  ];
  await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.deepEqual(createdLabels, ["ctw:my-app", "ctw:other-app"]);
});

test("registers a WorkerSession in the SessionRegistry on success", async (t) => {
  mockHerdr(t, {});

  const projects: ResolvedProject[] = [{ name: "my-app", path: "/tmp/my-app" }];
  const sessions = await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.equal(sessions.size, 1);
  const session = sessions.get("my-app");
  assert.ok(session);
  assert.equal(session?.name, "my-app");
  assert.equal(session?.workspaceId, "ws-my-app");
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
  const sessions = await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
  assert.ok(!sessions.has("broken-app"));
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "broken-app"')));
});

test("closes the dangling tab when sending the command to a created tab fails", async (t) => {
  const closedWorkspaceIds: string[] = [];
  mockHerdr(t, { brokenPaneLabels: ["broken-app"] }, closedWorkspaceIds);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const projects: ResolvedProject[] = [
    { name: "broken-app", path: "/tmp/broken-app" },
    { name: "my-app", path: "/tmp/my-app" },
  ];
  const sessions = await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
  assert.ok(!sessions.has("broken-app"));
  assert.deepEqual(closedWorkspaceIds, ["ws-broken-app"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "broken-app"')));
});

test("restores the user's focused workspace after closing a dangling workspace", async (t) => {
  const closedWorkspaceIds: string[] = [];
  const focusedWorkspaceIds: string[] = [];
  mockHerdr(
    t,
    { brokenPaneLabels: ["broken-app"], focusedWorkspaceId: "ws-user" },
    closedWorkspaceIds,
    undefined,
    focusedWorkspaceIds,
  );
  t.mock.method(console, "error", () => {});

  const projects: ResolvedProject[] = [{ name: "broken-app", path: "/tmp/broken-app" }];
  await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.deepEqual(closedWorkspaceIds, ["ws-broken-app"]);
  assert.deepEqual(focusedWorkspaceIds, ["ws-user"]);
});

test("registers the session immediately after workspaceCreate, before awaiting the command dispatch (regression guard against workspace leak on shutdown)", async () => {
  const source = await readFile(new URL("./dispatcher.ts", import.meta.url), "utf8");
  const workspaceCreateIndex = source.indexOf("await workspaceCreate(");
  const sessionsSetIndex = source.indexOf("sessions.set(", workspaceCreateIndex);
  const startWorkerIndex = source.indexOf("await startWorkerInPane(", workspaceCreateIndex);
  assert.ok(workspaceCreateIndex !== -1 && sessionsSetIndex !== -1 && startWorkerIndex !== -1);
  assert.ok(
    sessionsSetIndex < startWorkerIndex,
    "sessions.set() must run right after workspaceCreate() resolves, before the startWorkerInPane await, so a SIGINT/SIGTERM arriving during the prompt wait / send / startup wait still sees the workspace in the SessionRegistry",
  );
});

test("closes the dangling tab and removes the leaked session when paneSendKeys (the second await) fails after paneSendText already succeeded", async (t) => {
  const closedWorkspaceIds: string[] = [];
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (args[0] === "tab" && args[1] === "list") {
        callback(null, JSON.stringify({ result: { tabs: [] } }), "");
        return;
      }
      if (args[0] === "workspace" && args[1] === "list") {
        callback(null, JSON.stringify({ result: { workspaces: [] } }), "");
        return;
      }
      if (args[0] === "tab" && args[1] === "rename") {
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "workspace" && args[1] === "create") {
        const labelIndex = args.indexOf("--label");
        const rawLabel = args[labelIndex + 1];
        const label = rawLabel.startsWith("ctw:") ? rawLabel.slice("ctw:".length) : rawLabel;
        callback(
          null,
          JSON.stringify({
            result: {
              workspace: { workspace_id: `ws-${label}`, label: rawLabel },
              root_pane: { pane_id: `pane-${label}`, tab_id: `tab-${label}` },
            },
          }),
          "",
        );
        return;
      }
      if (args[0] === "workspace" && args[1] === "close") {
        closedWorkspaceIds.push(args[2]);
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "pane" && args[1] === "read") {
        callback(null, "[user:~/my-app]$ ", "");
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
  const sessions = await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.equal(sessions.size, 0);
  assert.deepEqual(closedWorkspaceIds, ["ws-my-app"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "my-app"')));
});

test("waits for the pane prompt before sending the command so a shell still initializing cannot swallow it", async (t) => {
  const calls: string[] = [];
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      calls.push(args.slice(0, 2).join(" "));
      if (args[0] === "pane" && args[1] === "read") {
        // 最初の2回はシェル初期化中で何も描画されていない状態を返す。
        const reads = calls.filter((call) => call === "pane read").length;
        callback(null, reads <= 2 ? "" : "[user:~/my-app]$ ", "");
        return;
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        callback(
          null,
          JSON.stringify({
            result: {
              process_info: {
                foreground_processes: [{ name: "node", argv: [], cmdline: "claude-task-worker all", pid: 1 }],
              },
            },
          }),
          "",
        );
        return;
      }
      callback(null, JSON.stringify({ result: null }), "");
    },
  );

  const herdr = (await import("./herdr")) as typeof HerdrModule;
  const started = await startWorkerInPane("pane-my-app", "claude-task-worker all", herdr, FAST_TIMING);

  assert.equal(started, true);
  const firstSendIndex = calls.indexOf("pane send-text");
  const readsBeforeSend = calls.slice(0, firstSendIndex).filter((call) => call === "pane read").length;
  assert.ok(readsBeforeSend >= 3, `expected the prompt to be polled before sending, got calls: ${calls.join(", ")}`);
});

test("resends the command when the worker process never appears, then gives up after the attempt limit", async (t) => {
  const sendTextCount = { value: 0 };
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (args[0] === "pane" && args[1] === "read") {
        callback(null, "[user:~/my-app]$ ", "");
        return;
      }
      if (args[0] === "pane" && args[1] === "send-text") {
        sendTextCount.value += 1;
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        // 入力が捨てられ、フォアグラウンドがシェルのままのケース。
        callback(
          null,
          JSON.stringify({
            result: {
              process_info: { foreground_processes: [{ name: "zsh", argv: ["-zsh"], cmdline: "-zsh", pid: 1 }] },
            },
          }),
          "",
        );
        return;
      }
      callback(null, JSON.stringify({ result: null }), "");
    },
  );
  t.mock.method(console, "warn", () => {});

  const herdr = (await import("./herdr")) as typeof HerdrModule;
  const started = await startWorkerInPane("pane-my-app", "claude-task-worker all", herdr, {
    ...FAST_TIMING,
    sendMaxAttempts: 3,
  });

  assert.equal(started, false);
  assert.equal(sendTextCount.value, 3);
});

test("closes the tab and drops the session when the worker never starts in the dispatched pane", async (t) => {
  const closedWorkspaceIds: string[] = [];
  mockHerdr(t, { neverStartingLabels: ["dead-app"] }, closedWorkspaceIds);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });
  t.mock.method(console, "warn", () => {});

  const projects: ResolvedProject[] = [
    { name: "dead-app", path: "/tmp/dead-app" },
    { name: "my-app", path: "/tmp/my-app" },
  ];
  const sessions = await runDispatcher(projects, "claude-task-worker all", FAST_TIMING);

  assert.equal(sessions.size, 1);
  assert.ok(sessions.has("my-app"));
  assert.deepEqual(closedWorkspaceIds, ["ws-dead-app"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to dispatch project "dead-app"')));
});

test("waitForPaneReady returns false when the pane stays empty until the timeout", async (t) => {
  t.mock.method(childProcess, "execFile", (_c: string, _a: string[], _o: unknown, callback: ExecFileCallback) => {
    callback(null, "", "");
  });

  const herdr = (await import("./herdr")) as typeof HerdrModule;
  const ready = await waitForPaneReady("pane-my-app", herdr, { timeoutMs: 20, pollIntervalMs: 1 });

  assert.equal(ready, false);
});

test("waitForWorkerStartup returns true once a claude-task-worker process appears", async (t) => {
  let polls = 0;
  t.mock.method(childProcess, "execFile", (_c: string, _a: string[], _o: unknown, callback: ExecFileCallback) => {
    polls += 1;
    const foreground =
      polls < 3
        ? { name: "zsh", argv: ["-zsh"], cmdline: "-zsh", pid: 1 }
        : { name: "node", argv: [], cmdline: "claude-task-worker all", pid: 2 };
    callback(null, JSON.stringify({ result: { process_info: { foreground_processes: [foreground] } } }), "");
  });

  const herdr = (await import("./herdr")) as typeof HerdrModule;
  const started = await waitForWorkerStartup("pane-my-app", herdr, { timeoutMs: 500, pollIntervalMs: 1 });

  assert.equal(started, "started");
  assert.ok(polls >= 3);
});

test("waitForWorkerStartup returns other when the foreground process is neither a shell nor the worker", async (t) => {
  t.mock.method(childProcess, "execFile", (_c: string, _a: string[], _o: unknown, callback: ExecFileCallback) => {
    callback(
      null,
      JSON.stringify({
        result: {
          process_info: {
            foreground_processes: [{ name: "npm", argv: ["run", "dev"], cmdline: "npm run dev", pid: 1 }],
          },
        },
      }),
      "",
    );
  });

  const herdr = (await import("./herdr")) as typeof HerdrModule;
  const result = await waitForWorkerStartup("pane-my-app", herdr, { timeoutMs: 500, pollIntervalMs: 1 });

  assert.equal(result, "other");
});

test("gives up immediately without resending when the foreground process is neither a shell nor the worker", async (t) => {
  const sendTextCount = { value: 0 };
  t.mock.method(
    childProcess,
    "execFile",
    (_command: string, args: string[], _options: unknown, callback: ExecFileCallback) => {
      if (args[0] === "pane" && args[1] === "read") {
        callback(null, "[user:~/my-app]$ ", "");
        return;
      }
      if (args[0] === "pane" && args[1] === "send-text") {
        sendTextCount.value += 1;
        callback(null, JSON.stringify({ result: null }), "");
        return;
      }
      if (args[0] === "pane" && args[1] === "process-info") {
        callback(
          null,
          JSON.stringify({
            result: {
              process_info: {
                foreground_processes: [{ name: "npm", argv: ["run", "dev"], cmdline: "npm run dev", pid: 1 }],
              },
            },
          }),
          "",
        );
        return;
      }
      callback(null, JSON.stringify({ result: null }), "");
    },
  );
  t.mock.method(console, "warn", () => {});

  const herdr = (await import("./herdr")) as typeof HerdrModule;
  const started = await startWorkerInPane("pane-my-app", "claude-task-worker all", herdr, {
    ...FAST_TIMING,
    sendMaxAttempts: 3,
  });

  assert.equal(started, false);
  assert.equal(sendTextCount.value, 1);
});

interface WorkspaceFakeState {
  workspaceIds: string[];
  focusedWorkspaceId: string | undefined;
  closedWorkspaceIds: string[];
  focusCalls: string[];
}

// herdr の workspace 系コマンドの偽実装。実 herdr は `workspace close` の際、
// 閉じたワークスペースがフォーカスされていなくても別のワークスペースへ
// フォーカスを移すため、その挙動まで再現してフォーカス復元をテストできるようにする。
function makeWorkspaceFake(options?: { workspaceIds?: string[]; focusedWorkspaceId?: string }): {
  state: WorkspaceFakeState;
  methods: Pick<typeof HerdrModule, "workspaceList" | "workspaceClose" | "workspaceFocus">;
} {
  const state: WorkspaceFakeState = {
    workspaceIds: [...(options?.workspaceIds ?? ["ws-user", "ws-my-app"])],
    focusedWorkspaceId: options?.focusedWorkspaceId ?? "ws-user",
    closedWorkspaceIds: [],
    focusCalls: [],
  };
  return {
    state,
    methods: {
      workspaceList: async () =>
        state.workspaceIds.map((workspaceId) => ({
          workspaceId,
          label: workspaceId,
          focused: workspaceId === state.focusedWorkspaceId,
        })),
      workspaceClose: async (workspaceId: string) => {
        state.closedWorkspaceIds.push(workspaceId);
        state.workspaceIds = state.workspaceIds.filter((id) => id !== workspaceId);
        state.focusedWorkspaceId = state.workspaceIds.at(-1);
      },
      workspaceFocus: async (workspaceId: string) => {
        state.focusCalls.push(workspaceId);
        state.focusedWorkspaceId = workspaceId;
      },
    },
  };
}

function makeSession(overrides: Partial<DispatcherModule.WorkerSession> = {}): DispatcherModule.WorkerSession {
  return {
    name: "my-app",
    workspaceId: "ws-my-app",
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
  const { state, methods } = makeWorkspaceFake();
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: undefined as unknown as string, pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await assert.doesNotReject(pollOnce(sessions, fakeHerdr));

  assert.equal(sessions.size, 0);
  assert.deepEqual(state.closedWorkspaceIds, ["ws-my-app"]);
  assert.equal(errorLogs.length, 0);
});

test("pollOnce removes a session and closes the tab when the pane returned to the shell", async () => {
  const { state, methods } = makeWorkspaceFake();
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "zsh", argv: [], cmdline: "zsh", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.equal(sessions.size, 0);
  assert.deepEqual(state.closedWorkspaceIds, ["ws-my-app"]);
});

test("pollOnce restores the user's focused workspace after herdr moves focus on workspace close", async () => {
  // ワーカーが自然終了してワークスペースを閉じたときも、ユーザーが見ている
  // ワークスペースが勝手に切り替わってはいけない。
  const { state, methods } = makeWorkspaceFake({
    workspaceIds: ["ws-user", "ws-other", "ws-my-app"],
    focusedWorkspaceId: "ws-user",
  });
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "zsh", argv: [], cmdline: "zsh", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.deepEqual(state.closedWorkspaceIds, ["ws-my-app"]);
  assert.deepEqual(state.focusCalls, ["ws-user"]);
  assert.equal(state.focusedWorkspaceId, "ws-user");
});

test("pollOnce does not re-focus when the user was watching the workspace being closed", async () => {
  // 閉じる対象自身を見ていた場合は戻す先が消えているため、herdr の既定の遷移に任せる。
  const { state, methods } = makeWorkspaceFake({
    workspaceIds: ["ws-user", "ws-my-app"],
    focusedWorkspaceId: "ws-my-app",
  });
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "zsh", argv: [], cmdline: "zsh", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.deepEqual(state.closedWorkspaceIds, ["ws-my-app"]);
  assert.deepEqual(state.focusCalls, []);
});

test("pollOnce removes a session without closing the tab when the pane is gone", async () => {
  const { state, methods } = makeWorkspaceFake();
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneProcessInfo: async () => {
      throw new HerdrError("herdr pane process-info failed: [pane_not_found] no such pane", "pane_not_found");
    },
  } as unknown as typeof HerdrModule;

  await pollOnce(sessions, fakeHerdr);

  assert.equal(sessions.size, 0);
  assert.deepEqual(state.closedWorkspaceIds, []);
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

test("monitorSessions resolves done once all sessions disappear", async () => {
  const { methods } = makeWorkspaceFake();
  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const fakeHerdr = {
    HerdrError,
    ...methods,
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
  workspace?: Pick<typeof HerdrModule, "workspaceList" | "workspaceClose" | "workspaceFocus">;
  sentKeys?: string[];
}): typeof HerdrModule {
  const { ctrlCThreshold = {}, ctrlCCounts, workspace = makeWorkspaceFake().methods, sentKeys } = options;
  return {
    HerdrError,
    ...workspace,
    paneSendKeys: async (paneId: string, ...keys: string[]) => {
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
      sentKeys?.push(...keys);
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
  } as unknown as typeof HerdrModule;
}

test("shutdownDispatcher: 全セッションが1回目のctrl-c送信後にタイムアウト前に終了する", async (t) => {
  const exitCodes = mockProcessExit(t);
  const ctrlCCounts: Record<string, number> = {};
  const sentKeys: string[] = [];
  const fakeHerdr = makeShutdownFakeHerdr({ ctrlCCounts, sentKeys });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 200,
    retryTimeoutMs: 200,
    workspaceCloseTimeoutMs: 50,
  });

  assert.equal(ctrlCCounts[session.paneId], 1);
  // herdr は `+` 区切りのキーコンボ文字列のみ受理する。`ctrl-c`（ハイフン）は
  // invalid_key で拒否されるため、送信キーが `ctrl+c` であることを固定する。
  assert.deepEqual(sentKeys, ["ctrl+c"]);
  assert.equal(sessions.size, 0);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: 1回目タイムアウト後、生存paneにのみ再送1回して短縮タイムアウトで再待機する", async (t) => {
  const exitCodes = mockProcessExit(t);
  const ctrlCCounts: Record<string, number> = {};
  const fakeHerdr = makeShutdownFakeHerdr({
    ctrlCCounts,
    ctrlCThreshold: { "pane-my-app": 2 },
  });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    retryTimeoutMs: 200,
    workspaceCloseTimeoutMs: 50,
  });

  assert.equal(ctrlCCounts[session.paneId], 2);
  assert.equal(sessions.size, 0);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: 同時に2回呼んでも二重送信・二重待機・二重workspaceCloseが起きない", async (t) => {
  const exitCodes = mockProcessExit(t);
  const ctrlCCounts: Record<string, number> = {};
  const { state, methods } = makeWorkspaceFake();
  const fakeHerdr = makeShutdownFakeHerdr({ ctrlCCounts, workspace: methods });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);
  const shutdownOptions = {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 200,
    retryTimeoutMs: 200,
    workspaceCloseTimeoutMs: 50,
  };

  const p1 = shutdownDispatcher(sessions, undefined, shutdownOptions);
  const p2 = shutdownDispatcher(sessions, undefined, shutdownOptions);
  await Promise.all([p1, p2]);

  assert.equal(ctrlCCounts[session.paneId], 1);
  // ワークスペースを閉じるのは pollOnce 経由の1回だけ（closeRemainingWorkspaces 時点で
  // セッションは空になっているため、2重呼び出しでも close は重複しない）。
  assert.deepEqual(state.closedWorkspaceIds, [session.workspaceId]);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: monitorHandleが渡された場合stop()/done経由で先に停止してから待機に切り替わる", async (t) => {
  const exitCodes = mockProcessExit(t);
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
  const fakeHerdr = {
    ...makeShutdownFakeHerdr({ ctrlCCounts }),
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
    workspaceCloseTimeoutMs: 50,
  });

  assert.deepEqual(order, ["stop", "done-resolved", "sendCtrlC"]);
  assert.deepEqual(exitCodes, [0]);
});

test("shutdownDispatcher: 残っている全ワークスペースがworkspaceCloseで閉じられ、失敗しても他のcloseとプロセス終了がブロックされない", async (t) => {
  const exitCodes = mockProcessExit(t);
  const errorLogs: string[] = [];
  t.mock.method(console, "error", (message: string) => {
    errorLogs.push(message);
  });

  const { state, methods } = makeWorkspaceFake({
    workspaceIds: ["ws-user", "ws-a", "ws-b"],
    focusedWorkspaceId: "ws-user",
  });
  const sessionA = makeSession({ name: "app-a", workspaceId: "ws-a", tabId: "tab-a", paneId: "pane-a" });
  const sessionB = makeSession({ name: "app-b", workspaceId: "ws-b", tabId: "tab-b", paneId: "pane-b" });
  const sessions: DispatcherModule.SessionRegistry = new Map([
    [sessionA.name, sessionA],
    [sessionB.name, sessionB],
  ]);

  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneSendKeys: async () => {},
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
    workspaceClose: async (workspaceId: string) => {
      if (workspaceId === "ws-a") {
        throw new Error("workspaceClose boom");
      }
      await methods.workspaceClose(workspaceId);
    },
  } as unknown as typeof HerdrModule;

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    retryTimeoutMs: 20,
    workspaceCloseTimeoutMs: 50,
  });

  assert.deepEqual(state.closedWorkspaceIds, ["ws-b"]);
  assert.ok(errorLogs.some((line) => line.startsWith('[dispatcher] failed to close workspace "ws-a"')));
  assert.deepEqual(exitCodes, [1]);
  // close に一部失敗しても、ユーザーが見ていたワークスペースへのフォーカスは戻す。
  assert.deepEqual(state.focusCalls, ["ws-user"]);
});

test("shutdownDispatcher: 全タブのcloseに成功してもセッションが最終的に終了しなければexit(1)する", async (t) => {
  const exitCodes = mockProcessExit(t);
  const { state, methods } = makeWorkspaceFake();
  const ctrlCCounts: Record<string, number> = {};
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneSendKeys: async (paneId: string) => {
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
    },
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 20,
    retryTimeoutMs: 20,
    workspaceCloseTimeoutMs: 50,
  });

  assert.deepEqual(state.closedWorkspaceIds, [session.workspaceId]);
  assert.deepEqual(exitCodes, [1]);
});

test("shutdownDispatcher: forceKill:true を指定した2回目の呼び出しは1回目の完了を待たず強制的にctrl-c再送・workspaceClose・exit(1)を行う", async (t) => {
  const exitCodes = mockProcessExit(t);
  const ctrlCCounts: Record<string, number> = {};
  const { state, methods } = makeWorkspaceFake();
  const fakeHerdr = {
    HerdrError,
    ...methods,
    paneSendKeys: async (paneId: string) => {
      ctrlCCounts[paneId] = (ctrlCCounts[paneId] ?? 0) + 1;
    },
    paneProcessInfo: async () => ({
      foregroundProcesses: [{ name: "node", argv: [], cmdline: "claude-task-worker exec-issue", pid: 123 }],
    }),
  } as unknown as typeof HerdrModule;

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  const firstShutdown = shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 50,
    retryTimeoutMs: 50,
    workspaceCloseTimeoutMs: 50,
  });

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    workspaceCloseTimeoutMs: 50,
    forceKill: true,
  });

  assert.ok((ctrlCCounts[session.paneId] ?? 0) >= 1);
  assert.ok(state.closedWorkspaceIds.includes(session.workspaceId));
  assert.ok(exitCodes.includes(1));

  await firstShutdown;
});

test("shutdownDispatcher: Ctrl-Cでワークスペースを閉じてもユーザーが見ていたワークスペースへフォーカスを戻す", async (t) => {
  // herdr は workspace close のたびに別のワークスペースへフォーカスを移すため、
  // Ctrl-C で片付けるとユーザーの表示が勝手に切り替わってしまう（リグレッションガード）。
  const exitCodes = mockProcessExit(t);
  const ctrlCCounts: Record<string, number> = {};
  const { state, methods } = makeWorkspaceFake({
    workspaceIds: ["ws-user", "ws-other", "ws-my-app"],
    focusedWorkspaceId: "ws-user",
  });
  const fakeHerdr = makeShutdownFakeHerdr({ ctrlCCounts, workspace: methods });

  const session = makeSession();
  const sessions: DispatcherModule.SessionRegistry = new Map([[session.name, session]]);

  await shutdownDispatcher(sessions, undefined, {
    herdr: fakeHerdr,
    pollIntervalMs: 5,
    shutdownTimeoutMs: 200,
    retryTimeoutMs: 200,
    workspaceCloseTimeoutMs: 50,
  });

  assert.deepEqual(state.closedWorkspaceIds, ["ws-my-app"]);
  assert.equal(state.focusedWorkspaceId, "ws-user");
  assert.deepEqual(exitCodes, [0]);
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
