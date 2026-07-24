// 失敗時の通知に含める stderr 末尾の上限。claude -p はエラーを stderr にしか出さない
// ことがあり、破棄すると失敗通知が空になって原因調査ができなくなる。
export const STDERR_TAIL_LIMIT = 8 * 1024;

export interface TaskResult {
  status: "completed" | "failed";
  output: string;
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
