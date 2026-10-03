import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// 公開契約（semver 対象）。増減はこのテストの失敗として現れる。
const PUBLIC_EXPORTS = [
  "CLOUD_DONE_LABEL",
  "addAssignee",
  "addLabel",
  "buildClaudeEnv",
  "buildClaudeExecution",
  "closeIssue",
  "commentOnIssue",
  "commentOnPR",
  "createIssuePollingWorker",
  "createPrPollingWorker",
  "createScheduledWorker",
  "createWorktreeFromBranch",
  "defineWorker",
  "deleteLocalBranch",
  "ensureEpicBranch",
  "findOpenPrNumberByHeadRef",
  "findPrNumberByHeadRef",
  "findPrStateByHeadRef",
  "generateWorktreeName",
  "getCurrentUser",
  "getIssueBody",
  "getIssueState",
  "getIssueSubIssuesSummary",
  "getLastRunAt",
  "getPermissionMode",
  "getPrDetail",
  "getPrMergeable",
  "getRemoteEnvId",
  "getRepoInfo",
  "getRunMode",
  "getUiDesignConfig",
  "getWorkerConfig",
  "getWorktreePath",
  "hasLabel",
  "hasOpenBlockers",
  "isAdvisorEnabled",
  "isCloudWorker",
  "isRunning",
  "isShuttingDown",
  "isWorkerAtCapacity",
  "isWorkerDefinition",
  "linkClosingPr",
  "listIssuesByLabel",
  "listIssuesByNumbers",
  "listPrsClosingIssue",
  "listPrsCrossReferencingIssue",
  "listPullRequestsWithChecks",
  "loadConfig",
  "localBranchExists",
  "notifyError",
  "notifyTaskCompleted",
  "notifyTaskFailed",
  "parseClosingIssueNumbers",
  "publishLastRunPr",
  "removeLabel",
  "removeWorktree",
  "removeWorktreeByBranch",
  "run",
  "syncDefaultBranch",
];

test("lib exports exactly the public contract", async () => {
  const lib = (await import("./lib")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(lib).sort(), PUBLIC_EXPORTS);
});

const DIST = join(import.meta.dirname, "..", "dist");

// プロセス内状態（タスク台帳・worktree の直列化）を持つモジュールが CLI とカスタムワーカーで
// 分裂しないよう、dist/index.js と dist/lib.js が同じチャンクを共有していることを確認する。
test(
  "dist/index.js and dist/lib.js share a single process-manager / worktree chunk",
  { skip: !existsSync(join(DIST, "lib.js")) && "dist not built (run npm run build)" },
  () => {
    const files = readdirSync(DIST).filter((f) => f.endsWith(".js"));
    const read = (f: string) => readFileSync(join(DIST, f), "utf8");
    for (const marker of ["function isWorkerAtCapacity(", "function createWorktreeFromBranch("]) {
      const owners = files.filter((f) => read(f).includes(marker));
      assert.equal(owners.length, 1, `${marker} is bundled in ${owners.join(", ")}`);
      const [chunk] = owners;
      assert.notEqual(chunk, "index.js");
      assert.notEqual(chunk, "lib.js");
      for (const entry of ["index.js", "lib.js"]) {
        assert.ok(read(entry).includes(`from "./${chunk}"`), `${entry} does not import ${chunk}`);
      }
    }
    assert.ok(read("index.js").startsWith("#!/usr/bin/env node\n"));
  },
);
