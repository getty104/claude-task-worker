import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, DEFAULT_UI_DESIGN_CONFIG, CONFIG_PATH } from "../config.js";
import { ensureCodegraphGitIgnore, runCodegraphInit } from "./codegraph.js";

// 全16色を彩度100%（HSL S=100%）に振り切り、色相を 360/16 = 22.5度刻みで均等配置したうえで、
// リスト上の隣接ラベルが157.5度ずつ離れる順（stride 7）で割り当ててある。そのため意味的な系統
// （警告=暖色など）ではなく、見分けやすさを優先した並びになっている（cc-need-human-check の赤
// だけは意味を保持）。明度は色相ごとに、下記の制約下で色差が最大になる値を個別に選んである。
// - 全ペアの色差: 最小 ΔE(CIE76) ≈ 30。彩度は平均 C* ≈ 86・最小 45（旧配色は ΔE 22 / C* 64）
// - 文字とのコントラスト比は全色 4.5:1 以上。GitHub は Primer の perceived-lightness
//   （= (0.2126R + 0.7152G + 0.0722B) / 255、しきい値 0.6）で文字色を黒/白に自動で振り分ける
//   ため、その境界（0.50〜0.68）を避けてどちらに転んでも読める側へ寄せてある
// 一覧を変更するときは、色相を上記の刻みから外さないこと。明度を変える場合は、perceived-
// lightness が 0.16〜0.50 か 0.68〜0.93 に収まり、かつ自動選択される文字色とのコントラスト比が
// 4.5:1 以上であることを確認する（境界付近に置くと文字が読めない色になる）。
const LABELS: { name: string; color: string }[] = [
  { name: "cc-need-human-check", color: "eb0000" }, // red (hue 0)
  { name: "cc-fix-onetime", color: "47ffba" }, // aquamarine (hue 158)
  { name: "cc-resolve-conflict", color: "db00a4" }, // magenta (hue 315)
  { name: "cc-update-issue", color: "20ff00" }, // green (hue 113)
  { name: "cc-in-progress", color: "8000ff" }, // violet (hue 270)
  { name: "cc-release-ready", color: "b3cc00" }, // olive (hue 68)
  { name: "cc-pr-created", color: "0029a3" }, // navy (hue 225)
  { name: "cc-issue-created", color: "bd4700" }, // burnt orange (hue 23)
  { name: "cc-triage-scope", color: "00ffff" }, // cyan (hue 180)
  { name: "cc-answer-issue-questions", color: "e60056" }, // crimson (hue 338)
  { name: "cc-exec-issue", color: "52ff7d" }, // spring green (hue 135)
  { name: "cc-epic-issue", color: "c900e6" }, // purple (hue 293)
  { name: "cc-create-ui-design", color: "a1ff42" }, // chartreuse (hue 90)
  { name: "cc-ui-design", color: "6752ff" }, // indigo (hue 248)
  { name: "cc-ui-design-pr-created", color: "ffbf00" }, // amber (hue 45)
  { name: "cc-ui-design-ready", color: "0079c2" }, // azure (hue 203)
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
