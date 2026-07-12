import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ClaudeArgsModule from "./claude-args";

const { DISALLOWED_TOOLS, DISALLOWED_TOOLS_ARG } = (await import("./claude-args.ts")) as typeof ClaudeArgsModule;

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
