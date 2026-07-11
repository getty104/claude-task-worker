import type * as HerdrModule from "./herdr";
import type * as TableModule from "./table";
import type { ResolvedProject } from "./projects-config";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する一方、
// tsc --noEmit（npm run build）は allowImportingTsExtensions が無効なため
// 静的import文中の .ts 拡張子指定子を許容せず失敗する。両立のため、
// TSの静的解析対象にならない動的文字列結合でパスを構築している。
async function loadHerdr(): Promise<typeof HerdrModule> {
  const herdrModulePath = ["./herdr", "ts"].join(".");
  return (await import(herdrModulePath)) as typeof HerdrModule;
}

async function loadTable(): Promise<typeof TableModule> {
  const tableModulePath = ["./table", "ts"].join(".");
  return (await import(tableModulePath)) as typeof TableModule;
}

const { getDisplayWidth, truncateToWidth, padToWidth } = await loadTable();

export const POLL_INTERVAL_MS = 7 * 1000;
export const SHUTDOWN_TIMEOUT_MS = 10 * 60 * 1000;

export type WorkerSessionStatus = "running";

export interface WorkerSession {
  name: string;
  tabId: string;
  paneId: string;
  startedAt: Date;
  status: WorkerSessionStatus;
}

export type SessionRegistry = Map<string, WorkerSession>;

export async function runDispatcher(projects: ResolvedProject[], forwardedCommand: string): Promise<SessionRegistry> {
  const { checkHerdrAvailable, tabCreate, tabClose, tabList, paneSendText, paneSendKeys } = await loadHerdr();

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
    if (existingLabels.has(project.name)) {
      console.warn(`[dispatcher] project "${project.name}" already has a running tab, skipping`);
      continue;
    }

    let createdTabId: string | undefined;
    try {
      const { paneId, tabId } = await tabCreate({ label: project.name, cwd: project.path });
      createdTabId = tabId;
      await paneSendText(paneId, forwardedCommand);
      await paneSendKeys(paneId, "enter");
      sessions.set(project.name, {
        name: project.name,
        tabId,
        paneId,
        startedAt: new Date(),
        status: "running",
      });
    } catch (error) {
      console.error(`[dispatcher] failed to dispatch project "${project.name}": ${error}`);
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
      const isAlive = foregroundProcesses.some((process) => process.cmdline.includes("claude-task-worker"));
      if (!isAlive) {
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

  const pollInterval = setInterval(() => {
    void pollOnce(sessions, herdr).then(() => {
      if (sessions.size === 0) {
        finish();
      }
    });
  }, pollIntervalMs);
  pollInterval.unref();

  const renderInterval = setInterval(() => {
    renderSessionTable(sessions);
  }, renderIntervalMs);
  renderInterval.unref();

  return {
    stop: finish,
    done,
  };
}
