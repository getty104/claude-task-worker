// claude-task-worker/lib の公開エントリ。ここに並べた名前が公開契約（semver 対象）になる。
// index.ts はトップレベルで CLI を実行するため、ここから import してはいけない。

export { createIssuePollingWorker } from "./workers/issue-worker";
export type { IssueWorkerConfig, PreflightResult } from "./workers/issue-worker";
export { createPrPollingWorker } from "./workers/pr-worker";
export type { PrWorkerConfig } from "./workers/pr-worker";
export { createScheduledWorker } from "./workers/scheduled-worker";
export type { ScheduledWorkerConfig } from "./workers/scheduled-worker";
export { defineWorker, isWorkerDefinition } from "./workers/worker-definition";
export type { WorkerDefinition, WorkerKind, WorkerStartOptions } from "./workers/worker-definition";

export {
  addAssignee,
  addLabel,
  closeIssue,
  commentOnIssue,
  commentOnPR,
  findOpenPrNumberByHeadRef,
  findPrNumberByHeadRef,
  findPrStateByHeadRef,
  getCurrentUser,
  getIssueBody,
  getIssueState,
  getIssueSubIssuesSummary,
  getPrDetail,
  getPrMergeable,
  getRepoInfo,
  hasLabel,
  hasOpenBlockers,
  linkClosingPr,
  listIssuesByLabel,
  listIssuesByNumbers,
  listPrsClosingIssue,
  listPrsCrossReferencingIssue,
  listPullRequestsWithChecks,
  parseClosingIssueNumbers,
  removeLabel,
} from "./gh";
export type { ClosingPrRef, Issue, PullRequestWithChecks } from "./gh";
export { ensureEpicBranch, syncDefaultBranch } from "./git";
export {
  createWorktreeFromBranch,
  deleteLocalBranch,
  getWorktreePath,
  localBranchExists,
  removeWorktree,
  removeWorktreeByBranch,
} from "./worktree";
export { isRunning, isShuttingDown, isWorkerAtCapacity, run } from "./process-manager";
export { notifyError, notifyTaskCompleted, notifyTaskFailed } from "./slack";
export { buildClaudeEnv, buildClaudeExecution } from "./claude-args";
export {
  CLOUD_DONE_LABEL,
  getLastRunAt,
  getRemoteEnvId,
  getUiDesignConfig,
  getWorkerConfig,
  isCloudWorker,
  loadConfig,
} from "./config";
export type { WorkerRuntimeConfig } from "./config";
export { getPermissionMode, getRunMode, isAdvisorEnabled } from "./user-config";
export { publishLastRunPr } from "./last-run-pr";
export { generateWorktreeName } from "./random-name";
