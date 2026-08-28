import { test } from "node:test";
import assert from "node:assert/strict";
import type * as PlaywrightModule from "./playwright";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
const { buildInstallDepsCommand } = (await import("./playwright.ts")) as typeof PlaywrightModule;

test("buildInstallDepsCommand skips sudo when running as root", () => {
  // コンテナでは root かつ sudo バイナリ未導入が普通にあるため、昇格不要な root では sudo を挟まない。
  assert.deepEqual(buildInstallDepsCommand(0), {
    command: "npx",
    args: ["-y", "playwright-core@latest", "install-deps", "chromium"],
  });
});

test("buildInstallDepsCommand prefixes sudo for a non-root user", () => {
  assert.deepEqual(buildInstallDepsCommand(501), {
    command: "sudo",
    args: ["npx", "-y", "playwright-core@latest", "install-deps", "chromium"],
  });
});

test("buildInstallDepsCommand prefixes sudo when the uid is unknown", () => {
  // process.getuid は Windows で undefined。root と確定できない限り sudo 側へ倒す。
  assert.equal(buildInstallDepsCommand(undefined).command, "sudo");
});
