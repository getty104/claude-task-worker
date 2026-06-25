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
import { shutdown, waitForAllProcesses, setShuttingDown, isShuttingDown } from "./process-manager";
import { init } from "./commands/init";
import { loadConfig } from "./config";
import { resolveProjectNodeId } from "./gh";
import { buildTokenLimitText, send } from "./slack";
import type { WorkerOptions } from "./worker-options";

const WORKERS: Record<string, (options?: WorkerOptions) => Promise<void>> = {
  "exec-issue": execIssueWorker,
  "fix-review-point": fixReviewPointWorker,
  "create-issue": createIssueWorker,
  "update-issue": updateIssueWorker,
  "answer-issue-questions": answerIssueQuestionsWorker,
  "triage-issue": triageIssueWorker,
  "triage-created-issue": triageCreatedIssueWorker,
  "triage-pr": triagePrWorker,
  "check-dependabot": checkDependabotWorker,
};

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command> [options]

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
  all               Poll all workers except triage-issue, triage-created-issue, triage-pr, check-dependabot
  yolo              Poll all workers including triage-issue, triage-created-issue, triage-pr, check-dependabot

Options for all/yolo:
  --project <owner/number>  Filter target issues/PRs by GitHub Project (e.g. myorg/3)
  --branch <name>           Base branch for worktree checkout and PR creation

Example:
  claude-task-worker init
  claude-task-worker exec-issue
  claude-task-worker yolo --project myorg/3 --branch develop`);
}

function parseFlags(args: string[]): { project?: string; branch?: string } {
  let project: string | undefined;
  let branch: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--project" && args[i + 1]) {
      project = args[i + 1];
      i++;
    } else if (a === "--branch" && args[i + 1]) {
      branch = args[i + 1];
      i++;
    }
  }
  return { project, branch };
}

function parseProjectKey(key: string): { owner: string; number: number } | null {
  const match = key.match(/^([^/\s]+)\/(\d+)$/);
  if (!match) return null;
  return { owner: match[1], number: Number(match[2]) };
}

async function resolveProjectKey(key: string): Promise<string | null> {
  const parsed = parseProjectKey(key);
  if (!parsed) {
    console.error(`[worker] invalid project key: ${key} (expected "owner/number")`);
    return null;
  }
  const nodeId = await resolveProjectNodeId(parsed.owner, parsed.number);
  if (!nodeId) {
    console.error(`[worker] could not resolve project ${key} to a node ID`);
  }
  return nodeId;
}

async function resolveProjectsMap(input: Record<string, string>): Promise<Record<string, string>> {
  const entries = await Promise.all(
    Object.entries(input).map(async ([key, branch]) => {
      const nodeId = await resolveProjectKey(key);
      return nodeId ? ([nodeId, branch] as const) : null;
    }),
  );
  const result: Record<string, string> = {};
  for (const e of entries) {
    if (e) result[e[0]] = e[1];
  }
  return result;
}

async function buildWorkerOptions(args: string[]): Promise<WorkerOptions> {
  const { project, branch } = parseFlags(args);
  const config = loadConfig();
  const configProjects = config.projects ?? {};

  if (!project && !branch) {
    return { projects: await resolveProjectsMap(configProjects) };
  }
  if (!project && branch) {
    return { branch };
  }
  const projectNodeId = project ? await resolveProjectKey(project) : undefined;
  if (project && !projectNodeId) {
    console.error(`[worker] aborting: --project ${project} could not be resolved`);
    process.exit(1);
  }
  return {
    projectId: projectNodeId ?? undefined,
    branch,
    projects: await resolveProjectsMap(configProjects),
  };
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
  (async () => {
    const options = await buildWorkerOptions(process.argv.slice(3));
    await Promise.all([
      execIssueWorker(options),
      fixReviewPointWorker(options),
      createIssueWorker(options),
      updateIssueWorker(options),
      answerIssueQuestionsWorker(options),
    ]);
  })();
} else if (workerType === "yolo") {
  (async () => {
    const options = await buildWorkerOptions(process.argv.slice(3));
    await Promise.all([
      execIssueWorker(options),
      fixReviewPointWorker(options),
      createIssueWorker(options),
      updateIssueWorker(options),
      answerIssueQuestionsWorker(options),
      triageIssueWorker(options),
      triageCreatedIssueWorker(options),
      checkDependabotWorker(options),
      triagePrWorker(options),
    ]);
  })();
} else {
  WORKERS[workerType]();
}
