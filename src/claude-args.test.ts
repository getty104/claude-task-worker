import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ClaudeArgsModule from "./claude-args";

const { DISALLOWED_TOOLS, DISALLOWED_TOOLS_ARG, CLAUDE_SPAWN_ENV, SYSTEM_PROMPT, buildClaudeArgs, buildClaudeEnv } =
  (await import("./claude-args.ts")) as typeof ClaudeArgsModule;

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
