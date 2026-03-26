#!/usr/bin/env node

import { execIssueWorker } from "./workers/exec-issue.js";
import { fixReviewPointWorker } from "./workers/fix-review-point.js";
import { createIssueWorker } from "./workers/create-issue.js";
import { updateIssueWorker } from "./workers/update-issue.js";
import { triageIssuesWorker } from "./workers/triage-issues.js";
import { triagePrsWorker } from "./workers/triage-prs.js";
import { shutdown } from "./process-manager.js";
import { init } from "./commands/init.js";
import { buildTokenLimitText, send } from "./slack.js";

const WORKERS: Record<string, () => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
  "create-issue": createIssueWorker,
  "update-issue": updateIssueWorker,
  "triage-issues": triageIssuesWorker,
  "triage-prs": triagePrsWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command>

Commands:
  init              Create required GitHub labels
  usage             Notify current usage to Slack

Workers:
  exec-issue        Poll issues and run /exec-issue
  fix-review-point  Poll PRs and run /fix-review-point
  create-issue      Poll issues and run /create-issue
  update-issue      Poll issues and run update command
  triage-issues     Poll and triage issues every 5 minutes
  triage-prs        Poll and triage PRs every 5 minutes
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

const handleTermination = () => {
  shutdown();
  process.exit(0);
};
process.on("SIGTERM", handleTermination);
process.on("SIGINT", handleTermination);

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
  Promise.all([execIssueWorker(), fixReviewPointWorker(), createIssueWorker(), updateIssueWorker()]);
} else if (workerType === "yolo") {
  (async () => {
    await triagePrsWorker({ waitForFirstRun: true });
    console.log("[yolo] triage-prs first run completed, starting triage-issues");
    await triageIssuesWorker({ waitForFirstRun: true });
    console.log("[yolo] Triage workers completed first run, starting remaining workers");
    Promise.all([execIssueWorker(), fixReviewPointWorker(), createIssueWorker(), updateIssueWorker()]);
  })();
} else {
  WORKERS[workerType]();
}
