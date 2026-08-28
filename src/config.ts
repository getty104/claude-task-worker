import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize, sep as SEP } from "node:path";

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
  // ワーカー単位のクラウド実行オプトイン。既定は必ず false（クラウド実行はワーカーの
  // 明示的なオプトインが無い限り有効化しない）。
  cloud: boolean;
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
  cloud: false,
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
    cloud: false,
  },
  "create-issue": {
    skill: "/claude-task-worker:create-issue-from-issue-number",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "update-issue": {
    skill: "/claude-task-worker:update-issue",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "exec-issue": {
    skill: "/claude-task-worker:exec-issue",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "fix-review-point": {
    skill: "/claude-task-worker:fix-review-point",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "triage-created-issue": {
    skill: "/claude-task-worker:triage-created-issue",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "triage-pr": {
    skill: "/claude-task-worker:triage-pr",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "resolve-conflict": {
    skill: "/claude-task-worker:resolve-pr-conflict",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "check-dependabot": {
    skill: "/claude-task-worker:check-dependabot",
    model: "sonnet",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "epic-issue": {
    skill: "/claude-task-worker:create-epic-pr",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 300,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "create-ui-design": {
    skill: "/claude-task-worker:create-ui-design",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 60,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "apply-ui-design": {
    skill: "/claude-task-worker:apply-ui-design",
    model: "sonnet",
    advisorModel: "",
    effort: "medium",
    pollingIntervalSeconds: 300,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
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
    cloud: false,
  },
  "update-requirement-rules": {
    skill: "/claude-task-worker:update-requirement-rules",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
  "update-design-md": {
    skill: "/claude-task-worker:update-design-md",
    model: "opus",
    advisorModel: "",
    effort: "high",
    pollingIntervalSeconds: 3600,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    cloud: false,
  },
};

// 定期ワーカー（createScheduledWorker）の名前。init が lastRun の初期値を書き出す際に使う。
export const SCHEDULED_WORKER_NAMES = [
  "update-coding-guidelines",
  "update-requirement-rules",
  "update-design-md",
] as const;

// cloud: true を許可しないワーカー。resolve-conflict は .pen コンフリクト解消に pencil CLI と
// そのログイン認証がクラウド環境で使える保証が無いため、create-ui-design / apply-ui-design は
// クラウド環境からの force-push の可否が未検証のため、いずれも拒否する。
export const CLOUD_DENIED_WORKERS = ["resolve-conflict", "create-ui-design", "apply-ui-design"] as const;

// cloud: true のワーカー構成に非対応の組み合わせが無いかを検査する。
// 引数をオブジェクト1つにしてあるのは、後続Issue（プラグイン宣言の静的検査等）で
// 検査項目を追加してもシグネチャを壊さずフィールドを足せるようにするため。
export function checkCloudConfig(input: { workers: Record<string, WorkerRuntimeConfig>; mode: string }): string[] {
  const errors: string[] = [];
  for (const [name, worker] of Object.entries(input.workers)) {
    if (!worker.cloud) continue;
    if (input.mode !== "herdr") {
      errors.push(
        `worker "${name}" has cloud: true but mode is "${input.mode}" (creating a new cloud session requires a TTY, which "default" mode's spawn does not have). Set mode to "herdr" in config.json, or remove cloud from worker "${name}".`,
      );
    }
    if ((CLOUD_DENIED_WORKERS as readonly string[]).includes(name)) {
      errors.push(
        `worker "${name}" has cloud: true but this worker does not support cloud execution. Remove cloud from worker "${name}" in config.json.`,
      );
    }
  }
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
    if (typeof entry.cloud === "boolean") {
      result.cloud = entry.cloud;
    } else {
      console.warn(`[config] invalid workers.${name}.cloud: ${String(entry.cloud)}, using default ${base.cloud}`);
    }
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
