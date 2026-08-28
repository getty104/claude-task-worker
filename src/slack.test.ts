import { test } from "node:test";
import assert from "node:assert/strict";
import type * as SlackModule from "./slack";

const { buildTaskNotificationText } = (await import("./slack")) as typeof SlackModule;

const base = {
  workerName: "exec-issue",
  repoName: "owner/repo",
  id: 238,
  title: "Add cloud session URL",
  url: "https://github.com/owner/repo/pull/238",
  tokenText: " | 🟢 5h: 1.0% (reset: 1/1 0:00) / 7d: 1.0% (reset: 1/1 0:00)",
};

test("completed without cloudSessionId keeps the legacy body untouched", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base });
  assert.equal(
    text,
    `✅ [${base.workerName}] ${base.repoName} | Task completed: <${base.url}|#${base.id} ${base.title}>${base.tokenText}`,
  );
});

test("failed without cloudSessionId keeps the legacy body untouched", () => {
  const text = buildTaskNotificationText({ status: "failed", ...base });
  assert.equal(
    text,
    `❌ [${base.workerName}] ${base.repoName} | Task failed: <${base.url}|#${base.id} ${base.title}>${base.tokenText}`,
  );
});

test("completed with cloudSessionId prepends the session URL as line 1", () => {
  const withoutSession = buildTaskNotificationText({ status: "completed", ...base });
  const withSession = buildTaskNotificationText({ status: "completed", ...base, cloudSessionId: "abc-123" });
  const lines = withSession.split("\n");
  assert.equal(lines[0], "https://claude.ai/code/abc-123");
  assert.equal(lines.slice(1).join("\n"), withoutSession);
});

test("failed with cloudSessionId prepends the session URL as line 1", () => {
  const withoutSession = buildTaskNotificationText({ status: "failed", ...base });
  const withSession = buildTaskNotificationText({ status: "failed", ...base, cloudSessionId: "abc-123" });
  const lines = withSession.split("\n");
  assert.equal(lines[0], "https://claude.ai/code/abc-123");
  assert.equal(lines.slice(1).join("\n"), withoutSession);
});

test("empty string cloudSessionId does not add a URL line", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base, cloudSessionId: "" });
  assert.equal(text, buildTaskNotificationText({ status: "completed", ...base }));
});

test("whitespace-only cloudSessionId does not add a URL line", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base, cloudSessionId: "   " });
  assert.equal(text, buildTaskNotificationText({ status: "completed", ...base }));
});

test("long output is truncated to the last 1000 chars, unaffected by the session URL", () => {
  const longOutput = "x".repeat(1500);
  const withoutSession = buildTaskNotificationText({ status: "completed", ...base, output: longOutput });
  const withSession = buildTaskNotificationText({
    status: "completed",
    ...base,
    output: longOutput,
    cloudSessionId: "abc-123",
  });
  const expectedBlock = `\n\`\`\`…${longOutput.slice(-1000)}\`\`\``;
  assert.ok(withoutSession.endsWith(expectedBlock));
  assert.ok(withSession.endsWith(expectedBlock));
  assert.equal(withSession, `https://claude.ai/code/abc-123\n${withoutSession}`);
});

test("tokenText is included in the body", () => {
  const text = buildTaskNotificationText({ status: "completed", ...base });
  assert.ok(text.includes(base.tokenText));
});
