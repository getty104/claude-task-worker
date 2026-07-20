import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ClaudeArgsModule from "./claude-args";

const {
  DISALLOWED_TOOLS,
  DISALLOWED_TOOLS_ARG,
  CLAUDE_SPAWN_ENV,
  SYSTEM_PROMPT,
  CLAUDE_COMMAND,
  HEADROOM_COMMAND,
  buildClaudeArgs,
  buildClaudeEnv,
  buildClaudeExecution,
  HEADROOM_WRAP_OPTIONS,
  withContext1mSuffix,
} = (await import("./claude-args.ts")) as typeof ClaudeArgsModule;

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

test("SYSTEM_PROMPT states the autonomous-execution principles for the main agent", () => {
  // Injected via --append-system-prompt; replaces the paragraph formerly
  // duplicated in every worker-driven skill's 実行モードの制約 section.
  assert.ok(SYSTEM_PROMPT.includes("ユーザーへの確認・質問は行わず"));
  assert.ok(SYSTEM_PROMPT.includes("全ステップを完遂してから"));
  assert.ok(SYSTEM_PROMPT.includes("破壊的でない側"));
});

test("SYSTEM_PROMPT also carries the subagent rules", () => {
  // --append-subagent-system-prompt is print-mode only, so the subagent principles
  // are folded into the single --append-system-prompt injection instead.
  assert.ok(SYSTEM_PROMPT.includes("サブエージェントへ作業を委譲する場合"));
  assert.ok(SYSTEM_PROMPT.includes("完了報告は鵜呑みにしない"));
});

test("SYSTEM_PROMPT tells the agent to prefer CodeGraph over text search", () => {
  // explore-agent has the detailed procedure, but the main agent (and any other
  // subagent it delegates to) only learns the preference from here.
  assert.ok(SYSTEM_PROMPT.includes("CodeGraph が使える場合"));
  // Availability is decided by the MCP tool alone.
  assert.ok(SYSTEM_PROMPT.includes("MCP ツール"));
  assert.ok(SYSTEM_PROMPT.includes("codegraph_explore"));
  // And the agent must not set CodeGraph up mid-task.
  assert.ok(SYSTEM_PROMPT.includes("インデックスを用意しようとしない"));
});

test("SYSTEM_PROMPT does not assume a specific run mode", () => {
  // Injected into both `claude -p` (default mode) and TUI (herdr mode) sessions.
  assert.ok(!SYSTEM_PROMPT.includes("print"));
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
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.equal(args[args.indexOf("--disallowedTools") + 1], DISALLOWED_TOOLS_ARG);
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], SYSTEM_PROMPT);
    assert.equal(args[args.indexOf("--model") + 1], "opus");
    assert.equal(args[args.indexOf("--effort") + 1], "xhigh");
    // The subagent flag is print-mode only and no longer used in either mode.
    assert.ok(!args.includes("--append-subagent-system-prompt"));
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

test("buildClaudeExecution runs claude directly when headroom is off", () => {
  const invocation = { mode: "default", prompt: "/skill 123", model: "sonnet", effort: "high" } as const;
  const expectedArgs = buildClaudeArgs(invocation);

  for (const headroom of [undefined, false]) {
    const execution = buildClaudeExecution({ ...invocation, headroom });
    assert.equal(execution.command, CLAUDE_COMMAND);
    assert.deepEqual(execution.args, expectedArgs);
  }
});

test("buildClaudeExecution wraps claude with headroom when enabled", () => {
  const invocation = {
    mode: "default",
    prompt: "/skill 123",
    model: "sonnet",
    effort: "high",
    headroom: true,
  } as const;
  const execution = buildClaudeExecution(invocation);

  assert.equal(execution.command, HEADROOM_COMMAND);
  assert.deepEqual(execution.args, ["wrap", "claude", ...HEADROOM_WRAP_OPTIONS, "--", ...buildClaudeArgs(invocation)]);
});

test("buildClaudeExecution passes headroom's own options before the -- separator", () => {
  const execution = buildClaudeExecution({
    mode: "default",
    prompt: "/skill 1",
    model: "opus",
    effort: "high",
    headroom: true,
  });
  const separator = execution.args.indexOf("--");
  // Every headroom-own option must sit before the -- separator so headroom parses them.
  for (const flag of ["--1m", "--memory", "--no-tokensave", "--no-serena"]) {
    const index = execution.args.indexOf(flag);
    assert.ok(index > 1 && index < separator, `${flag} must be a headroom wrap option before --`);
  }
});

test("buildClaudeExecution opts out of tokensave and its Serena fallback", () => {
  // Not a context-size optimisation: with ENABLE_TOOL_SEARCH on, MCP tool schemas stay out
  // of the request (measured A/B difference: 11 bytes). The point is to stop headroom
  // re-registering + re-indexing tokensave on every task launch, and to stop it mutating the
  // user's global ~/.claude.json. --code-graph would contradict the opt-out, and
  // --no-tokensave alone just swaps in Serena.
  const execution = buildClaudeExecution({
    mode: "default",
    prompt: "/skill 1",
    model: "opus",
    effort: "high",
    headroom: true,
  });
  assert.ok(!execution.args.includes("--code-graph"));
  assert.ok(execution.args.includes("--no-tokensave"));
  assert.ok(execution.args.includes("--no-serena"));
});

test("buildClaudeArgs appends the [1m] suffix to --model only under headroom", () => {
  const common = { mode: "default", prompt: "/skill 1", effort: "high" } as const;

  // headroom's --1m only sets ANTHROPIC_MODEL, which the CLI's --model overrides, so the
  // suffix has to ride on --model itself for Claude Code to send the context-1m beta header.
  const wrapped = buildClaudeArgs({ ...common, model: "sonnet", headroom: true });
  assert.equal(wrapped[wrapped.indexOf("--model") + 1], "sonnet[1m]");

  // Without headroom there is no proxy stripping the model picker, so leave the model alone.
  for (const headroom of [undefined, false]) {
    const direct = buildClaudeArgs({ ...common, model: "sonnet", headroom });
    assert.equal(direct[direct.indexOf("--model") + 1], "sonnet");
  }
});

test("withContext1mSuffix is idempotent", () => {
  assert.equal(withContext1mSuffix("opus"), "opus[1m]");
  assert.equal(withContext1mSuffix("opus[1m]"), "opus[1m]");
  assert.equal(withContext1mSuffix("claude-sonnet-5[1m]"), "claude-sonnet-5[1m]");
});

test("buildClaudeExecution puts every claude flag after the -- separator", () => {
  // `headroom wrap claude` has its own options (--port / --memory / --no-mcp ...), and
  // flags like -p are only forwarded to claude when they follow `--`.
  for (const mode of ["default", "herdr"] as const) {
    const execution = buildClaudeExecution({
      mode,
      prompt: "/skill 1",
      model: "opus",
      effort: "xhigh",
      headroom: true,
    });
    const separator = execution.args.indexOf("--");
    assert.equal(separator, 2 + HEADROOM_WRAP_OPTIONS.length);
    // Nothing before the separator except `wrap claude` and headroom's own options.
    assert.deepEqual(execution.args.slice(0, separator), ["wrap", "claude", ...HEADROOM_WRAP_OPTIONS]);
    for (const flag of ["-p", "--model", "--effort", "--disallowedTools", "--append-system-prompt"]) {
      const index = execution.args.indexOf(flag);
      if (index === -1) continue; // -p is default-mode only
      assert.ok(index > separator, `${flag} must come after the -- separator`);
    }
  }
});

test("buildClaudeExecution keeps headroom orthogonal to the run mode", () => {
  const common = { prompt: "/skill 1", model: "opus", effort: "high", headroom: true } as const;
  const defaultArgs = buildClaudeExecution({ mode: "default", ...common }).args;
  const herdrArgs = buildClaudeExecution({ mode: "herdr", ...common }).args;

  // -p remains the only difference between the two modes, even when wrapped.
  const defaultSep = defaultArgs.indexOf("--");
  const herdrSep = herdrArgs.indexOf("--");
  assert.equal(defaultArgs[defaultSep + 1], "-p");
  assert.deepEqual(defaultArgs.slice(defaultSep + 2), herdrArgs.slice(herdrSep + 1));
});
