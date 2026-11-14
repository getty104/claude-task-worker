import { test } from "node:test";
import assert from "node:assert/strict";
import type * as SlackModule from "./slack";
import { appendCloudFailureGuidance } from "./task-result";

const { buildTaskNotificationText, extractCredential, formatTokenLimitText, parseUsageResponse, rateLimitBackoffMs } =
  (await import("./slack")) as typeof SlackModule;

const base = {
  workerName: "exec-issue",
  repoName: "owner/repo",
  id: 238,
  title: "Add cloud session URL",
  url: "https://github.com/owner/repo/pull/238",
};

test("completed without cloud param keeps the legacy body untouched", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base });
  assert.equal(
    text,
    `✅ [${base.workerName}] ${base.repoName} | Task completed: <${base.url}|#${base.id} ${base.title}>`,
  );
});

test("failed without cloud param keeps the legacy body untouched", () => {
  const text = buildTaskNotificationText({ status: "failed", ...base });
  assert.equal(text, `❌ [${base.workerName}] ${base.repoName} | Task failed: <${base.url}|#${base.id} ${base.title}>`);
});

test("completed with cloud.sessionId prepends the session URL as line 1", () => {
  const withoutSession = buildTaskNotificationText({ status: "completed", ...base });
  const withSession = buildTaskNotificationText({
    status: "completed",
    ...base,
    cloud: { sessionId: "abc-123" },
  });
  const lines = withSession.split("\n");
  assert.equal(lines[0], "https://claude.ai/code/abc-123");
  assert.equal(lines.slice(1).join("\n"), withoutSession);
});

test("failed with cloud.sessionId prepends the session URL as line 1", () => {
  const withoutSession = buildTaskNotificationText({ status: "failed", ...base });
  const withSession = buildTaskNotificationText({
    status: "failed",
    ...base,
    cloud: { sessionId: "abc-123" },
  });
  const lines = withSession.split("\n");
  assert.equal(lines[0], "https://claude.ai/code/abc-123");
  assert.equal(lines.slice(1).join("\n"), withoutSession);
});

test("whitespace-only cloud.sessionId falls back to the ID-extraction-failed line", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base, cloud: { sessionId: "   " } });
  const lines = text.split("\n");
  assert.equal(lines[0], "セッションURL不明（ID抽出に失敗）");
  assert.equal(lines.slice(1).join("\n"), buildTaskNotificationText({ status: "completed", ...base }));
});

test("cloud present but sessionId missing shows the ID-extraction-failed line", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base, cloud: {} });
  const lines = text.split("\n");
  assert.equal(lines[0], "セッションURL不明（ID抽出に失敗）");
  assert.equal(lines.slice(1).join("\n"), buildTaskNotificationText({ status: "completed", ...base }));
});

test("cloud present with empty sessionId shows the ID-extraction-failed line", () => {
  const text = buildTaskNotificationText({ status: "failed", ...base, cloud: { sessionId: "" } });
  const lines = text.split("\n");
  assert.equal(lines[0], "セッションURL不明（ID抽出に失敗）");
  assert.equal(lines.slice(1).join("\n"), buildTaskNotificationText({ status: "failed", ...base }));
});

test("cloud omitted (local execution) never shows a session URL or failure line", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base });
  assert.ok(!text.startsWith("https://claude.ai/code/"));
  assert.ok(!text.startsWith("セッションURL不明"));
});

test("long output is truncated to the last 1000 chars, unaffected by the session URL", () => {
  const longOutput = "x".repeat(1500);
  const withoutSession = buildTaskNotificationText({ status: "completed", ...base, output: longOutput });
  const withSession = buildTaskNotificationText({
    status: "completed",
    ...base,
    output: longOutput,
    cloud: { sessionId: "abc-123" },
  });
  const expectedBlock = `\n\`\`\`…${longOutput.slice(-1000)}\`\`\``;
  assert.ok(withoutSession.endsWith(expectedBlock));
  assert.ok(withSession.endsWith(expectedBlock));
  assert.equal(withSession, `https://claude.ai/code/abc-123\n${withoutSession}`);
});

test("cloud failure guidance survives truncation alongside the error tail when output exceeds 1000 chars", () => {
  const longError = "e".repeat(1500);
  const { output } = appendCloudFailureGuidance({ status: "failed", output: longError }, true);
  const text = buildTaskNotificationText({ status: "failed", ...base, output });
  assert.ok(text.includes("docs/cloud.md"), "guidance text must survive truncation");
  assert.ok(text.includes(longError.slice(-1000)), "tail of the actual error must survive truncation");
});

test("parseUsageResponse tolerates a missing five_hour window (e.g. Ultra plan)", () => {
  const usage = parseUsageResponse({
    five_hour: null,
    seven_day: { utilization: 12, resets_at: "2026-07-22T01:30:00Z" },
  });
  assert.equal(usage.fiveHourUtilization, null);
  assert.equal(usage.sevenDayUtilization, 12);
  const text = formatTokenLimitText(usage);
  assert.ok(!text.includes("5h"));
  assert.match(text, /^ \| 🟢 7d: 12\.0% \(reset: /);
});

test("formatTokenLimitText returns an empty string when no window is present", () => {
  assert.equal(formatTokenLimitText(parseUsageResponse({})), "");
});

test("extractCredential reads accessToken and expiresAt from Claude Code credentials", () => {
  assert.deepEqual(extractCredential({ claudeAiOauth: { accessToken: "tok", expiresAt: 123 } }), {
    token: "tok",
    expiresAt: 123,
  });
  assert.deepEqual(extractCredential("raw"), { token: "raw" });
});

test("rateLimitBackoffMs honors Retry-After seconds and HTTP-date, else falls back to the default", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(rateLimitBackoffMs("30", now), 30_000);
  assert.equal(rateLimitBackoffMs("Thu, 01 Jan 2026 00:01:00 GMT", now), 60_000);
  assert.equal(rateLimitBackoffMs(null, now), 600_000);
  assert.equal(rateLimitBackoffMs("garbage", now), 600_000);
});
