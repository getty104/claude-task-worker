import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { createLabel } from "../gh";
import {
  DEFAULT_CONFIG,
  DEFAULT_UI_DESIGN_CONFIG,
  CONFIG_PATH,
  SCHEDULED_WORKER_NAMES,
  CLOUD_DONE_LABEL,
} from "../config.js";
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
// **ΔE だけでは「同じ色に見える」という体感を拾いきれない**。ΔE は明度差も距離に算入するため、
// 明度の違う同系色（例: 濃い緑と明るい緑）を十分離れていると評価するが、ラベル一覧に並ぶと
// どちらも「緑」としか読めず見分けられない。実際 cc-answer-issue-questions は当初 H140 の濃い緑
// で、cc-in-progress（H118）との ΔE は 32.5 と基準を満たしていたのに、運用では取り違えが起きた
// （現在の H258 では ΔE 55.2 / 色相差 140°）。そのため共起する有彩色ラベルとの**色相差**も併せて
// 見る。ただし共起する有彩色ラベルが10色あり色相環はほぼ埋まっているので、どの色を選んでも
// 最寄りとの色相差は最大30°しか取れない。色相差を稼ぐこと自体より、**最寄りの色相が「見分け
// たい相手」にならないこと**を優先する（H88 は色相差30°を取れるが最寄りが cc-in-progress
// になるため、緑との混同を解消したい用途では不適格）。
// 色を変更するときは、(1) 共起するラベルすべてとの ΔE(CIE2000) が 25 以上、(2) 共起しない
// ラベルとも 15 以上、(3) perceived-lightness が 0.16〜0.50 か 0.68〜0.93 に収まる、(4) 自動選択
// される文字色とのコントラスト比が 4.5:1 以上、(5) cc-triage-scope 以外は HSL 彩度 90 以上、
// (6) 共起する有彩色ラベルとの色相差が確保でき、最寄りの色相が混同を避けたい相手でない、の
// 6点を確認すること。
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
  { name: "cc-answer-issue-questions", color: "c5adff" }, // vivid pale violet (H258 S100 L84 / L*75 C*45)
  { name: "cc-exec-issue", color: "74089b" }, // vivid purple (H284 S90 L32 / L*30 C*80)
  { name: "cc-epic-issue", color: "0fffdf" }, // vivid turquoise (H172 S100 L53 / L*90 C*57)
  { name: "cc-create-ui-design", color: "002aff" }, // vivid blue (H230 S100 L50 / L*36 C*123)
  { name: "cc-ui-design", color: "ffc524" }, // vivid amber (H44 S100 L57 / L*83 C*79)
  { name: "cc-ui-design-pr-created", color: "947100" }, // vivid bronze (H46 S100 L29 / L*50 C*56)
  { name: "cc-ui-design-ready", color: "0c73e9" }, // vivid azure (H212 S90 L48 / L*50 C*69)
  { name: CLOUD_DONE_LABEL, color: "33cfff" }, // vivid sky blue (H194 S100 L60 / L*78 C*42)
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
// lastRun は init 実行時刻で埋める。空だと初回ポーリングで3つの定期ワーカーが一斉に走り、
// セットアップ直後の（材料がまだ無い）リポジトリで空振りのセッションを3本焼くため。
async function createConfig(force: boolean): Promise<void> {
  const now = new Date().toISOString();
  const initialConfig = {
    ...DEFAULT_CONFIG,
    uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG },
    lastRun: Object.fromEntries(SCHEDULED_WORKER_NAMES.map((name) => [name, now])),
    workers: {},
  };
  const result = await writeFileWithMode(CONFIG_PATH, JSON.stringify(initialConfig, null, 2), force);
  logWriteResult(result, CONFIG_PATH);
}

// リポジトリの `.claude/settings.json` へ書き出すクラウドセッションの既定権限モード。
//
// クラウド実行（`--cloud`）では `--permission-mode` は**受理されるが VM 側に反映されない**
// （`--disallowedTools` / `--append-system-prompt-file` と同じ。Issue #307）。加えて
// bypassPermissions はクラウドのモード一覧に無く、既定の acceptEdits（「編集を受け入れる」）へ
// 落ちる。クラウドで権限モードを決められる経路は「リポジトリにコミットした設定ファイル」だけ
// なのでここへ書く。ローカル実行（default / herdr）はワーカーが `--permission-mode` フラグを
// 渡し、フラグが settings に勝つため挙動は変わらない。
export const CLOUD_DEFAULT_PERMISSION_MODE = "auto";

// 同ファイルへ書き出すトップレベル設定。ワーカーのタスクセッションは応答するユーザーが
// 常駐しない自律実行なので、確認を挟まず進む Proactive を既定にする。language は成果物
// （Issueコメント・PR本文・最終報告）の言語を揃えるため。
// どちらもユーザーの `~/.claude/settings.json` にあってもクラウドセッションには渡らない
// （公式表: ユーザー側の設定はマシンに閉じ、リポジトリにコミットしたものだけが届く）。
export const CLAUDE_SETTINGS_DEFAULTS = {
  outputStyle: "Proactive",
  language: "Japanese",
} as const;

export const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

// `.claude/settings.json` へ `permissions.defaultMode` と CLAUDE_SETTINGS_DEFAULTS を
// 差し込んだ内容を返す。変更不要（すべて指定済みで force なし）なら null。
//
// 既存ファイルを丸ごと上書きしないのは、対象リポジトリの settings.json には hooks・
// enabledPlugins・permissions.allow など無関係な設定が入っているのが普通で、それを消すと
// init が破壊的な操作になるため。JSON として読めない・`permissions` がオブジェクトでない
// 場合は書き換えずに投げ、呼び出し側がスキップして人へ委ねる。
export function withInitDefaults(existing: string | null, force: boolean): string | null {
  const parsed: unknown = existing === null ? {} : JSON.parse(existing);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("not a JSON object");
  }
  const settings = { ...(parsed as Record<string, unknown>) };
  const current = settings["permissions"] ?? {};
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    throw new Error("`permissions` is not an object");
  }
  const permissions = { ...(current as Record<string, unknown>) };
  let changed = false;
  // 既に指定がある場合は人の選択を尊重して触らない（--force のときだけ上書きする）。
  const set = (target: Record<string, unknown>, key: string, value: string): void => {
    if (key in target && !force) return;
    if (target[key] === value) return;
    target[key] = value;
    changed = true;
  };
  set(permissions, "defaultMode", CLOUD_DEFAULT_PERMISSION_MODE);
  for (const [key, value] of Object.entries(CLAUDE_SETTINGS_DEFAULTS)) set(settings, key, value);
  if (!changed) return null;
  return `${JSON.stringify({ ...settings, permissions }, null, 2)}\n`;
}

async function createClaudeSettings(force: boolean): Promise<void> {
  let existing: string | null;
  try {
    existing = await readFile(CLAUDE_SETTINGS_PATH, "utf-8");
  } catch {
    existing = null;
  }
  let next: string | null;
  try {
    next = withInitDefaults(existing, force);
  } catch (e) {
    console.log(`[init] Skipped: ${CLAUDE_SETTINGS_PATH} (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  if (next === null) {
    console.log(`[init] Already set: ${CLAUDE_SETTINGS_PATH}`);
    return;
  }
  await mkdir(".claude", { recursive: true });
  await writeFile(CLAUDE_SETTINGS_PATH, next, "utf-8");
  logWriteResult(existing === null ? "created" : "overwritten", CLAUDE_SETTINGS_PATH);
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

  console.log("[init] Writing Claude Code settings...");
  await createClaudeSettings(force);

  console.log("[init] Setting up CodeGraph...");
  await ensureCodegraphGitIgnore("init");
  await runCodegraphInit("init");

  console.log("[init] Done.");
}
