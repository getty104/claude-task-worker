import { test } from "node:test";
import assert from "node:assert/strict";
import type * as HerdrModule from "./herdr";
import type { AgentStatus } from "./herdr";
import type * as HerdrRunnerModule from "./herdr-runner";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
const { HerdrError } = (await import("./herdr")) as typeof HerdrModule;
const {
  taskTabLabel,
  toAgentName,
  createCompletionTracker,
  observeAgentStatus,
  buildHerdrTaskResult,
  extractCloudSessionId,
  normalizePtyOutput,
  waitForHerdrTask,
  startHerdrTask,
  stopHerdrTask,
} = (await import("./herdr-runner")) as typeof HerdrRunnerModule;

test("taskTabLabel formats the tab label as ctw:<project>:#<number>", () => {
  assert.equal(taskTabLabel("my-app", 123), "ctw:my-app:#123");
});

const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

test("toAgentName converts a task tab label into a valid herdr agent name", () => {
  // `:` と `#` を含むラベルは agent 名規則に違反するため潰されること。
  assert.equal(toAgentName(taskTabLabel("my-app", 123)), "ctw-my-app-123");
  assert.match(toAgentName(taskTabLabel("my-app", 123)), AGENT_NAME_RE);
});

test("toAgentName satisfies the herdr agent name rules for tricky inputs", () => {
  // 大文字・全角・記号を含む、数字始まり、先頭記号、超長文字列でも規則を満たす。
  const cases = [
    taskTabLabel("My_App", 12),
    taskTabLabel("プロジェクト", 7),
    taskTabLabel("123numeric", 9),
    taskTabLabel("a".repeat(60), 999999),
    "###",
  ];
  for (const label of cases) {
    const name = toAgentName(label);
    assert.match(name, AGENT_NAME_RE, `"${label}" -> "${name}" should be a valid agent name`);
  }
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

test("extractCloudSessionId extracts the id from a View URL line, dropping the query string", () => {
  const text = ["│ View: https://claude.ai/code/session_011AbCdEf?from=cli&m=0 │"].join("\n");
  assert.equal(extractCloudSessionId(text), "session_011AbCdEf");
});

test("extractCloudSessionId extracts the id from a Created cloud session line", () => {
  const text = "Created cloud session: session_011AbCdEf";
  assert.equal(extractCloudSessionId(text), "session_011AbCdEf");
});

test("extractCloudSessionId returns undefined when neither pattern is present", () => {
  assert.equal(extractCloudSessionId("⏺ 修正しました\nctx 7% │ 5h 26%"), undefined);
});

test("extractCloudSessionId does not treat the description itself as a session id", () => {
  // `Created cloud session:` の後ろは description（例: タスクタブラベル）そのものであり、
  // セッションID（`session_` 始まり）ではない。誤って description を掴まないことを検証する。
  assert.equal(extractCloudSessionId("Created cloud session: ctw:my-app:#123"), undefined);
});

test("extractCloudSessionId finds the id after normalizePtyOutput strips ANSI escapes mid-URL", () => {
  // 実測サンプル相当: script 経由の生出力には先頭の制御文字・ANSIカラー・末尾CRが混入し、
  // URLの途中にもエスケープが挟まる。正規化しないと `https://claude.ai/code/` の連続一致が
  // 崩れて抽出できない（本Issueの核心の回帰テスト）。
  const raw = "\x04\x08\x08\x1b[33mView: https://claude.ai/code/\x1b[39msession_011AbCdEf?from=cli&m=0\r\n";
  assert.equal(extractCloudSessionId(raw), undefined);
  assert.equal(extractCloudSessionId(normalizePtyOutput(raw)), "session_011AbCdEf");
});

test("normalizePtyOutput leaves plain text without an id as undefined after extraction", () => {
  const raw = "\x1b[33m⏺ 修正しました\x1b[39m\r\nctx 7% \x1b[2m│\x1b[22m 5h 26%\r\n";
  assert.equal(extractCloudSessionId(normalizePtyOutput(raw)), undefined);
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
  // 起動失敗など、herdr が検出できなかったケースの再現。
  agentStartError?: Error;
  // agentPrompt（`agent prompt` によるプロンプト投入）が投げるエラー。
  agentPromptError?: Error;
  // statuses を使い切った後に agent get が返し続けるステータス（既定 idle）。
  defaultStatus?: AgentStatus;
  // agent get の最初の1回だけ投げる一時的なエラー（statuses の残数に関係なく発生させる）。
  // waitForPromptAccepted が一時的な agentGet 失敗を受理成功と誤判定しないことの検証用。
  agentGetTransientError?: Error;
}

// プロンプト受理待ちを「1回だけ確認して打ち切る」時間設定（テストを決定的にするため）。
const FAST_ACCEPT = { promptAcceptTimeoutMs: 0, promptAcceptPollIntervalMs: 0 };

function makeFakeHerdr(options: FakeHerdrOptions): typeof HerdrModule {
  const statuses = [...options.statuses];
  let ctrlCSent = false;
  let agentGetCalls = 0;
  return {
    HerdrError,
    agentGet: async (target: string) => {
      agentGetCalls++;
      // ctrl-c 後は claude が終了して agent 検出が外れる（ペインは残る）。
      if (ctrlCSent && !options.paneSurvivesCtrlC) {
        throw new HerdrError(`agent ${target} not found`, "agent_not_found");
      }
      if (options.agentGetTransientError && agentGetCalls === 1) throw options.agentGetTransientError;
      if (options.agentGetError && statuses.length === 0) throw options.agentGetError;
      const agentStatus = statuses.shift() ?? options.defaultStatus ?? "idle";
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
      return {
        paneId,
        tabId: "tab-task",
        workspaceId: "w1",
        agentStatus: "idle" as const,
        sessionId: options.sessionId,
      };
    },
    agentPrompt: async (paneId: string, text: string) => {
      options.calls?.push(`agentPrompt:${paneId}:${text}`);
      if (options.agentPromptError) throw options.agentPromptError;
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
  // 投入後にターンが始まった（working）ことまで確認してから返る。
  const herdr = makeFakeHerdr({ statuses: ["working"], calls });
  const task = await startHerdrTask({
    label: "ctw:my-app:#12",
    cwd: "/tmp/worktree",
    args: ["--model", "opus"],
    prompt: "/skill 12",
    herdr,
    timing: FAST_ACCEPT,
  });
  // ルートペインがそのまま claude のペインになる（余剰シェルペインの paneClose は不要）。
  assert.deepEqual(task, { paneId: "pane-root", tabId: "tab-task" });
  // タブ作成 → ルートペインで agent start → agent prompt でタスク投入、の順。
  // **プロンプトは起動引数に含めない**（含めると agent start がタスク完了まで返らず、
  // herdr がターンを追跡しないため完了検知が永久に成立しなくなる）。
  assert.deepEqual(calls, [
    "tabCreate:ctw:my-app:#12:/tmp/worktree",
    "agentStart:pane-root:ctw-my-app-12:--model opus",
    "agentPrompt:pane-root:/skill 12",
  ]);
});

// プロンプト投入に失敗したまま待機へ進むと、何もしない claude を延々ポーリングすることになる。
// agent start の失敗と同じくタブを閉じて失敗として確定させる。
test("startHerdrTask closes the task tab when the prompt cannot be submitted", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, agentPromptError: new Error("agent_blocked") });
  await assert.rejects(
    startHerdrTask({ label: "ctw:my-app:#12", cwd: "/tmp/worktree", args: [], prompt: "/skill 12", herdr }),
    /agent_blocked/,
  );
  assert.equal(calls.at(-1), "tabClose:tab-task");
});

// `agent prompt` はエラーを返さないのに claude が何も始めないことがある（起動直後の
// ダイアログが Enter を食う）。無言で idle を待ち続けるとスキルが一度も実行されないまま
// タスクが張り付くため、再投入 → それでも始まらなければ失敗として確定させる。
test("startHerdrTask resends the prompt when the claude session stays idle after submission", async () => {
  const calls: string[] = [];
  // 1回目の投入後は idle のまま（＝投入が食われた）、再投入後に working へ移る。
  const herdr = makeFakeHerdr({ statuses: ["idle", "working"], calls });
  await startHerdrTask({
    label: "ctw:my-app:#12",
    cwd: "/tmp/worktree",
    args: [],
    prompt: "/skill 12",
    herdr,
    timing: FAST_ACCEPT,
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("agentPrompt")),
    ["agentPrompt:pane-root:/skill 12", "agentPrompt:pane-root:/skill 12"],
  );
});

// agentGet の一時的な失敗を受理成功として扱うと、ダイアログに食われた投入を
// 「受理済み」と誤判定し ensurePromptAccepted の再投入がスキップされてしまう
// （waitForHerdrTask 側は working を一度も観測できず無限待機に陥る）。
// 一時エラーの後に working が返れば、通常どおり受理成功と判定され再投入は起きないこと。
test("startHerdrTask treats a transient agentGet error as still-pending, not as accepted", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({
    statuses: ["working"],
    calls,
    agentGetTransientError: new Error("temporary herdr failure"),
  });
  await startHerdrTask({
    label: "ctw:my-app:#12",
    cwd: "/tmp/worktree",
    args: [],
    prompt: "/skill 12",
    herdr,
    timing: { promptAcceptTimeoutMs: 1000, promptAcceptPollIntervalMs: 1 },
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith("agentPrompt")),
    ["agentPrompt:pane-root:/skill 12"],
  );
});

test("startHerdrTask fails and closes the tab when the prompt is never accepted", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, defaultStatus: "idle" });
  await assert.rejects(
    startHerdrTask({
      label: "ctw:my-app:#12",
      cwd: "/tmp/worktree",
      args: [],
      prompt: "/skill 12",
      herdr,
      timing: FAST_ACCEPT,
    }),
    /did not start the task/,
  );
  assert.equal(calls.at(-1), "tabClose:tab-task");
});

// agent start は検出できなければ herdr がエラーを返す（起動失敗・プリアンブル失敗など）。
// waitForHerdrTask が無限待ちに陥る前にここで失敗として確定させ、シェルだけのタブを閉じる。
test("startHerdrTask closes the task tab when agent start fails", async () => {
  const calls: string[] = [];
  const herdr = makeFakeHerdr({ statuses: [], calls, agentStartError: new Error("boom") });
  await assert.rejects(
    startHerdrTask({ label: "ctw:my-app:#12", cwd: "/tmp/worktree", args: [], prompt: "/skill 12", herdr }),
    /boom/,
  );
  // シェルだけのタブを残さない。
  assert.deepEqual(calls, [
    "tabCreate:ctw:my-app:#12:/tmp/worktree",
    "agentStart:pane-root:ctw-my-app-12:",
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
