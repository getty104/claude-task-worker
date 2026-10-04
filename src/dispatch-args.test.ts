import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type * as DispatchArgsModule from "./dispatch-args";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const {
  buildForwardedCommand,
  shellQuote,
  hasCloudFlag,
  resetCloudFlagCache,
  assertCloudCompatibleCommand,
  getInheritConfigPath,
  resetInheritConfigPathCache,
} = (await import("./dispatch-args")) as typeof DispatchArgsModule;

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

test("buildForwardedCommand forwards --cloud (only --project and its value are stripped)", () => {
  const argv = ["exec-issue", "--project", "foo", "--cloud"];
  assert.equal(buildForwardedCommand(argv), "claude-task-worker 'exec-issue' '--cloud'");
});

test("buildForwardedCommand forwards a custom worker name unchanged", () => {
  const argv = ["my-custom", "--project", "foo", "--cloud"];
  assert.equal(buildForwardedCommand(argv), "claude-task-worker 'my-custom' '--cloud'");
});

test("hasCloudFlag reflects whether --cloud is present in process.argv, cached until reset", (t) => {
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    resetCloudFlagCache();
  });

  process.argv = [...originalArgv.filter((a) => a !== "--cloud")];
  resetCloudFlagCache();
  assert.equal(hasCloudFlag(), false);

  // argv を書き換えてもキャッシュが解決済みなら値は変わらない。
  process.argv = [...process.argv, "--cloud"];
  assert.equal(hasCloudFlag(), false);

  resetCloudFlagCache();
  assert.equal(hasCloudFlag(), true);
});

test("assertCloudCompatibleCommand exits 1 for --cloud-incompatible commands", (t) => {
  const exitCodes: number[] = [];
  t.mock.method(process, "exit", ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);

  for (const command of ["init", "apply-labels", "install", "update", "usage", "version", "list-workers"]) {
    exitCodes.length = 0;
    assertCloudCompatibleCommand(command);
    assert.deepEqual(exitCodes, [1], `assertCloudCompatibleCommand(${command})`);
  }
});

test("assertCloudCompatibleCommand does not exit for compatible commands", (t) => {
  const exitCodes: number[] = [];
  t.mock.method(process, "exit", ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit);

  for (const command of ["exec-issue", "triage-pr", "all"]) {
    assertCloudCompatibleCommand(command);
  }
  assert.deepEqual(exitCodes, []);
});

test("buildForwardedCommand resolves a relative --inherit-config value to an absolute path", () => {
  const argv = ["all", "--project", "foo", "--inherit-config", "shared/ctw.json"];
  assert.equal(
    buildForwardedCommand(argv),
    `claude-task-worker 'all' '--inherit-config' ${shellQuote(resolve("shared/ctw.json"))}`,
  );
});

test("buildForwardedCommand keeps an absolute --inherit-config value as is", () => {
  assert.equal(
    buildForwardedCommand(["all", "--inherit-config", "/etc/ctw.json"]),
    "claude-task-worker 'all' '--inherit-config' '/etc/ctw.json'",
  );
});

test("getInheritConfigPath resolves the value against the cwd and is null when absent", (t) => {
  const original = process.argv;
  t.after(() => {
    process.argv = original;
    resetInheritConfigPathCache();
  });
  process.argv = ["node", "cli", "all"];
  resetInheritConfigPathCache();
  assert.equal(getInheritConfigPath(), null);

  process.argv = ["node", "cli", "all", "--inherit-config", "conf/ctw.json"];
  resetInheritConfigPathCache();
  assert.equal(getInheritConfigPath(), resolve("conf/ctw.json"));
});
