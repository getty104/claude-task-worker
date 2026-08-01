import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, DEFAULT_UI_DESIGN_CONFIG, CONFIG_PATH } from "../config.js";
import { ensureCodegraphGitIgnore, runCodegraphInit } from "./codegraph.js";

// cc-triage-scope を除く15色は**ビビッド固定**（HSL 彩度 90〜100 / L* 24〜95 / C* 56〜123）。その
// 制約下で「**同時に付きうるラベル同士**の最小 ΔE(CIE2000) を最大化する15色」を数値最適化した。
// 全ペア一律ではなく共起するペアだけを最大化するのは、Issue にしか付かないラベルと PR にしか
// 付かないラベルは同じ一覧に並ばないため、そこに色空間を割くと肝心の共起ペアが詰まるから。
// - 共起ペアの最小 ΔE(CIE2000) ≈ 25.2（全ペア一律で最適化すると ≈ 17.5 までしか取れない）
// - 非共起ペアにも下限 ΔE ≥ 15 を課す（横断検索など、別スコープのラベルが同じ画面に出る場合に
//   同色に見えないため）。最小は 15.4（cc-release-ready / cc-create-ui-design）
// - 共起の判定: (1) Issue 専用ラベル × PR 専用ラベルは共起しない、(2) UIデザインの状態遷移
//   （cc-create-ui-design → cc-ui-design-pr-created → cc-ui-design-ready）は順に付け替わるため
//   互いに共起しない、(3) それ以外はすべて共起しうるものとして扱う。cc-in-progress と
//   cc-need-human-check は実行中／要人手として他のラベルへ重ねて付くため、全色と共起する
// - 文字とのコントラスト比は全色 4.5:1 以上。GitHub は Primer の perceived-lightness
//   （= (0.2126R + 0.7152G + 0.0722B) / 255、しきい値 0.6）で文字色を黒/白に自動で振り分ける
//   ため、その境界（0.50〜0.68）を避けてどちらに転んでも読める側へ寄せてある
// 色相は cc-need-human-check（赤）/ cc-fix-onetime（赤系）/ cc-in-progress（緑）/ cc-update-issue
// （黄）/ cc-exec-issue（紫）を色相帯で固定し、残りを最適化に任せてある。cc-triage-scope だけは
// 白（C* 0）で、他15色との ΔE が 25 以上あることを制約に入れた（無彩色を1色だけ置くことで、
// 「まだスコープが決まっていない」状態が彩度の有無だけで見分けられる）。
// 色を変更するときは、(1) 共起するラベルすべてとの ΔE(CIE2000) が 25 以上、(2) 共起しない
// ラベルとも 15 以上、(3) perceived-lightness が 0.16〜0.50 か 0.68〜0.93 に収まる、(4) 自動選択
// される文字色とのコントラスト比が 4.5:1 以上、(5) cc-triage-scope 以外は HSL 彩度 90 以上、の
// 5点を確認すること。
const LABELS: { name: string; color: string }[] = [
  { name: "cc-need-human-check", color: "eb1700" }, // vivid red (H6 S100 L46 / L*50 C*97)
  { name: "cc-fix-onetime", color: "960837" }, // vivid wine red (H340 S90 L31 / L*32 C*56)
  { name: "cc-resolve-conflict", color: "6e7e07" }, // vivid olive (H68 S90 L26 / L*50 C*57)
  { name: "cc-update-issue", color: "fff700" }, // vivid yellow (H58 S100 L50 / L*95 C*95)
  { name: "cc-in-progress", color: "14ed0c" }, // vivid green (H118 S90 L49 / L*82 C*112)
  { name: "cc-release-ready", color: "00328a" }, // vivid navy (H218 S100 L27 / L*24 C*58)
  { name: "cc-pr-created", color: "df0c7c" }, // vivid magenta (H328 S90 L46 / L*49 C*77)
  { name: "cc-issue-created", color: "ffa347" }, // vivid orange (H30 S100 L64 / L*75 C*66)
  { name: "cc-triage-scope", color: "ffffff" }, // white (L*100 C*0)
  { name: "cc-answer-issue-questions", color: "077e2e" }, // vivid dark green (H140 S90 L26 / L*46 C*58)
  { name: "cc-exec-issue", color: "74089b" }, // vivid purple (H284 S90 L32 / L*30 C*80)
  { name: "cc-epic-issue", color: "0fffdf" }, // vivid turquoise (H172 S100 L53 / L*90 C*57)
  { name: "cc-create-ui-design", color: "002aff" }, // vivid blue (H230 S100 L50 / L*36 C*123)
  { name: "cc-ui-design", color: "ffc524" }, // vivid amber (H44 S100 L57 / L*83 C*79)
  { name: "cc-ui-design-pr-created", color: "947100" }, // vivid bronze (H46 S100 L29 / L*50 C*56)
  { name: "cc-ui-design-ready", color: "0c73e9" }, // vivid azure (H212 S90 L48 / L*50 C*69)
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
