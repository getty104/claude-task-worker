import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep as SEP } from "node:path";
import { getInheritConfigPath, hasCloudFlag, INHERIT_CONFIG_FLAG } from "./dispatch-args";

export type WorkerName =
  | "exec-issue"
  | "answer-issue-questions"
  | "create-issue"
  | "update-issue"
  | "triage-created-issue"
  | "fix-review-point"
  | "check-dependabot"
  | "triage-pr"
  | "resolve-conflict"
  | "epic-issue"
  | "create-ui-design"
  | "apply-ui-design"
  | "update-coding-guidelines"
  | "update-requirement-rules"
  | "update-design-md";

export interface WorkerRuntimeConfig {
  skill: string;
  model: string;
  // claude CLI の `--advisor <model>` に渡すモデル。空文字は「advisor を使わない」を意味する
  // （config.json の `advisor: true` でも `--advisor` を渡さない）。claude 側の制約で
  // advisor は main モデル以上の能力が必要なため、model が opus のワーカーの既定は
  // ""（＝無効）。sonnet へ下げたワーカーも既定は "" にしてある（opus advisor を付けると
  // 下げたぶんのコスト削減を打ち消すため）。品質が落ちた場合の調整弁として
  // claude-task-worker.json で "opus" を指定できる。
  advisorModel: string;
  effort: string;
  pollingIntervalSeconds: number;
  cooldownSeconds: number;
  maxConcurrentTasks: number;
  // false のワーカーは all / yolo の起動集合から外れ、個別起動では起動時に拒否される。
  enabled: boolean;
}

// Pencil デザイン先行ワークフロー（create-ui-design / apply-ui-design）の設定。
// Pencil を使っていないリポジトリで勝手にデザインPRが作られないようオプトインにする。
export interface UiDesignConfig {
  enabled: boolean;
  designDir: string;
  // デザインPRを人のレビュー無しで自動マージまで流すか。false（既定）ではデザインPRに
  // cc-triage-scope を付けないため、triage-pr が拾わず人がレビュー・マージするまで止まる。
  yolo: boolean;
}

// 定期ワーカー（24時間おきに1回だけ走らせるもの）の最終実行時刻。ワーカー名 → ISO8601。
// プロセス内のメモリではなくリポジトリの設定ファイルに置くのは、ワーカーを再起動しても
// 間隔が保たれるようにするため。値はワーカーが worktree 側へ書き込み、スキルの
// commit-push でその日の成果物と同じPRに含めてコミットされる。
export type LastRunLog = Record<string, string>;

interface Config {
  fixReviewPointCallbackCommentMessage?: string;
  // クラウド実行（--cloud）時に `claude --environment <id>` へ渡す環境ID。null なら渡さず、
  // claude 側の既定解決（settings の remote.defaultEnvironmentId → 一覧の最初の
  // anthropic_cloud 環境）に任せる。個人ごとに違う値になりやすいので
  // claude-task-worker.local.json 側で指定する想定。
  remoteEnvId: string | null;
  labels: string[];
  workerFiles: string[];
  uiDesign: UiDesignConfig;
  lastRun: LastRunLog;
  workers: Record<string, WorkerRuntimeConfig>;
}

export const DEFAULT_UI_DESIGN_CONFIG: UiDesignConfig = {
  enabled: false,
  designDir: "designs",
  yolo: false,
};

// opus ワーカーの effort は `medium`（Opus 5.5 の既定）。Opus 5.5 は `medium` で Opus 5 の `high` と
// 同等以上（コーディング・ナレッジワーク評価、Anthropic 実測）かつ同じレベル名でもターンあたりの
// 思考量が増えるため、Opus 5 時代の `high` をそのまま持ち越すとターンが長くコストも増えるだけになる
// （https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5#calibrate-effort）。
// sonnet ワーカーは Sonnet 5.5 ガイドの「エージェント的なツール使用は、仕様が確定したタスクは
// `medium` から、難しい・長いタスクは `high`」に従い、手順が本文に書き切ってある
// `update-issue` / `triage-created-issue` / `epic-issue` / `apply-ui-design` を `medium`、
// コード変更の判断を伴う `resolve-conflict` / `check-dependabot` を `high` にする
// （https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5#calibrate-effort）。
export const DEFAULT_WORKER_CONFIG: WorkerRuntimeConfig = {
  skill: "",
  model: "opus",
  advisorModel: "",
  effort: "medium",
  pollingIntervalSeconds: 60,
  cooldownSeconds: 0,
  maxConcurrentTasks: 1,
  enabled: true,
};

export const WORKER_DEFAULTS: Record<string, WorkerRuntimeConfig> = {
  "answer-issue-questions": {
    skill: "/claude-task-worker:answer-issue-questions",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "create-issue": {
    skill: "/claude-task-worker:create-issue-from-issue-number",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "update-issue": {
    skill: "/claude-task-worker:update-issue",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "exec-issue": {
    skill: "/claude-task-worker:exec-issue",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "fix-review-point": {
    skill: "/claude-task-worker:fix-review-point",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "triage-created-issue": {
    skill: "/claude-task-worker:triage-created-issue",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "triage-pr": {
    skill: "/claude-task-worker:triage-pr",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "resolve-conflict": {
    skill: "/claude-task-worker:resolve-pr-conflict",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "check-dependabot": {
    skill: "/claude-task-worker:check-dependabot",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "epic-issue": {
    skill: "/claude-task-worker:create-epic-pr",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 300,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "create-ui-design": {
    skill: "/claude-task-worker:create-ui-design",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "apply-ui-design": {
    skill: "/claude-task-worker:apply-ui-design",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 300,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  // 以下3つは定期ワーカー（createScheduledWorker）。実行間隔そのものは
  // SCHEDULE_INTERVAL_HOURS（24時間）と実行ログで決まり、pollingIntervalSeconds は
  // 「24時間経過したかを確認する頻度」でしかない。
  // model が opus なのは、成果物（CODING_GUIDELINES.md / .claude/requirements/ / DESIGN.md）が
  // 後続の全 Issue・全デザインの前提として読まれ、誤った一般化がそのまま下流の手戻りになるため。
  "update-coding-guidelines": {
    skill: "/claude-task-worker:update-coding-guidelines",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "update-requirement-rules": {
    skill: "/claude-task-worker:update-requirement-rules",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
  "update-design-md": {
    skill: "/claude-task-worker:update-design-md",
    model: "opus",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  },
};

// 定期ワーカー（createScheduledWorker）の名前。init が lastRun の初期値を書き出す際に使う。
export const SCHEDULED_WORKER_NAMES = [
  "update-coding-guidelines",
  "update-requirement-rules",
  "update-design-md",
] as const;

// クラウドセッションが最後の操作として付与し、ワーカーが完了検知に使うラベル
// （cc-cloud-done ラベルのポーリングでクラウドタスクの完了を判定する。#284）。
export const CLOUD_DONE_LABEL = "cc-cloud-done";

// --cloud 指定時に、そのワーカーをクラウド実行するか。
//
// かつては許可リスト（exec-issue / fix-review-point のみ）で絞っていた。他のワーカーは
// 完了検知（cc-cloud-done）の置き先が無い（定期ワーカー）・worktree ガードで中断する
// （create-ui-design）といった理由で成立しなかったため。前者は定期ワーカーの実行記録PR
// （ctw-last-run-<worker>）を検知対象に使うことで、後者は worktree ガードの免除指示を
// 同スキルへも渡すことで解消したので、リスト自体を撤去して全ワーカーを対象にする。
//
// 成立しうるかどうかと、実際に有用かどうかは別。`gh ... --json`（GraphQL）がクラウドの
// プロキシで 403 になる制約は残っているため、PR 詳細・CI 結果を大量に読むワーカー
// （triage-pr / check-dependabot / resolve-conflict）は GitHub MCP で代替できない操作に
// 当たると空振りしうる。`.pen` を編集するワーカー（create-ui-design / apply-ui-design）は
// クラウド VM 側に `pencil` CLI と認証（PEN_CLI_KEY）が要る。どのワーカーをクラウドへ
// 振るかは実行のたびに --cloud の付け外しで選ぶ。
export function isCloudWorker(_name: string): boolean {
  return hasCloudFlag();
}

// `claude auth status --json` が読めた場合は判定対象のフィールドを、
// 実行・パースに失敗した場合は「判定不能」を表す `unknown` を渡す。
export type CloudAuthStatus =
  | { kind: "ok"; loggedIn: boolean; authMethod: string; apiProvider: string; apiKeySource?: string }
  | { kind: "unknown" };

// claude.ai サインイン以外の構成（第三者プロバイダ・APIキー認証・未サインイン・カスタム
// エンドポイント）でのクラウドセッション作成失敗を、起動前に検出する。
// 旧 `docs/cloud-prerequisite-checks.md`（git 履歴） の判定式・文面案が正。判定不能（コマンド実行/パース
// 失敗）はエラーにしない — サインイン状態が読めないことを拒否根拠にしない安全側の倒し方。
export function checkCloudAuth(input: { status: CloudAuthStatus; baseUrl?: string }): string[] {
  if (input.status.kind === "unknown") return [];
  const { loggedIn, authMethod, apiProvider, apiKeySource } = input.status;
  const baseUrlSet = !!input.baseUrl;
  if (loggedIn && apiProvider === "firstParty" && authMethod === "claude.ai" && !apiKeySource && !baseUrlSet) {
    return [];
  }
  const prefix = `クラウド実行（--cloud フラグ）には claude.ai アカウントでのサインインが必要です。現在の認証構成: ${authMethod} / ${apiProvider}。`;
  if (apiProvider === "bedrock" || apiProvider === "vertex") {
    return [
      `${prefix} 第三者プロバイダ（Bedrock / Vertex）を使っている場合: クラウドセッションは Anthropic のインフラ上で動くため利用できません。CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX を解除するか、--cloud フラグを外してください。`,
    ];
  }
  if (apiKeySource || authMethod === "oauth_token") {
    return [
      `${prefix} API キー認証（ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN）の場合: API キーではクラウドセッションを作成できません。環境変数を解除して claude auth login でサインインしてください。`,
    ];
  }
  if (!loggedIn) {
    return [`${prefix} 未サインインの場合: claude auth login を実行してください。`];
  }
  if (baseUrlSet) {
    return [
      `${prefix} ANTHROPIC_BASE_URL を設定している場合: カスタムエンドポイント構成ではクラウドセッションを利用できません。解除してください。`,
    ];
  }
  return [`${prefix} claude auth status --json の出力からクラウド実行の前提条件を判定できませんでした。`];
}

// --cloud フラグ指定時に非対応の組み合わせが無いかを検査する。引数をオブジェクト1つに
// してあるのは、検査項目を追加してもシグネチャを壊さずフィールドを足せるようにするため。
// `auth` / `scriptAvailable` は cloud が false なら一切参照しない（既存リポジトリでの挙動を完全に不変に保つため）。
export function checkCloudConfig(input: {
  cloud: boolean;
  scriptAvailable?: boolean;
  auth?: { status: CloudAuthStatus; baseUrl?: string };
}): string[] {
  if (!input.cloud) return [];
  const errors: string[] = [];
  if (input.scriptAvailable === false) {
    errors.push(
      `--cloud requires a pty, provided via the "script" command (creating a new cloud session requires a TTY, which the worker's spawn does not have on its own). "script" is unavailable — either the platform is not darwin/linux, or "script" is not on PATH. Drop the --cloud flag, or run on darwin/linux where "script" is available.`,
    );
  }
  if (input.auth !== undefined) errors.push(...checkCloudAuth(input.auth));
  return errors;
}

export const DEFAULT_CONFIG: Config = {
  fixReviewPointCallbackCommentMessage: "",
  remoteEnvId: null,
  labels: [],
  workerFiles: [],
  uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG },
  lastRun: {},
  workers: {},
};

export const CONFIG_PATH = join(process.cwd(), "claude-task-worker.json");
// 個人ごとに違う設定（remoteEnvId など）を置くためのローカル上書きファイル。
// gitignore 対象で、同じキーは CONFIG_PATH より優先される。
export const LOCAL_CONFIG_PATH = join(process.cwd(), "claude-task-worker.local.json");

function defaultsFor(name: string): WorkerRuntimeConfig {
  return WORKER_DEFAULTS[name] ?? DEFAULT_WORKER_CONFIG;
}

// parseUiDesignEntry と同じくテスト可能にするため export する（純粋関数）。
export function parseWorkerEntry(name: string, val: unknown): WorkerRuntimeConfig | null {
  const base = defaultsFor(name);
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    console.warn(`[config] invalid workers.${name}: expected object, using defaults`);
    return null;
  }
  const entry = val as Record<string, unknown>;
  const result: WorkerRuntimeConfig = { ...base };
  if ("skill" in entry) {
    if (typeof entry.skill === "string" && entry.skill.length > 0) {
      result.skill = entry.skill;
    } else {
      console.warn(`[config] invalid workers.${name}.skill: ${String(entry.skill)}, using default ${base.skill}`);
    }
  }
  if ("model" in entry) {
    if (typeof entry.model === "string" && entry.model.length > 0) {
      result.model = entry.model;
    } else {
      console.warn(`[config] invalid workers.${name}.model: ${String(entry.model)}, using default ${base.model}`);
    }
  }
  // 他のフィールドと違い空文字を有効値として受け付ける（「advisor を使わない」の明示指定）。
  if ("advisorModel" in entry) {
    if (typeof entry.advisorModel === "string") {
      result.advisorModel = entry.advisorModel;
    } else {
      console.warn(
        `[config] invalid workers.${name}.advisorModel: ${String(entry.advisorModel)}, using default ${JSON.stringify(base.advisorModel)}`,
      );
    }
  }
  if ("effort" in entry) {
    if (typeof entry.effort === "string" && entry.effort.length > 0) {
      result.effort = entry.effort;
    } else {
      console.warn(`[config] invalid workers.${name}.effort: ${String(entry.effort)}, using default ${base.effort}`);
    }
  }
  if ("pollingIntervalSeconds" in entry) {
    const val = entry.pollingIntervalSeconds;
    if (typeof val === "number" && Number.isFinite(val) && val > 0) {
      result.pollingIntervalSeconds = val;
    } else {
      console.warn(
        `[config] invalid workers.${name}.pollingIntervalSeconds: ${String(val)}, using default ${base.pollingIntervalSeconds}`,
      );
    }
  }
  if ("cooldownSeconds" in entry) {
    const val = entry.cooldownSeconds;
    if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
      result.cooldownSeconds = val;
    } else {
      console.warn(
        `[config] invalid workers.${name}.cooldownSeconds: ${String(val)}, using default ${base.cooldownSeconds}`,
      );
    }
  }
  if ("maxConcurrentTasks" in entry) {
    const val = entry.maxConcurrentTasks;
    if (typeof val === "number" && Number.isInteger(val) && val > 0) {
      result.maxConcurrentTasks = val;
    } else {
      console.warn(
        `[config] invalid workers.${name}.maxConcurrentTasks: ${String(val)}, using default ${base.maxConcurrentTasks}`,
      );
    }
  }
  if ("enabled" in entry) {
    if (typeof entry.enabled === "boolean") {
      result.enabled = entry.enabled;
    } else {
      console.warn(`[config] invalid workers.${name}.enabled: ${String(entry.enabled)}, using default ${base.enabled}`);
    }
  }
  if ("cloud" in entry) {
    console.warn(
      `[config] workers.${name}.cloud is removed; cloud execution now opts in via the --cloud flag at runtime. This setting is ignored.`,
    );
  }
  return result;
}

// parseWorkerEntry と同じく「不正値は警告して既定値」で倒す。
export function parseUiDesignEntry(val: unknown): UiDesignConfig {
  const result: UiDesignConfig = { ...DEFAULT_UI_DESIGN_CONFIG };
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    console.warn(`[config] invalid uiDesign: expected object, using defaults`);
    return result;
  }
  const entry = val as Record<string, unknown>;
  if ("enabled" in entry) {
    if (typeof entry.enabled === "boolean") {
      result.enabled = entry.enabled;
    } else {
      console.warn(
        `[config] invalid uiDesign.enabled: ${String(entry.enabled)}, using default ${DEFAULT_UI_DESIGN_CONFIG.enabled}`,
      );
    }
  }
  if ("yolo" in entry) {
    if (typeof entry.yolo === "boolean") {
      result.yolo = entry.yolo;
    } else {
      console.warn(
        `[config] invalid uiDesign.yolo: ${String(entry.yolo)}, using default ${DEFAULT_UI_DESIGN_CONFIG.yolo}`,
      );
    }
  }
  if ("designDir" in entry) {
    const normalized =
      typeof entry.designDir === "string" && entry.designDir.length > 0 ? normalize(entry.designDir) : null;
    const isContained =
      normalized !== null && !isAbsolute(normalized) && normalized !== ".." && !normalized.startsWith(`..${SEP}`);
    if (isContained) {
      result.designDir = normalized;
    } else {
      console.warn(
        `[config] invalid uiDesign.designDir: ${String(entry.designDir)}, using default ${DEFAULT_UI_DESIGN_CONFIG.designDir}`,
      );
    }
  }
  return result;
}

// 値が文字列のエントリだけを残す（壊れた値で定期ワーカーが止まらないようにする）。
export function parseLastRunEntry(val: unknown): LastRunLog {
  if (typeof val !== "object" || val === null || Array.isArray(val)) {
    console.warn(`[config] invalid lastRun: expected object, ignoring`);
    return {};
  }
  const result: LastRunLog = {};
  for (const [name, at] of Object.entries(val as Record<string, unknown>)) {
    if (typeof at === "string" && !Number.isNaN(Date.parse(at))) {
      result[name] = at;
    } else {
      console.warn(`[config] invalid lastRun.${name}: ${String(at)}, ignoring`);
    }
  }
  return result;
}

export function parseLabelsEntry(val: unknown): string[] {
  if (!Array.isArray(val)) {
    console.warn(`[config] invalid labels: expected array of strings, ignoring`);
    return [];
  }
  const result: string[] = [];
  for (const item of val) {
    if (typeof item === "string" && item.trim().length > 0) {
      result.push(item.trim());
    } else {
      console.warn(`[config] invalid labels entry: ${String(item)}, ignoring`);
    }
  }
  return result;
}

export function parseWorkerFilesEntry(val: unknown): string[] {
  if (!Array.isArray(val)) {
    console.warn(`[config] invalid workerFiles: expected array of strings, ignoring`);
    return [];
  }
  const result: string[] = [];
  for (const item of val) {
    if (typeof item === "string" && item.trim().length > 0) {
      result.push(item.trim());
    } else {
      console.warn(`[config] invalid workerFiles entry: ${String(item)}, ignoring`);
    }
  }
  return result;
}

// 絶対パスはそのまま、~ は home 展開、それ以外は設定ファイルのあるディレクトリ基準で解決する。
export function resolveWorkerFilePath(entry: string, configDir: string, home: string): string {
  if (entry === "~") return home;
  if (entry.startsWith("~/")) return resolve(home, entry.slice(2));
  return resolve(configDir, entry);
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

// claude-task-worker.local.json を claude-task-worker.json へ重ねる。同じキーは local が勝つ。
// プレーンオブジェクト同士だけ再帰的にマージするので、`workers.<name>.model` のような深い
// キーだけをローカルで差し替えられる（配列・スカラー・型違いは local の値で丸ごと置き換え）。
// appendArrays は --inherit-config の土台へ重ねるとき用。配列は置き換えず土台の後ろへ追記する
// （重複は除く）。リポジトリ側の `labels` / `workerFiles` が共通パックの値を消さず足し込みになり、
// 旧 init が書いていた空配列も土台をそのまま残す。
export function mergeConfigRaw(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  appendArrays = false,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, val] of Object.entries(local)) {
    const current = result[key];
    if (appendArrays && Array.isArray(current) && Array.isArray(val)) {
      result[key] = [...current, ...val.filter((v) => !current.includes(v))];
    } else {
      result[key] = isPlainObject(current) && isPlainObject(val) ? mergeConfigRaw(current, val, appendArrays) : val;
    }
  }
  return result;
}

// 設定ファイルを生JSONとして読む。不在なら空オブジェクト（＝上書きなし）を返す。
function readRawConfig(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  if (!isPlainObject(parsed)) {
    console.warn(`[config] invalid ${path}: expected object, ignoring`);
    return {};
  }
  return parsed;
}

// --inherit-config のファイル内の相対パスを、そのファイルの所在ディレクトリ基準で解決し直す。
// 重ねる前にファイル単位で行うのは、定義元ファイルの基準を保つため（マージ後は出所が分からない）。
// cwd 直下の2ファイルは所在ディレクトリ＝cwd なので対象外（既存の解決結果をそのまま保つ）。
// - uiDesign.designDir: 下流の契約（リポジトリルート相対）に合わせ、絶対化した後 repoRoot 相対へ戻す。
//   リポジトリ外を指せば parseUiDesignEntry の既存検証が警告して既定値へ倒す
// - workerFiles: 絶対パスへ置き換える（~ 始まりはそのまま。resolveWorkerFilePath が home 展開する）
export function resolveInheritedRelativePaths(
  raw: Record<string, unknown>,
  configDir: string,
  repoRoot: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...raw };
  const uiDesign = raw["uiDesign"];
  if (isPlainObject(uiDesign) && typeof uiDesign.designDir === "string" && uiDesign.designDir.length > 0) {
    result["uiDesign"] = {
      ...uiDesign,
      designDir: relative(repoRoot, resolve(configDir, uiDesign.designDir)) || ".",
    };
  }
  const workerFiles = raw["workerFiles"];
  if (Array.isArray(workerFiles)) {
    result["workerFiles"] = workerFiles.map((entry) =>
      typeof entry === "string" && entry.trim().length > 0 && !entry.trim().startsWith("~")
        ? resolve(configDir, entry.trim())
        : entry,
    );
  }
  return result;
}

// 土台ファイルの指定元。エラーメッセージで「どこで指定したか」を出し分けるために持つ。
export const INHERIT_CONFIG_KEY = "inheritConfig";
export interface InheritConfigSource {
  path: string;
  origin: typeof INHERIT_CONFIG_FLAG | typeof INHERIT_CONFIG_KEY;
}
let cachedInheritConfigSource: InheritConfigSource | null | undefined;

// 土台ファイルの解決。--inherit-config（フラグ）が cwd の claude-task-worker(.local).json の
// inheritConfig キーより勝つ。キーの相対パスは書いたファイルの所在（＝cwd）基準、~ は home 展開。
// フラグと同じくプロセス内で1回だけ解決する。
export function resolveInheritConfigSource(): InheritConfigSource | null {
  if (cachedInheritConfigSource !== undefined) return cachedInheritConfigSource;
  const flagPath = getInheritConfigPath();
  if (flagPath) return (cachedInheritConfigSource = { path: flagPath, origin: INHERIT_CONFIG_FLAG });
  const raw = readCwdRawConfig();
  if (!(INHERIT_CONFIG_KEY in raw)) return (cachedInheritConfigSource = null);
  const val = raw[INHERIT_CONFIG_KEY];
  if (typeof val !== "string" || val.trim().length === 0) {
    console.warn(`[config] invalid ${INHERIT_CONFIG_KEY}: ${String(val)}, ignoring`);
    return (cachedInheritConfigSource = null);
  }
  cachedInheritConfigSource = {
    path: resolveWorkerFilePath(val.trim(), process.cwd(), homedir()),
    origin: INHERIT_CONFIG_KEY,
  };
  return cachedInheritConfigSource;
}

// テスト用。キャッシュを未解決へ戻す。
export function resetInheritConfigSourceCache(): void {
  cachedInheritConfigSource = undefined;
}

// 指定された土台ファイルの不在は、サイレントに既定へ倒さず拒否する（cwd 直下ファイルの不在とは違う）。
// 土台側の inheritConfig は解釈しない（継承は1段のみ）。
function readInheritedRawConfig(source: InheritConfigSource, repoRoot: string): Record<string, unknown> {
  if (!existsSync(source.path)) {
    throw new Error(`${source.origin} ${source.path} does not exist`);
  }
  const { [INHERIT_CONFIG_KEY]: _ignored, ...raw } = readRawConfig(source.path);
  return resolveInheritedRelativePaths(raw, dirname(source.path), repoRoot);
}

// cwd 直下の claude-task-worker.json に claude-task-worker.local.json を重ねた生JSON。
function readCwdRawConfig(): Record<string, unknown> {
  return mergeConfigRaw(readRawConfig(CONFIG_PATH), readRawConfig(LOCAL_CONFIG_PATH));
}

// 重ね順（後が勝つ）: --inherit-config（または inheritConfig キー） < cwd の claude-task-worker.json < cwd の claude-task-worker.local.json。
export function loadConfig(): Config {
  const inheritSource = resolveInheritConfigSource();
  const cwdRaw = readCwdRawConfig();
  const raw = inheritSource
    ? mergeConfigRaw(readInheritedRawConfig(inheritSource, process.cwd()), cwdRaw, true)
    : cwdRaw;

  const result: Config = {
    ...DEFAULT_CONFIG,
    labels: [],
    workerFiles: [],
    uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG },
    lastRun: {},
    workers: {},
  };

  if ("remoteEnvId" in raw) {
    const val = raw["remoteEnvId"];
    if (val === null) {
      result.remoteEnvId = null;
    } else if (typeof val === "string" && val.trim().length > 0) {
      result.remoteEnvId = val.trim();
    } else {
      console.warn(`[config] invalid remoteEnvId: ${String(val)}, using default null`);
    }
  }

  if ("labels" in raw) {
    result.labels = parseLabelsEntry(raw["labels"]);
  }

  if ("workerFiles" in raw) {
    result.workerFiles = parseWorkerFilesEntry(raw["workerFiles"]);
  }

  if ("lastRun" in raw) {
    result.lastRun = parseLastRunEntry(raw["lastRun"]);
  }

  if ("fixReviewPointCallbackCommentMessage" in raw) {
    const val = raw["fixReviewPointCallbackCommentMessage"];
    if (typeof val === "string") {
      result.fixReviewPointCallbackCommentMessage = val;
    }
  }

  if ("uiDesign" in raw) {
    result.uiDesign = parseUiDesignEntry(raw["uiDesign"]);
  }

  if ("workers" in raw) {
    const workers = raw["workers"];
    if (typeof workers !== "object" || workers === null || Array.isArray(workers)) {
      console.warn(`[config] invalid workers: expected object, ignoring`);
    } else {
      for (const [name, val] of Object.entries(workers as Record<string, unknown>)) {
        const parsed = parseWorkerEntry(name, val);
        if (parsed) result.workers[name] = parsed;
      }
    }
  }

  return result;
}

export function getWorkerConfig(workerName: string): WorkerRuntimeConfig {
  const config = loadConfig();
  return config.workers[workerName] ?? { ...defaultsFor(workerName) };
}

// workers.<name>.enabled。設定ファイルが読めない場合は既定（有効）へ倒し、変更前と同じ起動集合を保つ。
export function isWorkerEnabled(workerName: string): boolean {
  try {
    return getWorkerConfig(workerName).enabled;
  } catch (err) {
    console.warn(`[config] failed to load workers.${workerName}.enabled, treating it as enabled: ${err}`);
    return true;
  }
}

// all / yolo の起動候補を有効/無効に振り分ける。順序は names のまま保つ。
export function partitionEnabledWorkers(
  names: readonly string[],
  isEnabled: (name: string) => boolean,
): { enabled: string[]; disabled: string[] } {
  const enabled: string[] = [];
  const disabled: string[] = [];
  for (const name of names) (isEnabled(name) ? enabled : disabled).push(name);
  return { enabled, disabled };
}

// 個別起動で無効なワーカーを指定したときのエラーメッセージ。
export function disabledWorkerMessage(workerName: string): string {
  return `${workerName} is disabled by workers.${workerName}.enabled: false in claude-task-worker.json (or claude-task-worker.local.json). To run it, set workers.${workerName}.enabled to true or remove the key.`;
}

// 定期ワーカーの最終実行時刻（epoch ms）。記録が無い・読めない場合は undefined＝実行可。
// 書き込み先（writeLastRun / publishLastRunPr）と揃えるため、--inherit-config に関わらず cwd 直下から読む。
export function getLastRunAt(workerName: string): number | undefined {
  let at: string | undefined;
  try {
    const raw = readCwdRawConfig();
    at = "lastRun" in raw ? parseLastRunEntry(raw["lastRun"])[workerName] : undefined;
  } catch (err) {
    console.warn(`[config] failed to load lastRun, treating ${workerName} as never run: ${err}`);
    return undefined;
  }
  if (at === undefined) return undefined;
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// 最終実行時刻を <repoRoot>/claude-task-worker.json の lastRun へ書き込む。
// 呼び出し側は worktree のルートを渡す。書き込んだ差分はスキルの commit-push が
// その日の成果物（CODING_GUIDELINES.md 等）と同じコミット・同じPRに含める。
// 既存の設定は保持する（生JSONを読み直してマージするため、パース時に落ちる不正キーも壊さない）。
export function writeLastRun(repoRoot: string, workerName: string, at: Date = new Date()): void {
  const path = join(repoRoot, "claude-task-worker.json");
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    // 設定ファイルが無いリポジトリでは lastRun だけを持つファイルを新規作成する。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[config] failed to read ${path}, rewriting it with lastRun only: ${err}`);
    }
  }
  const current = typeof raw["lastRun"] === "object" && raw["lastRun"] !== null ? raw["lastRun"] : {};
  raw["lastRun"] = { ...(current as Record<string, unknown>), [workerName]: at.toISOString() };
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf-8");
}

// 設定ファイル不在・破損でもワークフローが勝手に有効化されないよう、
// 読み込みに失敗した場合は既定（無効）へ倒す。
// クラウド実行時に --environment へ渡す環境ID。設定ファイル不在・破損では null
// （＝フラグを渡さず claude 側の既定解決に任せる）へ倒す。
export function getRemoteEnvId(): string | null {
  try {
    return loadConfig().remoteEnvId;
  } catch (err) {
    console.warn(`[config] failed to load remoteEnvId, not passing --environment: ${err}`);
    return null;
  }
}

export function getUiDesignConfig(): UiDesignConfig {
  try {
    return loadConfig().uiDesign;
  } catch (err) {
    console.warn(`[config] failed to load uiDesign config, using defaults: ${err}`);
    return { ...DEFAULT_UI_DESIGN_CONFIG };
  }
}
