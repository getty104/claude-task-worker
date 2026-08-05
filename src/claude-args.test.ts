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

test("buildClaudeArgs uses -p only in default mode", () => {
  const common = { prompt: "/skill 123", model: "sonnet", effort: "high" };
  const defaultArgs = buildClaudeArgs({ mode: "default", ...common });
  const herdrArgs = buildClaudeArgs({ mode: "herdr", ...common });

  assert.equal(defaultArgs[0], "-p");
  assert.equal(defaultArgs[1], "/skill 123");
  assert.equal(herdrArgs[0], "/skill 123");
  assert.ok(!herdrArgs.includes("-p"));
  // Everything except the -p flag is identical between the two modes.
  assert.deepEqual(defaultArgs.slice(1), herdrArgs);
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

test("buildClaudeEnv drops the print-only ceiling in herdr mode", () => {
  assert.deepEqual(buildClaudeEnv("default"), { ...CLAUDE_SPAWN_ENV });
  assert.deepEqual(buildClaudeEnv("herdr"), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
});

test("buildClaudeEnv does not pass HERDR_DISABLE_SOUND (read by the herdr server, not the pane)", () => {
  assert.ok(!("HERDR_DISABLE_SOUND" in buildClaudeEnv("herdr")));
});

test("buildClaudeExecution always runs claude directly with the built args", () => {
  for (const mode of ["default", "herdr"] as const) {
    const invocation = { mode, prompt: "/skill 123", model: "sonnet", effort: "high" } as const;
    const execution = buildClaudeExecution(invocation);
    assert.equal(execution.command, CLAUDE_COMMAND);
    assert.deepEqual(execution.args, buildClaudeArgs(invocation));
  }
});

test("buildClaudeExecution keeps -p as the only difference between the two modes", () => {
  const common = { prompt: "/skill 1", model: "opus", effort: "high" } as const;
  const defaultArgs = buildClaudeExecution({ mode: "default", ...common }).args;
  const herdrArgs = buildClaudeExecution({ mode: "herdr", ...common }).args;

  assert.equal(defaultArgs[0], "-p");
  assert.deepEqual(defaultArgs.slice(1), herdrArgs);
});
