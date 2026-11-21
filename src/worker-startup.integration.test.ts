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
  "issue:cc-my-custom": "my-custom",
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
  files?: Record<string, string>,
): Promise<string[]> {
  const stubs = installCliStubs({ gh: GH_SCENARIO });
  const handle = await startWorker({ worker, workerConfig, userConfig: {}, records: stubs.records, files });
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

test("all and yolo skip workers disabled by workers.<name>.enabled and log them in one line", async (t) => {
  for (const [worker, list] of [
    ["all", ALL_WORKERS],
    ["yolo", YOLO_WORKERS],
  ] as const) {
    const expected = list.filter((w) => w !== "exec-issue" && w !== "update-issue");
    const stubs = installCliStubs({ gh: GH_SCENARIO });
    const handle = await startWorker({
      worker,
      workerConfig: {
        uiDesign: { enabled: true },
        workers: { "exec-issue": { enabled: false }, "update-issue": { enabled: false } },
      },
      userConfig: {},
      records: stubs.records,
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });
    const observe = (records: StubRecord[]) => observeStartedWorkers(records, handle.stdout());
    await handle.waitFor((records) => expected.every((w) => observe(records).includes(w)), 30_000);
    assert.deepEqual(observe(stubs.records()), expected, `${worker} started set`);
    assert.match(handle.stdout(), /\[worker\] skipped disabled workers: exec-issue, update-issue/, `${worker} log`);
  }
});

test("starting a disabled worker alone exits 1 without polling", async (t) => {
  const stubs = installCliStubs({ gh: GH_SCENARIO });
  const handle = await startWorker({
    worker: "exec-issue",
    workerConfig: { workers: { "exec-issue": { enabled: false } } },
    userConfig: {},
    records: stubs.records,
  });
  t.after(async () => {
    await handle.cleanup();
    stubs.cleanup();
  });
  assert.equal(await handle.waitForExit(15_000), 1);
  assert.deepEqual(observeStartedWorkers(stubs.records()), []);
  assert.match(handle.stdout() + handle.stderr(), /set workers\.exec-issue\.enabled to true or remove the key/);
});

const CUSTOM_WORKER_SOURCE = `import { createIssuePollingWorker } from "claude-task-worker/lib";
export const myCustom: unknown = createIssuePollingWorker({
  name: "my-custom",
  triggerLabels: ["cc-my-custom"],
  command: "my-skill",
});
`;

const CUSTOM_FILES = { "workers/my-custom.ts": CUSTOM_WORKER_SOURCE };
const CUSTOM_CONFIG = { workerFiles: ["workers/my-custom.ts"] };

test("a custom worker file listed in workerFiles starts alone and is added to all", async (t) => {
  const alone = await observeStartup(t, "my-custom", CUSTOM_CONFIG, ["my-custom"], [], CUSTOM_FILES);
  assert.deepEqual(alone, ["my-custom"]);
  const expected = [...ALL_WORKERS.filter((w) => !UI_DESIGN_WORKERS.includes(w)), "my-custom"].sort();
  const all = await observeStartup(t, "all", CUSTOM_CONFIG, expected, ["update-design-md"], CUSTOM_FILES);
  assert.deepEqual(all, expected);
});

test("workerFiles errors exit 1 before any gh call and name the file", async (t) => {
  const cases: [string, Record<string, string>, string[], RegExp][] = [
    ["missing.ts", {}, ["missing.ts"], /missing\.ts does not exist/],
    ["bad.ts", { "bad.ts": "export const = ;\n" }, ["bad.ts"], /failed to load .*bad\.ts/],
    ["empty.ts", { "empty.ts": "export const x = 1;\n" }, ["empty.ts"], /empty\.ts exports no worker definition/],
    [
      "preset.ts",
      { "preset.ts": CUSTOM_WORKER_SOURCE.replace("my-custom", "exec-issue") },
      ["preset.ts"],
      /preset\.ts.*"exec-issue".*preset/,
    ],
    [
      "dup",
      { "a.ts": CUSTOM_WORKER_SOURCE, "b.ts": CUSTOM_WORKER_SOURCE },
      ["a.ts", "b.ts"],
      /b\.ts.*"my-custom".*a\.ts/,
    ],
  ];
  for (const [label, files, workerFiles, pattern] of cases) {
    const stubs = installCliStubs({ gh: GH_SCENARIO });
    const handle = await startWorker({
      worker: "exec-issue",
      workerConfig: { workerFiles },
      userConfig: {},
      records: stubs.records,
      files,
    });
    t.after(async () => {
      await handle.cleanup();
      stubs.cleanup();
    });
    assert.equal(await handle.waitForExit(15_000), 1, label);
    assert.deepEqual(
      stubs.records().filter((r) => r.command === "gh"),
      [],
      label,
    );
    assert.match(handle.stdout() + handle.stderr(), pattern, label);
  }
});

test("list-workers prints preset and custom workers and exits 0; load failures exit 1", async (t) => {
  const stubs = installCliStubs({ gh: GH_SCENARIO });
  const ok = await startWorker({
    worker: "list-workers",
    workerConfig: { ...CUSTOM_CONFIG, workers: { "my-custom": { enabled: false } } },
    userConfig: {},
    records: stubs.records,
    files: CUSTOM_FILES,
  });
  const bad = await startWorker({
    worker: "list-workers",
    workerConfig: { workerFiles: ["missing.ts"] },
    userConfig: {},
    records: stubs.records,
  });
  t.after(async () => {
    await ok.cleanup();
    await bad.cleanup();
    stubs.cleanup();
  });
  assert.equal(await ok.waitForExit(15_000), 0);
  assert.match(ok.stdout(), /exec-issue\s+preset\s+enabled\s+preset/);
  assert.match(ok.stdout(), /my-custom\s+custom\s+disabled\s+\S*workers\/my-custom\.ts/);
  assert.equal(await bad.waitForExit(15_000), 1);
  assert.match(bad.stdout() + bad.stderr(), /missing\.ts does not exist/);
});
