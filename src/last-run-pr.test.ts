import { strict as assert } from "node:assert";
import test from "node:test";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import type * as ChildProcess from "node:child_process";
import type * as LastRunPr from "./last-run-pr";

const childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcess;

const m = (await import("./last-run-pr")) as typeof LastRunPr;

test("lastRunBranchName is fixed per worker so an open PR is reused instead of piling up", () => {
  assert.equal(m.lastRunBranchName("update-design-md"), "ctw-last-run-update-design-md");
  assert.equal(m.lastRunBranchName("update-design-md"), m.lastRunBranchName("update-design-md"));
});

test("hasLastRunChange treats an empty porcelain output as nothing to commit", () => {
  assert.equal(m.hasLastRunChange(""), false);
  assert.equal(m.hasLastRunChange("\n"), false);
  assert.equal(m.hasLastRunChange(" M claude-task-worker.json\n"), true);
  assert.equal(m.hasLastRunChange("?? claude-task-worker.json\n"), true);
});

// 記録PRは固定ブランチで再利用されるため、cc-triage-scope と Assignee が一度欠けると
// 以降は `pr create` を通らず二度と付かない（実測で発生し、triage-pr に拾われないまま放置された）。
// 作成経路・再利用経路のどちらでも毎回付け直すことを固定する。
async function capturePublishGhArgs(existingPr: number | null): Promise<string[][]> {
  const calls: string[][] = [];
  const worker = "test-worker";
  const cwd = `.claude/worktrees/${m.lastRunBranchName(worker)}`;
  await mkdir(cwd, { recursive: true });
  const stdoutFor = (command: string, args: string[]): string => {
    if (command === "gh") calls.push(args);
    if (command === "git" && args.includes("status")) return " M claude-task-worker.json\n";
    if (command === "gh" && args[0] === "pr" && args[1] === "list") {
      return JSON.stringify(existingPr === null ? [] : [{ number: existingPr }]);
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") return "https://github.com/o/r/pull/7\n";
    if (command === "gh" && args[0] === "api") return "getty104\n";
    return "";
  };
  const restore = childProcess.execFile;
  // gh.ts はコールバック形式、last-run-pr.ts / worktree.ts は promisify 形式で呼ぶため両方に応える。
  const fake = (command: string, args: string[], ...rest: unknown[]): unknown => {
    (rest[rest.length - 1] as (e: null, out: string, err: string) => void)(null, stdoutFor(command, args), "");
    return undefined;
  };
  (fake as unknown as Record<symbol, unknown>)[promisify.custom] = async (command: string, args: string[]) => ({
    stdout: stdoutFor(command, args),
    stderr: "",
  });
  (childProcess as { execFile: unknown }).execFile = fake;
  try {
    await m.publishLastRunPr(worker, "main", new Date("2026-09-06T00:00:00Z"));
  } finally {
    (childProcess as { execFile: unknown }).execFile = restore;
    await rm(cwd, { recursive: true, force: true });
  }
  return calls;
}

for (const [name, existing] of [
  ["creating a new PR", null],
  ["reusing the open PR", 42],
] as const) {
  test(`publishLastRunPr applies cc-triage-scope and the assignee when ${name}`, async () => {
    const calls = await capturePublishGhArgs(existing);
    assert.ok(
      calls.some((a) => a[0] === "pr" && a[1] === "edit" && a.includes("--add-label") && a.includes("cc-triage-scope")),
      `no --add-label cc-triage-scope in ${JSON.stringify(calls)}`,
    );
    assert.ok(
      calls.some((a) => a[0] === "pr" && a[1] === "edit" && a.includes("--add-assignee")),
      `no --add-assignee in ${JSON.stringify(calls)}`,
    );
    // 作成時に渡すと、メタデータ付与の失敗でPR作成ごと非0終了になり、ラベル無しのPRだけが残る。
    const create = calls.find((a) => a[0] === "pr" && a[1] === "create");
    assert.equal(create?.includes("--label") ?? false, false);
  });
}
