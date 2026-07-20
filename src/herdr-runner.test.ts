import { test } from "node:test";
import assert from "node:assert/strict";
import type * as HerdrModule from "./herdr";
import type { AgentStatus } from "./herdr";
import type * as HerdrRunnerModule from "./herdr-runner";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
const { HerdrError } = (await import("./herdr.ts")) as typeof HerdrModule;
const {
  taskTabLabel,
  createCompletionTracker,
  observeAgentStatus,
  buildHerdrTaskResult,
  waitForHerdrTask,
  startHerdrTask,
  stopHerdrTask,
} = (await import("./herdr-runner.ts")) as typeof HerdrRunnerModule;

test("taskTabLabel formats the tab label as ctw:<project>:#<number>", () => {
  assert.equal(taskTabLabel("my-app", 123), "ctw:my-app:#123");
});

test("observeAgentStatus only completes after a working status has been seen", () => {
  let tracker = createCompletionTracker();

  // 起動直後の idle / unknown を完了と誤判定しない。
  let result = observeAgentStatus(tracker, "idle");
  assert.equal(result.decision, "running");
  tracker = result.tracker;

  result = observeAgentStatus(tracker, "unknown");
  assert.equal(result.decision, "running");
  tracker = result.tracker;

  result = observeAgentStatus(tracker, "working");
  assert.equal(result.decision, "running");
  tracker = result.tracker;

  result = observeAgentStatus(tracker, "idle");
  assert.equal(result.decision, "completed");
});

test("observeAgentStatus completes on done (unviewed completion) without requiring a seen working status", () => {
  // ワーカーのタスクタブは誰も開かないため、herdr は idle ではなく done を返し続ける。
  // ポーリング間隔より短いタスクでは working を観測できないまま done に至るため、
  // seenWorking を要求すると永久に完了しない。
  const tracker = createCompletionTracker();

  const result = observeAgentStatus(tracker, "done");
  assert.equal(result.decision, "completed");
});

test("observeAgentStatus reports a blocked status only the first time", () => {
  let tracker = createCompletionTracker();

  let result = observeAgentStatus(tracker, "blocked");
  assert.equal(result.decision, "blocked-first-seen");
  tracker = result.tracker;

  result = observeAgentStatus(tracker, "blocked");
  assert.equal(result.decision, "running");
});

test("buildHerdrTaskResult treats an empty pane as a failed (no-op) session", () => {
  const result = buildHerdrTaskResult("   \n  ");
  assert.equal(result.status, "failed");
  assert.match(result.output, /produced no output/);
});

test("buildHerdrTaskResult passes the pane content through on success", () => {
  const result = buildHerdrTaskResult("done: created PR #12");
  assert.equal(result.status, "completed");
  assert.equal(result.output, "done: created PR #12");
});

interface FakeHerdrOptions {
  statuses: AgentStatus[];
  paneOutput?: string;
  agentGetError?: Error;
  calls?: string[];
  // ctrl-c 後もペインが残り続ける（claude が終了しない）ケースの再現
  paneSurvivesCtrlC?: boolean;
  // tabClose が投げるエラー（既に閉じているケースの再現）
  tabCloseError?: Error;
  tabCreateError?: Error;
  agentStartError?: Error;
  paneCloseError?: Error;
}

function makeFakeHerdr(options: FakeHerdrOptions): typeof HerdrModule {
  const statuses = [...options.statuses];
  let ctrlCSent = false;
  return {
    HerdrError,
    paneGet: async (paneId: string) => {
      if (ctrlCSent && !options.paneSurvivesCtrlC) {
        throw new HerdrError(`pane ${paneId} not found`, "pane_not_found");
      }
      return { paneId, tabId: "tab-task" };
    },
    agentGet: async (target: string) => {
      options.calls?.push(`agentGet:${target}`);
      if (options.agentGetError && statuses.length === 0) throw options.agentGetError;
      const agentStatus = statuses.shift() ?? "idle";
      return { paneId: target, tabId: "tab-1", workspaceId: "w1", agentStatus };
    },
    paneRead: async () => options.paneOutput ?? "task finished",
    paneSendKeys: async (paneId: string, ...keys: string[]) => {
      options.calls?.push(`sendKeys:${paneId}:${keys.join(",")}`);
      if (keys.filter((key) => key === "ctrl+c").length >= 2) ctrlCSent = true;
    },
    tabClose: async (tabId: string) => {
      options.calls?.push(`tabClose:${tabId}`);
      if (options.tabCloseError) throw options.tabCloseError;
    },
    tabCreate: async ({ label, cwd }: { label: string; cwd: string }) => {
      options.calls?.push(`tabCreate:${label}:${cwd}`);
      if (options.tabCreateError) throw options.tabCreateError;
      return { paneId: "pane-shell", tabId: "tab-task" };
    },
    agentStart: async ({ name, tabId, cwd }: { name: string; tabId?: string; cwd: string }) => {
      options.calls?.push(`agentStart:${name}:${tabId ?? "-"}:${cwd}`);
      if (options.agentStartError) throw options.agentStartError;
      return { paneId: "pane-1", tabId: tabId ?? "tab-root" };
    },
    paneClose: async (paneId: string) => {
      options.calls?.push(`paneClose:${paneId}`);
      if (options.paneCloseError) throw options.paneCloseError;
    },
  } as unknown as typeof HerdrModule;
}

test("waitForHerdrTask completes on the working -> idle transition and returns the pane output", async () => {
  const herdr = makeFakeHerdr({ statuses: ["unknown", "working", "working", "idle"], paneOutput: "PR created" });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1 });
  assert.deepEqual(result, { status: "completed", output: "PR created" });
});

test("waitForHerdrTask completes on done so a task tab nobody looks at is not stuck forever", async () => {
  const herdr = makeFakeHerdr({ statuses: ["unknown", "working", "done"], paneOutput: "PR created" });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1 });
  assert.deepEqual(result, { status: "completed", output: "PR created" });
});

test("waitForHerdrTask fails when the pane disappears", async () => {
  const herdr = makeFakeHerdr({
    statuses: ["working"],
    agentGetError: new HerdrError("pane w1:p1 not found", "pane_not_found"),
  });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1 });
  assert.equal(result.status, "failed");
  assert.match(result.output, /pane disappeared/);
});

test("waitForHerdrTask fails when the session goes idle without producing output", async () => {
  const herdr = makeFakeHerdr({ statuses: ["working", "idle"], paneOutput: "" });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1 });
  assert.equal(result.status, "failed");
  assert.match(result.output, /produced no output/);
});

test("waitForHerdrTask keeps waiting through a blocked status and reports it once", async () => {
  const herdr = makeFakeHerdr({ statuses: ["working", "blocked", "blocked", "idle"] });
  let blockedCount = 0;
  const result = await waitForHerdrTask("pane-1", {
    herdr,
    pollIntervalMs: 1,
    onBlocked: () => {
      blockedCount++;
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(blockedCount, 1);
});

test("waitForHerdrTask aborts when the worker is shutting down", async () => {
  const herdr = makeFakeHerdr({ statuses: ["working", "working", "working"] });
  const signal = { aborted: false };
  const pending = waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1, signal });
  signal.aborted = true;
  const result = await pending;
  assert.equal(result.status, "failed");
  assert.match(result.output, /shutting down/);
});

test("startHerdrTask creates the task tab first so the agent never flashes in the visible tab", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls });
  const task = await startHerdrTask({
    label: "ctw:my-app:#12",
    cwd: "/tmp/worktree",
    argv: ["claude", "/skill 12"],
    herdr,
  });
  assert.deepEqual(task, { paneId: "pane-1", tabId: "tab-task" });
  // タブ作成 → そのタブ限定で agent 起動 → 余ったシェルペインを片付ける、の順。
  assert.deepEqual(calls, [
    "tabCreate:ctw:my-app:#12:/tmp/worktree",
    "agentStart:ctw:my-app:#12:tab-task:/tmp/worktree",
    "paneClose:pane-shell",
  ]);
});

test("startHerdrTask closes the task tab when the agent fails to start", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, agentStartError: new Error("boom") });
  await assert.rejects(
    startHerdrTask({ label: "ctw:my-app:#12", cwd: "/tmp/worktree", argv: ["claude"], herdr }),
    /boom/,
  );
  // シェルだけのタブを残さない。
  assert.deepEqual(calls, [
    "tabCreate:ctw:my-app:#12:/tmp/worktree",
    "agentStart:ctw:my-app:#12:tab-task:/tmp/worktree",
    "tabClose:tab-task",
  ]);
});

test("startHerdrTask still returns the task when the placeholder shell pane cannot be closed", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, paneCloseError: new Error("pane busy") });
  const errorLogs: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => errorLogs.push(String(message));
  try {
    // agent は起動できているので、ペイン1枚の後片付け失敗でタスクを落とさない。
    const task = await startHerdrTask({
      label: "ctw:my-app:#12",
      cwd: "/tmp/worktree",
      argv: ["claude"],
      herdr,
    });
    assert.deepEqual(task, { paneId: "pane-1", tabId: "tab-task" });
  } finally {
    console.error = originalError;
  }
  assert.ok(errorLogs.some((line) => line.includes("placeholder shell pane")));
});

test("stopHerdrTask sends ctrl-c twice in one call so the claude TUI actually exits", async () => {
  // 実測: ctrl-c 1回では終了せず、間隔を空けた2回でも終了カウントがリセットされる。
  // 1コマンドで連続2回送ったときだけ TUI が終了する。
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls });
  await stopHerdrTask({ paneId: "pane-1", tabId: "tab-task" }, herdr, { exitPollIntervalMs: 1 });
  assert.equal(calls[0], "sendKeys:pane-1:ctrl+c,ctrl+c");
});

test("stopHerdrTask still closes the tab after claude exits (no-op when it is already gone)", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({
    statuses: [],
    calls,
    tabCloseError: new HerdrError("tab tab-task not found", "tab_not_found"),
  });
  const errorLogs: string[] = [];
  const originalError = console.error;
  console.error = (message: string) => errorLogs.push(String(message));
  try {
    await stopHerdrTask({ paneId: "pane-1", tabId: "tab-task" }, herdr, { exitPollIntervalMs: 1 });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(calls, ["sendKeys:pane-1:ctrl+c,ctrl+c", "tabClose:tab-task"]);
  // グレースフル終了でタブごと消えているケースなので、エラーログは出さない。
  assert.deepEqual(errorLogs, []);
});

test("stopHerdrTask forcefully closes the tab when claude does not exit on ctrl-c", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, paneSurvivesCtrlC: true });
  const warnLogs: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnLogs.push(String(message));
  try {
    await stopHerdrTask({ paneId: "pane-1", tabId: "tab-task" }, herdr, {
      exitTimeoutMs: 5,
      exitPollIntervalMs: 1,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(calls, ["sendKeys:pane-1:ctrl+c,ctrl+c", "tabClose:tab-task"]);
  assert.ok(warnLogs.some((line) => line.includes("did not exit")));
});
