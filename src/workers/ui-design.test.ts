import { test } from "node:test";
import assert from "node:assert/strict";
import type * as UiDesignModule from "./ui-design";

const { designBranchName, hasDesignReference, extractDesignFilePath, classifyDesignPr } =
  (await import("./ui-design.ts")) as typeof UiDesignModule;

test("designBranchName uses the fixed cc-ui-design-<N> naming", () => {
  assert.equal(designBranchName(123), "cc-ui-design-123");
});

test("classifyDesignPr proceeds only for a merged design PR", () => {
  assert.equal(classifyDesignPr({ state: "MERGED", mergedAt: "2026-07-21T00:00:00Z" }), "proceed");
});

test("classifyDesignPr proceeds when mergedAt is set even if state is reported as CLOSED", () => {
  // gh の state 表記揺れでマージ済みを取りこぼすと、実装フェーズへ進めないまま停滞する。
  assert.equal(classifyDesignPr({ state: "CLOSED", mergedAt: "2026-07-21T00:00:00Z" }), "proceed");
});

test("classifyDesignPr waits while the design PR is still open", () => {
  assert.equal(classifyDesignPr({ state: "OPEN", mergedAt: null }), "wait");
});

test("classifyDesignPr asks for a human when the design PR was closed unmerged", () => {
  assert.equal(classifyDesignPr({ state: "CLOSED", mergedAt: null }), "needs-human");
});

test("classifyDesignPr asks for a human when no design PR exists", () => {
  assert.equal(classifyDesignPr(null), "needs-human");
});

test("hasDesignReference accepts a body with the heading and a .pen path", () => {
  const body = [
    "実装内容の説明",
    "",
    "## UIデザイン",
    "",
    "- デザインファイル: `designs/12-login-form.pen`",
    "- デザインPR: #34（マージ済み）",
  ].join("\n");
  assert.equal(hasDesignReference(body), true);
});

test("hasDesignReference rejects a body without the heading", () => {
  assert.equal(hasDesignReference("- デザインファイル: `designs/12-login-form.pen`"), false);
});

test("hasDesignReference rejects a heading whose section lost the .pen path", () => {
  // 見出しだけ残って中身が消えた状態を「反映済み」と誤認してはいけない。
  assert.equal(hasDesignReference(["## UIデザイン", "", "（デザイン参照は削除されました）"].join("\n")), false);
});

test("hasDesignReference ignores a .pen path that appears only before the heading", () => {
  const body = ["`designs/old.pen` は過去の参照", "", "## UIデザイン", "", "（本文なし）"].join("\n");
  assert.equal(hasDesignReference(body), false);
});

test("hasDesignReference rejects a level-3 heading that merely contains the same text", () => {
  // `.includes("## UIデザイン")` は `### UIデザイン` にも一致してしまう誤検知パターン。
  const body = ["### UIデザイン", "", "- デザインファイル: `designs/12-login-form.pen`"].join("\n");
  assert.equal(hasDesignReference(body), false);
});

test("hasDesignReference rejects the template boilerplate mentioning the heading in prose", () => {
  // テンプレートの地の文に見出しテキストへの言及が出てきても、実際の見出し行でなければ通過させない。
  const body = [
    "実装内容の説明では `## UIデザイン` セクションの書式について触れています。",
    "",
    "- デザインファイル: `<.pen の実パス>`",
  ].join("\n");
  assert.equal(hasDesignReference(body), false);
});

test("hasDesignReference rejects an unreplaced placeholder path", () => {
  const body = ["## UIデザイン", "", "- デザインファイル: `<.pen の実パス>`"].join("\n");
  assert.equal(hasDesignReference(body), false);
});

test("hasDesignReference does not scan past the next top-level heading for a .pen path", () => {
  const body = [
    "## UIデザイン",
    "",
    "（このセクションには実パスがまだありません）",
    "",
    "## 別のセクション",
    "",
    "- デザインファイル: `designs/other.pen`",
  ].join("\n");
  assert.equal(hasDesignReference(body), false);
});

test("hasDesignReference accepts a .pen path immediately followed by another top-level heading", () => {
  const body = [
    "## UIデザイン",
    "",
    "- デザインファイル: `designs/12-login-form.pen`",
    "",
    "## 別のセクション",
    "",
    "無関係な本文",
  ].join("\n");
  assert.equal(hasDesignReference(body), true);
});

test("extractDesignFilePath returns the path when the section is valid", () => {
  const body = [
    "## UIデザイン",
    "",
    "- デザインファイル: `designs/12-login-form.pen`",
    "- デザインPR: #34（マージ済み）",
  ].join("\n");
  assert.equal(extractDesignFilePath(body), "designs/12-login-form.pen");
});

test("extractDesignFilePath returns null when there is no heading", () => {
  assert.equal(extractDesignFilePath("- デザインファイル: `designs/12-login-form.pen`"), null);
});

test("extractDesignFilePath returns null for an unreplaced placeholder path", () => {
  const body = ["## UIデザイン", "", "- デザインファイル: `<.pen の実パス>`"].join("\n");
  assert.equal(extractDesignFilePath(body), null);
});

test("extractDesignFilePath and hasDesignReference agree on validity", () => {
  const body = ["## UIデザイン", "", "- デザインファイル: `designs/12-login-form.pen`"].join("\n");
  assert.equal(extractDesignFilePath(body) !== null, hasDesignReference(body));
});
