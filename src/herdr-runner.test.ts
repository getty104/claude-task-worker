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

test("buildHerdrTaskResult prefers the transcript report over the TUI pane content", () => {
  // ペインの末尾は入力ボックスとステータスバーで埋まっており、Slack 通知が切り出す
  // 末尾1000文字は TUI の装飾しか含まない。transcript の最終レポートを本文にする。
  const pane = ["⏺ 修正しました", "", "─────────────", "❯", "─────────────", "  ctx ⣤ 7% │ 5h 26%"].join("\n");
  const result = buildHerdrTaskResult(pane, { report: "  PR #12 を作成しました  " });
  assert.deepEqual(result, { status: "completed", output: "PR #12 を作成しました" });
});

test("buildHerdrTaskResult falls back to the pane content when the transcript report is empty", () => {
  assert.deepEqual(buildHerdrTaskResult("PR created", { report: "  \n " }), {
    status: "completed",
    output: "PR created",
  });
  assert.equal(buildHerdrTaskResult("   ", { report: "" }).status, "failed");
});

interface FakeHerdrOptions {
  statuses: AgentStatus[];
  paneOutput?: string;
  agentGetError?: Error;
  calls?: string[];
  // agent get が返す claude のセッションID（transcript を引く鍵）
  sessionId?: string;
  // ctrl-c 後もペインが残り続ける（claude が終了しない）ケースの再現。
  // 新モデルでは claude はシェルペインで動くため、終了しても消えるのはペインではなく
  // agent 検出（agentGet が agent_not_found を返す）。
  paneSurvivesCtrlC?: boolean;
  // tabClose が投げるエラー（既に閉じているケースの再現）
  tabCloseError?: Error;
  tabCreateError?: Error;
  // agentStart（`agent start` 起動 + 検出待ち）が投げるエラー。
  // 起動失敗・プリアンブル失敗など、herdr が検出できなかったケースの再現。
  agentStartError?: Error;
}

function makeFakeHerdr(options: FakeHerdrOptions): typeof HerdrModule {
  const statuses = [...options.statuses];
  let ctrlCSent = false;
  return {
    HerdrError,
    agentGet: async (target: string) => {
      // ctrl-c 後は claude が終了して agent 検出が外れる（ペインは残る）。
      if (ctrlCSent && !options.paneSurvivesCtrlC) {
        throw new HerdrError(`agent ${target} not found`, "agent_not_found");
      }
      if (options.agentGetError && statuses.length === 0) throw options.agentGetError;
      const agentStatus = statuses.shift() ?? "idle";
      return { paneId: target, tabId: "tab-1", workspaceId: "w1", agentStatus, sessionId: options.sessionId };
    },
    paneRead: async () => options.paneOutput ?? "task finished",
    paneSendKeys: async (paneId: string, ...keys: string[]) => {
      options.calls?.push(`sendKeys:${paneId}:${keys.join(",")}`);
      if (keys.filter((key) => key === "ctrl+c").length >= 2) ctrlCSent = true;
    },
    agentStart: async (paneId: string, { name, args }: { name: string; args: string[] }) => {
      options.calls?.push(`agentStart:${paneId}:${name}:${args.join(" ")}`);
      if (options.agentStartError) throw options.agentStartError;
      return { paneId, tabId: "tab-task", workspaceId: "w1", agentStatus: "idle" as const, sessionId: options.sessionId };
    },
    tabClose: async (tabId: string) => {
      options.calls?.push(`tabClose:${tabId}`);
      if (options.tabCloseError) throw options.tabCloseError;
    },
    tabCreate: async ({ label, cwd }: { label: string; cwd: string }) => {
      options.calls?.push(`tabCreate:${label}:${cwd}`);
      if (options.tabCreateError) throw options.tabCreateError;
      return { paneId: "pane-root", tabId: "tab-task" };
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

test("waitForHerdrTask reports the transcript of the session herdr exposes on the pane", async () => {
  const herdr = makeFakeHerdr({
    statuses: ["unknown", "working", "done"],
    paneOutput: "❯\n  ctx ⣤ 7% │ 5h 26%",
    sessionId: "d3796b28-57e1-47fb-be7f-586e910ea883",
  });
  const seen: (string | undefined)[] = [];
  const result = await waitForHerdrTask("pane-1", {
    herdr,
    pollIntervalMs: 1,
    readReport: (sessionId) => {
      seen.push(sessionId);
      return "PR #12 を作成しました";
    },
  });
  assert.deepEqual(result, { status: "completed", output: "PR #12 を作成しました" });
  assert.deepEqual(seen, ["d3796b28-57e1-47fb-be7f-586e910ea883"]);
});

test("waitForHerdrTask falls back to the pane output when no transcript is found", async () => {
  const herdr = makeFakeHerdr({ statuses: ["working", "done"], paneOutput: "PR created" });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1, readReport: () => "" });
  assert.deepEqual(result, { status: "completed", output: "PR created" });
});

test("waitForHerdrTask fails when the pane disappears", async () => {
  const herdr = makeFakeHerdr({
    statuses: ["working"],
    agentGetError: new HerdrError("pane w1:p1 not found", "pane_not_found"),
  });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1 });
  assert.equal(result.status, "failed");
  assert.match(result.output, /disappeared/);
});

// 新モデルでは claude はシェルペインで動くため、途中で claude が死ぬとペイン消失ではなく
// agent 検出が外れる（agent_not_found）。これも「claude が消えた」失敗として扱う。
test("waitForHerdrTask fails when the agent disappears mid-task", async () => {
  const herdr = makeFakeHerdr({
    statuses: ["working"],
    agentGetError: new HerdrError("agent w1:p1 not found", "agent_not_found"),
  });
  const result = await waitForHerdrTask("pane-1", { herdr, pollIntervalMs: 1 });
  assert.equal(result.status, "failed");
  assert.match(result.output, /disappeared/);
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

test("startHerdrTask launches claude into the task tab's root shell pane via agent start", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls });
  const task = await startHerdrTask({
    label: "ctw:my-app:#12",
    cwd: "/tmp/worktree",
    args: ["/skill 12"],
    herdr,
  });
  // ルートペインがそのまま claude のペインになる（余剰シェルペインの paneClose は不要）。
  assert.deepEqual(task, { paneId: "pane-root", tabId: "tab-task" });
  // タブ作成 → ルートペインで agent start、の順。args には実行ファイル claude は含めない。
  assert.deepEqual(calls, ["tabCreate:ctw:my-app:#12:/tmp/worktree", "agentStart:pane-root:ctw:my-app:#12:/skill 12"]);
});

// agent start は検出できなければ herdr がエラーを返す（起動失敗・プリアンブル失敗など）。
// waitForHerdrTask が無限待ちに陥る前にここで失敗として確定させ、シェルだけのタブを閉じる。
test("startHerdrTask closes the task tab when agent start fails", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, agentStartError: new Error("boom") });
  await assert.rejects(
    startHerdrTask({ label: "ctw:my-app:#12", cwd: "/tmp/worktree", args: [], herdr }),
    /boom/,
  );
  // シェルだけのタブを残さない。
  assert.deepEqual(calls, [
    "tabCreate:ctw:my-app:#12:/tmp/worktree",
    "agentStart:pane-root:ctw:my-app:#12:",
    "tabClose:tab-task",
  ]);
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
