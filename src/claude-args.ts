// ワーカーは各スキルを `claude -p`（非対話・自律実行）で起動する。以下のツールは
// この実行形態では原理的に使い道がない（または有害）なため、CLI の `--disallowedTools`
// で完全に無効化する。存在しないツール名は無害な no-op になるため、環境差は問題ない。
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

// ワーカーが `claude -p` を spawn する際に process.env へ上書きマージする環境変数。
//
// - CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1: Bash / サブエージェントの
//   `run_in_background`・自動バックグラウンド化を含む全バックグラウンドタスク機能を
//   無効化する。処理は常にフォアグラウンドの同期実行となり、未完のままターンが終わって
//   プロセスが exit 0 する（ワーカーが「正常完了」と誤認してラベル遷移が壊れる）事故を
//   機能レベルで防ぐ。
// - CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0: 万一バックグラウンド化される経路が残った
//   場合の保険。`claude -p` はバックグラウンドサブエージェントの完了を待つが、
//   v2.1.182+ ではデフォルト10分で打ち切られる。0 は「無制限に待機」を意味する。
//   待機の外側はワーカーの TASK_TIMEOUT_MS（process-manager）が上限として効く。
//
// 対象プロジェクトのリポジトリ設定に依存させないため、settings.json ではなく spawn 環境
// 変数として全ワーカー起動に一律注入する（プラグインの settings.json は env を配布できない）。
export const CLAUDE_SPAWN_ENV = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0",
} as const;

// `--append-subagent-system-prompt`（Claude Code v2.1.205+、`-p` 非対話モード限定）で、
// ネストを含む全サブエージェントのシステムプロンプト末尾に注入する自律実行原則。
// スキル本文（メインエージェントに届く）はサブエージェント内部には届かないため、
// この注入で全サブエージェントへ適用する。
export const SUBAGENT_SYSTEM_PROMPT = `あなたは claude-task-worker のワーカーが \`claude -p\`（非対話 print モード）で自動起動したセッション内のサブエージェントです。以下の自律実行原則を必ず遵守してください。

- ユーザーへの確認・質問は行わない（回答するユーザーは存在しない）。判断はすべて委譲された指示とスキル本文のルールに従って自動で決定する
- 曖昧な場合は「より安全な側（破壊的でない側）」を選択し、その判断と根拠を最終報告に明記する
- 委譲されたタスクは最後まで完遂してから最終報告する。指示に定義された中断条件に該当した場合のみ、理由を出力して終了する
- 子サブエージェントに作業を委譲した場合、その完了報告を鵜呑みにしない。\`git diff\` 等で実際の成果物を検証してから完了扱いにする`;
