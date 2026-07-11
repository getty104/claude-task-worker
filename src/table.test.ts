import { test } from "node:test";
import assert from "node:assert/strict";
import type * as TableModule from "./table";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const { getDisplayWidth, truncateToWidth, padToWidth } = (await import("./table.ts")) as typeof TableModule;

test("getDisplayWidth returns 0 for empty string", () => {
  assert.equal(getDisplayWidth(""), 0);
});

test("getDisplayWidth treats ASCII characters as width 1", () => {
  assert.equal(getDisplayWidth("abc"), 3);
});

test("getDisplayWidth: U+10FF (just before U+1100) is width 1", () => {
  assert.equal(getDisplayWidth("ჿ"), 1);
});

test("getDisplayWidth: U+1100 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("ᄀ"), 2);
});

test("getDisplayWidth: U+2E80 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("⺀"), 2);
});

test("getDisplayWidth: U+2E7F (just before U+2E80) is width 1", () => {
  assert.equal(getDisplayWidth("⹿"), 1);
});

test("getDisplayWidth: U+3040 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("぀"), 2);
});

test("getDisplayWidth: U+303F (just before U+3040, in the gap after the preceding CJK punctuation range) is width 1", () => {
  assert.equal(getDisplayWidth("〿"), 1);
});

test("getDisplayWidth: U+4E00 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("一"), 2);
});

test("getDisplayWidth: U+33BF (just before U+3400, inside preceding range) is width 2", () => {
  assert.equal(getDisplayWidth("㎿"), 2);
});

test("getDisplayWidth: U+AC00 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("가"), 2);
});

test("getDisplayWidth: U+ABFF (just before U+AC00) is width 1", () => {
  assert.equal(getDisplayWidth("꯿"), 1);
});

test("getDisplayWidth: U+F900 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("豈"), 2);
});

test("getDisplayWidth: U+F8FF (just before U+F900) is width 1", () => {
  assert.equal(getDisplayWidth(""), 1);
});

test("getDisplayWidth: U+FE30 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("︰"), 2);
});

test("getDisplayWidth: U+FE2F (just before U+FE30) is width 1", () => {
  assert.equal(getDisplayWidth("︯"), 1);
});

test("getDisplayWidth: U+FF01 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("！"), 2);
});

test("getDisplayWidth: U+FF00 (just before U+FF01) is width 1", () => {
  assert.equal(getDisplayWidth("＀"), 1);
});

test("getDisplayWidth: U+FF60 (end of range) is width 2", () => {
  assert.equal(getDisplayWidth("｠"), 2);
});

test("getDisplayWidth: U+FF61 (just after U+FF60) is width 1", () => {
  assert.equal(getDisplayWidth("｡"), 1);
});

test("getDisplayWidth: U+FFE0 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("￠"), 2);
});

test("getDisplayWidth: U+FFDF (just before U+FFE0) is width 1", () => {
  assert.equal(getDisplayWidth("￟"), 1);
});

test("getDisplayWidth: U+FFE6 (end of range) is width 2", () => {
  assert.equal(getDisplayWidth("￦"), 2);
});

test("getDisplayWidth: U+FFE7 (just after U+FFE6) is width 1", () => {
  assert.equal(getDisplayWidth("￧"), 1);
});

test("getDisplayWidth: U+20000 (start of range, surrogate pair) is width 2", () => {
  assert.equal(getDisplayWidth("\u{20000}"), 2);
});

test("getDisplayWidth: U+1FFFF (just before U+20000, surrogate pair) is width 1", () => {
  assert.equal(getDisplayWidth("\u{1ffff}"), 1);
});

test("getDisplayWidth: U+30000 (start of range, surrogate pair) is width 2", () => {
  assert.equal(getDisplayWidth("\u{30000}"), 2);
});

test("getDisplayWidth: U+2FFFF (just before U+30000, in the gap after the preceding range ends at U+2FFFD) is width 1", () => {
  assert.equal(getDisplayWidth("\u{2ffff}"), 1);
});

test("getDisplayWidth: U+40000 (just after U+3FFFD range end) is width 1", () => {
  assert.equal(getDisplayWidth("\u{40000}"), 1);
});

test("truncateToWidth returns the original string unchanged when within maxWidth", () => {
  assert.equal(truncateToWidth("abc", 10), "abc");
});

test("truncateToWidth returns the original string unchanged when its width is comfortably under maxWidth", () => {
  assert.equal(truncateToWidth("abcde", 8), "abcde");
});

test("truncateToWidth truncates an ASCII string with an ellipsis when exceeding maxWidth", () => {
  assert.equal(truncateToWidth("abcdefghij", 5), "ab...");
});

test("truncateToWidth truncates a full-width (CJK) string with an ellipsis based on display width", () => {
  assert.equal(truncateToWidth("あいうえお", 6), "あ...");
});

test("truncateToWidth truncates a mixed half-width/full-width string with an ellipsis", () => {
  assert.equal(truncateToWidth("aあbいc", 6), "aあ...");
});

test("padToWidth pads an ASCII string with trailing spaces to reach targetWidth", () => {
  assert.equal(padToWidth("ab", 5), "ab   ");
});

test("padToWidth pads a full-width (CJK) string based on display width, not character count", () => {
  assert.equal(padToWidth("あい", 6), "あい  ");
});

test("padToWidth returns the string unchanged when its display width already equals targetWidth", () => {
  assert.equal(padToWidth("あい", 4), "あい");
});

test("padToWidth returns the string unchanged when its display width already exceeds targetWidth", () => {
  assert.equal(padToWidth("あいう", 4), "あいう");
});
