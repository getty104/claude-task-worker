import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, DEFAULT_UI_DESIGN_CONFIG, CONFIG_PATH } from "../config.js";
import { ensureCodegraphGitIgnore, runCodegraphInit } from "./codegraph.js";

// cc-triage-scope を除く15色は**ビビッド固定**（HSL 彩度 90〜100 / L* 26〜92 / C* 56〜111、平均
// C* 75）。その制約下で「全ペアの最小 ΔE(CIE2000) を最大化する15色」を数値最適化して選んである。
// - 全ペアの色差: 最小 ΔE(CIE2000) ≈ 17.5。彩度を高域に固定すると使える色空間の体積が減るため、
//   彩度を 32〜120 まで許した旧配色（≈ 21.6）より色差は下がる。見た目のビビッドさを優先した
//   トレードオフで、17.5 は「隣に並べれば別色と分かる」水準（旧々配色は 7.4 で判別不能だった）
// - 同系色相は明度で分離する（例: 緑は L*49 の 078834 と L*89 の 3dff64）
// - 文字とのコントラスト比は全色 4.5:1 以上。GitHub は Primer の perceived-lightness
//   （= (0.2126R + 0.7152G + 0.0722B) / 255、しきい値 0.6）で文字色を黒/白に自動で振り分ける
//   ため、その境界（0.50〜0.68）を避けてどちらに転んでも読める側へ寄せてある
// cc-triage-scope だけは明るいグレー（C* 3）で、ビビッド15色に対する ΔE(CIE2000) が 25 以上ある
// ことを最適化の制約に入れてある（無彩色を1色だけ置くことで、ラベル一覧上で「まだスコープが
// 決まっていない」状態が彩度の有無だけで見分けられる）。
// 見分けやすさを優先した結果、意味的な系統（警告=暖色など）は保証しない（cc-need-human-check の
// 赤だけは意味を保持するため最適化時に固定した）。色を変更するときは、(1) 他の15色すべてとの
// ΔE(CIE2000) が 17 以上、(2) perceived-lightness が 0.16〜0.50 か 0.68〜0.93 に収まる、
// (3) 自動選択される文字色とのコントラスト比が 4.5:1 以上、(4) cc-triage-scope 以外は HSL 彩度
// 90 以上、の4点を確認すること。
const LABELS: { name: string; color: string }[] = [
  { name: "cc-need-human-check", color: "da0b0b" }, // vivid red (H0 S90 L45 / L*46 C*90)
  { name: "cc-fix-onetime", color: "f5a542" }, // vivid orange (H33 S90 L61 / L*74 C*64)
  { name: "cc-resolve-conflict", color: "e90c59" }, // vivid crimson (H339 S90 L48 / L*50 C*79)
  { name: "cc-update-issue", color: "1af9d8" }, // vivid turquoise (H171 S95 L54 / L*88 C*56)
  { name: "cc-in-progress", color: "5a3dff" }, // vivid indigo (H249 S100 L62 / L*42 C*111)
  { name: "cc-release-ready", color: "3dff64" }, // vivid green (H132 S100 L62 / L*89 C*97)
  { name: "cc-pr-created", color: "0073d1" }, // vivid blue (H207 S100 L41 / L*48 C*57)
  { name: "cc-issue-created", color: "9e6700" }, // vivid bronze (H39 S100 L31 / L*48 C*58)
  { name: "cc-triage-scope", color: "d9dde3" }, // light gray (H213 S15 L87 / L*88 C*3)
  { name: "cc-answer-issue-questions", color: "cb0bd5" }, // vivid magenta (H297 S90 L44 / L*49 C*100)
  { name: "cc-exec-issue", color: "078834" }, // vivid emerald (H141 S90 L28 / L*49 C*61)
  { name: "cc-epic-issue", color: "ffeb33" }, // vivid yellow (H54 S100 L60 / L*92 C*84)
  { name: "cc-create-ui-design", color: "760891" }, // vivid purple (H288 S90 L30 / L*30 C*76)
  { name: "cc-ui-design", color: "98c70a" }, // vivid lime (H75 S90 L41 / L*75 C*82)
  { name: "cc-ui-design-pr-created", color: "00398f" }, // vivid navy (H216 S100 L28 / L*26 C*56)
  { name: "cc-ui-design-ready", color: "9f0459" }, // vivid wine (H327 S95 L32 / L*34 C*60)
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
