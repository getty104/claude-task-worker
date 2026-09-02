import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ExecIssueModule from "./exec-issue";
import type * as CliStubModule from "../test-support/cli-stub";
import type { ClosingPrRef } from "../gh";
import type * as GhModule from "../gh";

const { formatSessionReport, selectOwnedClosingPr, verifyPrCreated } =
  (await import("./exec-issue.ts")) as typeof ExecIssueModule;
const { installCliStubs } = (await import("../test-support/cli-stub.ts")) as typeof CliStubModule;
const { bodyClosesIssue } = (await import("../gh.ts")) as typeof GhModule;

function pr(overrides: Partial<ClosingPrRef>): ClosingPrRef {
  return {
    number: 1,
    state: "MERGED",
    headRefName: "adj-noun-1234",
    baseRefName: "main",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("wraps the session report in a code fence", () => {
  assert.equal(formatSessionReport("PR未作成: push に失敗\n"), "```\nPR未作成: push に失敗\n```");
});

test("falls back to a placeholder when the session produced no output", () => {
  assert.equal(formatSessionReport("   \n"), "（セッションの出力はありませんでした）");
});

test("keeps the tail of a long report, where the conclusion is", () => {
  const report = `${"x".repeat(5000)}\n最終報告: PRを作成できませんでした`;
  const formatted = formatSessionReport(report);
  assert.ok(formatted.includes("最終報告: PRを作成できませんでした"));
  assert.ok(formatted.includes("…（先頭を省略）"));
  assert.ok(formatted.length < report.length);
});

const baseCtx = {
  cloud: false,
  expectedHeadRefName: "adj-noun-1234",
  baseBranch: "main",
  startedAt: Date.parse("2026-01-01T00:00:00Z"),
  now: Date.parse("2026-01-02T00:00:00Z"),
};

test("selectOwnedClosingPr (local): adopts a PR whose headRefName matches", () => {
  const candidates = [pr({ number: 7, headRefName: "adj-noun-1234" })];
  assert.equal(selectOwnedClosingPr(candidates, baseCtx), 7);
});

test("selectOwnedClosingPr (local): rejects a PR whose headRefName does not match", () => {
  const candidates = [pr({ number: 7, headRefName: "other-branch" })];
  assert.equal(selectOwnedClosingPr(candidates, baseCtx), null);
});

test("selectOwnedClosingPr (cloud): adopts a PR whose base matches and createdAt is within range", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "main",
      createdAt: "2026-01-01T12:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), 9);
});

test("selectOwnedClosingPr (cloud): rejects a PR whose base does not match", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "cc-epic-1",
      createdAt: "2026-01-01T12:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), null);
});

test("selectOwnedClosingPr (cloud): rejects a PR created before the task started", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "main",
      createdAt: "2025-12-31T23:59:59Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), null);
});

test("selectOwnedClosingPr (cloud): rejects a PR created after the verification time", () => {
  const candidates = [
    pr({
      number: 9,
      baseRefName: "main",
      createdAt: "2026-01-03T00:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(candidates, { ...baseCtx, cloud: true }), null);
});

test("selectOwnedClosingPr: a CLOSED (unmerged) candidate is never adopted in either mode", () => {
  const closedLocal = [pr({ number: 7, state: "CLOSED", headRefName: "adj-noun-1234" })];
  assert.equal(selectOwnedClosingPr(closedLocal, baseCtx), null);

  const closedCloud = [
    pr({
      number: 9,
      state: "CLOSED",
      baseRefName: "main",
      createdAt: "2026-01-01T12:00:00Z",
    }),
  ];
  assert.equal(selectOwnedClosingPr(closedCloud, { ...baseCtx, cloud: true }), null);
});

// verifyPrCreated: gh スタブで4分岐（早期return2種 + ローカル/クラウド一致 + 不一致）を検証する。
function addLabelArgv(records: ReturnType<CliStubModule.InstalledCliStubs["records"]>, type: string): boolean {
  return records.some(
    (r) => r.command === "gh" && r.argv[0] === type && r.argv[1] === "edit" && r.argv.includes("cc-pr-created"),
  );
}

test("verifyPrCreated: cc-need-human-check already present, skips cc-pr-created", async (t) => {
  const stubs = installCliStubs({ gh: { view: { "5": { labels: [{ name: "cc-need-human-check" }] } } } });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: false,
    baseBranch: "main",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(result, false);
  assert.equal(addLabelArgv(stubs.records(), "issue"), false);
});

test("verifyPrCreated: issue closed by skill (no-change path), skips cc-pr-created", async (t) => {
  const stubs = installCliStubs({ gh: { view: { "5": { labels: [], state: "CLOSED" } } } });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: false,
    baseBranch: "main",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(result, undefined);
  assert.equal(addLabelArgv(stubs.records(), "issue"), false);
});

test("verifyPrCreated (local): adopts a PR whose head matches the worktree branch", async (t) => {
  const stubs = installCliStubs({
    gh: { view: { "5": { labels: [], state: "OPEN" } }, prList: [{ number: 7, headRefName: "adj-noun-1234" }] },
  });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: false,
    baseBranch: "main",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(result, undefined);
  assert.equal(addLabelArgv(stubs.records(), "issue"), true);
});

test("verifyPrCreated (cloud): adopts a closing PR by base + createdAt ownership, without calling `gh pr list`", async (t) => {
  const startedAt = Date.now() - 60_000;
  const stubs = installCliStubs({
    gh: {
      view: { "5": { labels: [], state: "OPEN" } },
      closingPrs: [
        {
          number: 9,
          state: "OPEN",
          headRefName: "cloud-generated-branch",
          baseRefName: "main",
          createdAt: new Date(Date.now() - 30_000).toISOString(),
        },
      ],
    },
  });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: true,
    baseBranch: "main",
    startedAt,
  });

  assert.equal(result, undefined);
  assert.equal(addLabelArgv(stubs.records(), "issue"), true);
  assert.equal(
    stubs.records().some((r) => r.command === "gh" && r.argv[0] === "pr" && r.argv[1] === "list"),
    false,
  );
});

test("verifyPrCreated: no matching PR found, marks cc-need-human-check and comments", async (t) => {
  const stubs = installCliStubs({
    gh: { view: { "5": { labels: [], state: "OPEN" } }, prList: [], closingPrs: [] },
  });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: false,
    baseBranch: "main",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(result, false);
  const records = stubs.records();
  assert.equal(
    records.some(
      (r) =>
        r.command === "gh" && r.argv[0] === "issue" && r.argv[1] === "edit" && r.argv.includes("cc-need-human-check"),
    ),
    true,
  );
  assert.equal(
    records.some((r) => r.command === "gh" && r.argv[0] === "issue" && r.argv[1] === "comment"),
    true,
  );
});

test("verifyPrCreated (cloud): adopts an Epic-based PR via cross-reference and links it", async (t) => {
  const startedAt = Date.now() - 60_000;
  const stubs = installCliStubs({
    gh: {
      view: { "5": { labels: [], state: "OPEN" } },
      // base がデフォルトブランチでないため GitHub は closing reference を作らない。
      closingPrs: [],
      crossRefPrs: [
        {
          number: 9,
          state: "OPEN",
          headRefName: "claude/task-worker-execution-abc123",
          baseRefName: "cc-epic-1",
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          body: "Closes #5",
        },
      ],
    },
  });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: true,
    baseBranch: "cc-epic-1",
    startedAt,
  });

  assert.equal(result, undefined);
  const records = stubs.records();
  assert.equal(addLabelArgv(records, "issue"), true);
  assert.equal(
    records.some((r) => r.command === "gh" && r.argv.some((arg) => arg.includes("addCloseIssueReferences"))),
    true,
  );
});

test("verifyPrCreated (cloud): a cross-referenced PR on another base is not adopted", async (t) => {
  const stubs = installCliStubs({
    gh: {
      view: { "5": { labels: [], state: "OPEN" } },
      closingPrs: [],
      crossRefPrs: [
        {
          number: 9,
          state: "OPEN",
          headRefName: "claude/task-worker-execution-abc123",
          baseRefName: "cc-epic-999",
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          body: "Closes #5",
        },
      ],
    },
  });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: true,
    baseBranch: "cc-epic-1",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(result, false);
  assert.equal(
    stubs.records().some((r) => r.command === "gh" && r.argv.some((arg) => arg.includes("addCloseIssueReferences"))),
    false,
  );
});

test("verifyPrCreated (cloud): a sibling PR that only mentions the issue (no closing keyword) is not adopted", async (t) => {
  const startedAt = Date.now() - 60_000;
  const stubs = installCliStubs({
    gh: {
      view: { "5": { labels: [], state: "OPEN" } },
      closingPrs: [],
      crossRefPrs: [
        {
          number: 10,
          state: "OPEN",
          headRefName: "claude/design-pr-def456",
          baseRefName: "cc-epic-1",
          createdAt: new Date(Date.now() - 30_000).toISOString(),
          body: "Refs #5",
        },
      ],
    },
  });
  t.after(() => stubs.cleanup());

  const result = await verifyPrCreated(5, "adj-noun-1234", "output", {
    cloud: true,
    baseBranch: "cc-epic-1",
    startedAt,
  });

  assert.equal(result, false);
  const records = stubs.records();
  assert.equal(addLabelArgv(records, "issue"), false);
  assert.equal(
    records.some((r) => r.command === "gh" && r.argv.some((arg) => arg.includes("addCloseIssueReferences"))),
    false,
  );
});

test("bodyClosesIssue: recognizes GitHub closing keywords", () => {
  assert.equal(bodyClosesIssue("Closes #5", 5), true);
  assert.equal(bodyClosesIssue("closes #5", 5), true);
  assert.equal(bodyClosesIssue("Fixed #5", 5), true);
  assert.equal(bodyClosesIssue("Resolves: #5", 5), true);
});

test("bodyClosesIssue: rejects mere mentions and non-matching numbers", () => {
  assert.equal(bodyClosesIssue("Refs #5", 5), false);
  assert.equal(bodyClosesIssue("#5", 5), false);
  assert.equal(bodyClosesIssue("Closes #51", 5), false);
});
