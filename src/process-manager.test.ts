import { test } from "node:test";
import assert from "node:assert/strict";
import type * as ProcessManagerModule from "./process-manager";
import type * as CliStubModule from "./test-support/cli-stub";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const { makeLogFeeder, logLines, waitForCloudTask, CLOUD_TASK_TIMEOUT_MS } =
  (await import("./process-manager")) as typeof ProcessManagerModule;
const { installCliStubs } = (await import("./test-support/cli-stub.ts")) as typeof CliStubModule;

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

test("waitForCloudTask: cc-cloud-done が付かないまま期限を過ぎると timeout で解決する", async () => {
  // CLOUD_TASK_TIMEOUT_MS（4時間）を実時間で待てないため、deadline 計算時だけ
  // Date.now() を過去へずらして「既に期限切れの待機」を作る。以降の判定は実時間の
  // Date.now() に戻すので、ループ内の `now >= deadline` が初回ポーリングで即座に成立する。
  const stubs = installCliStubs({ gh: {} });
  const realNow = Date.now;
  Date.now = () => realNow() - CLOUD_TASK_TIMEOUT_MS - 1000;
  let promise: Promise<"completed" | "timeout" | "aborted">;
  try {
    promise = waitForCloudTask(9001, "issue");
  } finally {
    Date.now = realNow;
  }
  try {
    const outcome = await promise;
    assert.equal(outcome, "timeout");
  } finally {
    stubs.cleanup();
  }
});
