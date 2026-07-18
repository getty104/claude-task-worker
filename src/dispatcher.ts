import type * as HerdrModule from "./herdr";
import type * as TableModule from "./table";
import type { ResolvedProject } from "./projects-config";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。動的importのままにすることで、
// --project 使用時にのみ必要なトップレベル処理（loadTable の呼び出し等）の実行タイミングを保つ。
// allowImportingTsExtensions により tsc --noEmit もこの指定子を許容し、
// リテラル文字列のため esbuild も単一ファイルバンドルにインライン化できる。
async function loadHerdr(): Promise<typeof HerdrModule> {
  return (await import("./herdr.ts")) as typeof HerdrModule;
}

async function loadTable(): Promise<typeof TableModule> {
  return (await import("./table.ts")) as typeof TableModule;
}

const { getDisplayWidth, truncateToWidth, padToWidth } = await loadTable();

export const POLL_INTERVAL_MS = 7 * 1000;
export const SHUTDOWN_TIMEOUT_MS = 10 * 60 * 1000;

// tabCreate 直後のペインはシェル（.zshrc / anyenv 等のプロファイル）を初期化中で、
// プロンプト描画（zle の起動）より前に送ったテキストは端末にエコーされるだけで
// シェルには読まれず捨てられる。その結果コマンドが実行されないままプロンプトが出て、
// ワーカーが起動せず pollOnce が「セッション終了」と誤判定してタブを閉じてしまう。
// これを防ぐため、ペインに最初の出力（プロンプト）が現れるまで待ってから送信する。
export const PANE_READY_TIMEOUT_MS = 30 * 1000;
export const PANE_READY_POLL_INTERVAL_MS = 200;

// 送信後にワーカープロセスがフォアグラウンドに現れるまでの待機上限。
// プロンプト待ちをすり抜けて入力が捨てられた場合も検知して再送できるようにする。
export const WORKER_STARTUP_TIMEOUT_MS = 30 * 1000;
export const WORKER_STARTUP_POLL_INTERVAL_MS = 500;
export const SEND_MAX_ATTEMPTS = 3;

// ディスパッチャーが作成するherdrタブのラベルに付与するプレフィックス。
// claude-task-worker が起動したタブを他のタブと区別できるようにする。
export const TAB_LABEL_PREFIX = "ctw:";

export function tabLabelFor(projectName: string): string {
  return `${TAB_LABEL_PREFIX}${projectName}`;
}

export type WorkerSessionStatus = "running";

export interface WorkerSession {
  name: string;
  tabId: string;
  paneId: string;
  startedAt: Date;
  status: WorkerSessionStatus;
}

export type SessionRegistry = Map<string, WorkerSession>;

export interface DispatchTimingOptions {
  paneReadyTimeoutMs?: number;
  paneReadyPollIntervalMs?: number;
  workerStartupTimeoutMs?: number;
  workerStartupPollIntervalMs?: number;
  sendMaxAttempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// pollOnce（生存監視）と waitForWorkerStartup（起動確認）で同じ判定を使い、
// 「起動したと判定した条件」と「生存していると判定する条件」を一致させる。
export function isWorkerProcess(process: { cmdline?: string }): boolean {
  return process.cmdline?.includes("claude-task-worker") ?? false;
}

// フォアグラウンドがまだコマンド未実行のシェルであることを判定する。ログインシェルは
// argv[0]/cmdline の先頭に "-" が付く（例: "-zsh"）ため、素のシェル名とあわせて判定する。
const SHELL_NAME_PATTERN = /^-?(zsh|bash|sh)$/;
export function isShellProcess(process: { name?: string; cmdline?: string }): boolean {
  return SHELL_NAME_PATTERN.test(process.name ?? "") || SHELL_NAME_PATTERN.test(process.cmdline ?? "");
}

// ペインに最初の出力（シェルのプロンプト）が現れるまで待つ。プロンプトの文字列は
// ユーザーのシェル設定に依存するため内容は判定せず、「何か描画されたか」だけを見る。
export async function waitForPaneReady(
  paneId: string,
  herdr: typeof HerdrModule,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? PANE_READY_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? PANE_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = await herdr.paneRead(paneId, { source: "visible" });
    if (content.trim() !== "") return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

// 送信したコマンドが実際に実行され、ワーカープロセスが立ち上がったことを確認する。
// フォアグラウンドがシェルのままなら未実行とみなしタイムアウトまで待つ（"shell"）が、
// シェルでもワーカーでもない無関係なプロセス（ユーザーの別コマンド等）を検出した場合は、
// それが実行中のコマンドの標準入力である可能性があるため、待たずに区別して返す（"other"）。
export type WorkerStartupResult = "started" | "shell" | "other";

export async function waitForWorkerStartup(
  paneId: string,
  herdr: typeof HerdrModule,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<WorkerStartupResult> {
  const timeoutMs = options?.timeoutMs ?? WORKER_STARTUP_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? WORKER_STARTUP_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { foregroundProcesses } = await herdr.paneProcessInfo(paneId);
    if (foregroundProcesses.some(isWorkerProcess)) return "started";
    if (foregroundProcesses.length > 0 && !foregroundProcesses.every(isShellProcess)) return "other";
    if (Date.now() >= deadline) return "shell";
    await sleep(pollIntervalMs);
  }
}

// プロンプト待ち → 送信 → 起動確認を1セットとし、起動を確認できなければ再送する。
// 再送はフォアグラウンドがシェルのまま（ワーカー未起動）と確認できた場合に限る。
// シェルでもワーカーでもない無関係なプロセスがフォアグラウンドにいる場合は、
// それが稼働中の別コマンドの標準入力である可能性があるため再送せず打ち切る。
export async function startWorkerInPane(
  paneId: string,
  forwardedCommand: string,
  herdr: typeof HerdrModule,
  options?: DispatchTimingOptions,
): Promise<boolean> {
  const maxAttempts = options?.sendMaxAttempts ?? SEND_MAX_ATTEMPTS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ready = await waitForPaneReady(paneId, herdr, {
      timeoutMs: options?.paneReadyTimeoutMs,
      pollIntervalMs: options?.paneReadyPollIntervalMs,
    });
    if (!ready) {
      console.warn(`[dispatcher] pane ${paneId} produced no prompt before the timeout, sending the command anyway`);
    }
    await herdr.paneSendText(paneId, forwardedCommand);
    await herdr.paneSendKeys(paneId, "enter");
    const result = await waitForWorkerStartup(paneId, herdr, {
      timeoutMs: options?.workerStartupTimeoutMs,
      pollIntervalMs: options?.workerStartupPollIntervalMs,
    });
    if (result === "started") return true;
    if (result === "other") {
      console.warn(
        `[dispatcher] pane ${paneId} foreground is neither the shell nor the worker, giving up without resending`,
      );
      return false;
    }
    if (attempt < maxAttempts) {
      console.warn(
        `[dispatcher] worker did not start in pane ${paneId} (attempt ${attempt}/${maxAttempts}), resending the command`,
      );
    }
  }
  return false;
}

export async function runDispatcher(
  projects: ResolvedProject[],
  forwardedCommand: string,
  timing?: DispatchTimingOptions,
): Promise<SessionRegistry> {
  const herdr = await loadHerdr();
  const { checkHerdrAvailable, tabCreate, tabClose, tabList } = herdr;

  try {
    await checkHerdrAvailable();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dispatcher] ${message}`);
    throw error;
  }

  const existingTabs = await tabList();
  const existingLabels = new Set(existingTabs.map((tab) => tab.label));

  const sessions: SessionRegistry = new Map();

  for (const project of projects) {
    if (existingLabels.has(tabLabelFor(project.name))) {
      console.warn(`[dispatcher] project "${project.name}" already has a running tab, skipping`);
      continue;
    }

    let createdTabId: string | undefined;
    try {
      const { paneId, tabId } = await tabCreate({ label: tabLabelFor(project.name), cwd: project.path });
      createdTabId = tabId;
      sessions.set(project.name, {
        name: project.name,
        tabId,
        paneId,
        startedAt: new Date(),
        status: "running",
      });
      const started = await startWorkerInPane(paneId, forwardedCommand, herdr, timing);
      if (!started) {
        throw new Error(
          `worker did not start in pane ${paneId} after ${timing?.sendMaxAttempts ?? SEND_MAX_ATTEMPTS} attempt(s)`,
        );
      }
    } catch (error) {
      console.error(`[dispatcher] failed to dispatch project "${project.name}": ${error}`);
      sessions.delete(project.name);
      if (createdTabId !== undefined) {
        try {
          await tabClose(createdTabId);
        } catch (closeError) {
          console.error(`[dispatcher] failed to close dangling tab for project "${project.name}": ${closeError}`);
        }
      }
    }
  }

  return sessions;
}

export interface MonitorHandle {
  stop(): void;
  done: Promise<void>;
}

export async function removeSession(
  sessions: SessionRegistry,
  name: string,
  { closeTab }: { closeTab: boolean },
): Promise<void> {
  const session = sessions.get(name);
  if (!session) return;
  sessions.delete(name);
  if (closeTab) {
    const { tabClose } = await loadHerdr();
    await tabClose(session.tabId);
  }
}

export async function pollOnce(sessions: SessionRegistry, herdr: typeof HerdrModule): Promise<void> {
  for (const [name, session] of [...sessions.entries()]) {
    try {
      const { foregroundProcesses } = await herdr.paneProcessInfo(session.paneId);
      if (!foregroundProcesses.some(isWorkerProcess)) {
        await removeSession(sessions, name, { closeTab: true });
      }
    } catch (error) {
      if (error instanceof herdr.HerdrError && error.code === "pane_not_found") {
        await removeSession(sessions, name, { closeTab: false });
        continue;
      }
      console.error(`[dispatcher] failed to poll session "${name}": ${error}`);
    }
  }
}

export function formatUptime(start: Date, now: Date): string {
  const totalSeconds = Math.max(0, Math.floor((now.getTime() - start.getTime()) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function renderSessionTable(sessions: SessionRegistry): void {
  const entries = [...sessions.values()];
  if (entries.length === 0) return;

  const maxProjectWidth = 20;

  const rows = entries.map((session) => ({
    project:
      getDisplayWidth(session.name) > maxProjectWidth ? truncateToWidth(session.name, maxProjectWidth) : session.name,
    tab: session.tabId,
    pane: session.paneId,
    status: session.status,
    uptime: formatUptime(session.startedAt, new Date()),
  }));

  const colWidths = {
    project: Math.max(7, ...rows.map((r) => getDisplayWidth(r.project))),
    tab: Math.max(3, ...rows.map((r) => r.tab.length)),
    pane: Math.max(4, ...rows.map((r) => r.pane.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    uptime: Math.max(6, ...rows.map((r) => r.uptime.length)),
  };

  const cols = [colWidths.project, colWidths.tab, colWidths.pane, colWidths.status, colWidths.uptime];
  const line = (l: string, m: string, r: string, f: string) => `${l}${cols.map((w) => f.repeat(w + 2)).join(m)}${r}`;

  const row = (project: string, tab: string, pane: string, status: string, uptime: string) =>
    `│ ${padToWidth(project, colWidths.project)} │ ${tab.padEnd(colWidths.tab)} │ ${pane.padEnd(colWidths.pane)} │ ${status.padEnd(colWidths.status)} │ ${uptime.padEnd(colWidths.uptime)} │`;

  const lines: string[] = [];
  lines.push(line("┌", "┬", "┐", "─"));
  lines.push(row("Project", "Tab", "Pane", "Status", "Uptime"));
  lines.push(line("├", "┼", "┤", "─"));
  for (const r of rows) {
    lines.push(row(r.project, r.tab, r.pane, r.status, r.uptime));
  }
  lines.push(line("└", "┴", "┘", "─"));

  console.clear();
  console.log(lines.join("\n"));
}

export function monitorSessions(
  sessions: SessionRegistry,
  herdr: typeof HerdrModule,
  options?: { pollIntervalMs?: number; renderIntervalMs?: number },
): MonitorHandle {
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
  const renderIntervalMs = options?.renderIntervalMs ?? 1000;

  let resolveDone: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let settled = false;

  const finish = () => {
    if (settled) return;
    settled = true;
    clearInterval(pollInterval);
    clearInterval(renderInterval);
    resolveDone();
  };

  // ポーリング／描画インターバルは unref しない。稼働セッションが残る限りイベントループを
  // 生かし続けることで、--project ディスパッチ後もステータステーブルを表示し続け、
  // 全セッションが終了する(finish)までプロセスが即終了しないようにする。
  // 停止時は finish()/stop() が両インターバルを clearInterval するため、ループは放置されない。
  const pollInterval = setInterval(() => {
    void pollOnce(sessions, herdr).then(() => {
      if (sessions.size === 0) {
        finish();
      }
    });
  }, pollIntervalMs);

  const renderInterval = setInterval(() => {
    renderSessionTable(sessions);
  }, renderIntervalMs);

  return {
    stop: finish,
    done,
  };
}

// process-manager.ts の SIGINT 2段階目 force-kill 待機(60s, process-manager.ts:150)を
// 上回るよう、再送後は余裕を持たせた90秒の短縮タイムアウトで再待機する。
export const SHUTDOWN_RETRY_TIMEOUT_MS = 90 * 1000;

export interface ShutdownOptions {
  herdr?: typeof HerdrModule;
  pollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  retryTimeoutMs?: number;
  tabCloseTimeoutMs?: number;
  forceKill?: boolean;
}

// herdr のキー名は `+` 区切りのキーコンボ文字列（例: `ctrl+c`）。
// `ctrl-c` のようなハイフン区切りは `invalid_key` エラーになり送信されない。
const CTRL_C_KEY = "ctrl+c";

async function sendCtrlCToAllSessions(sessions: SessionRegistry, herdr: typeof HerdrModule): Promise<void> {
  await Promise.all(
    [...sessions.values()].map(async (session) => {
      try {
        await herdr.paneSendKeys(session.paneId, CTRL_C_KEY);
      } catch (error) {
        console.error(`[dispatcher] failed to send ctrl-c to session "${session.name}": ${error}`);
      }
    }),
  );
}

async function waitUntilSessionsEmpty(
  sessions: SessionRegistry,
  herdr: typeof HerdrModule,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (sessions.size > 0) {
    await pollOnce(sessions, herdr);
    if (sessions.size === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return true;
}

async function closeRemainingTabs(
  sessions: SessionRegistry,
  herdr: typeof HerdrModule,
  timeoutMs: number,
): Promise<boolean> {
  const results = await Promise.all(
    [...sessions.values()].map(async (session) => {
      try {
        await Promise.race([
          herdr.tabClose(session.tabId),
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("tabClose timed out")), timeoutMs).unref();
          }),
        ]);
        return true;
      } catch (error) {
        console.error(
          `[dispatcher] failed to close tab "${session.tabId}" for session "${session.name}" during shutdown: ${error}`,
        );
        return false;
      }
    }),
  );
  return results.every((closed) => closed);
}

// index.ts の isShuttingDown/forceKilling（ワーカープロセス側のCtrl-C 2段階ガード）とは
// 別系統。dispatcher自身のshutdown多重実行のみを防ぐための専用ガード。
// in-flightのPromiseそのものをガードに使うことで、同時呼び出しは同じ結果を共有し、
// 完了後はガードを解放して（実運用ではprocess.exit(0)でプロセスごと終わるため無関係だが）
// テストなど同一プロセス内での再実行にも対応できるようにしている。
let shutdownPromise: Promise<void> | undefined;

async function forceKillAllSessions(
  sessions: SessionRegistry,
  herdr: typeof HerdrModule,
  tabCloseTimeoutMs: number,
): Promise<void> {
  console.log(`[dispatcher] force-kill requested, sending ctrl-c and closing ${sessions.size} session(s) immediately`);
  await sendCtrlCToAllSessions(sessions, herdr);
  await closeRemainingTabs(sessions, herdr, tabCloseTimeoutMs);
  process.exit(1);
}

export async function shutdownDispatcher(
  sessions: SessionRegistry,
  monitorHandle?: MonitorHandle,
  options?: ShutdownOptions,
): Promise<void> {
  if (shutdownPromise) {
    if (options?.forceKill) {
      const herdr = options.herdr ?? (await loadHerdr());
      const tabCloseTimeoutMs = options.tabCloseTimeoutMs ?? 5000;
      await forceKillAllSessions(sessions, herdr, tabCloseTimeoutMs);
      return;
    }
    console.log("[dispatcher] shutdown already in progress, ignoring duplicate request");
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    const herdr = options?.herdr ?? (await loadHerdr());
    const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS;
    const shutdownTimeoutMs = options?.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
    const retryTimeoutMs = options?.retryTimeoutMs ?? SHUTDOWN_RETRY_TIMEOUT_MS;
    const tabCloseTimeoutMs = options?.tabCloseTimeoutMs ?? 5000;

    if (monitorHandle) {
      monitorHandle.stop();
      await monitorHandle.done;
    }

    console.log(`[dispatcher] shutting down, sending ctrl-c to ${sessions.size} session(s)`);
    await sendCtrlCToAllSessions(sessions, herdr);

    let finishedInTime = await waitUntilSessionsEmpty(sessions, herdr, pollIntervalMs, shutdownTimeoutMs);

    if (!finishedInTime) {
      console.log(
        `[dispatcher] ${sessions.size} session(s) still alive after ${shutdownTimeoutMs}ms, resending ctrl-c once`,
      );
      await sendCtrlCToAllSessions(sessions, herdr);
      finishedInTime = await waitUntilSessionsEmpty(sessions, herdr, pollIntervalMs, retryTimeoutMs);
    }

    const allTabsClosed = await closeRemainingTabs(sessions, herdr, tabCloseTimeoutMs);

    process.exit(finishedInTime && allTabsClosed ? 0 : 1);
  })();

  try {
    await shutdownPromise;
  } finally {
    shutdownPromise = undefined;
  }
}

export interface DispatcherShutdownController {
  handle: () => Promise<void>;
  isShuttingDown: () => boolean;
}

// SIGINT/SIGTERM を process.on（.once ではない）で受ける --project ディスパッチャー向けの
// 2段階シャットダウンハンドラを生成する。1回目のシグナルで graceful shutdown を開始し、
// 2回目のシグナルで shutdownDispatcher の { forceKill: true } パスに入りセッションを強制終了する。
// 非 --project ワーカー側（index.ts の forceKilling ガード）と同等の保護を --project 側にも提供する。
// shutdown コールバックには sessions/monitorHandle を束ねた shutdownDispatcher 呼び出しを渡す。
// isShuttingDown() は「シャットダウン中か」を返し、呼び出し側が自然終了 exit と
// shutdownDispatcher 側の exit の二重発火を避ける判定に使う。
export function createDispatcherShutdownHandler(
  shutdown: (options?: ShutdownOptions) => Promise<void>,
): DispatcherShutdownController {
  let shuttingDown = false;
  let forceKilling = false;

  // handle は process.on("SIGINT"/"SIGTERM", handle) の await されないリスナーとして登録される。
  // shutdown（= shutdownDispatcher）は正常時は自身で process.exit するため解決しないが、
  // 途中で reject するとリスナーが未処理rejectionになりグローバルハンドラ任せの終了になる。
  // 意図した終了ログを残しつつ確実にプロセスを終わらせるため、両パスとも reject を捕捉して exit(1) する。
  const handle = async () => {
    if (shuttingDown) {
      if (forceKilling) return;
      forceKilling = true;
      console.log("\n[dispatcher] Force killing sessions immediately...");
      try {
        await shutdown({ forceKill: true });
      } catch (error) {
        console.error(`[dispatcher] force-kill shutdown failed: ${error}`);
        process.exit(1);
      }
      return;
    }
    shuttingDown = true;
    console.log("\n[dispatcher] Stopping sessions. Waiting for them to finish... (Press Ctrl-C again to force kill)");
    try {
      await shutdown();
    } catch (error) {
      console.error(`[dispatcher] shutdown failed: ${error}`);
      process.exit(1);
    }
  };

  return { handle, isShuttingDown: () => shuttingDown };
}
