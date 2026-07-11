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
import { removeStaleWorktrees } from "./worktree";
import { init } from "./commands/init";
import { install } from "./commands/install";
import { update } from "./commands/update";
import { version } from "./commands/version";
import { buildTokenLimitText, send } from "./slack";
import {
  hasProjectFilter,
  parseProjectFilters,
  assertProjectCompatibleCommand,
  buildForwardedCommand,
} from "./dispatch-args";
import { loadProjectsConfig, resolveTargetProjects, ProjectsConfigError } from "./projects-config";
// dispatcher.ts / herdr.ts はワーカー起動には不要な --project 専用モジュールで、
// dispatcher.ts のトップレベル await が即時実行されるのを避けるため、
// 静的importではなく --project 使用時にのみ実行される動的importで遅延読込する。
// esbuild の単一ファイルバンドルにインライン化されるよう、指定子は .ts 拡張子付きのリテラル文字列にする。
import type * as DispatcherModule from "./dispatcher";
import type { SessionRegistry, MonitorHandle } from "./dispatcher";
import type * as HerdrModule from "./herdr";

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
  console.log(`Usage: claude-task-worker <command> [--project <name>] [--epic <issue-number>] [--label <label-name>]

Commands:
  init [--force]    Create required GitHub labels and config file (use --force to overwrite existing files)
  install           Add the claude-task-worker marketplace, install the plugin, and install/update the CLI
  update            Update the claude-task-worker plugin/marketplace and the CLI itself
  usage             Notify current usage to Slack
  version           Print the installed claude-task-worker CLI version (aliases: --version, -v)

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
  --project <name>  Dispatch to project(s) via herdr instead of running the worker locally. Accepts a project name, a project group name, or "all". Repeatable.
  --epic <number>   Limit issue-based workers to sub-issues of the specified epic issue. Repeatable: any matching parent (OR).
  --label <name>    Limit issue-based workers to issues that also carry the specified label. Repeatable: all must be present (AND).

Example:
  claude-task-worker init
  claude-task-worker exec-issue
  claude-task-worker all --epic 100
  claude-task-worker all --epic 100 --epic 200
  claude-task-worker all --label priority-high
  claude-task-worker all --label priority-high --label needs-design
  claude-task-worker yolo --epic 100 --epic 200 --label priority-high
  claude-task-worker all --project all
  claude-task-worker all --project igsa
  claude-task-worker exec-issue --project my-app --epic 100`);
}

const workerType = process.argv[2];

if (workerType === "version" || workerType === "--version" || workerType === "-v") {
  version();
  process.exit(process.exitCode ?? 0);
}

if (!workerType) {
  printUsage();
  process.exit(1);
}

if (
  workerType !== "all" &&
  workerType !== "yolo" &&
  workerType !== "init" &&
  workerType !== "install" &&
  workerType !== "update" &&
  workerType !== "usage" &&
  !WORKERS[workerType]
) {
  console.error(`Unknown command: ${workerType}`);
  printUsage();
  process.exit(1);
}

if (hasProjectFilter()) {
  assertProjectCompatibleCommand(workerType);
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

if (!hasProjectFilter()) {
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
}

if (hasProjectFilter()) {
  (async () => {
    // sessions/monitorHandle は起動処理完了前に SIGTERM/SIGINT を受けても
    // shutdownDispatcher に安全に渡せるよう、起動前の空値で先に宣言する。
    let sessions: SessionRegistry = new Map();
    let monitorHandle: MonitorHandle | undefined;

    // 起動処理（runDispatcher/monitorSessions）が完了する前にシグナルを受けても
    // タブ・セッションが放置されないよう、動的import・起動処理より前にハンドラを登録する。
    const handleShutdown = async () => {
      const { shutdownDispatcher } = (await import("./dispatcher.ts")) as typeof DispatcherModule;
      await shutdownDispatcher(sessions, monitorHandle);
    };
    process.on("SIGTERM", handleShutdown);
    process.on("SIGINT", handleShutdown);

    // node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
    // .ts 拡張子付きのリテラル文字列で動的importする（dispatcher.ts と同様）。
    // allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
    const herdr = (await import("./herdr.ts")) as typeof HerdrModule;
    try {
      const config = loadProjectsConfig();
      const projects = resolveTargetProjects(parseProjectFilters(), config);
      const forwardedCommand = buildForwardedCommand(process.argv.slice(2));
      const { runDispatcher, monitorSessions } = (await import("./dispatcher.ts")) as typeof DispatcherModule;
      sessions = await runDispatcher(projects, forwardedCommand);
      monitorHandle = monitorSessions(sessions, herdr);
    } catch (err) {
      if (err instanceof ProjectsConfigError || err instanceof herdr.HerdrUnavailableError) {
        console.error(`[dispatcher] ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  })();
} else if (workerType === "init") {
  const force = process.argv.slice(3).includes("--force");
  init({ force });
} else if (workerType === "install") {
  (async () => {
    await install();
  })();
} else if (workerType === "update") {
  (async () => {
    await update();
  })();
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
  (async () => {
    // 前回の異常終了で残った worktree・ブランチをワーカー起動前に回収する
    await removeStaleWorktrees();
    await Promise.all([
      execIssueWorker({ epicFilters, labelFilters }),
      fixReviewPointWorker(),
      createIssueWorker({ epicFilters, labelFilters }),
      updateIssueWorker({ epicFilters, labelFilters }),
      answerIssueQuestionsWorker({ epicFilters, labelFilters }),
      resolveConflictWorker(),
      epicIssueWorker({ epicFilters, labelFilters }),
    ]);
  })();
} else if (workerType === "yolo") {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  (async () => {
    await removeStaleWorktrees();
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
  (async () => {
    await removeStaleWorktrees();
    await WORKERS[workerType]({ epicFilters, labelFilters });
  })();
}
