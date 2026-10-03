import { test } from "node:test";
import assert from "node:assert/strict";
import type * as CliStubModule from "./test-support/cli-stub";
import type { StubRecord } from "./test-support/cli-stub";
import type * as WorkerHarnessModule from "./test-support/worker-harness";

const { installCliStubs } = (await import("./test-support/cli-stub.ts")) as typeof CliStubModule;
const { startWorker } = (await import("./test-support/worker-harness.ts")) as typeof WorkerHarnessModule;

// ワーカーには「起動した」専用ログが無く、標準出力はテーブル再描画で流れるため、
// 各ワーカーが初回 tick で必ず発行する外部呼び出し（gh のポーリングクエリ・claude のスキル起動）を
// ワーカー名へ写像して観測する。
const OBSERVATION_TO_WORKER: Record<string, string> = {
  "issue:cc-exec-issue": "exec-issue",
  "issue:cc-triage-scope": "create-issue",
  "issue:cc-update-issue": "update-issue",
  "issue:cc-answer-issue-questions": "answer-issue-questions",
  "issue:cc-issue-created+cc-triage-scope": "triage-created-issue",
  "issue:cc-epic-issue": "epic-issue",
  "issue:cc-create-ui-design": "create-ui-design",
  "issue:cc-ui-design-pr-created": "apply-ui-design",
  "pr:cc-fix-onetime": "fix-review-point",
  "pr:dependencies": "check-dependabot",
  "pr:cc-triage-scope": "triage-pr",
  "pr:cc-resolve-conflict": "resolve-conflict",
  "skill:update-coding-guidelines": "update-coding-guidelines",
  "skill:update-requirement-rules": "update-requirement-rules",
  "skill:update-design-md": "update-design-md",
};

const SCHEDULED_WORKERS = ["update-coding-guidelines", "update-requirement-rules", "update-design-md"];

// 定期ワーカーは同時に走る git worktree add が .git/config のロックで競合すると、gh も claude も
// 呼ばないまま初回 tick を落とす（プロダクション側の既知の競合）。そのため起動ログ
// （`Checking every`）も観測に使う。update-design-md だけはワーカー自体は常に起動し、uiDesign 無効時に
// tick 内で no-op になるため、起動ログを根拠にできない（recordsOnly）。
function observeStartedWorkers(records: StubRecord[], stdout = "", recordsOnly: string[] = []): string[] {
  const observed = new Set<string>();
  for (const worker of SCHEDULED_WORKERS) {
    if (!recordsOnly.includes(worker) && stdout.includes(`[${worker}] Checking every`)) observed.add(worker);
  }
  for (const r of records) {
    if (r.command === "gh" && (r.argv[0] === "issue" || r.argv[0] === "pr") && r.argv[1] === "list") {
      if (!r.argv.includes("--assignee")) continue;
      const labels: string[] = [];
      r.argv.forEach((arg, i) => {
        if (arg === "--label") labels.push(r.argv[i + 1]);
      });
      const worker = OBSERVATION_TO_WORKER[`${r.argv[0]}:${labels.sort().join("+")}`];
      if (worker) observed.add(worker);
    } else if (r.command === "claude" && r.argv[0] === "-p") {
      const skill = /^\/claude-task-worker:(.+?) \d+$/.exec(r.argv[1] ?? "")?.[1];
      const worker = skill && OBSERVATION_TO_WORKER[`skill:${skill}`];
      if (worker) observed.add(worker);
    } else if (r.command === "gh" && r.argv[0] === "pr" && r.argv[1] === "list" && r.argv.includes("--head")) {
      const head = r.argv[r.argv.indexOf("--head") + 1] ?? "";
      const worker = head.replace(/^ctw-last-run-/, "");
      if (head !== worker && SCHEDULED_WORKERS.includes(worker)) observed.add(worker);
    }
  }
  return [...observed].sort();
}

const UI_DESIGN_WORKERS = ["apply-ui-design", "create-ui-design", "update-design-md"];

const ALL_WORKERS = [
  "answer-issue-questions",
  "apply-ui-design",
  "create-issue",
  "create-ui-design",
  "exec-issue",
  "epic-issue",
  "fix-review-point",
  "resolve-conflict",
  "update-coding-guidelines",
  "update-design-md",
  "update-issue",
  "update-requirement-rules",
].sort();

const YOLO_WORKERS = [...ALL_WORKERS, "check-dependabot", "triage-created-issue", "triage-pr"].sort();

const GH_SCENARIO = {
  login: "octocat",
  repo: { owner: "acme", name: "demo", defaultBranch: "main" },
  issues: [],
  prList: [],
};

async function observeStartup(
  t: { after(fn: () => Promise<void>): void },
  worker: string,
  workerConfig: Record<string, unknown>,
  expected: string[],
  recordsOnly: string[] = [],
): Promise<string[]> {
  const stubs = installCliStubs({ gh: GH_SCENARIO });
  const handle = await startWorker({ worker, workerConfig, userConfig: {}, records: stubs.records });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });
  const observe = (records: StubRecord[]) => observeStartedWorkers(records, handle.stdout(), recordsOnly);
  await handle.waitFor((records) => expected.every((w) => observe(records).includes(w)), 30_000);
  return observe(stubs.records());
}

test("all starts exactly the 12 workers when uiDesign is enabled", async (t) => {
  const started = await observeStartup(t, "all", { uiDesign: { enabled: true } }, ALL_WORKERS);
  assert.deepEqual(started, ALL_WORKERS);
});

test("yolo starts exactly the 15 workers when uiDesign is enabled", async (t) => {
  const started = await observeStartup(t, "yolo", { uiDesign: { enabled: true } }, YOLO_WORKERS);
  assert.deepEqual(started, YOLO_WORKERS);
});

test("all and yolo leave the uiDesign workers inactive for an empty config", async (t) => {
  const withoutUiDesign = (list: string[]) => list.filter((w) => !UI_DESIGN_WORKERS.includes(w));
  for (const [worker, list] of [
    ["all", ALL_WORKERS],
    ["yolo", YOLO_WORKERS],
  ] as const) {
    const expected = withoutUiDesign(list);
    const started = await observeStartup(t, worker, {}, expected, ["update-design-md"]);
    assert.deepEqual(started, expected, `${worker} with {}`);
  }
});

test("exec-issue alone keeps running and polls cc-exec-issue", async (t) => {
  const stubs = installCliStubs({ gh: GH_SCENARIO });
  const handle = await startWorker({ worker: "exec-issue", workerConfig: {}, userConfig: {}, records: stubs.records });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });
  await handle.waitFor(
    (records) =>
      records.some(
        (r) =>
          r.command === "gh" &&
          r.argv[0] === "issue" &&
          r.argv[1] === "list" &&
          r.argv.includes("--label") &&
          r.argv[r.argv.indexOf("--label") + 1] === "cc-exec-issue",
      ),
    30_000,
  );
  assert.equal(handle.child.exitCode, null);
  assert.deepEqual(observeStartedWorkers(stubs.records()), ["exec-issue"]);
});
