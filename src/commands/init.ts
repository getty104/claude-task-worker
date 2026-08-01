import { mkdir, writeFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import { DEFAULT_CONFIG, DEFAULT_UI_DESIGN_CONFIG, CONFIG_PATH } from "../config.js";
import { ensureCodegraphGitIgnore, runCodegraphInit } from "./codegraph.js";

// 全16色は「色相・明度・彩度の3軸すべて」を使って散らしてある。旧配色は彩度を100%に固定し色相
// だけで散らしていたため、色相環上で等間隔でも実際の見分けは付きにくかった（高彩度域では色相差
// あたりの知覚差が小さく、ΔE(CIE76) 上は離れていても人の目には近い色になる）。そこで下記の制約
// 下で「全ペアの最小 ΔE(CIE2000) を最大化する16色」を数値最適化して選び直した。
// - 全ペアの色差: 最小 ΔE(CIE2000) ≈ 21.6（旧配色は 7.4。CIE76 では旧 30.3 / 新 29.0 とほぼ同値
//   になるが、CIE76 は高彩度域の色差を過大評価するため実際の見分けやすさを反映しない）
// - 明度 L* は 30〜89、彩度 C* は 32〜120（平均 58）に分布させ、同系色相でも明度・彩度で分離する
// - 文字とのコントラスト比は全色 4.5:1 以上。GitHub は Primer の perceived-lightness
//   （= (0.2126R + 0.7152G + 0.0722B) / 255、しきい値 0.6）で文字色を黒/白に自動で振り分ける
//   ため、その境界（0.50〜0.68）を避けてどちらに転んでも読める側へ寄せてある
// 見分けやすさを優先した結果、意味的な系統（警告=暖色など）は保証しない（cc-need-human-check の
// 赤だけは意味を保持するため最適化時に固定した）。色を変更するときは、(1) 他の15色すべてとの
// ΔE(CIE2000) が 20 以上、(2) perceived-lightness が 0.16〜0.50 か 0.68〜0.93 に収まる、
// (3) 自動選択される文字色とのコントラスト比が 4.5:1 以上、の3点を確認すること。
const LABELS: { name: string; color: string }[] = [
  { name: "cc-need-human-check", color: "e10000" }, // red (H0 S100 L44 / L*47 C*95)
  { name: "cc-fix-onetime", color: "ffb400" }, // amber (H42 S100 L50 / L*78 C*83)
  { name: "cc-resolve-conflict", color: "c30a78" }, // magenta (H324 S90 L40 / L*43 C*71)
  { name: "cc-update-issue", color: "00fae6" }, // cyan (H175 S100 L49 / L*89 C*53)
  { name: "cc-in-progress", color: "7d6ea5" }, // muted violet (H256 S23 L54 / L*50 C*33)
  { name: "cc-release-ready", color: "00ff00" }, // green (H120 S100 L50 / L*88 C*120)
  { name: "cc-pr-created", color: "141edc" }, // blue (H237 S83 L47 / L*30 C*112)
  { name: "cc-issue-created", color: "783732" }, // maroon (H4 S41 L33 / L*32 C*32)
  { name: "cc-triage-scope", color: "5abeff" }, // sky (H204 S100 L68 / L*74 C*42)
  { name: "cc-answer-issue-questions", color: "ff91f5" }, // pink (H305 S100 L78 / L*75 C*64)
  { name: "cc-exec-issue", color: "285023" }, // dark green (H113 S39 L23 / L*30 C*33)
  { name: "cc-epic-issue", color: "8c6405" }, // dark gold (H42 S93 L28 / L*45 C*52)
  { name: "cc-create-ui-design", color: "ffa591" }, // salmon (H11 S100 L78 / L*76 C*39)
  { name: "cc-ui-design", color: "aab478" }, // sage (H70 S29 L59 / L*71 C*32)
  { name: "cc-ui-design-pr-created", color: "008273" }, // teal (H173 S100 L25 / L*49 C*34)
  { name: "cc-ui-design-ready", color: "0073a0" }, // azure (H197 S100 L31 / L*45 C*33)
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
