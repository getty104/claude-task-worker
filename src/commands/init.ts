import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, DEFAULT_UI_DESIGN_CONFIG, CONFIG_PATH } from "../config.js";
import { ensureCodegraphGitIgnore, runCodegraphInit } from "./codegraph.js";

// 全16色を「彩度95%・明度58〜80%（HSL）」の高彩度・高明度帯に揃え、色相を 360/16 = 22.5度
// 刻みで均等配置したうえで、リスト上の隣接ラベルが157.5度ずつ離れる順（stride 7）で割り当てて
// ある。そのため意味的な系統（警告=暖色など）ではなく、見分けやすさを優先した並びになっている
// （cc-need-human-check の赤だけは意味を保持）。
// - 全ペアの色差: 最小 ΔE(CIE76) ≈ 22（隣接ペアは ≈ 67）。同系色に見えるペアは無い
// - 黒文字とのコントラスト比は全色 7:1 以上。GitHub はラベル色の明度から文字色を自動決定する
//   ため、全ラベルが黒文字で統一され、白文字/黒文字が混在してちらつくことがない
// 一覧を変更するときは、色相を上記の刻みから外さず、明度も 58〜80% に収めること（明度を上げ
// すぎると旧 c5def5 のように淡く沈み、下げすぎると白文字に切り替わってコントラストが落ちる）。
const LABELS: { name: string; color: string }[] = [
  { name: "cc-need-human-check", color: "fb6565" }, // red (hue 0)
  { name: "cc-fix-onetime", color: "7efccc" }, // mint (hue 158)
  { name: "cc-resolve-conflict", color: "fb56d1" }, // magenta (hue 315)
  { name: "cc-update-issue", color: "48fa2e" }, // green (hue 113)
  { name: "cc-in-progress", color: "ba79fc" }, // violet (hue 270)
  { name: "cc-release-ready", color: "e8fb60" }, // yellow (hue 68)
  { name: "cc-pr-created", color: "9cb4fc" }, // periwinkle (hue 225)
  { name: "cc-issue-created", color: "fcbd97" }, // apricot (hue 23)
  { name: "cc-triage-scope", color: "3dfafa" }, // cyan (hue 180)
  { name: "cc-answer-issue-questions", color: "fc83b0" }, // pink (hue 338)
  { name: "cc-exec-issue", color: "65fb8a" }, // spring green (hue 135)
  { name: "cc-epic-issue", color: "e656fb" }, // fuchsia (hue 293)
  { name: "cc-create-ui-design", color: "9cfa3d" }, // chartreuse (hue 90)
  { name: "cc-ui-design", color: "a397fc" }, // lavender (hue 248)
  { name: "cc-ui-design-pr-created", color: "fce292" }, // light amber (hue 45)
  { name: "cc-ui-design-ready", color: "74c9fb" }, // sky (hue 203)
];

const ISSUE_TEMPLATE = `name: "[claude-task-worker] Issue作成依頼"
description: claude-task-workerでGitHub Issueを作成する
title: "[claude-task-worker] Issue作成依頼"
labels:
  - cc-triage-scope
body:
  - type: textarea
    id: request
    attributes:
      label: 依頼内容
      description: 作成してほしいIssueの内容を記述してください
    validations:
      required: true
`;

const ASSIGN_CREATOR_WORKFLOW = `name: Assign creator on cc-triage-scope

on:
  issues:
    types: [opened]

jobs:
  assign:
    if: contains(github.event.issue.labels.*.name, 'cc-triage-scope')
    runs-on: ubuntu-latest
    permissions:
      issues: write
    steps:
      - uses: actions/github-script@v9
        with:
          script: |
            await github.rest.issues.addAssignees({
              owner: context.repo.owner,
              repo: context.repo.repo,
              issue_number: context.issue.number,
              assignees: [context.payload.issue.user.login]
            });
`;

async function writeFileWithMode(
  path: string,
  content: string,
  force: boolean,
): Promise<"created" | "overwritten" | "skipped"> {
  try {
    await access(path);
    if (!force) return "skipped";
    await writeFile(path, content, "utf-8");
    return "overwritten";
  } catch {
    await writeFile(path, content, "utf-8");
    return "created";
  }
}

function logWriteResult(result: "created" | "overwritten" | "skipped", path: string): void {
  if (result === "created") console.log(`[init] Created: ${path}`);
  else if (result === "overwritten") console.log(`[init] Overwritten: ${path}`);
  else console.log(`[init] Already exists: ${path}`);
}

// ワーカーごとの設定（workers.<name>）は書き出さない。未指定なら `getWorkerConfig()` が
// WORKER_DEFAULTS へフォールバックするため、既定値を写経した設定はプラグイン更新で既定が
// 変わっても古い値に固定され続けるだけで害になる。上書きしたいワーカーだけを人が追記する。
async function createConfig(force: boolean): Promise<void> {
  const initialConfig = {
    ...DEFAULT_CONFIG,
    uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG },
    workers: {},
  };
  const result = await writeFileWithMode(CONFIG_PATH, JSON.stringify(initialConfig, null, 2), force);
  logWriteResult(result, CONFIG_PATH);
}

export async function init(options: { force?: boolean } = {}): Promise<void> {
  const force = options.force ?? false;
  console.log(`[init] Creating labels...${force ? " (force mode)" : ""}`);

  for (const label of LABELS) {
    const ok = await createLabel(label.name, label.color, true);
    if (ok) {
      console.log(`[init] Ensured label: ${label.name}`);
    } else {
      console.log(`[init] Failed to create label: ${label.name}`);
    }
  }

  console.log("[init] Creating issue template...");
  await mkdir(".github/ISSUE_TEMPLATE", { recursive: true });
  const templatePath = ".github/ISSUE_TEMPLATE/cc-triage-scope.yml";
  logWriteResult(await writeFileWithMode(templatePath, ISSUE_TEMPLATE, force), templatePath);

  console.log("[init] Creating GitHub Actions workflow...");
  await mkdir(".github/workflows", { recursive: true });
  const workflowPath = ".github/workflows/assign-creator-on-cc-triage-scope.yml";
  logWriteResult(await writeFileWithMode(workflowPath, ASSIGN_CREATOR_WORKFLOW, force), workflowPath);

  console.log("[init] Creating config file...");
  await createConfig(force);

  console.log("[init] Setting up CodeGraph...");
  await ensureCodegraphGitIgnore("init");
  await runCodegraphInit("init");

  console.log("[init] Done.");
}
