import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "fetch-unresolved-comments.sh");

function hasJq() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeGhStub(dir, { threadIds = [], graphqlExitCode = 0, prViewExitCode = 0 } = {}) {
  const edges = threadIds.map((id) => ({
    node: { id, isResolved: false, isOutdated: false, path: "a.ts", line: 1, comments: { nodes: [] } },
  }));
  const listResponse = JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          number: 42,
          title: "t",
          url: "u",
          state: "OPEN",
          author: { login: "a" },
          reviewRequests: { nodes: [] },
          comments: { nodes: [] },
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, edges },
        },
      },
    },
  });
  const ghPath = path.join(dir, "gh");
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo 'owner/repo'
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  [ ${prViewExitCode} -ne 0 ] && exit ${prViewExitCode}
  echo '42'
elif [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  [ ${graphqlExitCode} -ne 0 ] && { echo 'gh: GraphQL is not enabled for this session' >&2; exit ${graphqlExitCode}; }
  echo '${listResponse}'
else
  echo "unhandled gh invocation: $@" >&2
  exit 1
fi
`,
  );
  chmodSync(ghPath, 0o755);
  return dir;
}

function run(dir, opts = {}) {
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  return execFileSync("bash", [scriptPath], { env, encoding: "utf8", ...opts });
}

test("returns the threads as JSON and exits zero", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-unresolved-"));
  makeGhStub(dir, { threadIds: ["PRRT_1"] });
  const parsed = JSON.parse(run(dir));
  assert.equal(parsed.pr_number, 42);
  assert.deepEqual(
    parsed.unresolved_threads.map((t) => t.thread_id),
    ["PRRT_1"],
  );
});

test("an empty result is a successful zero-thread run", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-unresolved-"));
  makeGhStub(dir, { threadIds: [] });
  const parsed = JSON.parse(run(dir));
  assert.deepEqual(parsed.unresolved_threads, []);
});

// クラウドセッションの GraphQL ゲート（403）を模したケース。ここで exit 0 ＋ 空配列を
// 返すと、triage-pr が「未解決の指摘0件」と誤認して未対応のまま PR をマージする。
test("exits non-zero when the GraphQL query fails", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-unresolved-"));
  makeGhStub(dir, { graphqlExitCode: 1 });
  assert.throws(() => run(dir, { stdio: "pipe" }));
});

test("exits non-zero when the PR number cannot be determined", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fetch-unresolved-"));
  makeGhStub(dir, { prViewExitCode: 1 });
  assert.throws(() => run(dir, { stdio: "pipe" }));
});
