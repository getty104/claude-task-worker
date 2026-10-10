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

test("adoptCloudDesignPr: finds the design PR on the cloud branch and renames its head to cc-ui-design-<N>", async (t) => {
  const stubs = installCliStubs({
    gh: {
      crossRefPrs: [
        {
          number: 9,
          state: "OPEN",
          headRefName: "claude/design-login-ab12cd",
          baseRefName: "main",
          createdAt: new Date(Date.now() - 30_000).toISOString(),
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

  assert.equal(prNumber, 9);
  const apiCalls = stubs.records().filter((r) => r.command === "gh" && r.argv[0] === "api" && r.argv[1] === "-X");
  assert.deepEqual(
    apiCalls.map((r) => [r.argv[2], r.argv[3]]),
    [
      ["DELETE", "repos/acme/demo/git/refs/heads/cc-ui-design-5"],
      ["POST", "repos/acme/demo/branches/claude/design-login-ab12cd/rename"],
    ],
  );
  assert.ok(apiCalls[1].argv.includes("new_name=cc-ui-design-5"));
});

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
