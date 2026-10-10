import { test } from "node:test";
import assert from "node:assert/strict";
import type * as CreateUiDesignModule from "./create-ui-design";
import type * as CliStubModule from "../test-support/cli-stub";
import type * as GhModule from "../gh";

const { adoptCloudDesignPr } = (await import("./create-ui-design.ts")) as typeof CreateUiDesignModule;
const { installCliStubs } = (await import("../test-support/cli-stub.ts")) as typeof CliStubModule;
const { bodyMentionsIssue } = (await import("../gh.ts")) as typeof GhModule;

test("bodyMentionsIssue: accepts `Refs #N` and rejects other numbers", () => {
  assert.equal(bodyMentionsIssue("Refs #42", 42), true);
  assert.equal(bodyMentionsIssue("Closes #42", 42), true);
  assert.equal(bodyMentionsIssue("Refs #420", 42), false);
  assert.equal(bodyMentionsIssue("no reference", 42), false);
});

function cloudPr(overrides: Record<string, unknown> = {}) {
  return {
    number: 9,
    state: "OPEN",
    headRefName: "claude/design-login-ab12cd",
    baseRefName: "main",
    createdAt: new Date(Date.now() - 30_000).toISOString(),
    body: "Refs #5",
    title: "Login design",
    headSha: "abc123",
    ...overrides,
  };
}

test("adoptCloudDesignPr: recreates the design PR from cc-ui-design-<N> and closes the original without renaming its head", async (t) => {
  const stubs = installCliStubs({ gh: { crossRefPrs: [cloudPr()] } });
  t.after(() => stubs.cleanup());

  const prNumber = await adoptCloudDesignPr(5, "cc-ui-design-5", {
    baseBranch: "main",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(prNumber, 999);
  const apiCalls = stubs.records().filter((r) => r.command === "gh" && r.argv[0] === "api" && r.argv[1] === "-X");
  assert.deepEqual(
    apiCalls.map((r) => [r.argv[2], r.argv[3]]),
    [
      ["DELETE", "repos/acme/demo/git/refs/heads/cc-ui-design-5"],
      ["POST", "repos/acme/demo/git/refs"],
      ["PATCH", "repos/acme/demo/pulls/9"],
    ],
  );
  assert.ok(apiCalls[1].argv.includes("ref=refs/heads/cc-ui-design-5"));
  assert.ok(apiCalls[1].argv.includes("sha=abc123"));
  const create = stubs.records().find((r) => r.argv[0] === "pr" && r.argv[1] === "create");
  assert.ok(create);
  assert.deepEqual(
    [create.argv[create.argv.indexOf("--base") + 1], create.argv[create.argv.indexOf("--head") + 1]],
    ["main", "cc-ui-design-5"],
  );
  assert.equal(create.argv[create.argv.indexOf("--body") + 1], "Refs #5");
});

for (const [label, overrides] of [
  ["a fork PR", { headRepo: "someone/demo" }],
  ["a merged PR", { state: "MERGED" }],
  ["a PR on another base", { baseRefName: "cc-epic-1" }],
  ["a PR not referencing the issue", { body: "Refs #6" }],
] as const) {
  test(`adoptCloudDesignPr: ${label} is not adopted and no branch or PR is touched`, async (t) => {
    const stubs = installCliStubs({ gh: { crossRefPrs: [cloudPr(overrides)] } });
    t.after(() => stubs.cleanup());

    const prNumber = await adoptCloudDesignPr(5, "cc-ui-design-5", {
      baseBranch: "main",
      startedAt: Date.now() - 60_000,
    });

    assert.equal(prNumber, null);
    assert.equal(
      stubs.records().some((r) => (r.argv[0] === "api" && r.argv[1] === "-X") || r.argv[1] === "create"),
      false,
    );
  });
}

test("adoptCloudDesignPr: a PR created before the task started is not adopted and nothing is renamed", async (t) => {
  const stubs = installCliStubs({
    gh: {
      crossRefPrs: [
        {
          number: 9,
          state: "OPEN",
          headRefName: "claude/old-design-ab12cd",
          baseRefName: "main",
          createdAt: "2026-01-01T00:00:00Z",
          body: "Refs #5",
        },
      ],
    },
  });
  t.after(() => stubs.cleanup());

  const prNumber = await adoptCloudDesignPr(5, "cc-ui-design-5", {
    baseBranch: "main",
    startedAt: Date.now() - 60_000,
  });

  assert.equal(prNumber, null);
  assert.equal(
    stubs.records().some((r) => r.argv[0] === "api" && r.argv[1] === "-X"),
    false,
  );
});
