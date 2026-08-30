import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep as SEP } from "node:path";
import { hasCloudFlag } from "./dispatch-args";

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
  uiDesign: UiDesignConfig;
  lastRun: LastRunLog;
  workers: Record<string, WorkerRuntimeConfig>;
}

export const DEFAULT_UI_DESIGN_CONFIG: UiDesignConfig = {
  enabled: false,
  designDir: "designs",
  yolo: false,
};

export const DEFAULT_WORKER_CONFIG: WorkerRuntimeConfig = {
  skill: "",
  model: "opus",
  advisorModel: "",
  effort: "high",
  pollingIntervalSeconds: 60,
  cooldownSeconds: 0,
  maxConcurrentTasks: 1,
};

export const WORKER_DEFAULTS: Record<string, WorkerRuntimeConfig> = {
  "answer-issue-questions": {
    skill: "/claude-task-worker:answer-issue-questions",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "create-issue": {
    skill: "/claude-task-worker:create-issue-from-issue-number",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "update-issue": {
    skill: "/claude-task-worker:update-issue",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "exec-issue": {
    skill: "/claude-task-worker:exec-issue",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "fix-review-point": {
    skill: "/claude-task-worker:fix-review-point",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "triage-created-issue": {
    skill: "/claude-task-worker:triage-created-issue",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "triage-pr": {
    skill: "/claude-task-worker:triage-pr",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "resolve-conflict": {
    skill: "/claude-task-worker:resolve-pr-conflict",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "check-dependabot": {
    skill: "/claude-task-worker:check-dependabot",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "epic-issue": {
    skill: "/claude-task-worker:create-epic-pr",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 300,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "create-ui-design": {
    skill: "/claude-task-worker:create-ui-design",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "apply-ui-design": {
    skill: "/claude-task-worker:apply-ui-design",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 300,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
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
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "update-requirement-rules": {
    skill: "/claude-task-worker:update-requirement-rules",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
  },
  "update-design-md": {
    skill: "/claude-task-worker:update-design-md",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
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

// --cloud 指定時にクラウド実行するワーカー（許可リスト）。ここに無いワーカーは --cloud を
// 付けてもローカル実行のまま残す（起動時エラーにはしない。`all` / `yolo` から一括起動される
// ため、拒否すると --cloud がそれらのコマンドで使えなくなる）。
//
// 拒否リストではなく許可リストにしてあるのは、クラウド実行が「成果ゼロでも完了扱いになり、
// トリガーラベルの再付与で再起動され続ける」失敗の仕方をするため。`triage-pr` /
// `fix-review-point` 系はワーカー側（pr-worker.ts）が完了時に `cc-triage-scope` を再付与し、
// cooldown も無いので、クラウドで空振りするワーカーを既定で通すと 60 秒ごとにクラウド
// セッションを焼き続ける。新しいワーカーが黙ってクラウドへ流れないよう、既定はローカルにする。
//
// 現在の許可は `exec-issue` / `fix-review-point` の2つ。どちらも 2026-08-29 の smoke test で
// エンドツーエンドの成立を確認した経路（`docs/cloud-graphql-proxy-limits.md` の適合性表）で、
// 実装本体という最も重い作業をクラウドへ逃がせる。他のワーカーは GraphQL ゲートで判断材料を
// 取得できない・`pencil` CLI が無い・完了検知の置き先が無いなどの理由で成立しない。
export const CLOUD_ALLOWED_WORKERS = ["exec-issue", "fix-review-point"] as const;

// --cloud 指定時に、そのワーカーをクラウド実行するか。許可リスト外のワーカーは
// 起動時エラーにせずローカル実行のまま残す。
export function isCloudWorker(name: string): boolean {
  return hasCloudFlag() && (CLOUD_ALLOWED_WORKERS as readonly string[]).includes(name);
}

// `claude auth status --json` が読めた場合は判定対象のフィールドを、
// 実行・パースに失敗した場合は「判定不能」を表す `unknown` を渡す。
export type CloudAuthStatus =
  | { kind: "ok"; loggedIn: boolean; authMethod: string; apiProvider: string; apiKeySource?: string }
  | { kind: "unknown" };

// claude.ai サインイン以外の構成（第三者プロバイダ・APIキー認証・未サインイン・カスタム
// エンドポイント）でのクラウドセッション作成失敗を、起動前に検出する。
// `docs/cloud-prerequisite-checks.md` の判定式・文面案が正。判定不能（コマンド実行/パース
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
// `auth` は cloud が false なら一切参照しない（既存リポジトリでの挙動を完全に不変に保つため）。
export function checkCloudConfig(input: {
  cloud: boolean;
  mode: string;
  auth?: { status: CloudAuthStatus; baseUrl?: string };
}): string[] {
  if (!input.cloud) return [];
  const errors: string[] = [];
  if (input.mode !== "herdr") {
    errors.push(
      `--cloud requires mode "herdr" but mode is "${input.mode}" (creating a new cloud session requires a TTY, which "default" mode's spawn does not have). Set mode to "herdr" in config.json, or drop the --cloud flag.`,
    );
  }
  if (input.auth !== undefined) errors.push(...checkCloudAuth(input.auth));
  return errors;
}

export const DEFAULT_CONFIG: Config = {
  fixReviewPointCallbackCommentMessage: "",
  uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG },
  lastRun: {},
  workers: {},
};

export const CONFIG_PATH = join(process.cwd(), "claude-task-worker.json");

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

export function loadConfig(): Config {
  const configPath = CONFIG_PATH;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG, uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG }, lastRun: {}, workers: {} };
    }
    throw err;
  }

  const result: Config = { ...DEFAULT_CONFIG, uiDesign: { ...DEFAULT_UI_DESIGN_CONFIG }, lastRun: {}, workers: {} };

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

// 定期ワーカーの最終実行時刻（epoch ms）。記録が無い・読めない場合は undefined＝実行可。
export function getLastRunAt(workerName: string): number | undefined {
  let at: string | undefined;
  try {
    at = loadConfig().lastRun[workerName];
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
export function getUiDesignConfig(): UiDesignConfig {
  try {
    return loadConfig().uiDesign;
  } catch (err) {
    console.warn(`[config] failed to load uiDesign config, using defaults: ${err}`);
    return { ...DEFAULT_UI_DESIGN_CONFIG };
  }
}
