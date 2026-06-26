#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue";
import { fixReviewPointWorker } from "./workers/fix-review-point";
import { createIssueWorker } from "./workers/create-issue";
import { updateIssueWorker } from "./workers/update-issue";
import { answerIssueQuestionsWorker } from "./workers/answer-issue-questions";
import { triageIssueWorker } from "./workers/triage-issue";
import { triageCreatedIssueWorker } from "./workers/triage-created-issue";
import { triagePrWorker } from "./workers/triage-pr";
import { checkDependabotWorker } from "./workers/check-dependabot";
import { epicIssueWorker } from "./workers/epic-issue";
import { shutdown, waitForAllProcesses, setShuttingDown, isShuttingDown } from "./process-manager";
import { init } from "./commands/init";
import { buildTokenLimitText, send } from "./slack";

const WORKERS: Record<string, (opts?: { epicFilter?: number }) => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
  "create-issue": createIssueWorker,
  "update-issue": updateIssueWorker,
  "answer-issue-questions": answerIssueQuestionsWorker,
  "triage-issue": triageIssueWorker,
  "triage-created-issue": triageCreatedIssueWorker,
  "triage-pr": triagePrWorker,
  "check-dependabot": checkDependabotWorker,
  "epic-issue": epicIssueWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command> [--epic <issue-number>]

Commands:
  init [--force]    Create required GitHub labels and config file (use --force to overwrite existing files)
  usage             Notify current usage to Slack

Workers:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point
  create-issue      Poll issues and run /create-issue
  update-issue      Poll issues and run update command
  answer-issue-questions  Poll issues and run /answer-issue-questions
  triage-issue      Poll cc-triage-scope issues and run /triage-issues per issue
  triage-created-issue  Poll cc-created-issue + cc-triage-issue issues and run /triage-created-issue
  triage-pr         Poll and triage PRs every 5 minutes
  check-dependabot  Poll dependabot PRs every 1 hour
  epic-issue        Poll cc-epic-issue issues and create epic PR when all sub-issues are closed
  all               Poll all workers except triage-issue, triage-created-issue, triage-pr, check-dependabot
  yolo              Poll all workers including triage-issue, triage-created-issue, triage-pr, check-dependabot

Options:
  --epic <number>   Limit issue-based workers to sub-issues of the specified epic issue (for 'all' and 'yolo')

Example:
  claude-task-worker init
  claude-task-worker exec-issue
  claude-task-worker all --epic 100`);
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

function parseEpicFilter(): number | undefined {
  const idx = process.argv.indexOf("--epic");
  if (idx === -1) return undefined;
  const raw = process.argv[idx + 1];
  if (!raw) {
    console.error("--epic requires a numeric issue number");
    process.exit(1);
  }
  const num = Number(raw);
  if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
    console.error(`--epic requires a positive integer issue number, got: ${raw}`);
    process.exit(1);
  }
  return num;
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
  const epicFilter = parseEpicFilter();
  Promise.all([
    execIssueWorker({ epicFilter }),
    fixReviewPointWorker(),
    createIssueWorker({ epicFilter }),
    updateIssueWorker({ epicFilter }),
    answerIssueQuestionsWorker({ epicFilter }),
    epicIssueWorker(),
  ]);
} else if (workerType === "yolo") {
  const epicFilter = parseEpicFilter();
  (async () => {
    await Promise.all([
      execIssueWorker({ epicFilter }),
      fixReviewPointWorker(),
      createIssueWorker({ epicFilter }),
      updateIssueWorker({ epicFilter }),
      answerIssueQuestionsWorker({ epicFilter }),
      triageIssueWorker({ epicFilter }),
      triageCreatedIssueWorker({ epicFilter }),
      checkDependabotWorker(),
      triagePrWorker(),
      epicIssueWorker(),
    ]);
  })();
} else {
  WORKERS[workerType]();
}
