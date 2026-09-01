import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type * as ClaudeArgsModule from "./claude-args";

const {
  DISALLOWED_TOOLS,
  DISALLOWED_TOOLS_ARG,
  CLAUDE_SPAWN_ENV,
  SYSTEM_PROMPT_BASE,
  OPUS_SYSTEM_PROMPT_ADDENDUM,
  CLAUDE_COMMAND,
  buildClaudeArgs,
  buildClaudeEnv,
  buildClaudeExecution,
  buildCloudCreateArgs,
  buildCloudPrompt,
  buildCloudToolRestriction,
  appendCloudDoneInstruction,
  buildCloudCheckoutInstruction,
  buildCloudWorktreeInstruction,
  CLOUD_REPORT_HEADING,
  shellQuote,
  buildScriptCommand,
  isOpusModel,
  systemPromptFilePath,
  systemPromptFor,
} = (await import("./claude-args")) as typeof ClaudeArgsModule;

test("DISALLOWED_TOOLS covers the tools with no autonomous use", () => {
  assert.deepEqual(
    [...DISALLOWED_TOOLS],
    [
      "Monitor",
      "ScheduleWakeup",
      "AskUserQuestion",
      "EnterPlanMode",
      "CronCreate",
      "CronDelete",
      "CronList",
      "RemoteTrigger",
      "EnterWorktree",
    ],
  );
});

test("DISALLOWED_TOOLS keeps the Exit* escape hatches allowed", () => {
  assert.ok(!DISALLOWED_TOOLS.includes("ExitPlanMode" as never));
  assert.ok(!DISALLOWED_TOOLS.includes("ExitWorktree" as never));
});

test("DISALLOWED_TOOLS_ARG is a single comma-joined token for --disallowedTools", () => {
  assert.equal(DISALLOWED_TOOLS_ARG, DISALLOWED_TOOLS.join(","));
  // Must be one token (no spaces) so it can't bleed into following CLI flags.
  assert.ok(!/\s/.test(DISALLOWED_TOOLS_ARG));
});

test("CLAUDE_SPAWN_ENV disables background tasks and lifts the bg-wait ceiling", () => {
  assert.deepEqual(
    { ...CLAUDE_SPAWN_ENV },
    {
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
    },
  );
});

test("SYSTEM_PROMPT_BASE states the autonomous-execution principles for the main agent", () => {
  // Injected via --append-system-prompt-file; replaces the paragraph formerly
  // duplicated in every worker-driven skill's 実行モードの制約 section.
  assert.ok(SYSTEM_PROMPT_BASE.includes("ユーザーへの確認・質問は行わず"));
  assert.ok(SYSTEM_PROMPT_BASE.includes("全ステップを完遂してから"));
  assert.ok(SYSTEM_PROMPT_BASE.includes("破壊的でない側"));
});

test("SYSTEM_PROMPT_BASE also carries the subagent rules", () => {
  // --append-subagent-system-prompt is print-mode only, so the subagent principles
  // are folded into the single --append-system-prompt injection instead.
  assert.ok(SYSTEM_PROMPT_BASE.includes("サブエージェントへ作業を委譲する場合"));
  assert.ok(SYSTEM_PROMPT_BASE.includes("完了報告は鵜呑みにしない"));
});

test("SYSTEM_PROMPT_BASE tells the agent to prefer CodeGraph over text search", () => {
  // explore-agent has the detailed procedure, but the main agent (and any other
  // subagent it delegates to) only learns the preference from here.
  assert.ok(SYSTEM_PROMPT_BASE.includes("CodeGraph が使える場合"));
  // Availability is decided by the MCP tool alone.
  assert.ok(SYSTEM_PROMPT_BASE.includes("MCP ツール"));
  assert.ok(SYSTEM_PROMPT_BASE.includes("codegraph_explore"));
  // And the agent must not set CodeGraph up mid-task.
  assert.ok(SYSTEM_PROMPT_BASE.includes("インデックスを用意しようとしない"));
});

test("SYSTEM_PROMPT_BASE does not assume a specific run mode", () => {
  // Injected into both `claude -p` (default mode) and TUI (herdr mode) sessions.
  assert.ok(!SYSTEM_PROMPT_BASE.includes("print"));
});

test("OPUS_SYSTEM_PROMPT_ADDENDUM curbs the Opus 5 default behaviours", () => {
  // Verbosity, scope creep, over-delegation and over-verification.
  assert.ok(OPUS_SYSTEM_PROMPT_ADDENDUM.includes("依頼されたスコープだけ"));
  assert.ok(OPUS_SYSTEM_PROMPT_ADDENDUM.includes("埋め草セクション"));
  assert.ok(OPUS_SYSTEM_PROMPT_ADDENDUM.includes("自分で数回のツール呼び出しで終わる作業は委譲しない"));
  assert.ok(OPUS_SYSTEM_PROMPT_ADDENDUM.includes("再チェックを目的にサブエージェントを起動しない"));
});

test("isOpusModel matches aliases and full model IDs, case-insensitively", () => {
  for (const model of ["opus", "Opus", "claude-opus-5", "claude-opus-5[1m]"]) {
    assert.equal(isOpusModel(model), true, `${model} must be treated as opus`);
  }
  for (const model of ["sonnet", "claude-sonnet-5", "haiku", ""]) {
    assert.equal(isOpusModel(model), false, `${model} must not be treated as opus`);
  }
});

test("systemPromptFor appends the addendum for opus only", () => {
  assert.equal(systemPromptFor("sonnet"), SYSTEM_PROMPT_BASE);
  assert.equal(systemPromptFor("opus"), `${SYSTEM_PROMPT_BASE}\n\n${OPUS_SYSTEM_PROMPT_ADDENDUM}`);
  // The opus variant is strictly additive: the base principles still apply.
  assert.ok(systemPromptFor("claude-opus-5").startsWith(SYSTEM_PROMPT_BASE));
});

test("systemPromptFilePath writes one file per variant so concurrent workers can't clobber it", () => {
  const opusPath = systemPromptFilePath("opus");
  const sonnetPath = systemPromptFilePath("sonnet");
  assert.notEqual(opusPath, sonnetPath);
  assert.equal(readFileSync(opusPath, "utf8"), systemPromptFor("opus"));
  assert.equal(readFileSync(sonnetPath, "utf8"), SYSTEM_PROMPT_BASE);
  // Same variant resolves to the same cached path regardless of the model spelling.
  assert.equal(systemPromptFilePath("claude-opus-5"), opusPath);
});

// herdr mode must NOT pass the prompt on the command line: claude would start working
// immediately, `herdr agent start` (which blocks until the agent is ready for input) would not
// return until the task finished, and herdr would not track the turn — so the worker never
// observes `working` and never completes (observed symptom: stuck at `running:idle`).
// The prompt is submitted after startup via `herdr agent prompt` instead.
test("buildClaudeArgs passes the prompt on the command line only in default mode", () => {
  const common = { prompt: "/skill 123", model: "sonnet", effort: "high" };
  const defaultArgs = buildClaudeArgs({ mode: "default", ...common });
  const herdrArgs = buildClaudeArgs({ mode: "herdr", ...common });

  assert.equal(defaultArgs[0], "-p");
  assert.equal(defaultArgs[1], "/skill 123");
  assert.ok(!herdrArgs.includes("-p"));
  assert.ok(!herdrArgs.includes("/skill 123"));
  // Everything except `-p <prompt>` is identical between the two modes.
  assert.deepEqual(defaultArgs.slice(2), herdrArgs);
});

test("buildClaudeArgs keeps the tool restrictions and the system prompt in both modes", () => {
  for (const mode of ["default", "herdr"] as const) {
    const args = buildClaudeArgs({ mode, prompt: "/skill 1", model: "opus", effort: "xhigh" });
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
    assert.equal(args[args.indexOf("--disallowedTools") + 1], DISALLOWED_TOOLS_ARG);
    // The system prompt is passed via a file (see below); the inline flag must not be used.
    assert.ok(!args.includes("--append-system-prompt"));
    assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], systemPromptFilePath("opus"));
    assert.equal(args[args.indexOf("--model") + 1], "opus");
    assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
    // The subagent flag is print-mode only and no longer used in either mode.
    assert.ok(!args.includes("--append-subagent-system-prompt"));
  }
});

test("buildClaudeArgs passes the system prompt via a file so no arg carries a newline", () => {
  // herdr rejects any agent argument containing a newline with
  // invalid_agent_argument ("agent arguments cannot be encoded safely for the
  // target shell"), so the multiline system prompt must go through a file.
  for (const mode of ["default", "herdr"] as const) {
    for (const model of ["opus", "sonnet"] as const) {
      const args = buildClaudeArgs({ mode, prompt: "/skill 1", model, effort: "high" });
      for (const arg of args) {
        assert.ok(!arg.includes("\n"), `arg must not contain a newline: ${JSON.stringify(arg)}`);
      }
      const promptPath = args[args.indexOf("--append-system-prompt-file") + 1];
      assert.ok(path.isAbsolute(promptPath), "system prompt file path must be absolute");
      assert.equal(readFileSync(promptPath, "utf8"), systemPromptFor(model));
    }
  }
});

test("buildClaudeArgs passes the permission mode via --permission-mode", () => {
  for (const mode of ["default", "herdr"] as const) {
    for (const permissionMode of ["manual", "auto", "acceptEdits", "dontAsk", "plan", "bypassPermissions"] as const) {
      const args = buildClaudeArgs({ mode, prompt: "/skill 1", model: "opus", effort: "high", permissionMode });
      assert.equal(args[args.indexOf("--permission-mode") + 1], permissionMode);
    }
    // 未指定は既定（bypassPermissions）になる。
    const args = buildClaudeArgs({ mode, prompt: "/skill 1", model: "opus", effort: "high" });
    assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  }
});

test("buildClaudeArgs omits --advisor unless an advisor model is given", () => {
  for (const advisorModel of [undefined, "", "   "]) {
    const args = buildClaudeArgs({ mode: "default", prompt: "/skill 1", model: "opus", effort: "high", advisorModel });
    assert.ok(!args.includes("--advisor"), `--advisor must be omitted for ${JSON.stringify(advisorModel)}`);
  }
});

test("buildClaudeArgs passes --advisor with the model in both modes", () => {
  for (const mode of ["default", "herdr"] as const) {
    const args = buildClaudeArgs({ mode, prompt: "/skill 1", model: "sonnet", effort: "high", advisorModel: "opus" });
    assert.equal(args[args.indexOf("--advisor") + 1], "opus");
    // 値なしの --advisor は後続フラグを値として食うため、必ず末尾に値が続くこと。
    assert.ok(args.indexOf("--advisor") < args.length - 1);
  }
});

test("buildClaudeEnv drops the print-only ceiling outside print mode (herdr / cloud)", () => {
  assert.deepEqual(buildClaudeEnv("default"), { ...CLAUDE_SPAWN_ENV });
  assert.deepEqual(buildClaudeEnv("herdr"), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  // `--cloud` は `--print` と併用できないため、default モードのクラウド実行も print にならない。
  assert.ok(!("CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" in buildClaudeEnv("default", true)));
});

test("buildClaudeEnv does not pass HERDR_DISABLE_SOUND (read by the herdr server, not the pane)", () => {
  assert.ok(!("HERDR_DISABLE_SOUND" in buildClaudeEnv("herdr")));
});

test("buildClaudeEnv adds CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC only when cloud is true", () => {
  assert.deepEqual(buildClaudeEnv("default"), { ...CLAUDE_SPAWN_ENV });
  assert.deepEqual(buildClaudeEnv("default", false), { ...CLAUDE_SPAWN_ENV });
  assert.deepEqual(buildClaudeEnv("herdr", false), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  assert.deepEqual(buildClaudeEnv("default", true), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  assert.deepEqual(buildClaudeEnv("herdr", true), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
});

test("buildClaudeExecution always runs claude directly with the built args", () => {
  for (const mode of ["default", "herdr"] as const) {
    const invocation = { mode, prompt: "/skill 123", model: "sonnet", effort: "high" } as const;
    const execution = buildClaudeExecution(invocation);
    assert.equal(execution.command, CLAUDE_COMMAND);
    assert.deepEqual(execution.args, buildClaudeArgs(invocation));
  }
});

test("buildClaudeExecution keeps `-p <prompt>` as the only difference between the two modes", () => {
  const common = { prompt: "/skill 1", model: "opus", effort: "high" } as const;
  const defaultArgs = buildClaudeExecution({ mode: "default", ...common }).args;
  const herdrArgs = buildClaudeExecution({ mode: "herdr", ...common }).args;

  assert.equal(defaultArgs[0], "-p");
  assert.equal(defaultArgs[1], "/skill 1");
  assert.deepEqual(defaultArgs.slice(2), herdrArgs);
});

// herdr モードだけ、起動後に `herdr agent prompt` で投入するプロンプトを別口で返す。
test("buildClaudeExecution exposes the prompt separately in herdr mode only", () => {
  const common = { prompt: "/skill 1", model: "opus", effort: "high" } as const;
  assert.equal(buildClaudeExecution({ mode: "herdr", ...common }).prompt, "/skill 1");
  assert.equal(buildClaudeExecution({ mode: "default", ...common }).prompt, undefined);
});

test("buildClaudeArgs omits -p <prompt> and --cloud itself when cloud is true", () => {
  // Cloud sessions do not support print mode (observed: `Error: --cloud cannot be
  // combined with --print.`), so -p must drop out in both default and herdr mode.
  // `--cloud <description>` itself is not added here: description（herdr のタスクタブ
  // ラベル）は process-manager.ts 側でしか決まらないため、buildCloudCreateArgs() が
  // このフラグ列の先頭へ足して作成コマンドを完成させる。
  for (const mode of ["default", "herdr"] as const) {
    const args = buildClaudeArgs({ mode, prompt: "/skill 1", model: "opus", effort: "high", cloud: true });
    assert.ok(!args.includes("-p"));
    assert.ok(!args.includes("/skill 1"));
    assert.ok(!args.includes("--cloud"));
  }
});

test("buildClaudeArgs (cloud) contains only the create command's common flags", () => {
  const args = buildClaudeArgs({ mode: "herdr", prompt: "/skill 1", model: "opus", effort: "high", cloud: true });
  assert.ok(args.includes("--permission-mode"));
  assert.ok(args.includes("--disallowedTools"));
  assert.ok(args.includes("--append-system-prompt-file"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--effort"));
});

test("buildCloudCreateArgs prepends --cloud <prompt> to the common flags", () => {
  // 1コマンド方式では description はクラウドセッションの初期プロンプトそのもの
  // （渡した瞬間に実行される）ため、複数行のタスクプロンプトを渡すケースで検証する。
  const commonArgs = ["--permission-mode", "bypassPermissions", "--model", "opus"];
  const prompt = "/claude-task-worker:exec-issue 123\n\n追加の指示1行目\n追加の指示2行目";
  assert.deepEqual(buildCloudCreateArgs(commonArgs, prompt), [
    "--cloud",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--model",
    "opus",
  ]);
});

test("shellQuote wraps values in single quotes and escapes embedded single quotes", () => {
  assert.equal(shellQuote("simple"), "'simple'");
  assert.equal(shellQuote("with space"), "'with space'");
  assert.equal(shellQuote("ctw:my-app:#123"), "'ctw:my-app:#123'");
  assert.equal(shellQuote("it's here"), "'it'\\''s here'");
});

test("shellQuote keeps a multi-line value as a single quoted token", () => {
  // herdr の `pane send-text` はシェルへそのまま送るため、改行を含む初期プロンプトも
  // 単一のシングルクォートトークンに収まっている必要がある（複数トークンに割れると
  // 後続のコマンド解釈が壊れる）。
  const quoted = shellQuote("line1\nline2\nline3");
  assert.equal(quoted, "'line1\nline2\nline3'");
  assert.equal(quoted.match(/'/g)?.length, 2, "囲む2つのシングルクォート以外が含まれてはいけない");
});

test("buildScriptCommand builds a BSD script(1) argv on darwin", () => {
  const result = buildScriptCommand("claude", ["--cloud", "do it"], "darwin");
  assert.deepEqual(result, {
    command: "script",
    args: ["-q", "/dev/null", "claude", "--cloud", "do it"],
  });
});

test("buildScriptCommand builds a util-linux script(1) argv on linux with a single quoted command string", () => {
  const prompt = "line1\nline2 with 'quotes' and spaces";
  const result = buildScriptCommand("claude", ["--cloud", prompt], "linux");
  assert.equal(result.command, "script");
  assert.equal(result.args.length, 3);
  assert.equal(result.args[0], "-qec");
  assert.equal(result.args[2], "/dev/null");
  assert.equal(result.args[1], [shellQuote("claude"), shellQuote("--cloud"), shellQuote(prompt)].join(" "));
});

test("buildScriptCommand throws for an unsupported platform, naming it in the message", () => {
  assert.throws(() => buildScriptCommand("claude", [], "win32"), /win32/);
});

test("buildClaudeArgs passes --ref when baseRef is given", () => {
  const args = buildClaudeArgs({
    mode: "herdr",
    prompt: "/skill 1",
    model: "opus",
    effort: "high",
    cloud: true,
    baseRef: "main",
  });
  assert.equal(args[args.indexOf("--ref") + 1], "main");
  assert.ok(!args.includes("--on-branch"));
});

test("buildClaudeArgs passes --on-branch when onBranch is given", () => {
  const args = buildClaudeArgs({
    mode: "herdr",
    prompt: "/skill 1",
    model: "opus",
    effort: "high",
    cloud: true,
    onBranch: "cc-epic-1",
  });
  assert.equal(args[args.indexOf("--on-branch") + 1], "cc-epic-1");
  assert.ok(!args.includes("--ref"));
});

test("buildClaudeArgs throws when both baseRef and onBranch are given for a cloud session", () => {
  assert.throws(
    () =>
      buildClaudeArgs({
        mode: "herdr",
        prompt: "/skill 1",
        model: "opus",
        effort: "high",
        cloud: true,
        baseRef: "main",
        onBranch: "cc-epic-1",
      }),
    /--on-branch and --ref/,
  );
});

test("buildClaudeArgs omits both --ref and --on-branch when neither is given for a cloud session", () => {
  const args = buildClaudeArgs({ mode: "herdr", prompt: "/skill 1", model: "opus", effort: "high", cloud: true });
  assert.ok(!args.includes("--ref"));
  assert.ok(!args.includes("--on-branch"));
});

test("buildClaudeArgs keeps the other flags unchanged for a cloud session", () => {
  const args = buildClaudeArgs({
    mode: "herdr",
    prompt: "/skill 1",
    model: "opus",
    effort: "high",
    cloud: true,
    baseRef: "main",
  });
  assert.equal(args[args.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.equal(args[args.indexOf("--disallowedTools") + 1], DISALLOWED_TOOLS_ARG);
  assert.equal(args[args.indexOf("--append-system-prompt-file") + 1], systemPromptFilePath("opus"));
  assert.equal(args[args.indexOf("--model") + 1], "opus");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
});

test("buildClaudeArgs is unchanged when cloud is unspecified or false", () => {
  const common = { prompt: "/skill 123", model: "sonnet", effort: "high" } as const;
  for (const mode of ["default", "herdr"] as const) {
    const withoutCloud = buildClaudeArgs({ mode, ...common });
    const cloudFalse = buildClaudeArgs({ mode, ...common, cloud: false });
    assert.deepEqual(cloudFalse, withoutCloud);
    assert.ok(!withoutCloud.includes("--cloud"));
  }
});

test("appendCloudDoneInstruction keeps the original prompt and appends the label instruction", () => {
  const prompt = "/claude-task-worker:exec-issue 123";
  const result = appendCloudDoneInstruction(prompt, { type: "issue", number: 123 });
  assert.ok(result.startsWith(prompt));
  assert.ok(result.includes("cc-cloud-done"));
  assert.ok(result.includes("Issue #123"));
});

test("appendCloudDoneInstruction includes the cloud report heading", () => {
  const result = appendCloudDoneInstruction("/skill 1", { type: "issue", number: 1 });
  assert.ok(result.includes(CLOUD_REPORT_HEADING));
});

test("appendCloudDoneInstruction switches wording between issue and pr targets", () => {
  const issueResult = appendCloudDoneInstruction("/skill 1", { type: "issue", number: 1 });
  const prResult = appendCloudDoneInstruction("/skill 1", { type: "pr", number: 1 });
  assert.ok(issueResult.includes("Issue #1"));
  assert.ok(issueResult.includes("gh issue edit 1 --add-label cc-cloud-done"));
  assert.ok(prResult.includes("PR #1"));
  assert.ok(prResult.includes("gh pr edit 1 --add-label cc-cloud-done"));
});

test("buildCloudToolRestriction lists every DISALLOWED_TOOLS entry", () => {
  const restriction = buildCloudToolRestriction();
  for (const tool of DISALLOWED_TOOLS) {
    assert.ok(restriction.includes(tool), `expected restriction text to mention ${tool}`);
  }
});

test("buildCloudCheckoutInstruction tells PR tasks to skip gh pr checkout", () => {
  const result = buildCloudCheckoutInstruction({ type: "pr", number: 42 });
  assert.match(result, /PR #42/);
  assert.match(result, /gh pr checkout/);
  assert.match(result, /--on-branch/);
});

test("buildCloudCheckoutInstruction stays empty for issue tasks", () => {
  // Issue 系ワーカーは `--ref` でベースブランチだけを指定し、クラウド側が新規作業ブランチを
  // 切る。checkout の概念が無いので指示を足さない。
  assert.equal(buildCloudCheckoutInstruction({ type: "issue", number: 42 }), "");
});

test("appendCloudDoneInstruction adds the checkout skip only for pr targets", () => {
  assert.match(appendCloudDoneInstruction("/skill 1", { type: "pr", number: 7 }), /gh pr checkout/);
  assert.doesNotMatch(appendCloudDoneInstruction("/skill 1", { type: "issue", number: 7 }), /gh pr checkout/);
});

test("buildCloudWorktreeInstruction exempts the worktree guard but keeps the default-branch check", () => {
  const result = buildCloudWorktreeInstruction("/claude-task-worker:exec-issue 1");
  assert.match(result, /\.claude\/worktrees\//);
  // 免除するのは worktree 条件だけで、ガードの目的である「デフォルトブランチで作業しない」は
  // 残す。この2点が同時に書かれていないと、スキルが両方を落として保護がゼロになる。
  assert.match(result, /デフォルトブランチ/);
});

test("buildCloudWorktreeInstruction only targets exec-issue and fix-review-point", () => {
  // 同じ worktree ガードを持つ他スキル（クラウドで走る create-issue-from-issue-number /
  // update-issue を含む）まで巻き添えで免除しないこと。
  assert.notEqual(buildCloudWorktreeInstruction("/claude-task-worker:fix-review-point 1"), "");
  for (const skill of [
    "/claude-task-worker:create-issue-from-issue-number",
    "/claude-task-worker:update-issue",
    "/claude-task-worker:triage-pr",
    "/claude-task-worker:create-ui-design",
  ]) {
    assert.equal(buildCloudWorktreeInstruction(`${skill} 1`), "");
  }
});

test("appendCloudDoneInstruction adds the worktree exemption for both issue and pr targets", () => {
  // exec-issue（Issue 系）と fix-review-point（PR 系）が同じガードを持つため、
  // checkout 指示と違い両方へ付ける。対象外スキルには付かない。
  assert.match(
    appendCloudDoneInstruction("/claude-task-worker:exec-issue 7", { type: "issue", number: 7 }),
    /\.claude\/worktrees\//,
  );
  assert.match(
    appendCloudDoneInstruction("/claude-task-worker:fix-review-point 7", { type: "pr", number: 7 }),
    /\.claude\/worktrees\//,
  );
  assert.doesNotMatch(
    appendCloudDoneInstruction("/claude-task-worker:update-issue 7", { type: "issue", number: 7 }),
    /\.claude\/worktrees\//,
  );
});

test("buildCloudPrompt keeps the worktree exemption scoped once principles are prepended", () => {
  // buildCloudPrompt はタスクプロンプトを先頭に置くため、原則を連結した後も先頭トークンは
  // スキル名のまま。ここが崩れると対象スキルの判定が効かなくなる。
  assert.match(
    buildCloudPrompt("/claude-task-worker:exec-issue 7", "sonnet", { type: "issue", number: 7 }),
    /\.claude\/worktrees\//,
  );
  assert.doesNotMatch(
    buildCloudPrompt("/claude-task-worker:triage-pr 7", "sonnet", { type: "pr", number: 7 }),
    /\.claude\/worktrees\//,
  );
});

test("local execution keeps the prompt free of the worktree exemption", () => {
  // ローカル実行はワーカーが worktree を作るためガードをそのまま効かせる必要がある。
  // ローカルのプロンプトは `-p` の引数としてそのまま渡り、cloud 系の組み立てを通らない。
  const args = buildClaudeArgs({ mode: "default", prompt: "/skill 1", model: "sonnet", effort: "high" });
  assert.deepEqual(
    args.filter((arg) => arg.includes(".claude/worktrees/")),
    [],
  );
});

test("buildCloudPrompt includes the base system prompt body", () => {
  const result = buildCloudPrompt("/skill 1", "sonnet");
  assert.ok(result.includes(SYSTEM_PROMPT_BASE));
});

test("buildCloudPrompt appends the opus addendum only for opus models", () => {
  const opusResult = buildCloudPrompt("/skill 1", "opus");
  const sonnetResult = buildCloudPrompt("/skill 1", "sonnet");
  assert.ok(opusResult.includes(OPUS_SYSTEM_PROMPT_ADDENDUM));
  assert.ok(!sonnetResult.includes(OPUS_SYSTEM_PROMPT_ADDENDUM));
});

test("buildCloudPrompt includes the tool restriction text", () => {
  const result = buildCloudPrompt("/skill 1", "sonnet");
  for (const tool of DISALLOWED_TOOLS) {
    assert.ok(result.includes(tool));
  }
});

test("buildCloudPrompt keeps the cc-cloud-done instruction and task prompt when a target is given", () => {
  const prompt = "/claude-task-worker:exec-issue 123";
  const result = buildCloudPrompt(prompt, "sonnet", { type: "issue", number: 123 });
  assert.ok(result.startsWith(prompt));
  assert.ok(result.includes(prompt));
  assert.ok(result.includes(CLOUD_REPORT_HEADING));
  assert.ok(result.includes("cc-cloud-done"));
  assert.ok(result.includes("Issue #123"));
});

test("buildCloudPrompt omits the cc-cloud-done instruction when no target is given", () => {
  const result = buildCloudPrompt("/claude-task-worker:update-coding-guidelines 1", "sonnet");
  assert.ok(!result.includes("cc-cloud-done"));
  assert.ok(!result.includes(CLOUD_REPORT_HEADING));
  assert.ok(result.includes(SYSTEM_PROMPT_BASE));
  assert.ok(result.includes(DISALLOWED_TOOLS[0]));
});

test("buildClaudeArgs passes --environment with the id only for cloud runs", () => {
  const base = { prompt: "/skill 1", model: "opus", effort: "high", remoteEnvId: "env_abc" } as const;
  const cloudArgs = buildClaudeArgs({ mode: "default", cloud: true, ...base });
  assert.equal(cloudArgs[cloudArgs.indexOf("--environment") + 1], "env_abc");
  // 値なしの --environment は後続フラグを値として食うため、必ず末尾に値が続くこと。
  assert.ok(cloudArgs.indexOf("--environment") < cloudArgs.length - 1);
  // ローカル実行（--cloud なし）では claude が受け付けないので付けない。
  assert.ok(!buildClaudeArgs({ mode: "default", ...base }).includes("--environment"));
});

test("buildClaudeArgs omits --environment unless a remote env id is given", () => {
  for (const remoteEnvId of [undefined, "", "   "]) {
    const args = buildClaudeArgs({
      mode: "default",
      cloud: true,
      prompt: "/skill 1",
      model: "opus",
      effort: "high",
      remoteEnvId,
    });
    assert.ok(!args.includes("--environment"), `--environment must be omitted for ${JSON.stringify(remoteEnvId)}`);
  }
});
