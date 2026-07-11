import type * as HerdrModule from "./herdr";
import type { ResolvedProject } from "./projects-config";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求する一方、
// tsc --noEmit（npm run build）は allowImportingTsExtensions が無効なため
// 静的import文中の .ts 拡張子指定子を許容せず失敗する。両立のため、
// TSの静的解析対象にならない動的文字列結合でパスを構築している。
async function loadHerdr(): Promise<typeof HerdrModule> {
  const herdrModulePath = ["./herdr", "ts"].join(".");
  return (await import(herdrModulePath)) as typeof HerdrModule;
}

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
