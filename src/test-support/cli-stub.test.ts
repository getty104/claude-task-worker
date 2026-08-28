import { test } from "node:test";
import assert from "node:assert/strict";
import type * as GhModule from "../gh";
import type * as CliStubModule from "./cli-stub";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする（既存テストと同じパターン）。
const { getCurrentUser, getRepoInfo, hasLabel, addLabel } = (await import("../gh.ts")) as typeof GhModule;
const { installCliStubs } = (await import("./cli-stub.ts")) as typeof CliStubModule;

test("gh スタブ: getCurrentUser / getRepoInfo / hasLabel / addLabel がシナリオ経由で応答する", async () => {
  const previousPath = process.env.PATH;
  const previousScenario = process.env.CTW_STUB_GH_SCENARIO;

  const stubs = installCliStubs({
    gh: {
      login: "octocat",
      repo: { owner: "acme", name: "widgets", defaultBranch: "trunk" },
      view: { "42": { labels: [{ name: "cc-exec-issue" }] } },
    },
  });

  try {
    assert.equal(await getCurrentUser(), "octocat");
    assert.deepEqual(await getRepoInfo(), { owner: "acme", name: "widgets", defaultBranch: "trunk" });
    assert.equal(await hasLabel("issue", 42, "cc-exec-issue"), true);
    assert.equal(await hasLabel("issue", 42, "cc-not-present"), false);

    await addLabel("issue", 42, "cc-in-progress");
    const ghRecords = stubs.records().filter((r) => r.command === "gh");
    const editRecord = ghRecords.find((r) => r.argv[0] === "issue" && r.argv[1] === "edit");
    assert.ok(editRecord, "addLabel の gh issue edit がレコードに残っていること");
    assert.deepEqual(editRecord?.argv, ["issue", "edit", "42", "--add-label", "cc-in-progress"]);
  } finally {
    stubs.cleanup();
  }

  assert.equal(process.env.PATH, previousPath);
  assert.equal(process.env.CTW_STUB_GH_SCENARIO, previousScenario);
});

test("gh スタブ: 未登録の Issue/PR 番号には空オブジェクトを返す", async () => {
  const stubs = installCliStubs({ gh: { view: {} } });
  try {
    assert.equal(await hasLabel("issue", 999, "cc-anything"), false);
  } finally {
    stubs.cleanup();
  }
});
