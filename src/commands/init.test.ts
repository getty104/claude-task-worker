import { test } from "node:test";
import assert from "node:assert/strict";
import type * as InitModule from "./init";

const init = (await import("./init")) as typeof InitModule;

// 「キュー合流（cc-triage-scope）」と「依頼者の紐付け（cc-issue-request）」を同じラベルへ
// 戻すと、ワーカーや外部パイプラインの自動起票にも assign が発火し、その bot アカウントが
// 全 Issue の assignee になる。役割の再統合を機械的に止める。
test("assign-creator fires on cc-issue-request, not on cc-triage-scope", () => {
  assert.match(init.ASSIGN_CREATOR_WORKFLOW, /labels\.\*\.name, 'cc-issue-request'/);
  assert.doesNotMatch(init.ASSIGN_CREATOR_WORKFLOW, /cc-triage-scope/);
});

// 人の依頼もワーカーのキューへ入る必要があるため、テンプレートは両方を付ける。
test("the issue template applies both the queue label and the request marker", () => {
  assert.match(init.ISSUE_TEMPLATE, /^ {2}- cc-triage-scope$/m);
  assert.match(init.ISSUE_TEMPLATE, /^ {2}- cc-issue-request$/m);
});

// テンプレートが付けるラベルは init が作成していないと GitHub 側で黙って落ちる。
test("init creates every label the issue template applies", () => {
  const applied = [...init.ISSUE_TEMPLATE.matchAll(/^ {2}- (cc-[a-z-]+)$/gm)].map((m) => m[1]);
  assert.ok(applied.length > 0);
  for (const name of applied) {
    assert.ok(
      init.LABELS.some((label) => label.name === name),
      `${name} is applied by the issue template but not created by init`,
    );
  }
});

// "skipped" は既存ファイルの中身が不明なので、内容が最新版と一致するかで判定する。
test("isContentMismatch flags skipped with stale content", () => {
  assert.equal(init.isContentMismatch("skipped", "expected", "actual"), true);
});

// 2回目の init 実行では既存ファイルが最新版と同一のはずで、旧ファイル削除を止めてはいけない。
test("isContentMismatch allows skipped with matching content", () => {
  assert.equal(init.isContentMismatch("skipped", "same", "same"), false);
});

// created/overwritten はそのターンで最新版を書き込んだ直後なので、内容に関わらず一致とみなす。
test("isContentMismatch ignores created and overwritten", () => {
  assert.equal(init.isContentMismatch("created", "expected", "different"), false);
  assert.equal(init.isContentMismatch("overwritten", "expected", "different"), false);
});
