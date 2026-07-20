import type * as HerdrModule from "./herdr";
import type { AgentStatus } from "./herdr";
import type { TaskResult } from "./task-result";
// node --experimental-strip-types は実ファイル解決を要求するため、値のimportは
// .ts 拡張子付きにする（herdr-runner.ts はテストから直接 .ts で読み込まれる）。
import { stripHeadroomBanner } from "./task-result.ts";

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
 * 「ペインの内容が空か」だけで成否を判定する。プリアンブル失敗などでモデルが
 * 起動しないまま idle になったセッションを空振りとして失敗扱いにする狙いは
 * task-result.ts の buildTaskResult と同じ。
 *
 * `headroom` が有効な場合、ペインには claude の手前に headroom の起動バナーが残りうる。
 * バナーだけのペインを「出力あり」と誤認しないよう、default モードと同じく空判定の前に
 * 取り除く（通知に載せる output は元のペイン内容のままにする）。
 */
export function buildHerdrTaskResult(paneOutput: string, options?: { headroom?: boolean }): TaskResult {
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

/**
 * herdr のタスク専用タブで claude を TUI 起動する（1タスク=1タブ）。
 *
 * 手順は「先にタスク専用タブを作り、その中へ agent を起動する」。
 * `agent start` はタブ内への split でしかペインを作れないため、`--tab` を省略すると
 * ワークスペースのアクティブタブ（＝ユーザーが見ているタブ）に一瞬ペインが割り込み、
 * その後 `pane move --new-tab` で消える——というちらつきが起きる。
 * 先に `--no-focus` でタブを作っておけば、割り込み先は最初から不可視の新規タブになる。
 *
 * 新規タブのルートペイン（シェル）は agent ペインを split で迎え入れた後は不要なので、
 * 閉じてタブを agent ペイン1枚にする。
 */
export async function startHerdrTask({
  label,
  cwd,
  argv,
  env,
  workspaceId,
  herdr,
}: {
  label: string;
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  workspaceId?: string;
  herdr?: typeof HerdrModule;
}): Promise<HerdrTask> {
  const mod = herdr ?? (await loadHerdr());
  const { tabId, paneId: shellPaneId } = await mod.tabCreate({ label, cwd, workspaceId, env });

  let paneId: string;
  try {
    ({ paneId } = await mod.agentStart({ name: label, cwd, argv, env, workspaceId, tabId }));
  } catch (err) {
    // agent を起動できなかった場合、シェルだけのタブが残り続けるため閉じてから失敗させる。
    await mod.tabClose(tabId).catch(() => {});
    throw err;
  }

  // ルートペインを閉じられなくても agent 自体は動いているので、タスクは失敗させない
  // （タブにシェルペインが1枚余分に残るだけで、タブごと閉じる stopHerdrTask で片付く）。
  await mod.paneClose(shellPaneId).catch((err: unknown) => {
    console.error(`[herdr-runner] failed to close the placeholder shell pane ${shellPaneId}: ${err}`);
  });

  return { paneId, tabId };
}

/**
 * agent ステータスをポーリングしてタスクの完了を待ち、ペインの内容を回収する。
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
  },
): Promise<TaskResult> {
  const mod = options?.herdr ?? (await loadHerdr());
  const pollIntervalMs = options?.pollIntervalMs ?? AGENT_POLL_INTERVAL_MS;
  let tracker = createCompletionTracker();

  for (;;) {
    if (options?.signal?.aborted) {
      return { status: "failed", output: "[worker] the worker is shutting down; the task was interrupted" };
    }

    let status: AgentStatus;
    try {
      status = (await mod.agentGet(paneId)).agentStatus;
    } catch (err) {
      if (err instanceof mod.HerdrError && err.code === "pane_not_found") {
        return {
          status: "failed",
          output: "[worker] the claude pane disappeared before the task completed (claude died or the tab was closed)",
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
      return buildHerdrTaskResult(output, { headroom: options?.headroom });
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

// ペインが消えるまで待つ。消えた＝そのペインのプロセス（claude）が終了したということ。
async function waitForPaneGone(
  paneId: string,
  mod: typeof HerdrModule,
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? CLAUDE_EXIT_TIMEOUT_MS;
  const pollIntervalMs = options?.pollIntervalMs ?? CLAUDE_EXIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await mod.paneGet(paneId);
    } catch (err) {
      if (err instanceof mod.HerdrError && err.code === "pane_not_found") return true;
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
 * claude がグレースフルに終了するとペインが消え、そのタブに他のペインが無ければ
 * タブも自動で消える。そのため tabClose は「残っていた場合の強制クローズ」として呼び、
 * 既に消えている場合のエラー（tab_not_found）は正常系として扱う。
 */
export async function stopHerdrTask(
  task: HerdrTask,
  herdr?: typeof HerdrModule,
  options?: { exitTimeoutMs?: number; exitPollIntervalMs?: number },
): Promise<void> {
  const mod = herdr ?? (await loadHerdr());

  try {
    await mod.paneSendKeys(task.paneId, "ctrl+c", "ctrl+c");
    const exited = await waitForPaneGone(task.paneId, mod, {
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
