import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as TranscriptModule from "./transcript";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する。
const { extractFinalAssistantText, findTranscriptPath, readFinalReport } =
  (await import("./transcript.ts")) as typeof TranscriptModule;

function assistantLine(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    ...extra,
  });
}

test("extractFinalAssistantText returns the last main-agent assistant text", () => {
  const jsonl = [
    JSON.stringify({ type: "user", message: { role: "user", content: "start" } }),
    assistantLine("中間の報告"),
    assistantLine("サブエージェントの報告", { isSidechain: true }),
    assistantLine("最終レポート\n\nPR: https://example.com/pull/1"),
    JSON.stringify({ type: "last-prompt", lastPrompt: "/skill 1" }),
    "",
  ].join("\n");

  assert.equal(extractFinalAssistantText(jsonl), "最終レポート\n\nPR: https://example.com/pull/1");
});

test("extractFinalAssistantText skips tool-only turns and broken lines", () => {
  const jsonl = [
    assistantLine("本文のあるターン"),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
    }),
    "{ this is not json",
    "",
  ].join("\n");

  assert.equal(extractFinalAssistantText(jsonl), "本文のあるターン");
});

test("extractFinalAssistantText returns an empty string when the model never spoke", () => {
  const jsonl = [JSON.stringify({ type: "user", message: { role: "user", content: "start" } })].join("\n");
  assert.equal(extractFinalAssistantText(jsonl), "");
});

test("findTranscriptPath locates the session file by id regardless of the project directory name", () => {
  const root = mkdtempSync(join(tmpdir(), "ctw-transcript-"));
  const projectDir = join(root, "-Users-me-programming-some-app--claude-worktrees-peppy-chain-7452");
  mkdirSync(projectDir);
  const sessionId = "d3796b28-57e1-47fb-be7f-586e910ea883";
  const path = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(path, assistantLine("完了しました"));

  assert.equal(findTranscriptPath(sessionId, root), path);
  assert.equal(findTranscriptPath("00000000-0000-0000-0000-000000000000", root), null);
  assert.equal(findTranscriptPath("", root), null);
  assert.equal(readFinalReport(sessionId, root), "完了しました");
});

test("readFinalReport returns an empty string for a missing session or root", () => {
  assert.equal(readFinalReport(undefined), "");
  assert.equal(readFinalReport("some-id", join(tmpdir(), "ctw-does-not-exist-9999")), "");
});
