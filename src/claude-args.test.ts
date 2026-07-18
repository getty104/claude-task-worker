import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ClaudeArgsModule from "./claude-args";

const { DISALLOWED_TOOLS, DISALLOWED_TOOLS_ARG, SUBAGENT_SYSTEM_PROMPT } =
  (await import("./claude-args.ts")) as typeof ClaudeArgsModule;

test("DISALLOWED_TOOLS covers the tools with no autonomous use", () => {
  assert.deepEqual(
    [...DISALLOWED_TOOLS],
    [
      "Monitor",
      "ScheduleWakeup",
      "SendMessage",
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

test("SUBAGENT_SYSTEM_PROMPT states the background-execution prohibitions", () => {
  // The rules injected into every subagent must cover each background-escape vector
  // that block-async-execution.mjs cannot reach inside subagents.
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes("run_in_background: true"));
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes("run_in_background: false"));
  for (const keyword of ["nohup", "disown", "setsid", "Monitor", "ScheduleWakeup", "SendMessage"]) {
    assert.ok(SUBAGENT_SYSTEM_PROMPT.includes(keyword), `missing keyword: ${keyword}`);
  }
});
