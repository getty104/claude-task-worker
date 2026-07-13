#!/usr/bin/env node
// PreToolUse guard for the worker-driven skills (exec-issue / fix-review-point / ...).
//
// These skills run under `claude -p` (non-interactive). In print mode there is no
// re-invocation loop: if the agent backgrounds work (Bash run_in_background, a
// background Agent) or yields expecting to be woken later (Monitor / ScheduleWakeup),
// the process exits as soon as the turn ends — before the deferred work finishes.
// The outer worker then sees exit code 0, mistakes the unfinished run for a completed
// one, and transitions labels (cc-pr-created / cc-fix-onetime removal) while the E2E
// tests / PR creation never actually ran.
//
// The skill prose already forbids this, but prose is not enforced. This hook turns the
// rule into a hard guardrail by DENYing the offending tool calls so everything runs
// synchronously in the foreground and the -p session only ends once the work is done.
//
// The decision logic lives in the pure `evaluate()` export so it can be unit tested;
// the stdin→decision plumbing only runs when this file is executed as the hook entry.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FOREGROUND_HINT =
  "This skill runs under `claude -p` (non-interactive): there is no later re-invocation, " +
  "so any deferred or backgrounded work is abandoned the moment the turn ends and the outer " +
  "worker mistakes the unfinished run for a completed one. Run the work synchronously in the " +
  "FOREGROUND and wait for it to finish before continuing.";

export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Blank out single- and double-quoted spans so shell operators / keywords that live
// inside string literals (e.g. `echo "please dont nohup this"`, a URL with `&`) don't
// trip the detectors.
function stripQuotedSpans(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// A lone `&` acting as the background control operator: not part of `&&`, not a
// redirection (`>&`, `<&`, `&>`, `2>&1`) or the bash `|&` pipe. It backgrounds whatever
// precedes it regardless of position — trailing, before `;`, before a newline, or before
// another command (`long-task & echo done`, `npm run dev &\nsleep 2`).
const BACKGROUND_OP = /(?<![&<>|])&(?![&>])/;

// nohup / disown / setsid only when they start a command (line start, or right after a
// command separator), so `cat nohup.log` and `echo "... nohup ..."` are not flagged.
const DETACH_AT_CMD_START = /(?:^|[;&|\n])\s*(?:nohup|disown|setsid)\b/;

/**
 * Decide whether a PreToolUse payload should be denied.
 * @param {unknown} payload Parsed PreToolUse hook input.
 * @returns {{ deny: boolean, reason?: string }}
 */
export function evaluate(payload) {
  if (!isRecord(payload)) return { deny: false };

  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  const toolInput = isRecord(payload.tool_input) ? payload.tool_input : {};
  const bg = toolInput.run_in_background;

  // Pure deferral/yield tools: they hand control back expecting a wakeup that never comes here.
  if (toolName === "Monitor" || toolName === "ScheduleWakeup") {
    return {
      deny: true,
      reason:
        `${toolName} defers work to a later re-invocation. ${FOREGROUND_HINT} ` +
        `Do not use ${toolName}; execute the work inline instead (e.g. run the test/command directly and wait for it).`,
    };
  }

  // Subagents: the Agent tool defaults to run_in_background: true. A foreground call MUST set it to false.
  if (toolName === "Agent") {
    if (bg !== false) {
      return {
        deny: true,
        reason:
          "Agent calls default to run_in_background: true (background). " +
          `${FOREGROUND_HINT} Re-issue this Agent call with run_in_background: false so it completes synchronously.`,
      };
    }
    return { deny: false };
  }

  // Bash: default is foreground, so only block explicit backgrounding or shell-level detachment.
  if (toolName === "Bash") {
    if (bg === true) {
      return {
        deny: true,
        reason:
          "Bash was invoked with run_in_background: true. " +
          `${FOREGROUND_HINT} Re-run it with run_in_background: false (or omit the flag) and wait for it to finish.`,
      };
    }
    const rawCmd = typeof toolInput.command === "string" ? toolInput.command : "";
    const cmd = stripQuotedSpans(rawCmd);
    if (DETACH_AT_CMD_START.test(cmd) || BACKGROUND_OP.test(cmd)) {
      return {
        deny: true,
        reason:
          "This Bash command backgrounds or detaches a process (a `&` control operator, nohup, disown, or setsid). " +
          `${FOREGROUND_HINT} Run it in the foreground without detaching.`,
      };
    }
    return { deny: false };
  }

  return { deny: false };
}

function denyOutput(reason) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf-8") || "{}");
  } catch {
    // Never break a run on malformed hook input.
    process.exit(0);
  }
  const result = evaluate(payload);
  if (result.deny) {
    process.stdout.write(denyOutput(result.reason));
  }
  // No output + exit 0 => the tool call proceeds normally.
  process.exit(0);
}

// Only run the stdin→decision flow when executed as the hook entry point, not when
// imported by unit tests.
const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  main();
}
