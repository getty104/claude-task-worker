#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue";
import { fixReviewPointWorker } from "./workers/fix-review-point";
import { createIssueWorker } from "./workers/create-issue";
import { updateIssueWorker } from "./workers/update-issue";
import { answerIssueQuestionsWorker } from "./workers/answer-issue-questions";
import { triageCreatedIssueWorker } from "./workers/triage-created-issue";
import { triagePrWorker } from "./workers/triage-pr";
import { resolveConflictWorker } from "./workers/resolve-conflict";
import { checkDependabotWorker } from "./workers/check-dependabot";
import { epicIssueWorker } from "./workers/epic-issue";
import { shutdown, waitForAllProcesses, setShuttingDown, isShuttingDown } from "./process-manager";
import { init } from "./commands/init";
import { buildTokenLimitText, send } from "./slack";

const WORKERS: Record<string, (opts?: { epicFilters?: number[]; labelFilters?: string[] }) => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
  "create-issue": createIssueWorker,
  "update-issue": updateIssueWorker,
  "answer-issue-questions": answerIssueQuestionsWorker,
  "triage-created-issue": triageCreatedIssueWorker,
  "triage-pr": triagePrWorker,
  "resolve-conflict": resolveConflictWorker,
  "check-dependabot": checkDependabotWorker,
  "epic-issue": epicIssueWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command> [--epic <issue-number>] [--label <label-name>]

Commands:
  init [--force]    Create required GitHub labels and config file (use --force to overwrite existing files)
  usage             Notify current usage to Slack

Workers:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point
  create-issue      Poll issues and run /create-issue
  update-issue      Poll issues and run update command
  answer-issue-questions  Poll issues and run /answer-issue-questions
  triage-created-issue  Poll cc-issue-created + cc-triage-scope issues and run /triage-created-issue
  triage-pr         Poll and triage PRs every 5 minutes
  resolve-conflict  Poll cc-resolve-conflict PRs and run /resolve-conflict
  check-dependabot  Poll dependabot PRs every 1 hour
  epic-issue        Poll cc-epic-issue issues and create epic PR when all sub-issues are closed
  all               Poll all workers except triage-created-issue, triage-pr, check-dependabot
  yolo              Poll all workers including triage-created-issue, triage-pr, check-dependabot

Options:
  --epic <number>   Limit issue-based workers to sub-issues of the specified epic issue. Repeatable: any matching parent (OR).
  --label <name>    Limit issue-based workers to issues that also carry the specified label. Repeatable: all must be present (AND).

Example:
  claude-task-worker init
  claude-task-worker exec-issue
  claude-task-worker all --epic 100
  claude-task-worker all --epic 100 --epic 200
  claude-task-worker all --label priority-high
  claude-task-worker all --label priority-high --label needs-design
  claude-task-worker yolo --epic 100 --epic 200 --label priority-high`);
}

const workerType = process.argv[2];

if (!workerType) {
  printUsage();
  process.exit(1);
}

if (
  workerType !== "all" &&
  workerType !== "yolo" &&
  workerType !== "init" &&
  workerType !== "usage" &&
  !WORKERS[workerType]
) {
  console.error(`Unknown command: ${workerType}`);
  printUsage();
  process.exit(1);
}

function collectFlagValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== flag) continue;
    const raw = process.argv[i + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }
    values.push(raw);
  }
  return values;
}

function parseEpicFilters(): number[] {
  const raws = collectFlagValues("--epic");
  return raws.map((raw) => {
    const num = Number(raw);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
      console.error(`--epic requires a positive integer issue number, got: ${raw}`);
      process.exit(1);
    }
    return num;
  });
}

function parseLabelFilters(): string[] {
  return collectFlagValues("--label");
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandled rejection:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  if (isShuttingDown()) return;
  setShuttingDown();
  console.log(
    "\n[worker] Stopping new tasks. Waiting for in-flight tasks to finish... (Send SIGTERM again to force kill)",
  );
  await waitForAllProcesses();
  process.exit(0);
});

let forceKilling = false;
process.on("SIGINT", async () => {
  if (isShuttingDown()) {
    if (forceKilling) return;
    forceKilling = true;
    console.log("\n[worker] Force killing running tasks... (cleaning up labels and worktrees)");
    shutdown("SIGKILL");
    const cleanupTimeout = new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref());
    await Promise.race([waitForAllProcesses(), cleanupTimeout]);
    process.exit(1);
  }
  setShuttingDown();
  console.log(
    "\n[worker] Stopping new tasks. Waiting for in-flight tasks to finish... (Press Ctrl-C again to force kill)",
  );
  await waitForAllProcesses();
  process.exit(0);
});

if (workerType === "init") {
  const force = process.argv.slice(3).includes("--force");
  init({ force });
} else if (workerType === "usage") {
  (async () => {
    const text = await buildTokenLimitText();
    if (!text) {
      console.error("Failed to fetch usage info");
      process.exit(1);
    }
    console.log(text.trim());
    await send({ text: `📊 Usage${text}` });
  })();
} else if (workerType === "all") {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  Promise.all([
    execIssueWorker({ epicFilters, labelFilters }),
    fixReviewPointWorker(),
    createIssueWorker({ epicFilters, labelFilters }),
    updateIssueWorker({ epicFilters, labelFilters }),
    answerIssueQuestionsWorker({ epicFilters, labelFilters }),
    resolveConflictWorker(),
    epicIssueWorker({ epicFilters, labelFilters }),
  ]);
} else if (workerType === "yolo") {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  (async () => {
    await Promise.all([
      execIssueWorker({ epicFilters, labelFilters }),
      fixReviewPointWorker(),
      createIssueWorker({ epicFilters, labelFilters }),
      updateIssueWorker({ epicFilters, labelFilters }),
      answerIssueQuestionsWorker({ epicFilters, labelFilters }),
      triageCreatedIssueWorker({ epicFilters, labelFilters }),
      checkDependabotWorker(),
      triagePrWorker(),
      resolveConflictWorker(),
      epicIssueWorker({ epicFilters, labelFilters }),
    ]);
  })();
} else {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  WORKERS[workerType]({ epicFilters, labelFilters });
}
