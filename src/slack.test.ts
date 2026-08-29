import { test } from "node:test";
import assert from "node:assert/strict";
import type * as SlackModule from "./slack";
import { appendCloudFailureGuidance } from "./task-result";

const { buildTaskNotificationText } = (await import("./slack")) as typeof SlackModule;

const base = {
  workerName: "exec-issue",
  repoName: "owner/repo",
  id: 238,
  title: "Add cloud session URL",
  url: "https://github.com/owner/repo/pull/238",
  tokenText: " | 🟢 5h: 1.0% (reset: 1/1 0:00) / 7d: 1.0% (reset: 1/1 0:00)",
};

test("completed without cloud param keeps the legacy body untouched", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base });
  assert.equal(
    text,
    `✅ [${base.workerName}] ${base.repoName} | Task completed: <${base.url}|#${base.id} ${base.title}>${base.tokenText}`,
  );
});

test("failed without cloud param keeps the legacy body untouched", () => {
  const text = buildTaskNotificationText({ status: "failed", ...base });
  assert.equal(
    text,
    `❌ [${base.workerName}] ${base.repoName} | Task failed: <${base.url}|#${base.id} ${base.title}>${base.tokenText}`,
  );
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
  assert.ok(text.includes("docs/cloud-prerequisite-checks.md"), "guidance text must survive truncation");
  assert.ok(text.includes(longError.slice(-1000)), "tail of the actual error must survive truncation");
});

test("tokenText is included in the body", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base });
  assert.ok(text.includes(base.tokenText));
});
