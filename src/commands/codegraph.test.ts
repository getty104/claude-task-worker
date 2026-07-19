import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type * as CodegraphModule from "./codegraph";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const { appendIgnoreEntry, globalGitIgnorePath, CODEGRAPH_IGNORE_ENTRY } =
  (await import("./codegraph.ts")) as typeof CodegraphModule;

test("appendIgnoreEntry creates the entry when the file is empty", () => {
  assert.equal(appendIgnoreEntry("", CODEGRAPH_IGNORE_ENTRY), ".codegraph/\n");
});

test("appendIgnoreEntry appends to existing content that ends with a newline", () => {
  assert.equal(appendIgnoreEntry(".DS_Store\n", CODEGRAPH_IGNORE_ENTRY), ".DS_Store\n.codegraph/\n");
});

test("appendIgnoreEntry inserts a newline when existing content lacks a trailing one", () => {
  assert.equal(appendIgnoreEntry(".DS_Store", CODEGRAPH_IGNORE_ENTRY), ".DS_Store\n.codegraph/\n");
});

test("appendIgnoreEntry returns null when the entry is already listed", () => {
  assert.equal(appendIgnoreEntry(".DS_Store\n.codegraph/\n", CODEGRAPH_IGNORE_ENTRY), null);
});

test("appendIgnoreEntry treats the slash-less form as already listed", () => {
  assert.equal(appendIgnoreEntry(".codegraph\n", CODEGRAPH_IGNORE_ENTRY), null);
});

test("appendIgnoreEntry ignores surrounding whitespace when checking for the entry", () => {
  assert.equal(appendIgnoreEntry("  .codegraph/  \n", CODEGRAPH_IGNORE_ENTRY), null);
});

test("appendIgnoreEntry does not treat a negation pattern as already listed", () => {
  // `!.codegraph/` は「無視しない」指定なので、追記をスキップしてはいけない
  assert.equal(appendIgnoreEntry("!.codegraph/\n", CODEGRAPH_IGNORE_ENTRY), "!.codegraph/\n.codegraph/\n");
});

test("appendIgnoreEntry does not match a substring of a longer pattern", () => {
  assert.equal(appendIgnoreEntry(".codegraph-win/\n", CODEGRAPH_IGNORE_ENTRY), ".codegraph-win/\n.codegraph/\n");
});

test("globalGitIgnorePath falls back to ~/.config/git/ignore without XDG_CONFIG_HOME", () => {
  assert.equal(globalGitIgnorePath({}, "/home/alice"), join("/home/alice", ".config", "git", "ignore"));
});

test("globalGitIgnorePath honors XDG_CONFIG_HOME", () => {
  assert.equal(
    globalGitIgnorePath({ XDG_CONFIG_HOME: "/xdg/config" }, "/home/alice"),
    join("/xdg/config", "git", "ignore"),
  );
});

test("globalGitIgnorePath ignores a blank XDG_CONFIG_HOME", () => {
  assert.equal(
    globalGitIgnorePath({ XDG_CONFIG_HOME: "   " }, "/home/alice"),
    join("/home/alice", ".config", "git", "ignore"),
  );
});
