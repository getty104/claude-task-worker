// 失敗時の通知に含める stderr 末尾の上限。claude -p はエラーを stderr にしか出さない
// ことがあり、破棄すると失敗通知が空になって原因調査ができなくなる。
export const STDERR_TAIL_LIMIT = 8 * 1024;

export interface TaskResult {
  status: "completed" | "failed";
  output: string;
  // クラウド実行（workers.<name>.cloud）のセッションURL用ID。herdr モードでペインから
  // 抽出できた場合のみ設定する。default モード（claude -p の spawn）は常に undefined。
  cloudSessionId?: string;
}

// クラウド実行（workers.<name>.cloud: true）の前提条件のうち、GitHub 連携と
// allow_remote_sessions 組織ポリシーはローカルから静的判定できない
// （docs/cloud-prerequisite-checks.md の「案内メッセージの文面案」2・4）。
// そのため起動時エラーにはできず、タスクが実際に失敗したときの案内としてのみ付与する。
// Slack 通知は output の末尾1000文字しか載せない（src/slack.ts）ため、案内文は
// 実際のエラー本文を押し出さないよう短く保ち、かつエラー本文より前に置く。
const CLOUD_FAILURE_GUIDANCE =
  "[worker] クラウド実行の前提条件（GitHub 連携 / allow_remote_sessions 組織ポリシー）が" +
  "満たされていない可能性があります。詳細は docs/cloud-prerequisite-checks.md を参照してください。";

/**
 * クラウド実行の失敗結果にのみ、前提条件の案内を output へ追記する。
 * ローカル実行（cloud が false）や完了結果には一切追記しない。
 * 案内文は output の前に置く。Slack 通知は末尾1000文字を切り出すため、後ろに置くと
 * 実際のエラー本文が案内文に押し出されて読めなくなる。
 */
export function appendCloudFailureGuidance(result: TaskResult, cloud: boolean | undefined): TaskResult {
  if (!cloud || result.status === "completed") return result;
  return { ...result, output: `${CLOUD_FAILURE_GUIDANCE}\n${result.output}` };
}

/**
 * 子プロセスの終了状態を completed / failed に分類し、通知用の出力文字列を組み立てる。
 *
 * exit 0 でも stdout が空の場合は失敗として扱う。claude -p は正常完了時に必ず最終
 * レポートを stdout へ出力するため、空のままの exit 0 は「スキルプリアンブルの
 * `!` コマンド失敗などでモデル未起動のままセッションが中断された」ことを意味する。
 * これを完了扱いにするとワーカーがラベル遷移を進めてしまい、トリガーラベルが
 * 再装填される triage-pr では毎ポーリングで空振りセッションを起動し続ける
 * 無限リトライループになる。
 */
export function buildTaskResult(code: number | null, stdout: string, stderrTail: string): TaskResult {
  const emptyOutput = stdout.trim() === "";
  const completed = code === 0 && !emptyOutput;
  let output = stdout;
  if (code === 0 && emptyOutput) {
    output +=
      "[worker] claude exited with code 0 but produced no output " +
      "(session aborted before the model ran; e.g. a skill preamble command failed)";
  } else if (!completed) {
    output += `\n[worker] claude exited with code ${code}`;
  }
  if (!completed && stderrTail.trim() !== "") {
    output += `\n[stderr] ${stderrTail.trim()}`;
  }
  return { status: completed ? "completed" : "failed", output };
}
