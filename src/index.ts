#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue";
import { fixReviewPointWorker } from "./workers/fix-review-point";
import { createIssueWorker } from "./workers/create-issue";
import { updateIssueWorker } from "./workers/update-issue";
import { answerIssueQuestionsWorker } from "./workers/answer-issue-questions";
import { triageIssueWorker } from "./workers/triage-issue";
import { triagePrWorker } from "./workers/triage-pr";
import { checkDependabotWorker } from "./workers/check-dependabot";
import { shutdown, waitForAllProcesses, setShuttingDown, isShuttingDown } from "./process-manager";
import { init } from "./commands/init";
import { buildTokenLimitText, send } from "./slack";

const WORKERS: Record<string, () => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
  "create-issue": createIssueWorker,
  "update-issue": updateIssueWorker,
  "answer-issue-questions": answerIssueQuestionsWorker,
  "triage-issue": triageIssueWorker,
  "triage-pr": triagePrWorker,
  "check-dependabot": checkDependabotWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command>

Commands:
  init              Create required GitHub labels and config file
  usage             Notify current usage to Slack

Workers:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point
  create-issue      Poll issues and run /create-issue
  update-issue      Poll issues and run update command
  answer-issue-questions  Poll issues and run /answer-issue-questions
  triage-issue      Poll cc-triage-scope issues and run /triage-issues per issue
  triage-pr         Poll and triage PRs every 5 minutes
  check-dependabot  Poll dependabot PRs every 1 hour
  all               Poll all workers (except triage)
  yolo              Poll all workers including triage

Example:
  claude-task-worker init
  claude-task-worker exec-issue`);
}

const workerType = process.argv[2];

if (!workerType) {
  printUsage();
  process.exit(1);
}

if (workerType !== "all" && workerType !== "yolo" && workerType !== "init" && workerType !== "usage" && !WORKERS[workerType]) {
  console.error(`Unknown command: ${workerType}`);
  printUsage();
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandled rejection:", err);
  process.exit(1);
});

process.on("SIGTERM", () => {
  shutdown();
  process.exit(0);
});

process.on("SIGINT", () => {
  if (isShuttingDown()) {
    shutdown();
    process.exit(1);
  }
  setShuttingDown();
  console.log("\n[worker] Waiting for running tasks to complete... (Press Ctrl-C again to force exit)");
  waitForAllProcesses().then(() => process.exit(0));
});

if (workerType === "init") {
  init();
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
  Promise.all([execIssueWorker(), fixReviewPointWorker(), createIssueWorker(), updateIssueWorker(), answerIssueQuestionsWorker(), triageIssueWorker()]);
} else if (workerType === "yolo") {
  (async () => {
    await Promise.all([execIssueWorker(), fixReviewPointWorker(), createIssueWorker(), updateIssueWorker(), answerIssueQuestionsWorker(), triageIssueWorker(), checkDependabotWorker(), triagePrWorker()]);
  })();
} else {
  WORKERS[workerType]();
}
