import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ClaudeArgsModule from "./claude-args";

const { DISALLOWED_TOOLS, DISALLOWED_TOOLS_ARG, CLAUDE_SPAWN_ENV, SUBAGENT_SYSTEM_PROMPT } =
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

test("SUBAGENT_SYSTEM_PROMPT states the autonomous-execution principles", () => {
  // The principles injected into every subagent: no user questions, finish the
  // delegated task before reporting, verify nested subagent reports.
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes("ユーザーへの確認・質問は行わない"));
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes("完遂してから最終報告"));
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes("完了報告を鵜呑みにしない"));
});
