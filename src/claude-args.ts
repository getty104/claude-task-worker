import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PERMISSION_MODE, type PermissionMode, type RunMode } from "./user-config";

// ワーカーは各スキルを自律実行モードで起動する（default モードは `claude -p`、
// herdr モードは herdr タブ内の TUI セッション。どちらも応答するユーザーは常駐しない）。
// 以下のツールはこの実行形態では原理的に使い道がない（または有害）なため、CLI の
// `--disallowedTools` で完全に無効化する。存在しないツール名は無害な no-op になるため、環境差は問題ない。
//
// 「入る」系だけを無効化し「出る」系（ExitPlanMode / ExitWorktree）は残す方針：
// 万一その状態で開始してもモデルが脱出できるようにするため。
//
// 補足: `TaskCreate` 等の進捗管理、`WebFetch`/`WebSearch`/`LSP`/各種 MCP は正当な用途が
// あるため無効化しない。バックグラウンド実行は CLAUDE_SPAWN_ENV の
// CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 で機能ごと無効化されるため、ツール単位の
// ガードは不要。
export const DISALLOWED_TOOLS = [
  // 遅延 / yield: 後続ウェイクアップ前提。print モードではウェイクアップが発火せず、
  // 呼ぶと処理未完のままプロセスが終了する。
  "Monitor",
  "ScheduleWakeup",

  // 対話 / 承認: 自律実行セッションには回答・承認するユーザーが存在しない。
  "AskUserQuestion",
  "EnterPlanMode",

  // スコープ外の副作用を伴う自動化: コード修正タスクに用途がなく、ユーザーの
  // クラウド routine / リモート環境へ副作用を及ぼしうる。
  "CronCreate",
  "CronDelete",
  "CronList",
  "RemoteTrigger",

  // 環境管理の競合: ワーカーは locked worktree の残骸問題のため claude 管理の worktree を
  // 意図的に避け、自前で worktree を生成して cwd として渡している。モデルが worktree を
  // 作成/切り替えると、この前提とクリーンアップが壊れる。
  "EnterWorktree",
] as const;

// `--disallowedTools` はカンマ/スペース区切りの可変長引数。単一トークンで渡して
// 後続フラグとの境界を曖昧にしないよう、カンマ結合した1値として渡す。
export const DISALLOWED_TOOLS_ARG = DISALLOWED_TOOLS.join(",");

// ワーカーが `claude -p`（default モード）を spawn する際に process.env へ上書きマージする環境変数。
//
// - CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1: Claude 管理下のバックグラウンド機構
//   （Bash の `run_in_background`・サブエージェントの自動バックグラウンド化）のみを
//   無効化する。`nohup`/`disown`/末尾 `&` によるシェルレベルのプロセス detach や、
//   `docker compose up -d` 等が起動する切り離しプロセスまでは防げないため、未完のまま
//   ターンが終わってプロセスが exit 0 する事故を完全には防止できない。Stop フックに
//   よる起動プロセスの後片付けとワーカーレベルの完了検証（onCompleted）が引き続き
//   必要な理由はこのため。
// - CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0: 万一バックグラウンド化される経路が残った
//   場合の保険。`claude -p` はバックグラウンドサブエージェントの完了を待つが、
//   v2.1.182+ ではデフォルト10分で打ち切られる。0 は「無制限に待機」を意味する。
//
// 対象プロジェクトのリポジトリ設定に依存させないため、settings.json ではなく spawn 環境
// 変数として全ワーカー起動に一律注入する（プラグインの settings.json は env を配布できない）。
export const CLAUDE_SPAWN_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
} as const;

// `--append-system-prompt-file` でシステムプロンプト末尾に注入する自律実行原則。
// （文字列を直接 `--append-system-prompt` へ渡すのではなくファイル経由にする理由は
// `systemPromptFilePath()` を参照。）
// かつては各ワーカー起動スキルの「実行モードの制約」セクションに同文を複製していたが、
// ワーカー起動時の CLI 注入に一元化した（対話セッションでスキルを手動実行する場合は
// 実在するユーザーと対話してよいため、スキル本文に置かないのが正しい）。
//
// サブエージェント向けの原則もここに統合している。かつては
// `--append-subagent-system-prompt`（`-p` 非対話モード限定）で全サブエージェントへ
// 直接注入していたが、herdr モードの TUI 起動では同フラグが使えず、実行形態によって
// 原則の届き方が変わってしまう。そのため注入経路を `--append-system-prompt` 一本に統一し、
// サブエージェントへはメインエージェントが委譲プロンプトで伝える形にした。
//
// 文面は実行形態（`claude -p` / TUI）に依存しない表現にしてある。
//
// コード探索の原則（CodeGraph 優先）もここに含める。`explore-agent` には同エージェントの
// 定義（`plugin/agents/explore-agent.md`）で詳細な手順を持たせてあるが、メインエージェント
// 自身が探索する場合や、explore-agent 以外のサブエージェントへ委譲する場合には届かないため、
// 全セッション共通の原則としてシステムプロンプトにも置く。
//
// 本文は「全モデル共通の基底（`SYSTEM_PROMPT_BASE`）＋ opus 実行時のみ足す追補
// （`OPUS_SYSTEM_PROMPT_ADDENDUM`）」の2段構成にしてある（`systemPromptFor()` 参照）。
export const SYSTEM_PROMPT_BASE = `このセッションは \`claude-task-worker\` のワーカーから自動起動されている（応答できるユーザーは常駐していない）。以下の自律実行原則を必ず遵守すること。

- ユーザーへの確認・質問は行わず、起動されたスキルのルールに従って自律的に判断する
- 曖昧な場合は「より安全な側（破壊的でない側）」を選択し、その判断と根拠を最終報告に明記する
- 全ステップを完遂してから終了する（スキルに定義された中断条件に該当した場合のみ、理由を出力して終了する）
- サブエージェントへ作業を委譲する場合は、上記の原則を委譲プロンプトにも明記して伝える
- サブエージェントの完了報告は鵜呑みにしない。\`git diff\` 等で実際の成果物を検証してから完了扱いにする

コードの探索・調査では以下に従うこと。

- **CodeGraph が使える場合は \`Grep\`/\`Glob\` によるテキスト検索より優先する**。シンボルの定義元・参照元・呼び出し関係を構造として辿れるため、命名ゆれによる取りこぼしが起きにくく、必要な情報に少ない試行で到達できる
- **利用可否は codegraph 系の MCP ツール（\`codegraph_explore\` 等）が自分に与えられているかだけで判断する**。無ければ「利用不可」と即断してテキスト検索へ進み、判定に手間をかけない
- 未インデックスのプロジェクトでは MCP ツールがあってもエラーや空の結果が返る。その場合もテキスト検索へ切り替えるだけでよく、インデックスを用意しようとしない（タスクの責務外）
- CodeGraph が返したソースは「読み終えたもの」として扱い、同じ箇所を \`Grep\`/\`Read\` で裏取りし直さない。ただし出力に staleness（インデックスが古い旨）の警告が出ている場合は該当ファイルを \`Read\` して現物を確認する
- 設定ファイル・ドキュメント・コメント/文字列リテラル・未対応言語など CodeGraph が扱わない対象は、従来どおりテキスト検索で補う
- 探索をサブエージェントへ委譲する場合は、この方針も委譲プロンプトに明記して伝える`;

// opus 実行時のみ基底プロンプトの末尾に足す追補。
//
// Opus 5 は既定で「冗長に書く・スコープを広げる・積極的に委譲する・指示されなくても自己検証する」
// 方向へ倒れるため、その4点を抑える指示を入れる
// （https://platform.claude.com/docs/ja/build-with-claude/prompt-engineering/prompting-claude-opus-5）。
// 同じ調整は opus 実行のスキル/エージェント本文にも入れてあるが、そちらはスキルごとの局所的な
// 規定であり、(1) サブエージェント（`general-purpose-assistant` 等、モデル指定を持つもの）や
// (2) スキルを跨いだセッション全体には届かないため、セッション単位の原則としてここにも置く。
//
// sonnet には足さない。これらは Opus 5 の既定挙動への逆張りであり、sonnet では逆に
// 「検証を促す」「委譲を促す」方向の指示が要るケースがあるため、既存の基底プロンプトのまま
// 挙動を変えない（＝本追補の導入で sonnet ワーカーの振る舞いは一切変わらない）。
export const OPUS_SYSTEM_PROMPT_ADDENDUM = `成果物の分量とスコープについては以下に従うこと。

- 依頼されたスコープだけを成果物にする。周辺のリファクタ・命名整理・気づいた別の改善を勝手に足さない。気づいた点は実装せず、最終報告に1行で挙げるだけにする
- 依頼の前提が誤っていると考える場合も、指摘を1-2行添えたうえで**依頼どおりのスコープで**完遂する（黙って縮小・拡大・別物への置き換えをしない）
- Issueコメント・PRの本文・description・レポート等の書き物は、必要な実質だけを書く。同じ内容の言い換え・埋め草セクション・「該当なし」を並べるだけの節を足さない
- 最終報告は結論から書く。1文目で「何をしたか / どこで止まったか」を述べ、詳細をその後に置く

サブエージェントへの委譲は以下に従うこと。

- 自分で数回のツール呼び出しで終わる作業は委譲しない（ブリーフィング作成と委譲先の再探索でコストと時間が倍になる）
- 委譲するのは、独立して並列実行できる作業・探索範囲の広い調査・専門エージェントの前提知識が要る作業に限る
- 1タスクに1エージェント。1体で完結する作業に複数体を重ねて起動しない
- **自分の作業の確認・再チェックを目的にサブエージェントを起動しない**。成果物の検証は \`git diff\` やテスト・Lintの実行で自分で行う`;

// モデルに応じて注入するシステムプロンプト本文を返す。
export function systemPromptFor(model: string): string {
  return isOpusModel(model) ? `${SYSTEM_PROMPT_BASE}\n\n${OPUS_SYSTEM_PROMPT_ADDENDUM}` : SYSTEM_PROMPT_BASE;
}

// `--model` に渡す値が opus 系かを判定する。
// 判定を部分一致にしているのは、`claude-task-worker.json` の `workers.<name>.model` が
// エイリアス（`opus`）でもフルID（`claude-opus-5`）でも指定できるため。未知の値は
// 「opus ではない」＝追補なしの基底プロンプトへ倒す（sonnet 側が従来の挙動）。
export function isOpusModel(model: string): boolean {
  return model.toLowerCase().includes("opus");
}

export interface ClaudeInvocation {
  mode: RunMode;
  // スキル呼び出し文字列（例: "/claude-task-worker:exec-issue 123"）
  prompt: string;
  model: string;
  effort: string;
  // `--advisor` に渡すモデル。空文字・未指定ならフラグ自体を渡さない。
  // config.json の `advisor` が false のときは呼び出し側が空文字を渡す
  // （ワーカー側でゲートする。`buildClaudeArgs` は渡された値をそのまま反映するだけ）。
  advisorModel?: string;
  // claude CLI の権限モード。config.json の `permission`（既定 bypassPermissions）。
  permissionMode?: PermissionMode;
  // true なら Claude Code on the web（クラウド実行）のセッションとして起動する。
  // クラウドセッションは print モード非対応なので `-p <prompt>` を付けない
  // （実測: `Error: --cloud cannot be combined with --print.`）。
  cloud?: boolean;
  // `--ref` に渡すクラウドセッションのベースブランチ。`onBranch` とは排他。
  baseRef?: string;
  // `--on-branch` に渡すクラウドセッションのベースブランチ。`baseRef` とは排他。
  onBranch?: string;
}

export const CLAUDE_COMMAND = "claude";

// バリアント（`opus` / `default`）ごとの書き出し済みファイルパス。
const cachedSystemPromptFilePaths = new Map<string, string>();

// システムプロンプト本文を絶対パスのファイルへ書き出し、その絶対パスを返す
// （バリアントごとにプロセス内で一度だけ）。
//
// herdr モードは agent 引数を `herdr agent start ... -- <args>` としてターゲットシェル経由で
// 起動するが、herdr は**改行を含む引数**を拒否する
// （code: `invalid_agent_argument` / "agent arguments cannot be encoded safely for the
// target shell"）。SYSTEM_PROMPT は複数行のため、`--append-system-prompt <文字列>` で
// 直接渡すと herdr モードのタスク起動が必ずこのエラーで失敗する。そこで内容をファイルへ
// 逃がし、`--append-system-prompt-file <path>` で参照させる（引数に改行が乗らなくなる）。
// default モード（spawn。シェルを介さないので改行自体は問題ない）でも同じファイル参照を
// 使い、両モードの引数を一致させておく。
//
// 内容はビルドごとに静的なので、バリアントごとにプロセス単位の固定パスへ一度だけ書けば十分。
// file は消さず残す（claude が起動時に読むまで存在し続ける必要があり、tmpdir は OS が回収する）。
// 半端な読み取りを避けるため一時ファイル + rename で原子的に書き込む。
//
// ファイル名にバリアントを含めるのは、opus と sonnet のワーカーが同一プロセス内で並走する
// （`all` / `--project` 実行）ため。同一パスを共有すると、後から起動したワーカーの書き込みが
// 先のワーカー向けの内容を上書きしてしまう。
export function systemPromptFilePath(model: string): string {
  const variant = isOpusModel(model) ? "opus" : "default";
  const cached = cachedSystemPromptFilePaths.get(variant);
  if (cached) return cached;
  const dir = path.join(os.tmpdir(), "claude-task-worker");
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `append-system-prompt-${process.pid}-${variant}.txt`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, systemPromptFor(model), "utf8");
  renameSync(tmp, target);
  cachedSystemPromptFilePaths.set(variant, target);
  return target;
}

// claude の起動引数を組み立てる。モードによる差は `-p`（非対話 print モード）の有無だけで、
// ツール制限・システムプロンプト・モデル指定は両モードで共通にする。
// システムプロンプトはファイル経由（`--append-system-prompt-file`）で渡す（理由は
// `systemPromptFilePath()` を参照）。
export function buildClaudeArgs({
  mode,
  prompt,
  model,
  effort,
  advisorModel,
  permissionMode,
  cloud,
  baseRef,
  onBranch,
}: ClaudeInvocation): string[] {
  const ref = baseRef?.trim() ?? "";
  const onBranchValue = onBranch?.trim() ?? "";
  // CLI 側も `--ref` / `--on-branch` の同時指定を排他としてエラーにするが（実測 T8）、
  // 起動して外部プロセスのエラーで気づく形にしないよう、引数を組み立てる前に弾く。
  if (cloud === true && ref !== "" && onBranchValue !== "") {
    throw new Error("--on-branch and --ref both set the cloud session's base branch; pass one or the other");
  }
  const advisor = advisorModel?.trim() ?? "";
  const permission = permissionMode ?? DEFAULT_PERMISSION_MODE;
  return [
    // default モードはプロンプトを引数で渡す（print モード）。herdr モードでは渡さない:
    // 引数で渡すと claude が起動と同時に作業を始めてしまい、`herdr agent start` が
    // 「入力待ちになるまで」ブロックする仕様と噛み合わない（タスクが終わるまで返らず、
    // 2分を超えると timeout で落ちる）。プロンプトは起動後に `herdr agent prompt` で
    // 投入し、herdr にターンを追跡させる（herdr-runner.ts の startHerdrTask 参照）。
    // クラウド実行（`cloud: true`）も print モード非対応のため同様に省く
    // （実測 T2: `Error: --cloud cannot be combined with --print.`）。
    ...(mode === "herdr" || cloud === true ? [] : ["-p", prompt]),
    "--permission-mode",
    permission,
    "--disallowedTools",
    DISALLOWED_TOOLS_ARG,
    "--append-system-prompt-file",
    systemPromptFilePath(model),
    "--model",
    model,
    "--effort",
    effort,
    // advisor 未指定（空文字）ならフラグごと省く。値なしの `--advisor` を渡すと
    // 後続フラグを値として食われるため、必ずモデル名とセットでのみ付ける。
    ...(advisor === "" ? [] : ["--advisor", advisor]),
    // クラウド実行時のみ付与する。プロンプトは `--cloud` の値として渡さない（値なしフラグ）。
    // ベースブランチ指定は `--ref` / `--on-branch` のどちらか一方のみ（両方指定は上で例外）。
    ...(cloud === true ? ["--cloud"] : []),
    ...(cloud === true && ref !== "" ? ["--ref", ref] : []),
    ...(cloud === true && onBranchValue !== "" ? ["--on-branch", onBranchValue] : []),
  ];
}

export interface ClaudeExecution {
  command: string;
  args: string[];
  // herdr モードのみ設定される、起動後に `herdr agent prompt` で投入するプロンプト。
  // default モードでは args に含まれるため undefined。
  prompt?: string;
}

/**
 * タスクを起動する実行可能ファイルと引数を組み立てる。
 *
 * 実行形態（default / herdr）とは直交する。default モードでは spawn の command
 * （`claude`）と引数にそのまま渡す。herdr モードでは `command`（＝claude）を agent kind、
 * `args` を `herdr agent start ... -- <args>` の agent 引数として使い、`prompt` は起動後に
 * `herdr agent prompt` で投入する（`herdr-runner.ts` の `startHerdrTask` 参照）。
 */
export function buildClaudeExecution(invocation: ClaudeInvocation): ClaudeExecution {
  return {
    command: CLAUDE_COMMAND,
    args: buildClaudeArgs(invocation),
    ...(invocation.mode === "herdr" ? { prompt: invocation.prompt } : {}),
  };
}

// claude へ渡す環境変数を組み立てる。
// herdr モードでは `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` は print モード専用のため渡さない。
//
// かつてここで `HERDR_DISABLE_SOUND=1` も渡していたが、これは**効かない**ので撤去した。
// 同変数を読むのは herdr 本体の sound モジュール（`src/sound.rs` 冒頭で `NEXTEST` と共に
// チェックされる）であり、参照されるのは**サウンドを再生する herdr サーバープロセス自身の
// 環境変数**。タスクペイン（claude 子プロセス）の環境に入れてもサーバーには届かない。
// エージェントの状態遷移音は herdr 側の設定（`~/.config/herdr/config.toml` の
// `[ui.sound]`）か、ワーカー用 herdr セッションを `HERDR_DISABLE_SOUND=1` 付きで
// 起動することでしか止められない。
export function buildClaudeEnv(mode: RunMode): Record<string, string> {
  return mode === "herdr"
    ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: CLAUDE_SPAWN_ENV.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS }
    : { ...CLAUDE_SPAWN_ENV };
}
