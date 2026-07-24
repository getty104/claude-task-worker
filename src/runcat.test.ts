import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as RuncatModule from "./runcat";
import type { UsageInfo } from "./slack";

const { buildRuncatSnapshot, resetStamp, resetHour, writeRuncatUsage } =
  (await import("./runcat")) as typeof RuncatModule;

// 2026-07-19 21:00 JST
const NOW = new Date("2026-07-19T12:00:00Z");

const usage: UsageInfo = {
  fiveHourUtilization: 12,
  fiveHourResetsAt: "2026-07-19T14:00:00Z", // 23:00 JST（同日）
  sevenDayUtilization: 34.5678,
  sevenDayResetsAt: "2026-07-22T01:30:00Z", // 07/22 10:30 JST（別日）
};

test("resetStamp omits the date when the reset is on the same JST day", () => {
  assert.equal(resetStamp("2026-07-19T14:00:00Z", NOW), "23:00");
});

test("resetStamp includes the date when the reset falls on another JST day", () => {
  assert.equal(resetStamp("2026-07-22T01:30:00Z", NOW), "07/22 10:30");
});

test("resetStamp and resetHour return an empty string for an unparsable value", () => {
  assert.equal(resetStamp("not-a-date", NOW), "");
  assert.equal(resetHour("not-a-date"), "");
});

test("resetHour returns the JST hour only", () => {
  assert.equal(resetHour("2026-07-19T14:00:00Z"), "23");
});

test("resetStamp rounds a partial minute up to the next minute", () => {
  // 22:59:59 JST → 23:00
  assert.equal(resetStamp("2026-07-19T13:59:59Z", NOW), "23:00");
  // 22:59:00.001 JST も同じく次の分へ繰り上げる
  assert.equal(resetStamp("2026-07-19T13:59:00.001Z", NOW), "23:00");
});

test("resetStamp rolls over the JST date when rounding up crosses midnight", () => {
  // 23:59:59 JST → 翌日 00:00 なので日付付きになる
  assert.equal(resetStamp("2026-07-19T14:59:59Z", NOW), "07/20 00:00");
});

test("resetHour rounds up to the next hour when the minute rolls over", () => {
  // 22:59:59 JST → 23:00 なので時は 23
  assert.equal(resetHour("2026-07-19T13:59:59Z"), "23");
});

test("buildRuncatSnapshot formats metrics like statusline.py", () => {
  const snapshot = buildRuncatSnapshot(usage, NOW);
  assert.equal(snapshot.title, "Claude Code");
  assert.equal(snapshot.symbol, "staroflife");
  assert.deepEqual(snapshot.metrics, [
    { title: "5h", formattedValue: "12% ↻23:00", normalizedValue: 0.12 },
    { title: "7d", formattedValue: "34.5678% ↻07/22 10:30", normalizedValue: 0.3457 },
  ]);
});

test("buildRuncatSnapshot builds a compact bar value with the 5h reset hour", () => {
  assert.equal(buildRuncatSnapshot(usage, NOW).metricsBarValue, "12/34.5678 ↻23");
});

test("buildRuncatSnapshot drops the reset marker from the bar when the 5h reset is unparsable", () => {
  const snapshot = buildRuncatSnapshot({ ...usage, fiveHourResetsAt: "" }, NOW);
  assert.equal(snapshot.metricsBarValue, "12/34.5678");
  assert.equal(snapshot.metrics[0].formattedValue, "12%");
});

test("buildRuncatSnapshot stamps lastUpdatedDate as UTC without milliseconds", () => {
  assert.equal(buildRuncatSnapshot(usage, NOW).lastUpdatedDate, "2026-07-19T12:00:00Z");
});

test("writeRuncatUsage writes the snapshot and leaves no temp file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "runcat-test-"));
  const out = join(dir, "nested", "runcat-usage.json");
  writeRuncatUsage(usage, out);

  const written = JSON.parse(readFileSync(out, "utf-8"));
  assert.equal(written.title, "Claude Code");
  assert.equal(written.metrics.length, 2);
  assert.deepEqual(readdirSync(join(dir, "nested")), ["runcat-usage.json"]);
});
