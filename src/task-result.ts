// 失敗時の通知に含める stderr 末尾の上限。claude -p はエラーを stderr にしか出さない
// ことがあり、破棄すると失敗通知が空になって原因調査ができなくなる。
export const STDERR_TAIL_LIMIT = 8 * 1024;

export interface TaskResult {
  status: "completed" | "failed";
  output: string;
}

// クラウド実行（workers.<name>.cloud: true）の前提条件のうち、GitHub 連携と
// allow_remote_sessions 組織ポリシーはローカルから静的判定できない
// （docs/cloud-prerequisite-checks.md の「案内メッセージの文面案」2・4）。
// そのため起動時エラーにはできず、タスクが実際に失敗したときの案内としてのみ付与する。
const CLOUD_FAILURE_GUIDANCE =
  "[worker] クラウドセッションの作成が GitHub 連携の未設定で失敗した可能性があります" +
  "（`--ref` / `--on-branch` が拒否された場合はこれが原因です）。" +
  "https://claude.ai/code で対象リポジトリの GitHub 連携をセットアップしてください。" +
  "GitHub App の認可、または `/web-setup` による `gh` トークンの同期のどちらでも構いません。" +
  "ローカルからは連携状態を確認する手段がないため、事前チェックは行っていません。\n" +
  "[worker] クラウドセッションの作成が組織ポリシー（`allow_remote_sessions`）で拒否された可能性があります。" +
  "組織の管理者にクラウドセッションの有効化を依頼してください。" +
  "`Couldn't verify your organization's policy` と表示された場合はポリシーの取得自体に失敗しています" +
  "（ネットワークを確認してください）。ローカルからはポリシーを照会する手段がないため、事前チェックは行っていません。";

/**
 * クラウド実行の失敗結果にのみ、前提条件の案内を output へ追記する。
 * ローカル実行（cloud が false）や完了結果には一切追記しない。
 */
export function appendCloudFailureGuidance(result: TaskResult, cloud: boolean | undefined): TaskResult {
  if (!cloud || result.status === "completed") return result;
  return { ...result, output: `${result.output}\n${CLOUD_FAILURE_GUIDANCE}` };
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
