import { test } from "node:test";
import assert from "node:assert/strict";
import type * as DispatchArgsModule from "./dispatch-args";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する一方、
// tsc --noEmit（npm run build）は allowImportingTsExtensions が無効なため
// 静的import文中の .ts 拡張子指定子を許容せず失敗する。両立のため、
// TSの静的解析対象にならない動的文字列結合でパスを構築している。
const dispatchArgsModulePath = ["./dispatch-args", "ts"].join(".");
const { buildForwardedCommand, shellQuote } = (await import(dispatchArgsModulePath)) as typeof DispatchArgsModule;

test("buildForwardedCommand strips --project and its value from argv.slice(2)-shaped input", () => {
  const argv = ["all", "--project", "foo"];
  assert.equal(buildForwardedCommand(argv), "claude-task-worker 'all'");
});

test("buildForwardedCommand preserves non-project tokens and their order", () => {
  const argv = ["exec-issue", "--epic", "100", "--project", "my-app", "--label", "priority-high"];
  assert.equal(buildForwardedCommand(argv), "claude-task-worker 'exec-issue' '--epic' '100' '--label' 'priority-high'");
});

test("buildForwardedCommand handles multiple --project flags", () => {
  const argv = ["all", "--project", "foo", "--project", "bar"];
  assert.equal(buildForwardedCommand(argv), "claude-task-worker 'all'");
});

test("buildForwardedCommand returns bare command when argv is empty", () => {
  assert.equal(buildForwardedCommand([]), "claude-task-worker");
});

test("buildForwardedCommand shell-quotes tokens containing single quotes", () => {
  const argv = ["exec-issue", "--label", "it's-a-label"];
  assert.equal(buildForwardedCommand(argv), `claude-task-worker 'exec-issue' '--label' ${shellQuote("it's-a-label")}`);
});
