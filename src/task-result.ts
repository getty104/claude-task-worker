// 失敗時の通知に含める stderr 末尾の上限。claude -p はエラーを stderr にしか出さない
// ことがあり、破棄すると失敗通知が空になって原因調査ができなくなる。
export const STDERR_TAIL_LIMIT = 8 * 1024;

export interface TaskResult {
  status: "completed" | "failed";
  output: string;
}

/**
 * `headroom wrap claude` が claude を起動する前に stdout へ出す起動バナーを取り除く。
 *
 * headroom は起動時に枠線・`ANTHROPIC_BASE_URL=...`・`Extra args: ...` などを
 * **無条件で stdout へ**出力する（`--verbose` とは無関係で、抑止するオプションも無い）。
 * これをそのまま数えると「exit 0 かつ stdout が空＝空振りセッション」の検知が
 * 常に空振りしなくなり、無限リトライループを止める最後の砦が効かなくなる。
 *
 * バナーの各行は空行か2スペース始まり（`click.echo("  ...")`）で、claude を起動する
 * **前に**すべて出力される。そのため「先頭から続く空行 / 2スペース始まりの行」だけを
 * 落とせば、claude 本体の出力には触れずにバナーを除去できる。判定を誤って claude の
 * 出力を落としても失敗側（＝ラベルを進めない安全側）に倒れるだけになるよう、
 * 通知に載せる `output` は元の stdout のままにし、この結果は空判定にのみ使う。
 */
export function stripHeadroomBanner(stdout: string): string {
  const lines = stdout.split("\n");
  let i = 0;
  while (i < lines.length && (lines[i].trim() === "" || lines[i].startsWith("  "))) i++;
  return lines.slice(i).join("\n");
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
 *
 * `headroom` が有効な場合は claude の出力の手前に headroom の起動バナーが混ざるため、
 * 空判定はバナーを除去してから行う（`stripHeadroomBanner`）。exit code は headroom が
 * claude のものをそのまま伝播する（`SystemExit(result.returncode)`）ので調整不要。
 */
export function buildTaskResult(
  code: number | null,
  stdout: string,
  stderrTail: string,
  options?: { headroom?: boolean },
): TaskResult {
  const meaningful = options?.headroom ? stripHeadroomBanner(stdout) : stdout;
  const emptyOutput = meaningful.trim() === "";
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
