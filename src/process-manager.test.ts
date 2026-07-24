import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ProcessManagerModule from "./process-manager";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const { makeLogFeeder, logLines } = (await import("./process-manager")) as typeof ProcessManagerModule;

test("makeLogFeeder: 1バイトずつfeedしてもマルチバイト文字が文字化けしない", () => {
  const startLength = logLines.length;
  const feeder = makeLogFeeder(1, "stdout");
  const line = "日本語テスト";
  const bytes = Buffer.from(`${line}\n`, "utf-8");
  for (const byte of bytes) feeder.feed(Buffer.from([byte]));
  feeder.flush();

  const pushed = logLines.slice(startLength);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].text, line);
  assert.ok(!pushed[0].text.includes("�"));
});

test("makeLogFeeder: 複数chunkにまたがる1行が正しく1行として結合される", () => {
  const startLength = logLines.length;
  const feeder = makeLogFeeder(2, "stdout");
  const line = "日本語テスト行です";
  const bytes = Buffer.from(`${line}\n`, "utf-8");
  const mid = Math.floor(bytes.length / 2);
  feeder.feed(bytes.subarray(0, mid));
  feeder.feed(bytes.subarray(mid));
  feeder.flush();

  const pushed = logLines.slice(startLength);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].text, line);
});
