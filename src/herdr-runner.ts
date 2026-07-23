import type * as HerdrModule from "./herdr";
import type { AgentStatus } from "./herdr";
import type { TaskResult } from "./task-result";
// node --experimental-strip-types は実ファイル解決を要求するため、値のimportは
// .ts 拡張子付きにする（herdr-runner.ts はテストから直接 .ts で読み込まれる）。
import { stripHeadroomBanner } from "./task-result.ts";
import { readFinalReport } from "./transcript.ts";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする（dispatcher.ts と同様）。
// herdr.ts は herdr モードでのみ必要なため、静的importにはしない。
async function loadHerdr(): Promise<typeof HerdrModule> {
  return (await import("./herdr.ts")) as typeof HerdrModule;
}

// agent ステータスのポーリング間隔。TUI セッションは完了後もプロセスが生き続けるため、
// プロセスの exit ではなくこのポーリングでタスク完了を検知する。
export const AGENT_POLL_INTERVAL_MS = 3 * 1000;

// 完了時にペインから回収する行数。claude -p の stdout の代わりに Slack 通知・
// 空振り検知へ流用する。
export const PANE_OUTPUT_LINES = 300;

// herdr モードのタスクが作るタブのラベル。
export function taskTabLabel(projectName: string, number: number): string {
  return `ctw:${projectName}:#${number}`;
}

// 完了判定の状態。TUI は起動直後 unknown / idle を経てから working になるため、
// 「一度 working を観測してから idle になった」ことを完了条件にする。
// idle 単独を完了とみなすと、起動直後のプロンプト表示前に完了と誤判定してしまう。
// （`done` は起動直後には現れないため、この seenWorking ガードの対象外。後述）
export interface CompletionTracker {
  seenWorking: boolean;
  warnedBlocked: boolean;
}

export function createCompletionTracker(): CompletionTracker {
  return { seenWorking: false, warnedBlocked: false };
}

export type TrackerDecision = "running" | "completed" | "blocked-first-seen";

// ステータス1件を観測して次の状態と判定を返す。純粋関数としてテストできるよう、
// ログ出力や待機はここでは行わない。
export function observeAgentStatus(
  tracker: CompletionTracker,
  status: AgentStatus,
): { tracker: CompletionTracker; decision: TrackerDecision } {
  if (status === "working") {
    return { tracker: { ...tracker, seenWorking: true }, decision: "running" };
  }
  // `done` は「作業を終えたが、まだ誰もそのペインを見ていない」未確認完了の状態。
  // ワーカーのタスクタブは誰も開かないため、herdr は idle ではなく done を返し続ける
  // （ユーザーがタブを開くと idle へ落ちる）。done を知らないと unknown 扱いになり、
  // 「タブを見るまでタスクが完了しない」バグになる。
  //
  // idle と違って seenWorking を要求しない。done は working からの遷移でしか現れず
  // 起動直後に誤検知する余地が無い一方、ポーリング間隔（既定3秒）より短いタスクでは
  // working を一度も観測できずに done へ到達しうるためで、ガードを付けると
  // その取りこぼしがそのまま無限待ちになる。
  if (status === "done") {
    return { tracker, decision: "completed" };
  }
  if (status === "blocked") {
    // blocked（入力待ち）は人が herdr のペインを開いて解除する前提。自動失敗にはせず、
    // 初回だけ警告を出せるよう decision で区別する。
    if (tracker.warnedBlocked) return { tracker, decision: "running" };
    return { tracker: { ...tracker, warnedBlocked: true }, decision: "blocked-first-seen" };
  }
  if (status === "idle" && tracker.seenWorking) {
    return { tracker, decision: "completed" };
  }
  return { tracker, decision: "running" };
}

/**
 * herdr モードのタスク結果を組み立てる。`claude -p` と違い exit code が無いため、
 * 「出力が空か」だけで成否を判定する。プリアンブル失敗などでモデルが
 * 起動しないまま idle になったセッションを空振りとして失敗扱いにする狙いは
 * task-result.ts の buildTaskResult と同じ。
 *
 * 通知に載せる本文は **transcript から取った最終レポート（`report`）を最優先**する。
 * ペインの端末内容は「会話ログ + 空行パディング + 入力ボックス + ステータスバー」で、
 * Slack 通知が切り出す末尾1000文字はほぼ TUI の装飾しか含まないため、通知本文として
 * 使い物にならない（transcript.ts 参照）。transcript を引けなかった場合のみ
 * 従来どおりペイン内容へフォールバックする。
 *
 * `headroom` が有効な場合、ペインには claude の手前に headroom の起動バナーが残りうる。
 * バナーだけのペインを「出力あり」と誤認しないよう、default モードと同じく空判定の前に
 * 取り除く（通知に載せる output は元のペイン内容のままにする）。
 */
export function buildHerdrTaskResult(
  paneOutput: string,
  options?: { headroom?: boolean; report?: string },
): TaskResult {
  const report = options?.report?.trim() ?? "";
  if (report !== "") {
    return { status: "completed", output: report };
  }
  const meaningful = options?.headroom ? stripHeadroomBanner(paneOutput) : paneOutput;
  if (meaningful.trim() === "") {
    return {
      status: "failed",
      output:
        "[worker] the claude session became idle but its pane produced no output " +
        "(session aborted before the model ran; e.g. a skill preamble command failed)",
    };
  }
  return { status: "completed", output: paneOutput };
}

export interface HerdrTask {
  paneId: string;
  tabId: string;
}

// タスクタブのルートペインにシェルプロンプトが現れるまで待つ上限。
export const PANE_READY_TIMEOUT_MS = 30 * 1000;
export const PANE_READY_POLL_INTERVAL_MS = 200;
// 起動コマンド送信後、claude が herdr の自動エージェント検出で捕捉されるまで待つ上限。
// headroom 経由の起動はプロキシ立ち上げ分だけ遅くなるため広めに取る。
export const AGENT_DETECT_TIMEOUT_MS = 120 * 1000;
export const AGENT_DETECT_POLL_INTERVAL_MS = 500;

export interface StartTiming {
  paneReadyTimeoutMs?: number;
  paneReadyPollIntervalMs?: number;
  agentDetectTimeoutMs?: number;
  agentDetectPollIntervalMs?: number;
}

/**
 * herdr のタスク専用タブで claude を TUI 起動する（1タスク=1タブ）。
 *
 * `--no-focus` でタスク専用タブを作り、その**ルートペイン（シェル）へ起動コマンドを
 * 流し込んで** claude を起動する（`launchAgentInPane`）。新しい herdr（0.7 系）の
 * `agent start` は `--kind` の正規実行ファイルしか起動できず `headroom wrap claude ...`
 * を起動できない（かつ `--workspace`/`--tab` が廃止され `unknown option: --workspace` で
 * 失敗する）ため、agent start は使わない。claude は herdr の自動エージェント検出で
 * そのまま捕捉されるため、`agentGet(paneId)` で状態・セッションIDを取得できる。
 *
 * ルートペインがそのまま claude のペインになるので、旧実装のような余剰シェルペインの
 * `paneClose` は不要。
 *
 * 手順:
 * 1. tabCreate（`--no-focus`）でユーザーの見ているタブに割り込まないタスク専用タブを作る
 * 2. waitForPaneReady でシェルプロンプトの描画を待つ（未描画で送ると入力が捨てられる）
 * 3. launchAgentInPane で起動コマンドを送る
 * 4. waitForAgentDetected で claude が agent として検出されるまで待つ（旧 agent start が
 *    担っていた「起動確認」の代替）。検出できなければ失敗として確定し、タブを閉じる
 *    （検出前の agent_not_found を waitForHerdrTask が握ると無限待ちになるため）
 */
export async function startHerdrTask({
  label,
  cwd,
  argv,
  env,
  workspaceId,
  herdr,
  timing,
}: {
  label: string;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  workspaceId?: string;
  herdr?: typeof HerdrModule;
  timing?: StartTiming;
}): Promise<HerdrTask> {
  const mod = herdr ?? (await loadHerdr());
  const { tabId, paneId } = await mod.tabCreate({ label, cwd, workspaceId, env });

  try {
    // tabCreate 直後のペインはシェル初期化中でプロンプト未表示のことがある。その状態で
    // 起動コマンドを送ると入力が捨てられて claude が起動しない（dispatcher の
    // waitForPaneReady と同じレース）。描画が現れるまで待ってから送る。
    const ready = await waitForPaneReady(paneId, mod, {
      timeoutMs: timing?.paneReadyTimeoutMs,
      pollIntervalMs: timing?.paneReadyPollIntervalMs,
    });
    if (!ready) {
      console.warn(`[herdr-runner] pane ${paneId} produced no prompt before the timeout, launching anyway`);
    }
    await mod.launchAgentInPane(paneId, argv);
    const detected = await waitForAgentDetected(paneId, mod, {
      timeoutMs: timing?.agentDetectTimeoutMs,
      pollIntervalMs: timing?.agentDetectPollIntervalMs,
    });
    if (!detected) {
      throw new Error(
        `claude was not detected in pane ${paneId} after launch (it may have failed to start; e.g. a skill preamble command failed)`,
      );
    }
  } catch (err) {
    // 起動できなかった場合、シェルだけのタブが残り続けるため閉じてから失敗させる。
    await mod.tabClose(tabId).catch(() => {});
    throw err;
  }

  return { paneId, tabId };
}

// ペインに最初の出力（シェルのプロンプト）が現れるまで待つ。プロンプト文字列はユーザーの
// シェル設定依存のため内容は判定せず「何か描画されたか」だけを見る（dispatcher.ts と同じ方針）。
async function waitForPaneReady(
  paneId: string,
  mod: typeof HerdrModule,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? PANE_READY_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? PANE_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let content = "";
    try {
      content = await mod.paneRead(paneId, { source: "visible" });
    } catch (err) {
      // 一時的な読み取り失敗はタイムアウトまで再試行する。ただし herdr 通信自体の
      // 問題を無言で握り潰すと原因調査が難しくなるため、waitForHerdrTask と同様にログは残す。
      console.error(`[herdr-runner] failed to read pane ${paneId} while waiting for its prompt: ${err}`);
    }
    if (content.trim() !== "") return true;
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

// 起動コマンド送信後、claude が herdr の自動エージェント検出で捕捉される（agentGet が
// 成功する）まで待つ。shell だけのペインでは agentGet が agent_not_found を投げるため、
// それが解消したら検出成功とみなす。ペイン自体が消えた（pane_not_found）場合は起動不能。
async function waitForAgentDetected(
  paneId: string,
  mod: typeof HerdrModule,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? AGENT_DETECT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? AGENT_DETECT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mod.agentGet(paneId);
      return true;
    } catch (err) {
      if (err instanceof mod.HerdrError && err.code === "pane_not_found") return false;
      // agent_not_found（まだ検出前）は正常な待機継続。それ以外の想定外エラー
      // （herdr 通信の問題など）は、waitForHerdrTask と同様にログを残してから継続する。
      if (!(err instanceof mod.HerdrError && err.code === "agent_not_found")) {
        console.error(`[herdr-runner] unexpected error while waiting for agent detection on pane ${paneId}: ${err}`);
      }
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

/**
 * agent ステータスをポーリングしてタスクの完了を待ち、完了時の出力を回収する。
 * 出力は transcript の最終レポートを優先し、引けない場合だけペイン内容を使う。
 *
 * - `working` → `idle` の遷移を完了とみなす
 * - `blocked` は人の介入を待つ状態として待機を継続する（自動失敗にはしない）
 * - ペインが消えた場合（`pane_not_found`）は claude の異常終了・タブの手動クローズとして失敗扱い
 *
 * タスクの実行時間に上限は設けない（default モードと同じ方針）。
 */
export async function waitForHerdrTask(
  paneId: string,
  options?: {
    pollIntervalMs?: number;
    herdr?: typeof HerdrModule;
    onBlocked?: () => void;
    onStatus?: (status: AgentStatus) => void;
    signal?: { aborted: boolean };
    headroom?: boolean;
    // テスト用の差し替え口（既定は transcript.ts の readFinalReport）。
    readReport?: (sessionId: string | undefined) => string;
  },
): Promise<TaskResult> {
  const mod = options?.herdr ?? (await loadHerdr());
  const pollIntervalMs = options?.pollIntervalMs ?? AGENT_POLL_INTERVAL_MS;
  let tracker = createCompletionTracker();
  // 完了後に transcript を引くための claude セッションID。herdr は TUI の起動直後には
  // まだセッションIDを持たないため、ポーリングのたびに最新の値で更新する。
  let sessionId: string | undefined;

  for (;;) {
    if (options?.signal?.aborted) {
      return { status: "failed", output: "[worker] the worker is shutting down; the task was interrupted" };
    }

    let status: AgentStatus;
    try {
      const agent = await mod.agentGet(paneId);
      status = agent.agentStatus;
      if (agent.sessionId) sessionId = agent.sessionId;
    } catch (err) {
      // 新モデルでは claude はタブのルートシェルペインで動くため、claude が異常終了しても
      // ペインは残る（シェルへ戻る）。この場合ペイン消失（pane_not_found）ではなく
      // エージェント検出が外れる（agent_not_found）ので、両方を「claude が消えた」失敗として扱う。
      // startHerdrTask が検出を確認してからこの待機に入るため、ここでの agent_not_found は
      // 起動前の未検出ではなく途中消滅を意味する。
      if (err instanceof mod.HerdrError && (err.code === "pane_not_found" || err.code === "agent_not_found")) {
        return {
          status: "failed",
          output: "[worker] the claude agent disappeared before the task completed (claude died or the tab was closed)",
        };
      }
      // 一時的な herdr の応答失敗でタスクを落とさない（次のポーリングで回復しうる）。
      console.error(`[herdr-runner] failed to read agent status for pane ${paneId}: ${err}`);
      await sleep(pollIntervalMs);
      continue;
    }

    options?.onStatus?.(status);
    const observed = observeAgentStatus(tracker, status);
    tracker = observed.tracker;

    if (observed.decision === "completed") {
      const output = await readPaneOutput(paneId, mod);
      const report = (options?.readReport ?? readFinalReport)(sessionId);
      return buildHerdrTaskResult(output, { headroom: options?.headroom, report });
    }
    if (observed.decision === "blocked-first-seen") {
      options?.onBlocked?.();
    }

    await sleep(pollIntervalMs);
  }
}

async function readPaneOutput(paneId: string, mod: typeof HerdrModule): Promise<string> {
  try {
    return await mod.paneRead(paneId, { source: "recent", lines: PANE_OUTPUT_LINES });
  } catch (err) {
    console.error(`[herdr-runner] failed to read pane ${paneId}: ${err}`);
    return "";
  }
}

// claude の終了を待つ上限。グレースフルに終われなかった場合は tabClose で強制的に閉じる。
export const CLAUDE_EXIT_TIMEOUT_MS = 15 * 1000;
export const CLAUDE_EXIT_POLL_INTERVAL_MS = 200;

// claude が終了する（agent 検出が外れる）まで待つ。新モデルでは claude はタブの
// ルートシェルペインで動くため、claude が終了してもペイン自体は残り（シェルへ戻る）、
// `agentGet` が agent_not_found を返すようになる。ペインごと消える（pane_not_found）
// ケースも合わせて「claude が終了した」とみなす。
async function waitForAgentGone(
  paneId: string,
  mod: typeof HerdrModule,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? CLAUDE_EXIT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? CLAUDE_EXIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mod.agentGet(paneId);
    } catch (err) {
      if (err instanceof mod.HerdrError && (err.code === "agent_not_found" || err.code === "pane_not_found")) {
        return true;
      }
      // 一時的な herdr の応答失敗では諦めず、タイムアウトまで再試行する。
    }
    if (Date.now() >= deadline) return false;
    await sleep(pollIntervalMs);
  }
}

/**
 * タスクの TUI セッションを終了してタブを閉じる。
 *
 * ペインの内容はタブを閉じると失われるため、必ず出力を回収した後に呼ぶこと。
 * また claude がまだ worktree を掴んでいる状態で worktree を削除できないよう、
 * 呼び出し側は「停止 → 完了コールバック（worktree 削除）」の順序を守る。
 *
 * ctrl-c は **1コマンドで連続2回** 送る。Claude Code の TUI は ctrl-c 1回では終了せず
 * （1回目は入力のキャンセル）、間隔を空けた2回でも終了カウントがリセットされて終了しない
 * ことを実測で確認している（`pane send-keys <pane> ctrl+c ctrl+c` なら終了する）。
 * ここで終了させずに tabClose だけに頼ると、claude は後片付けの機会を得られないまま
 * 強制終了される。
 *
 * 新モデルでは claude はタブのルートシェルペインで動くため、claude がグレースフルに
 * 終了してもペイン（＝シェル）とタブは残る。そのため tabClose は必須で、agent 検出が
 * 外れる（＝claude が終了した）のを待ってから確実にタブごと閉じる。既にタブが
 * 消えているケース（tab_not_found）は正常系として握り潰す。
 */
export async function stopHerdrTask(
  task: HerdrTask,
  herdr?: typeof HerdrModule,
  options?: { exitTimeoutMs?: number; exitPollIntervalMs?: number },
): Promise<void> {
  const mod = herdr ?? (await loadHerdr());

  try {
    await mod.paneSendKeys(task.paneId, "ctrl+c", "ctrl+c");
    const exited = await waitForAgentGone(task.paneId, mod, {
      timeoutMs: options?.exitTimeoutMs,
      pollIntervalMs: options?.exitPollIntervalMs,
    });
    if (!exited) {
      console.warn(
        `[herdr-runner] claude did not exit in pane ${task.paneId} after ctrl-c, closing the tab forcefully`,
      );
    }
  } catch (err) {
    // ペインが既に消えている場合など。タブのクローズは続行する。
    console.error(`[herdr-runner] failed to send ctrl-c to pane ${task.paneId}: ${err}`);
  }

  try {
    await mod.tabClose(task.tabId);
  } catch (err) {
    // グレースフル終了でタブごと消えている場合は正常。
    if (err instanceof mod.HerdrError && (err.code === "tab_not_found" || err.code === "pane_not_found")) return;
    console.error(`[herdr-runner] failed to close tab ${task.tabId}: ${err}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
