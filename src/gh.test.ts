import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as ChildProcess from "node:child_process";
import type * as GhModule from "./gh";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

const { hasLabel, findPrNumberClosingIssue } = (await import("./gh.ts")) as typeof GhModule;

const REPO_INFO_STDOUT = JSON.stringify({
  owner: { login: "getty104" },
  name: "claude-task-worker",
  defaultBranchRef: { name: "main" },
});

// findPrNumberClosingIssue は getRepoInfo（repo view）→ GraphQL の順に execFile を呼ぶため、
// args に "graphql" を含むかどうかで返すstdoutを切り替える。
function mockRepoInfoThenGraphql(t: TestContext, graphqlStdout: string): void {
  t.mock.method(childProcess, "execFile", (_command: string, args: string[], callback: ExecFileCallback) => {
    if (args.includes("graphql")) {
      callback(null, graphqlStdout, "");
      return;
    }
    callback(null, REPO_INFO_STDOUT, "");
  });
}

type ExecFileCallback = (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void;

// gh.ts の execGh は execFile("gh", args, callback) の3引数形で呼び出すため、
// callback は第3引数に来る。
function mockExecFile(t: TestContext, stdout: string): void {
  t.mock.method(childProcess, "execFile", (_command: string, _args: string[], callback: ExecFileCallback) => {
    callback(null, stdout, "");
  });
}

test("hasLabel returns true when the label is present", async (t) => {
  mockExecFile(t, JSON.stringify({ labels: [{ name: "cc-need-human-check" }, { name: "cc-in-progress" }] }));
  assert.equal(await hasLabel("issue", 89, "cc-need-human-check"), true);
});

test("hasLabel returns false when the label is absent", async (t) => {
  mockExecFile(t, JSON.stringify({ labels: [{ name: "cc-in-progress" }] }));
  assert.equal(await hasLabel("issue", 89, "cc-need-human-check"), false);
});

test("hasLabel treats a null-parsed response as having no labels", async (t) => {
  // gh が想定外に "null" を返しても、parsed?.labels のnullガードで例外を投げず false になる。
  mockExecFile(t, "null");
  await assert.doesNotReject(async () => {
    assert.equal(await hasLabel("issue", 89, "cc-need-human-check"), false);
  });
});

test("hasLabel retries on a transient gh failure and eventually succeeds", async (t) => {
  let calls = 0;
  t.mock.method(childProcess, "execFile", (_command: string, _args: string[], callback: ExecFileCallback) => {
    calls += 1;
    if (calls === 1) {
      callback(new Error("gh: temporary failure") as NodeJS.ErrnoException, "", "connection reset");
      return;
    }
    callback(null, JSON.stringify({ labels: [{ name: "cc-need-human-check" }] }), "");
  });
  assert.equal(await hasLabel("issue", 89, "cc-need-human-check"), true);
  assert.equal(calls, 2);
});

test("findPrNumberClosingIssue returns null when the only referencing PR is CLOSED (unmerged)", async (t) => {
  // 無関係な却下済み（未マージでクローズ）のPRを誤検出してはいけない。
  mockRepoInfoThenGraphql(
    t,
    JSON.stringify({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: { nodes: [{ number: 42, state: "CLOSED" }] },
          },
        },
      },
    }),
  );
  assert.equal(await findPrNumberClosingIssue(1), null);
});

test("findPrNumberClosingIssue returns the number of a MERGED referencing PR", async (t) => {
  mockRepoInfoThenGraphql(
    t,
    JSON.stringify({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: { nodes: [{ number: 7, state: "MERGED" }] },
          },
        },
      },
    }),
  );
  assert.equal(await findPrNumberClosingIssue(1), 7);
});

test("findPrNumberClosingIssue returns the number of an OPEN referencing PR", async (t) => {
  mockRepoInfoThenGraphql(
    t,
    JSON.stringify({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: { nodes: [{ number: 9, state: "OPEN" }] },
          },
        },
      },
    }),
  );
  assert.equal(await findPrNumberClosingIssue(1), 9);
});

test("findPrNumberClosingIssue skips a leading CLOSED node and returns the following MERGED one", async (t) => {
  mockRepoInfoThenGraphql(
    t,
    JSON.stringify({
      data: {
        repository: {
          issue: {
            closedByPullRequestsReferences: {
              nodes: [
                { number: 42, state: "CLOSED" },
                { number: 7, state: "MERGED" },
              ],
            },
          },
        },
      },
    }),
  );
  assert.equal(await findPrNumberClosingIssue(1), 7);
});
