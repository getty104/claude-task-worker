import type { RunMode } from "./user-config.js";

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

// `--append-system-prompt` でシステムプロンプト末尾に注入する自律実行原則。
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
export const SYSTEM_PROMPT = `このセッションは \`claude-task-worker\` のワーカーから自動起動されている（応答できるユーザーは常駐していない）。以下の自律実行原則を必ず遵守すること。

- ユーザーへの確認・質問は行わず、起動されたスキルのルールに従って自律的に判断する
- 曖昧な場合は「より安全な側（破壊的でない側）」を選択し、その判断と根拠を最終報告に明記する
- 全ステップを完遂してから終了する（スキルに定義された中断条件に該当した場合のみ、理由を出力して終了する）
- サブエージェントへ作業を委譲する場合は、上記の原則を委譲プロンプトにも明記して伝える
- サブエージェントの完了報告は鵜呑みにしない。\`git diff\` 等で実際の成果物を検証してから完了扱いにする`;

export interface ClaudeInvocation {
  mode: RunMode;
  // スキル呼び出し文字列（例: "/claude-task-worker:exec-issue 123"）
  prompt: string;
  model: string;
  effort: string;
}

// claude の起動引数を組み立てる。モードによる差は `-p`（非対話 print モード）の有無だけで、
// ツール制限・システムプロンプト・モデル指定は両モードで共通にする。
export function buildClaudeArgs({ mode, prompt, model, effort }: ClaudeInvocation): string[] {
  return [
    ...(mode === "herdr" ? [] : ["-p"]),
    prompt,
    "--dangerously-skip-permissions",
    "--chrome",
    "--disallowedTools",
    DISALLOWED_TOOLS_ARG,
    "--append-system-prompt",
    SYSTEM_PROMPT,
    "--model",
    model,
    "--effort",
    effort,
  ];
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
  if (mode === "herdr") {
    return {
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: CLAUDE_SPAWN_ENV.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS,
    };
  }
  return { ...CLAUDE_SPAWN_ENV };
}
