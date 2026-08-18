import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

const SKILLS_DIR = join(process.cwd(), "plugin", "skills");

function frontmatter(path: string): Record<string, string> {
  const src = readFileSync(path, "utf-8");
  assert.ok(src.startsWith("---\n"), `${path}: missing frontmatter`);
  const end = src.indexOf("\n---\n", 4);
  assert.ok(end > 0, `${path}: unterminated frontmatter`);
  const out: Record<string, string> = {};
  for (const line of src.slice(4, end).split("\n")) {
    // ネストしたキー（hooks 配下など）は無視する。トップレベルのみを見る。
    const m = /^([a-z][a-z-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => [e.name, frontmatter(join(SKILLS_DIR, e.name, "SKILL.md"))] as const);

test("a skill declaring model/effort also declares context: fork", () => {
  // モデルは会話の途中で切り替わらないため、`context: fork`（別コンテキストのサブエージェント）
  // でない限りスキルの `model:` / `effort:` は効かず、呼び出し元のモデルで走る。
  // 実測での裏付け: opus の exec-issue セッション244件すべてでメインスレッドのモデルが単一で、
  // `model: sonnet` の commit-push を毎回呼んでいるのに sonnet のターンが1つも現れない。
  // 効かない宣言を残すと「sonnet で動いている」という誤った前提でコスト試算・調整をしてしまう。
  for (const [name, fm] of skills) {
    if (!("model" in fm) && !("effort" in fm)) continue;
    assert.equal(fm.context, "fork", `plugin/skills/${name}: model/effort declared without context: fork`);
  }
});

test("worker entry skills do not pin a model", () => {
  // ワーカー起動スキルのモデルは claude-task-worker.json の workers.<name>.model が決める。
  // スキル側に `model:` を書くと（fork した場合）その設定を無視して上書きしてしまう。
  const entrySkills = [
    "exec-issue",
    "fix-review-point",
    "answer-issue-questions",
    "create-issue-from-issue-number",
    "update-issue",
    "triage-created-issue",
    "triage-pr",
    "resolve-pr-conflict",
    "check-dependabot",
    "create-epic-pr",
    "create-ui-design",
    "apply-ui-design",
    "update-coding-guidelines",
    "update-requirement-rules",
    "update-design-md",
  ];
  for (const name of entrySkills) {
    const fm = skills.find(([n]) => n === name)?.[1];
    assert.ok(fm, `plugin/skills/${name}: not found`);
    assert.ok(!("model" in fm), `plugin/skills/${name}: must not pin model`);
    assert.ok(!("context" in fm), `plugin/skills/${name}: must not fork (worker spawns it directly)`);
  }
});
