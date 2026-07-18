// ワーカーは各スキルを `claude -p`（非対話・自律実行）で起動する。以下のツールは
// この実行形態では原理的に使い道がない（または有害）なため、CLI の `--disallowedTools`
// で完全に無効化する。存在しないツール名は無害な no-op になるため、環境差は問題ない。
//
// 「入る」系だけを無効化し「出る」系（ExitPlanMode / ExitWorktree）は残す方針：
// 万一その状態で開始してもモデルが脱出できるようにするため。
//
// 補足: バックグラウンド実行が問題になる `Bash`/`Agent` は、フォアグラウンドなら正当な
// ため一律無効化できない。これらは各スキルの PreToolUse フック
// (`plugin/scripts/block-async-execution.mjs`) が条件付きで deny する。
// また `TaskCreate` 等の進捗管理、`WebFetch`/`WebSearch`/`LSP`/各種 MCP は正当な用途が
// あるため無効化しない。
export const DISALLOWED_TOOLS = [
  // 遅延 / yield: 後続ウェイクアップ前提。print モードには再起動ループが無いため、
  // 呼ぶと処理未完のままプロセスが終了する。
  "Monitor",
  "ScheduleWakeup",
  // SendMessage は過去に起動したサブエージェントをバックグラウンドでしか再開できず、
  // 「完了通知を待ちます」でターンを終える誘因になる。未完のサブエージェントへの追加指示は
  // フォアグラウンドの新規 Agent 起動で代替させる。
  "SendMessage",

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

// `--append-subagent-system-prompt`（Claude Code v2.1.205+、`-p` 非対話モード限定）で、
// ネストを含む全サブエージェントのシステムプロンプト末尾に注入するテキスト。
// `worker-skill-executor` エージェント定義や各スキルの PreToolUse フック
// (`plugin/scripts/block-async-execution.mjs`) はサブエージェント（`Agent`）内部の
// ツール呼び出しには届かないため、バックグラウンド実行禁止ルールはこの注入で
// 全サブエージェントへ適用する。
export const SUBAGENT_SYSTEM_PROMPT = `あなたは claude-task-worker のワーカーが \`claude -p\`（非対話 print モード）で自動起動したセッション内のサブエージェントです。print モードには再起動ループが無く、親エージェントがターンを終えた時点でプロセスが正常終了します。あなたが処理をバックグラウンド化して未完のまま制御を返すと、外側のワーカーが「正常完了」と誤認して GitHub Issue/PR のラベル状態が壊れます。以下のルールを必ず遵守してください。

- \`Bash\` を \`run_in_background: true\` で呼ばない。コマンド末尾に \`&\` を付けず、\`nohup\` / \`disown\` / \`setsid\` でプロセスをデタッチしない
- \`Agent\` ツールは既定がバックグラウンド実行のため、呼び出しごとに必ず \`run_in_background: false\` を明示し、フォアグラウンドで完了を待ってから次へ進む
- \`Skill\` ツールに \`run_in_background: true\` を指定しない
- \`Monitor\` / \`ScheduleWakeup\` / \`SendMessage\` などで処理を後回しにしない。「完了通知を待ちます」のような通知待ち状態でターンを終えない
- E2E テストのように時間のかかる処理も、同期実行で完了を待つのが正しい挙動であり、バックグラウンド化して待たずに進んではならない
- バックグラウンドタスクが残った状態で完了報告してターンを終えない。未完の処理はフォアグラウンドで完了まで実行し切ってから報告する
- ユーザーへの確認・質問は行わない（回答するユーザーは存在しない）。曖昧な場合は破壊的でない側を選び、その判断と根拠を最終報告に明記する`;
