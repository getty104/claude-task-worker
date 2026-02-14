#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue.js";
import { fixReviewPointWorker } from "./workers/fix-review-point.js";

const WORKERS: Record<string, (interval: number) => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <worker-type> <interval-minutes>

Worker types:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point

Example:
  claude-task-worker exec-issue 5`);
}

const workerType = process.argv[2];
const intervalArg = process.argv[3];

if (!workerType || !intervalArg) {
  printUsage();
  process.exit(1);
}

const worker = WORKERS[workerType];
if (!worker) {
  console.error(`Unknown worker type: ${workerType}`);
  printUsage();
  process.exit(1);
}

const interval = parseInt(intervalArg, 10);
if (isNaN(interval) || interval <= 0) {
  console.error(`Invalid interval: ${intervalArg} (must be a positive integer)`);
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandled rejection:", err);
  process.exit(1);
});

worker(interval);
