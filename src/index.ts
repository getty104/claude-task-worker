#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue.js";
import { fixReviewPointWorker } from "./workers/fix-review-point.js";
import { createIssueWorker } from "./workers/create-issue.js";
import { updateIssueWorker } from "./workers/update-issue.js";
import { shutdown } from "./process-manager.js";
import { init } from "./commands/init.js";

const WORKERS: Record<string, () => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
  "create-issue": createIssueWorker,
  "update-issue": updateIssueWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command>

Commands:
  init              Create required GitHub labels

Workers:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point
  create-issue      Poll issues and run /create-issue
  update-issue      Poll issues and run update command
  both              Poll all workers

Example:
  claude-task-worker init
  claude-task-worker exec-issue`);
}

const workerType = process.argv[2];

if (!workerType) {
  printUsage();
  process.exit(1);
}

if (workerType !== "both" && workerType !== "init" && !WORKERS[workerType]) {
  console.error(`Unknown command: ${workerType}`);
  printUsage();
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandled rejection:", err);
  process.exit(1);
});

const handleTermination = () => {
  shutdown();
  process.exit(0);
};
process.on("SIGTERM", handleTermination);
process.on("SIGINT", handleTermination);

if (workerType === "init") {
  init();
} else if (workerType === "both") {
  Promise.all([execIssueWorker(), fixReviewPointWorker(), createIssueWorker(), updateIssueWorker()]);
} else {
  WORKERS[workerType]();
}
