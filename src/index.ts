#!/usr/bin/env node

import { PRESET_WORKERS } from "./workers/registry";
import type { WorkerDefinition, WorkerStartOptions } from "./workers/worker-definition";
import {
  shutdown,
  waitForAllProcesses,
  setShuttingDown,
  isShuttingDown,
  ensureRenderInterval,
} from "./process-manager";
import { captureConsole } from "./table";
import { removeStaleWorktrees } from "./worktree";
import { init, applyLabels } from "./commands/init";
import { install } from "./commands/install";
import { cloudSetup } from "./commands/cloud-setup";
import { update } from "./commands/update";
import { version, notifyIfOutdated } from "./commands/version";
import { buildTokenLimitText, send } from "./slack";
import {
  hasProjectFilter,
  parseProjectFilters,
  assertProjectCompatibleCommand,
  buildForwardedCommand,
  hasCloudFlag,
  assertCloudCompatibleCommand,
} from "./dispatch-args";
import { loadUserConfig, resolveTargetProjects, UserConfigError, getRunMode } from "./user-config";
import { loadCustomWorkers, type CustomWorker } from "./custom-workers";
import {
  CONFIG_PATH,
  loadConfig,
  resolveWorkerFilePath,
  checkCloudConfig,
  CLOUD_DONE_LABEL,
  disabledWorkerMessage,
  isWorkerEnabled,
  partitionEnabledWorkers,
  type CloudAuthStatus,
} from "./config";
import { buildScriptCommand } from "./claude-args";
import { createLabel } from "./gh";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// dispatcher.ts / herdr.ts はワーカー起動には不要な --project 専用モジュールで、
// dispatcher.ts のトップレベル await が即時実行されるのを避けるため、
// 静的importではなく --project 使用時にのみ実行される動的importで遅延読込する。
// esbuild の単一ファイルバンドルにインライン化されるよう、指定子は .ts 拡張子付きのリテラル文字列にする。
import type * as DispatcherModule from "./dispatcher";
import type { SessionRegistry, MonitorHandle } from "./dispatcher";
import type * as HerdrModule from "./herdr";

const NON_WORKER_COMMANDS = ["init", "apply-labels", "install", "update", "cloud-setup", "usage"];

// workerFiles のロードはワーカーを起動し得るコマンドだけで行う（init / install 等と --project では不要）。
async function loadCustomWorkersOrExit(): Promise<CustomWorker[]> {
  let files: string[];
  try {
    files = loadConfig().workerFiles.map((f) => resolveWorkerFilePath(f, dirname(CONFIG_PATH), homedir()));
  } catch (err) {
    console.warn(`[config] failed to load workerFiles, ignoring: ${err}`);
    return [];
  }
  const { workers, errors } = await loadCustomWorkers(
    files,
    PRESET_WORKERS.map((e) => e.definition.name),
  );
  if (errors.length > 0) {
    for (const message of errors) console.error(`[worker] ${message}`);
    process.exit(1);
  }
  return workers;
}

function printUsage(): void {
  console.log(`Usage: claude-task-worker <command> [--project <name>] [--epic <issue-number>] [--label <label-name>]

Commands:
  init [--force]  Create required GitHub labels and config file (use --force to overwrite existing files)
  apply-labels      Create the preset labels and the custom labels declared in claude-task-worker.json (labels)
  install           Add the claude-task-worker marketplace, install the plugin, and install/update the CLI
  update            Update the claude-task-worker plugin/marketplace and the CLI itself
  cloud-setup [--force]  Prepare a cloud session VM (writes permission mode, output style, and language into ~/.claude/settings.json). Meant for a cloud environment setup script
  usage             Notify current usage to Slack
  list-workers      List preset and custom workers (name, kind, enabled, source)
  version           Print the installed claude-task-worker CLI version (aliases: --version, -v)

Workers:
${PRESET_WORKERS.map((e) => `  ${e.definition.name.padEnd(17)}${e.definition.name.length > 17 ? "  " : " "}${e.description}`).join("\n")}
${customWorkers.map((c) => `  ${c.definition.name.padEnd(17)}${c.definition.name.length > 17 ? "  " : " "}Custom worker (${c.source})`).join("\n")}${customWorkers.length > 0 ? "\n" : ""}  all               Poll all workers except ${PRESET_WORKERS.filter(
    (e) => !e.inAll,
  )
    .map((e) => e.definition.name)
    .join(", ")}
  yolo              Poll all workers including ${PRESET_WORKERS.filter((e) => !e.inAll)
    .map((e) => e.definition.name)
    .join(", ")}

Options:
  --project <name>  Dispatch to project(s) via herdr instead of running the worker locally. Accepts a project name, a project group name, or "all". Repeatable.
  --debug           Post each task's final report as a comment on the target Issue/PR (off by default; the report is only sent to Slack). Works in both local and --cloud runs.
  --epic <number>   Limit issue-based workers to sub-issues of the specified epic issue. Repeatable: any matching parent (OR).
  --label <name>    Limit issue-based workers to issues that also carry the specified label. Repeatable: all must be present (AND).

Example:
  claude-task-worker init
  claude-task-worker exec-issue
  claude-task-worker all --epic 100
  claude-task-worker all --epic 100 --epic 200
  claude-task-worker all --label priority-high
  claude-task-worker all --label priority-high --label needs-design
  claude-task-worker yolo --epic 100 --epic 200 --label priority-high
  claude-task-worker all --project all
  claude-task-worker all --project web
  claude-task-worker exec-issue --project my-app --epic 100`);
}

const workerType = process.argv[2];

if (workerType === "version" || workerType === "--version" || workerType === "-v") {
  version();
  await notifyIfOutdated();
  process.exit(process.exitCode ?? 0);
}

// 最新版の案内。ワーカーは captureConsole() 後にログテーブルへ流れるよう、
// 待たずに投げっぱなしにする（起動を数秒遅らせないため）。
void notifyIfOutdated();

const customWorkers: CustomWorker[] =
  workerType && !NON_WORKER_COMMANDS.includes(workerType) && !hasProjectFilter() ? await loadCustomWorkersOrExit() : [];

const WORKERS: Record<string, WorkerDefinition> = Object.fromEntries(
  [...PRESET_WORKERS.map((e) => e.definition), ...customWorkers.map((c) => c.definition)].map((d) => [d.name, d]),
);

if (!workerType) {
  printUsage();
  process.exit(1);
}

if (
  workerType !== "all" &&
  workerType !== "yolo" &&
  workerType !== "init" &&
  workerType !== "apply-labels" &&
  workerType !== "install" &&
  workerType !== "update" &&
  workerType !== "cloud-setup" &&
  workerType !== "usage" &&
  workerType !== "list-workers" &&
  !WORKERS[workerType]
) {
  console.error(`Unknown command: ${workerType}`);
  printUsage();
  process.exit(1);
}

if (hasProjectFilter()) {
  assertProjectCompatibleCommand(workerType);
}

if (hasCloudFlag()) {
  assertCloudCompatibleCommand(workerType);
}

function collectFlagValues(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== flag) continue;
    const raw = process.argv[i + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(`${flag} requires a value`);
      process.exit(1);
    }
    values.push(raw);
  }
  return values;
}

function parseEpicFilters(): number[] {
  const raws = collectFlagValues("--epic");
  return raws.map((raw) => {
    const num = Number(raw);
    if (!Number.isFinite(num) || !Number.isInteger(num) || num <= 0) {
      console.error(`--epic requires a positive integer issue number, got: ${raw}`);
      process.exit(1);
    }
    return num;
  });
}

function parseLabelFilters(): string[] {
  return collectFlagValues("--label");
}

process.on("unhandledRejection", (err) => {
  console.error("[worker] unhandled rejection:", err);
  process.exit(1);
});

// mode: "herdr" のワーカーは全タスクを herdr のタブで実行するため、herdr が使えなければ
// 1タスクも実行できない。ラベルだけ書き換えて失敗し続ける事故を避けるため、起動時に
// 疎通を確認して落とす（"default" へのサイレントフォールバックはしない）。
async function assertRunModeAvailable(): Promise<void> {
  if (getRunMode() !== "herdr") return;
  // herdr.ts は herdr モード（と --project）でのみ必要なため動的importで遅延読込する。
  const herdr = (await import("./herdr")) as typeof HerdrModule;
  try {
    await herdr.checkHerdrAvailable();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] config.json has mode "herdr" but herdr is unavailable: ${message}`);
    process.exit(1);
  }
  console.log("[worker] run mode: herdr (each task runs as a TUI session in its own herdr tab)");
}

// `claude auth status --json` を実行してパースする。未ログイン時は exit 1 だが stdout に
// JSON が出る（`docs/cloud-prerequisite-checks.md` M3）ため、終了コードでは判定しない。
// 実行・パースに失敗した場合は「判定不能」として扱い、起動を止める根拠にしない。
async function readCloudAuthStatus(): Promise<CloudAuthStatus> {
  let stdout: string;
  try {
    const result = await execFileAsync("claude", ["auth", "status", "--json"]);
    stdout = result.stdout;
  } catch (err) {
    const maybeStdout = (err as { stdout?: string }).stdout;
    if (!maybeStdout) return { kind: "unknown" };
    stdout = maybeStdout;
  }
  try {
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    return {
      kind: "ok",
      loggedIn: parsed.loggedIn === true,
      authMethod: String(parsed.authMethod ?? ""),
      apiProvider: String(parsed.apiProvider ?? ""),
      apiKeySource: typeof parsed.apiKeySource === "string" ? parsed.apiKeySource : undefined,
    };
  } catch {
    return { kind: "unknown" };
  }
}

// --cloud に必要な pty は `script(1)` で割り当てるため、platform 対応（buildScriptCommand が
// throw するかどうかで判定。darwin/linux の列挙をここへ二重定義しない）と PATH 上の存在の
// 両方を確認する。`which` の ENOENT・非0終了はいずれも「利用不可」へ倒す。
async function resolveScriptAvailable(): Promise<boolean> {
  try {
    buildScriptCommand("true", []);
  } catch {
    return false;
  }
  try {
    await execFileAsync("which", ["script"]);
    return true;
  } catch {
    return false;
  }
}

// --cloud フラグ指定時の構成が非対応（script(1) によるpty割り当て不可、claude.ai 未サインイン）だと
// タスク起動が壊れた形で失敗し続けるため、サイレントにローカル実行へフォールバックせず起動時に落とす。
// サインイン状態・script可否の I/O は --cloud が指定されていなければ行わない
// （--cloud を書かない既存の使い方での挙動を完全に不変に保つため）。
async function assertCloudAvailable(): Promise<void> {
  const cloud = hasCloudFlag();
  // init を再実行していない既存リポジトリでも cc-cloud-done ラベルを保証する
  // （無いとポーラー・クラウド双方が失敗し続け、タスクが4時間タイムアウトを繰り返す）。
  // createLabel は失敗を握りつぶすため、作成できなかった場合は起動時エラーにする
  // （素通りさせると、ラベル不在のまま全クラウドタスクがタイムアウトを繰り返す）。
  // color は init.ts の LABELS の CLOUD_DONE_LABEL エントリと同じ値。
  const labelReady = cloud ? await createLabel(CLOUD_DONE_LABEL, "33cfff", true) : true;
  const status = cloud ? await readCloudAuthStatus() : undefined;
  const scriptAvailable = cloud ? await resolveScriptAvailable() : undefined;
  const errors = checkCloudConfig({
    cloud,
    scriptAvailable,
    auth: status ? { status, baseUrl: process.env.ANTHROPIC_BASE_URL } : undefined,
  });
  if (!labelReady) {
    errors.push(
      `${CLOUD_DONE_LABEL} ラベルを作成できませんでした。gh の認証・権限を確認するか、claude-task-worker init を実行してください。`,
    );
  }
  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`[worker] ${message}`);
    }
    process.exit(1);
  }
  if (cloud) {
    console.log("[worker] cloud execution enabled (--cloud); every worker started by this process runs in the cloud");
  }
}

// all / yolo の候補から workers.<name>.enabled: false を除いて起動する。除外があれば1行で示す。
function startEnabledWorkers(names: readonly string[], filters: WorkerStartOptions): Promise<void>[] {
  const { enabled, disabled } = partitionEnabledWorkers(names, isWorkerEnabled);
  if (disabled.length > 0) console.log(`[worker] skipped disabled workers: ${disabled.join(", ")}`);
  return enabled.map((name) => WORKERS[name].start(filters));
}

// カスタムワーカーは all / yolo の両方に含める。
function candidateNames(include: (e: (typeof PRESET_WORKERS)[number]) => boolean): string[] {
  return [
    ...PRESET_WORKERS.filter(include).map((e) => e.definition.name),
    ...customWorkers.map((c) => c.definition.name),
  ];
}

function printWorkerRow(name: string, type: string, source: string): void {
  console.log(`${name.padEnd(28)}${type.padEnd(8)}${isWorkerEnabled(name) ? "enabled " : "disabled"}  ${source}`);
}

// 起動前の前提チェックをまとめて実行する。
async function assertRunPrerequisites(): Promise<void> {
  // 毎秒のテーブル再描画（画面クリア）でエラーログが一瞬しか見えないため、
  // console 出力をステータステーブル下のログテーブルへ流し込む。
  captureConsole();
  ensureRenderInterval();
  await assertRunModeAvailable();
  await assertCloudAvailable();
}

if (!hasProjectFilter()) {
  process.on("SIGTERM", async () => {
    if (isShuttingDown()) return;
    setShuttingDown();
    console.log(
      "\n[worker] Stopping new tasks. Waiting for in-flight tasks to finish... (Send SIGTERM again to force kill)",
    );
    await waitForAllProcesses();
    process.exit(0);
  });

  let forceKilling = false;
  process.on("SIGINT", async () => {
    if (isShuttingDown()) {
      if (forceKilling) return;
      forceKilling = true;
      console.log("\n[worker] Force killing running tasks... (cleaning up labels and worktrees)");
      shutdown("SIGKILL");
      const cleanupTimeout = new Promise<void>((resolve) => setTimeout(resolve, 60_000).unref());
      await Promise.race([waitForAllProcesses(), cleanupTimeout]);
      process.exit(1);
    }
    setShuttingDown();
    console.log(
      "\n[worker] Stopping new tasks. Waiting for in-flight tasks to finish... (Press Ctrl-C again to force kill)",
    );
    await waitForAllProcesses();
    process.exit(0);
  });
}

if (hasProjectFilter()) {
  (async () => {
    // sessions/monitorHandle は起動処理完了前に SIGTERM/SIGINT を受けても
    // shutdownDispatcher に安全に渡せるよう、起動前の空値で先に宣言する。
    let sessions: SessionRegistry = new Map();
    let monitorHandle: MonitorHandle | undefined;

    // node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
    // .ts 拡張子付きのリテラル文字列で動的importする（dispatcher.ts と同様）。
    // allowImportingTsExtensions により tsc --noEmit もこの指定子を許容する。
    // dispatcher.ts / herdr.ts は --project 使用時にのみ必要なモジュールで、この分岐内で読込む。
    const herdr = (await import("./herdr")) as typeof HerdrModule;
    const dispatcher = (await import("./dispatcher")) as typeof DispatcherModule;

    // セッションテーブルの再描画で消えないよう、console 出力をログテーブルへ流す。
    captureConsole();

    // 起動処理（runDispatcher/monitorSessions）が完了する前にシグナルを受けても
    // タブ・セッションが放置されないよう、起動処理より前にハンドラを登録する。
    // 1回目のシグナルで graceful shutdown、2回目のシグナルで force-kill する2段階ハンドラ。
    // 非 --project ワーカー側の forceKilling ガードと同等の保護を --project 側にも提供する。
    // isShuttingDown() で「シャットダウン中か」を判定し、下の await monitorHandle.done 後の
    // 自然終了 exit と shutdownDispatcher 側の exit が二重に発火しないようにする。
    const shutdownController = dispatcher.createDispatcherShutdownHandler((options) =>
      dispatcher.shutdownDispatcher(sessions, monitorHandle, options),
    );
    process.on("SIGTERM", shutdownController.handle);
    process.on("SIGINT", shutdownController.handle);

    try {
      const config = loadUserConfig();
      const projects = resolveTargetProjects(parseProjectFilters(), config);
      const forwardedCommand = buildForwardedCommand(process.argv.slice(2));
      sessions = await dispatcher.runDispatcher(projects, forwardedCommand);
      if (sessions.size === 0) {
        console.log("[dispatcher] no sessions were dispatched, exiting");
        process.exit(0);
      }
      monitorHandle = dispatcher.monitorSessions(sessions, herdr);
      // 稼働セッションが残る限りここで待機し、ステータステーブルを表示し続ける。
      // done は全セッション終了(finish)またはシャットダウン(stop)で解決する。
      await monitorHandle.done;
      // シャットダウン経由の解決時は shutdownDispatcher 側が graceful に終了して exit するため、
      // ここでの exit はセッションが自然に全終了したケースに限定する。
      if (!shutdownController.isShuttingDown()) {
        console.log("[dispatcher] all sessions finished, exiting");
        process.exit(0);
      }
    } catch (err) {
      if (err instanceof UserConfigError || err instanceof herdr.HerdrUnavailableError) {
        console.error(`[dispatcher] ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  })();
} else if (workerType === "init") {
  const initArgs = process.argv.slice(3);
  const force = initArgs.includes("--force");
  init({ force });
} else if (workerType === "apply-labels") {
  applyLabels();
} else if (workerType === "install") {
  (async () => {
    await install();
  })();
} else if (workerType === "update") {
  (async () => {
    await update();
  })();
} else if (workerType === "cloud-setup") {
  (async () => {
    await cloudSetup({ force: process.argv.slice(3).includes("--force") });
  })();
} else if (workerType === "usage") {
  (async () => {
    // buildTokenLimitText は取得した利用状況で RunCat 用スナップショットも更新する
    const text = await buildTokenLimitText();
    if (!text) {
      console.error("Failed to fetch usage info");
      process.exit(1);
    }
    console.log(text.trim());
    await send({ text: `📊 Usage${text}` });
  })();
} else if (workerType === "list-workers") {
  for (const e of PRESET_WORKERS) printWorkerRow(e.definition.name, "preset", "preset");
  for (const c of customWorkers) printWorkerRow(c.definition.name, "custom", c.source);
} else if (workerType === "all") {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  (async () => {
    await assertRunPrerequisites();
    // 前回の異常終了で残った worktree・ブランチをワーカー起動前に回収する
    await removeStaleWorktrees();
    await Promise.all(
      startEnabledWorkers(
        candidateNames((e) => e.inAll),
        { epicFilters, labelFilters },
      ),
    );
  })();
} else if (workerType === "yolo") {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  (async () => {
    await assertRunPrerequisites();
    await removeStaleWorktrees();
    await Promise.all(
      startEnabledWorkers(
        candidateNames((e) => e.inYolo),
        { epicFilters, labelFilters },
      ),
    );
  })();
} else {
  const epicFilters = parseEpicFilters();
  const labelFilters = parseLabelFilters();
  (async () => {
    // assertRunPrerequisites() の console キャプチャより前に判定する（ログテーブルでは有効化方法が切り詰められるため）。
    if (!isWorkerEnabled(workerType)) {
      console.error(`[worker] ${disabledWorkerMessage(workerType)}`);
      process.exit(1);
    }
    await assertRunPrerequisites();
    await removeStaleWorktrees();
    await WORKERS[workerType].start({ epicFilters, labelFilters });
  })();
}
