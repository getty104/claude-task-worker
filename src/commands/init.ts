import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, DEFAULT_UI_DESIGN_CONFIG, CONFIG_PATH } from "../config.js";
import { ensureCodegraphGitIgnore, runCodegraphInit } from "./codegraph.js";

// 色は「色相を最低でも約20度ずつ離す」か「同系色相なら明度を大きく離す（明ラベル=黒文字 /
// 暗ラベル=白文字）」のどちらかを満たすように選んである。GitHub はラベル色の明度から文字色を
// 自動で決めるため、中間の明度に固めると文字が読みにくいラベルが増える。淡すぎる色
// （旧 c5def5 / bfd4f2 など）と、同系色に密集していた紫3色・黄2色・ピンク4色は解消済み。
// 一覧を変更するときは、既存色と色相・明度の両方が近くならないかを確認すること。
const LABELS: { name: string; color: string }[] = [
  // 警告・修正系（暖色）
  { name: "cc-need-human-check", color: "b60205" }, // dark red
  { name: "cc-fix-onetime", color: "e8590c" }, // orange
  { name: "cc-resolve-conflict", color: "ffc53d" }, // amber
  { name: "cc-update-issue", color: "cddc39" }, // lime
  // 進行・完了系（緑〜青緑）
  { name: "cc-in-progress", color: "0e8a16" }, // dark green
  { name: "cc-release-ready", color: "4ade80" }, // bright green
  { name: "cc-pr-created", color: "006b75" }, // dark teal
  // Issueライフサイクル（シアン〜紫）
  { name: "cc-issue-created", color: "67e8f9" }, // cyan
  { name: "cc-triage-scope", color: "1f6feb" }, // blue
  { name: "cc-answer-issue-questions", color: "3730a3" }, // indigo
  { name: "cc-exec-issue", color: "7c3aed" }, // violet
  { name: "cc-epic-issue", color: "c4b5fd" }, // light lavender
  // UIデザイン系（フクシア〜ピンク〜コーラル）
  { name: "cc-create-ui-design", color: "a21caf" }, // dark fuchsia
  { name: "cc-ui-design", color: "db2777" }, // magenta
  { name: "cc-ui-design-pr-created", color: "f9a8d4" }, // light pink
  { name: "cc-ui-design-ready", color: "ff8a80" }, // coral
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
