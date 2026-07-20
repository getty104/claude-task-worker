import { test } from "node:test";
import assert from "node:assert/strict";
import type * as TableModule from "./table";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
const { getDisplayWidth, truncateToWidth, padToWidth, buildTaskTableLines } = (await import(
  "./table.ts"
)) as typeof TableModule;

test("getDisplayWidth returns 0 for empty string", () => {
  assert.equal(getDisplayWidth(""), 0);
});

test("getDisplayWidth treats ASCII characters as width 1", () => {
  assert.equal(getDisplayWidth("abc"), 3);
});

test("getDisplayWidth: U+10FF (just before U+1100) is width 1", () => {
  assert.equal(getDisplayWidth("ჿ"), 1);
});

test("getDisplayWidth: U+1100 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("ᄀ"), 2);
});

test("getDisplayWidth: U+2E80 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("⺀"), 2);
});

test("getDisplayWidth: U+2E7F (just before U+2E80) is width 1", () => {
  assert.equal(getDisplayWidth("⹿"), 1);
});

test("getDisplayWidth: U+3040 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("぀"), 2);
});

test("getDisplayWidth: U+303F (just before U+3040, in the gap after the preceding CJK punctuation range) is width 1", () => {
  assert.equal(getDisplayWidth("〿"), 1);
});

test("getDisplayWidth: U+4E00 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("一"), 2);
});

test("getDisplayWidth: U+33BF (just before U+3400, inside preceding range) is width 2", () => {
  assert.equal(getDisplayWidth("㎿"), 2);
});

test("getDisplayWidth: U+AC00 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("가"), 2);
});

test("getDisplayWidth: U+ABFF (just before U+AC00) is width 1", () => {
  assert.equal(getDisplayWidth("꯿"), 1);
});

test("getDisplayWidth: U+F900 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("豈"), 2);
});

test("getDisplayWidth: U+F8FF (just before U+F900) is width 1", () => {
  assert.equal(getDisplayWidth(""), 1);
});

test("getDisplayWidth: U+FE30 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("︰"), 2);
});

test("getDisplayWidth: U+FE2F (just before U+FE30) is width 1", () => {
  assert.equal(getDisplayWidth("︯"), 1);
});

test("getDisplayWidth: U+FF01 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("！"), 2);
});

test("getDisplayWidth: U+FF00 (just before U+FF01) is width 1", () => {
  assert.equal(getDisplayWidth("＀"), 1);
});

test("getDisplayWidth: U+FF60 (end of range) is width 2", () => {
  assert.equal(getDisplayWidth("｠"), 2);
});

test("getDisplayWidth: U+FF61 (just after U+FF60) is width 1", () => {
  assert.equal(getDisplayWidth("｡"), 1);
});

test("getDisplayWidth: U+FFE0 (start of range) is width 2", () => {
  assert.equal(getDisplayWidth("￠"), 2);
});

test("getDisplayWidth: U+FFDF (just before U+FFE0) is width 1", () => {
  assert.equal(getDisplayWidth("￟"), 1);
});

test("getDisplayWidth: U+FFE6 (end of range) is width 2", () => {
  assert.equal(getDisplayWidth("￦"), 2);
});

test("getDisplayWidth: U+FFE7 (just after U+FFE6) is width 1", () => {
  assert.equal(getDisplayWidth("￧"), 1);
});

test("getDisplayWidth: U+20000 (start of range, surrogate pair) is width 2", () => {
  assert.equal(getDisplayWidth("\u{20000}"), 2);
});

test("getDisplayWidth: U+1FFFF (just before U+20000, surrogate pair) is width 1", () => {
  assert.equal(getDisplayWidth("\u{1ffff}"), 1);
});

test("getDisplayWidth: U+30000 (start of range, surrogate pair) is width 2", () => {
  assert.equal(getDisplayWidth("\u{30000}"), 2);
});

test("getDisplayWidth: U+2FFFF (just before U+30000, in the gap after the preceding range ends at U+2FFFD) is width 1", () => {
  assert.equal(getDisplayWidth("\u{2ffff}"), 1);
});

test("getDisplayWidth: U+40000 (just after U+3FFFD range end) is width 1", () => {
  assert.equal(getDisplayWidth("\u{40000}"), 1);
});

test("truncateToWidth returns the original string unchanged when within maxWidth", () => {
  assert.equal(truncateToWidth("abc", 10), "abc");
});

test("truncateToWidth returns the original string unchanged when its width is comfortably under maxWidth", () => {
  assert.equal(truncateToWidth("abcde", 8), "abcde");
});

test("truncateToWidth truncates an ASCII string with an ellipsis when exceeding maxWidth", () => {
  assert.equal(truncateToWidth("abcdefghij", 5), "ab...");
});

test("truncateToWidth truncates a full-width (CJK) string with an ellipsis based on display width", () => {
  assert.equal(truncateToWidth("あいうえお", 6), "あ...");
});

test("truncateToWidth truncates a mixed half-width/full-width string with an ellipsis", () => {
  assert.equal(truncateToWidth("aあbいc", 6), "aあ...");
});

test("padToWidth pads an ASCII string with trailing spaces to reach targetWidth", () => {
  assert.equal(padToWidth("ab", 5), "ab   ");
});

test("padToWidth pads a full-width (CJK) string based on display width, not character count", () => {
  assert.equal(padToWidth("あい", 6), "あい  ");
});

test("padToWidth returns the string unchanged when its display width already equals targetWidth", () => {
  assert.equal(padToWidth("あい", 4), "あい");
});

test("padToWidth returns the string unchanged when its display width already exceeds targetWidth", () => {
  assert.equal(padToWidth("あいう", 4), "あいう");
});

// --- buildTaskTableLines ---

type TaskTableEntry = TableModule.TaskTableEntry;

const NOW = new Date("2026-07-20T12:00:30");
const STARTED = new Date("2026-07-20T12:00:00");

function task(overrides: Partial<TaskTableEntry> & Pick<TaskTableEntry, "id" | "status">): TaskTableEntry {
  return {
    title: `task ${overrides.id}`,
    workerName: "exec-issue",
    startedAt: STARTED,
    ...overrides,
  };
}

/** 罫線・ヘッダーを除いたデータ行だけを、上から順に取り出す。 */
function dataRows(lines: string[]): string[] {
  return lines.filter((l) => l.startsWith("│") && !l.includes("Duration"));
}

/**
 * データ行を、実行中セクションの区切り罫線を境に上下へ分ける。
 * 区切りが無い場合は全行を before に入れる（呼び出し側が hasSectionDivider と併用する）。
 */
function sections(lines: string[]): { before: string[]; after: string[] } {
  // ヘッダー行とその下の罫線を落とし、残りを区切り罫線で二分する
  const body = lines.filter((l) => l.startsWith("│") || l.startsWith("├")).slice(2);
  const divider = body.findIndex((l) => l.startsWith("├"));
  if (divider === -1) return { before: body, after: [] };
  return { before: body.slice(0, divider), after: body.slice(divider + 1) };
}

/** データ行のあいだにセクション区切りの罫線があるか。 */
function hasSectionDivider(lines: string[]): boolean {
  return sections(lines).after.length > 0;
}

test("buildTaskTableLines returns no lines when there are no tasks", () => {
  assert.deepEqual(buildTaskTableLines([], NOW), []);
});

test("buildTaskTableLines lists running tasks above finished ones", () => {
  const lines = buildTaskTableLines(
    [
      task({ id: 1, status: "completed", finishedAt: NOW }),
      task({ id: 2, status: "running" }),
      task({ id: 3, status: "failed", finishedAt: NOW }),
    ],
    NOW,
  );

  const rows = dataRows(lines);
  assert.equal(rows.length, 3);
  assert.match(rows[0], /#2/);
  assert.match(rows[1], /#1/);
  assert.match(rows[2], /#3/);
});

// リグレッション: herdr モードの running 行は status が `running:working` のように
// 装飾されるため、表示文字列で running を判定すると完了セクションへ落ちてしまっていた。
test("buildTaskTableLines keeps a herdr running task with an agent status in the running section", () => {
  const lines = buildTaskTableLines(
    [
      task({ id: 1, status: "completed", finishedAt: NOW }),
      task({ id: 2, status: "running", agentStatus: "working" }),
      task({ id: 3, status: "running", agentStatus: "blocked" }),
    ],
    NOW,
  );

  // 区切り罫線の上（実行中セクション）に居ることまで確かめる。
  // 行の並び順だけでは、完了セクションへ落ちていても順序が偶然一致して見逃す。
  const { before, after } = sections(lines);
  assert.equal(before.length, 2);
  assert.match(before[0], /#2.*running:working/);
  assert.match(before[1], /#3.*running:blocked/);
  assert.equal(after.length, 1);
  assert.match(after[0], /#1.*completed/);
});

test("buildTaskTableLines renders the agent status alongside the task status", () => {
  const lines = buildTaskTableLines([task({ id: 7, status: "running", agentStatus: "blocked" })], NOW);

  assert.match(dataRows(lines)[0], /running:blocked/);
});

test("buildTaskTableLines draws a divider between the running and finished sections", () => {
  const lines = buildTaskTableLines(
    [task({ id: 1, status: "running", agentStatus: "working" }), task({ id: 2, status: "completed", finishedAt: NOW })],
    NOW,
  );

  assert.equal(hasSectionDivider(lines), true);
});

test("buildTaskTableLines draws no divider when every task is still running", () => {
  const lines = buildTaskTableLines(
    [task({ id: 1, status: "running", agentStatus: "working" }), task({ id: 2, status: "running" })],
    NOW,
  );

  assert.equal(hasSectionDivider(lines), false);
});

test("buildTaskTableLines draws no divider when every task has finished", () => {
  const lines = buildTaskTableLines(
    [task({ id: 1, status: "completed", finishedAt: NOW }), task({ id: 2, status: "failed", finishedAt: NOW })],
    NOW,
  );

  assert.equal(hasSectionDivider(lines), false);
});

test("buildTaskTableLines sizes the status column to fit a decorated herdr status", () => {
  const lines = buildTaskTableLines([task({ id: 1, status: "running", agentStatus: "working" })], NOW);

  // 全行の表示幅が揃っている（幅算出が装飾済み status を含んでいる）ことを確認する
  const widths = new Set(lines.map((l) => getDisplayWidth(l)));
  assert.equal(widths.size, 1);
});

test("buildTaskTableLines shows the worktree column only when some task has a path", () => {
  const withPath = buildTaskTableLines(
    [task({ id: 1, status: "running", path: ".claude/worktrees/brave-otter-1234" })],
    NOW,
  );
  const withoutPath = buildTaskTableLines([task({ id: 1, status: "running" })], NOW);

  assert.match(withPath.join("\n"), /Worktree/);
  assert.doesNotMatch(withoutPath.join("\n"), /Worktree/);
});

test("buildTaskTableLines measures elapsed time against the supplied clock", () => {
  const lines = buildTaskTableLines([task({ id: 1, status: "running" })], NOW);

  assert.match(dataRows(lines)[0], /0m 30s/);
});
