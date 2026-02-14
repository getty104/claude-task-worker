#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue.js";
import { fixReviewPointWorker } from "./workers/fix-review-point.js";

const WORKERS: Record<string, () => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <worker-type>

Worker types:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point
  both              Poll both issues and PRs

Example:
  claude-task-worker exec-issue`);
}

const workerType = process.argv[2];

if (!workerType) {
  printUsage();
  process.exit(1);
}

if (workerType !== "both" && !WORKERS[workerType]) {
  console.error(`Unknown worker type: ${workerType}`);
  printUsage();
  process.exit(1);
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandled rejection:", err);
  process.exit(1);
});

if (workerType === "both") {
  Promise.all([execIssueWorker(), fixReviewPointWorker()]);
} else {
  WORKERS[workerType]();
}
