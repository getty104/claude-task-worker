import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import type * as ClaudeArgsModule from "./claude-args";

const { buildClaudeArgs, buildClaudeEnv } = (await import("./claude-args")) as typeof ClaudeArgsModule;

// This file pins the full, literal output of buildClaudeArgs()/buildClaudeEnv() for the
// existing local (non-cloud) execution path, so any change to it (intentional or not) fails
// a test here rather than being discovered downstream. Deliberately duplicates literals
// instead of referencing DISALLOWED_TOOLS_ARG / systemPromptFilePath() etc. — this test must
// fail if the production values change, not track them.

// `cloud` is out of scope here by design, not because the field is missing: ClaudeInvocation
// now has `cloud` / `baseRef` / `onBranch`. Cloud argument shapes are pinned in
// claude-args.test.ts, and the worker-level wiring in cloud-execution.integration.test.ts.

const PROMPT_FILE_PLACEHOLDER = "<system-prompt-file>";

function withPromptFilePlaceholder(args: readonly string[]): string[] {
  const copy = [...args];
  const index = copy.indexOf("--append-system-prompt-file") + 1;
  copy[index] = PROMPT_FILE_PLACEHOLDER;
  return copy;
}

test("buildClaudeArgs is pinned for default mode + opus", () => {
  const args = buildClaudeArgs({ mode: "default", prompt: "/skill 1", model: "opus", effort: "high" });
  assert.deepEqual(withPromptFilePlaceholder(args), [
    "-p",
    "/skill 1",
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "Monitor,ScheduleWakeup,AskUserQuestion,EnterPlanMode,CronCreate,CronDelete,CronList,RemoteTrigger,EnterWorktree",
    "--append-system-prompt-file",
    PROMPT_FILE_PLACEHOLDER,
    "--model",
    "opus",
    "--effort",
    "high",
  ]);

  const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
  assert.ok(path.isAbsolute(promptFile));
  assert.equal(path.basename(promptFile), `append-system-prompt-${process.pid}-opus.txt`);
});

test("buildClaudeArgs is pinned for default mode + sonnet", () => {
  const args = buildClaudeArgs({ mode: "default", prompt: "/skill 1", model: "sonnet", effort: "high" });
  assert.deepEqual(withPromptFilePlaceholder(args), [
    "-p",
    "/skill 1",
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "Monitor,ScheduleWakeup,AskUserQuestion,EnterPlanMode,CronCreate,CronDelete,CronList,RemoteTrigger,EnterWorktree",
    "--append-system-prompt-file",
    PROMPT_FILE_PLACEHOLDER,
    "--model",
    "sonnet",
    "--effort",
    "high",
  ]);

  const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
  assert.ok(path.isAbsolute(promptFile));
  assert.equal(path.basename(promptFile), `append-system-prompt-${process.pid}-default.txt`);
});

test("buildClaudeArgs is pinned for herdr mode + opus", () => {
  const args = buildClaudeArgs({ mode: "herdr", prompt: "/skill 1", model: "opus", effort: "high" });
  assert.deepEqual(withPromptFilePlaceholder(args), [
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "Monitor,ScheduleWakeup,AskUserQuestion,EnterPlanMode,CronCreate,CronDelete,CronList,RemoteTrigger,EnterWorktree",
    "--append-system-prompt-file",
    PROMPT_FILE_PLACEHOLDER,
    "--model",
    "opus",
    "--effort",
    "high",
  ]);

  const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
  assert.ok(path.isAbsolute(promptFile));
  assert.equal(path.basename(promptFile), `append-system-prompt-${process.pid}-opus.txt`);
});

test("buildClaudeArgs is pinned for herdr mode + sonnet", () => {
  const args = buildClaudeArgs({ mode: "herdr", prompt: "/skill 1", model: "sonnet", effort: "high" });
  assert.deepEqual(withPromptFilePlaceholder(args), [
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "Monitor,ScheduleWakeup,AskUserQuestion,EnterPlanMode,CronCreate,CronDelete,CronList,RemoteTrigger,EnterWorktree",
    "--append-system-prompt-file",
    PROMPT_FILE_PLACEHOLDER,
    "--model",
    "sonnet",
    "--effort",
    "high",
  ]);

  const promptFile = args[args.indexOf("--append-system-prompt-file") + 1];
  assert.ok(path.isAbsolute(promptFile));
  assert.equal(path.basename(promptFile), `append-system-prompt-${process.pid}-default.txt`);
});

test("buildClaudeEnv is pinned for default and herdr modes", () => {
  assert.deepEqual(buildClaudeEnv("default"), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
  });
  assert.deepEqual(buildClaudeEnv("herdr"), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  });
  assert.deepEqual(buildClaudeEnv("default", true), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
  assert.deepEqual(buildClaudeEnv("herdr", true), {
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  });
});
