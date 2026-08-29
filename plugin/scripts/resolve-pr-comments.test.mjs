import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, "resolve-pr-comments.sh");

function hasJq() {
  try {
    execFileSync("jq", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeGhStub(dir, { threadIds = [], graphqlExitCode = 0, mutationExitCode = 0 } = {}) {
  const ghPath = path.join(dir, "gh");
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
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, edges },
        },
      },
    },
  });
  writeFileSync(
    ghPath,
    `#!/usr/bin/env bash
echo "$@" >> "${path.join(dir, "gh-calls.log")}"
if [ "$1" = "repo" ] && [ "$2" = "view" ]; then
  echo 'owner/repo'
elif [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  echo '42'
elif [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  if [[ "$*" == *"resolveReviewThread"* ]]; then
    [ ${mutationExitCode} -ne 0 ] && exit ${mutationExitCode}
    echo '{"data":{"resolveReviewThread":{"thread":{"id":"x","isResolved":true}}}}'
  else
    [ ${graphqlExitCode} -ne 0 ] && { echo 'gh: GraphQL is not enabled for this session' >&2; exit ${graphqlExitCode}; }
    echo '${listResponse}'
  fi
else
  echo "unhandled gh invocation: $@" >&2
  exit 1
fi
`,
  );
  chmodSync(ghPath, 0o755);
  return dir;
}

test("uses the PR number passed as the first argument", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  execFileSync("bash", [scriptPath, "99"], { env });
  const log = execFileSync("cat", [path.join(dir, "gh-calls.log")], { encoding: "utf8" });
  assert.match(log, /pullRequest\(number: 99\)/);
  assert.doesNotMatch(log, /^pr view/m);
});

test("falls back to `gh pr view` when no argument is given", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir);
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  execFileSync("bash", [scriptPath], { env });
  const log = execFileSync("cat", [path.join(dir, "gh-calls.log")], { encoding: "utf8" });
  assert.match(log, /pullRequest\(number: 42\)/);
  assert.match(log, /^pr view/m);
});

// クラウドセッションの GraphQL ゲート（403）を模したケース。取得に失敗したことを
// 終了コードで伝えられないと、呼び出し側が「未解決0件」と誤認して Resolve 済み扱いにする。
test("exits non-zero when the GraphQL query fails", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir, { graphqlExitCode: 1 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  assert.throws(() => execFileSync("bash", [scriptPath, "99"], { env, stdio: "pipe" }));
});

// mutation だけが失敗するケース。スレッド単位の失敗は処理を止めないが、
// 1件でも失敗したら全件成功とみなされないよう非0で終える。
test("exits non-zero when a thread fails to resolve", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir, { threadIds: ["PRRT_1"], mutationExitCode: 1 });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  assert.throws(() => execFileSync("bash", [scriptPath, "99"], { env, stdio: "pipe" }));
});

test("resolves every unresolved thread and exits zero", { skip: !hasJq() && "jq not installed" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "resolve-pr-comments-"));
  makeGhStub(dir, { threadIds: ["PRRT_1", "PRRT_2"] });
  const env = { ...process.env, PATH: `${dir}:${process.env.PATH}` };
  const out = execFileSync("bash", [scriptPath, "99"], { env, encoding: "utf8" });
  assert.match(out, /✓ Resolved thread: PRRT_1/);
  assert.match(out, /✓ Resolved thread: PRRT_2/);
  assert.match(out, /Processed 2 resolved \/ 0 failed/);
});
