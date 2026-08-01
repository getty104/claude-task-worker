# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build          # TypeScript → dist/
npm run dev            # Watch mode (auto-rebuild)
npm link               # Make CLI globally available

claude-task-worker init            # Create required GitHub labels
claude-task-worker exec-issue      # Poll dev-ready issues
claude-task-worker fix-review-point # Poll PRs with review feedback
claude-task-worker create-issue    # Poll cc-triage-scope issues whose blockedBy are all closed
claude-task-worker update-issue    # Poll update-issue labeled issues
claude-task-worker install         # Add marketplace, install plugin, install/update the CLI itself
claude-task-worker update          # Update the claude-task-worker plugin/marketplace and the CLI itself
claude-task-worker all             # Run all workers concurrently
```

## Architecture

ポーリングベースのCLIツール。GitHub Issues/PRを定期監視し、Claude CLIプロセスを起動してAI駆動タスクを実行する。

### コア構成

- **`src/index.ts`** - CLI エントリポイント。コマンドルーティング
- **`src/gh.ts`** - GitHub CLI (`gh`) ラッパー。全GitHub操作を集約
- **`src/process-manager.ts`** - 子プロセス管理。リアルタイムステータステーブル表示、プロセスライフサイクル管理
- **`src/table.ts`** - 端末テーブル描画のヘルパー。`getDisplayWidth()`/`truncateToWidth()`/`padToWidth()`（全角を幅2として扱う桁揃え）、`buildTaskTableLines()`（ステータステーブルの行組み立て）。`buildTaskTableLines()` は副作用を持たない純粋関数で、`process-manager.ts` の `renderTable()` が `console.clear()` + 出力のみを担う。**実行中/完了のセクション振り分けは `TaskTableEntry.status` で行い、表示用の status 文字列では判定しない**。herdr モードの実行中行は `running:working` のように agentStatus を併記した装飾済み文字列になるため、表示値で `=== "running"` を見ると実行中タスクが完了セクション（区切り罫線の下）へ紛れ込む
- **`src/commands/init.ts`** - GitHub ラベル初期作成コマンド。あわせて CodeGraph のセットアップ（グローバル gitignore への `.codegraph/` 登録 → `codegraph init` によるインデックス構築）も行う
- **`src/commands/install.ts`** - マーケットプレイス追加・プラグインインストール・CLI自体のインストール・CodeGraph CLI / DESIGN.md CLI のインストールを一括で行うコマンド
- **`src/commands/update.ts`** - プラグイン/マーケットプレイス・CLI自体・CodeGraph CLI / DESIGN.md CLI の更新コマンド
- **`src/commands/codegraph.ts`** - CodeGraph（`@colbymchenry/codegraph`）連携。`installCodegraphCli()`（`npm install -g` によるインストール）、`upgradeCodegraphCli()`（`codegraph upgrade` による更新。CodeGraph 自身の更新機構を使うことで配布方法の変更に追随できる。未インストール環境では `codegraph` コマンドが無く失敗するため `installCodegraphCli()` へフォールバックする）、`runCodegraphInit()`（`codegraph init`）、`ensureCodegraphGitIgnore()`（グローバル gitignore への `.codegraph/` 追記）、`globalGitIgnorePath()`/`appendIgnoreEntry()`（テスト可能な純粋関数）
  - **`codegraph install` はあえて実行しない**。同コマンドは各エージェントの設定ファイルへ MCP サーバー定義を書き込むが、その役割は本プラグインの `plugin/.mcp.json`（`codegraph serve --mcp`）が担っているため、両方走らせると同じサーバーが二重登録される。CLI のインストールだけを `npm install -g` で行う
  - グローバル gitignore（`~/.config/git/ignore`、`XDG_CONFIG_HOME` があればその配下）へ入れるのは、`.codegraph/` がプロジェクトごとのローカルインデックス（SQLite）でコミット対象ではない一方、対象リポジトリの `.gitignore` を汚したくないため。追記は冪等で、`.codegraph/` と `.codegraph` の両方を登録済みとみなす（`!.codegraph/` のような否定パターンは登録済み扱いにしない）
- **`src/commands/design-md.ts`** - DESIGN.md CLI（[`@google/design.md`](https://github.com/google-labs-code/design.md)）連携。`installDesignMdCli()` の1関数のみで、`install` / `update` の**どちらからも同じ関数を呼ぶ**（CodeGraph と違い self-upgrade 機構を持たないため、更新手段が `npm install -g <pkg>@latest` しかない。冪等なので分岐する意味がない）。同パッケージは bin として `design.md` と `designmd` の2つを提供するが、`.` を含む前者は環境によって解決に失敗するためスキル側は **`designmd` を既定**にしている
- **`src/runcat.ts`** - RunCat Neo 用の利用状況スナップショット書き出し。`~/.claude/runcat-usage.json`（`RUNCAT_OUT_FILE` で上書き可）へ一時ファイル + rename で原子的に書き込む。フォーマットは `~/dotfiles/claude/statusline.py` の出力と揃えてある（`buildRuncatSnapshot`/`resetStamp`/`resetHour`）。ただしリセット時刻は `ceilToMinute()` で秒以下を切り上げて分境界に揃える（API は `:59` 秒でリセット時刻を返すため、切り捨て表示だと 1 分手前に見える）。切り上げが日付・時をまたぐ場合はそれぞれ日付付き表示・次の時に繰り上がる。書き出しは `slack.ts` の `buildTokenLimitText()` 経由で行われるため、`usage` コマンド実行時に加えてワーカーのタスク完了/失敗通知のたびに更新される（Slack webhook 未設定でも通知が no-op になるだけでスナップショットは更新される）。ただし利用状況の取得自体は `/tmp/claude-usage-cache.json` の360秒キャッシュを挟むため、値の鮮度は最大6分古くなりうる
- **`src/workers/`** - 各ワーカー実装
- **`src/workers/ui-design.ts`** - UIデザイン先行ワークフローの純粋ヘルパー（`create-ui-design` / `apply-ui-design` が共有）。`designBranchName()`（`cc-ui-design-<N>`）、`hasDesignReference()`（description のデザイン参照セクション判定）、`classifyDesignPr()`（デザインPRの状態 → preflight 判定）、各種 Issue コメント本文。gh 依存を持たないため分岐だけをユニットテストできる
- **`plugin/`** - Claude Code プラグイン本体（`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `scripts/`, `.mcp.json`）
- **`.claude-plugin/marketplace.json`** - このリポジトリを Claude Code マーケットプレイスとして公開するための定義
- **`src/dispatcher.ts`** - ディスパッチャー本体。`runDispatcher()`（herdr疎通確認 → プロジェクトごとに**ワークスペース**を作成しルートペインへコマンド送信。ラベルは `workspaceLabelFor()` で `ctw:` プレフィックス付き（`LABEL_PREFIX`）にし、既存ワークスペースの重複判定も同プレフィックスで行う。ルートタブも同ラベルへ `tabRename()` する）、`startWorkerInPane()`（プロンプト待ち `waitForPaneReady()` → コマンド送信 → 起動確認 `waitForWorkerStartup()` → 未起動なら再送）、`monitorSessions()`（セッション生存監視＋ステータステーブル描画ループの起動）、`renderSessionTable()`（稼働セッション一覧のテーブル描画）、`shutdownDispatcher()`（SIGINT/SIGTERM時、各セッションへctrl-c送信 → 終了待機 → **ワークスペースクローズ**のグレースフルシャットダウン。ワークスペースごと閉じることで herdr モードのタスクタブも一緒に片付く）
- **`src/herdr.ts`** - herdr CLIラッパー。`workspaceCreate`/`workspaceList`/`workspaceClose`/`workspaceFocus`（ワークスペース管理。`workspaceList` の `focused` はフォーカス復元の判定に使う）、`tabCreate`/`tabRename`/`tabClose`/`tabList`（タブ管理）、`agentStart`（既存ペイン（タスクタブのルートシェル）で `herdr agent start <name> --kind claude --pane <id> --timeout <ms> -- <args>` を使って claude(TUI) を起動。実行ファイルは `--kind` が供給するため `--` の後ろへ渡すのは claude のフラグだけ。**agent として検出され入力待ちになる（interactive_ready）まで同期的にブロックする**ため、旧 send-text 方式の「起動 → 検出待ちポーリング」を1コマンドで担う。返り値は `agent get` と同じ `AgentInfo` に正規化）、`AGENT_KIND`（`"claude"`）/`AGENT_START_READY_TIMEOUT_MS`（`--timeout` の既定。最大300000ms）、`agentGet`（agentステータス取得。`agent_session.kind === "id"` のときは claude のセッションIDも返す）、`paneSendText`/`paneSendKeys`（ペインへの入力送信。`paneSendText` は dispatcher の転送コマンド送信で使う）、`paneRead`（ペインの端末内容取得）、`paneGet`/`paneClose`、`paneProcessInfo`（フォアグラウンドプロセス確認）、`getCurrentWorkspaceId`（herdrが各ペインへ自動注入する `HERDR_WORKSPACE_ID` の読み出し）、`checkHerdrAvailable`（herdr導入・疎通確認）
  - **`agent start` は herdr の `--timeout`（検出完了までブロック）より execFile 側のタイムアウトを長く取る**（`runHerdr`/`execHerdr` は `timeoutMs` オプションを受け付け、`agentStart` は `AGENT_START_READY_TIMEOUT_MS + バッファ` を渡す）。短いと検出待ちの途中で execFile が SIGKILL してしまう。cwd と env は `tabCreate` の `--cwd` / `--env` でペインへ渡し、そこで起動する claude が継承する。`agent start` は対象ペインが**シェルプロンプトにいること**を前提とするため、呼び出し側は起動前に `waitForPaneReady` でプロンプト描画を待つ（herdr-runner 参照）
  - **`--cwd` は必ず絶対パスへ解決してから渡す**（`cwdArgs()`）。`--cwd` を解決するのはワーカーではなく herdr サーバー（別プロセス）のため、相対パスを渡すとワーカーのcwdではなく herdr サーバーのcwd基準で解決される。実測では**エラーにならず黙ってホームディレクトリで起動**するため、worktree を渡したつもりのタスクがリポジトリ外で走る。`getWorktreePath()` は相対パス（`.claude/worktrees/<id>`）を返し、default モードの `spawn({cwd})` はワーカーのcwd基準で正しく解決されるため、この差は herdr モードでだけ牙をむく
  - herdr は大半のコマンドで「終了コード0＋stdoutにJSON」を返すが、一部（実測では存在しないタブへの `tab close`）は「終了コード非0＋**stderr**にJSON」を返す。`runHerdr()` は stdout から error を取れなかった場合のみ stderr も解析し、どちらの形でも `HerdrError`（`code` 付き）にする。取り出せないと `stopHerdrTask()` の「`tab_not_found` は正常系」判定が効かず、claudeがグレースフル終了するたびに偽のエラーログが出る。ただし `result`（成功値）の取得元は stdout のみ
- **`src/transcript.ts`** - Claude Code のセッション transcript（`~/.claude/projects/*/<sessionId>.jsonl`）から最終レポートを取り出す。`findTranscriptPath()`（セッションIDでディレクトリを総なめ）、`extractFinalAssistantText()`（末尾から最初に見つかる非 sidechain のアシスタントテキスト。純粋関数）、`readFinalReport()`。herdr モードで `claude -p` の stdout の代わりに Slack 通知本文を作るために使う
- **`src/herdr-runner.ts`** - herdrモードのタスク実行。`startHerdrTask()`（`tabCreate`（`--no-focus`）→ `waitForPaneReady`（シェルプロンプト描画待ち）→ `agentStart`（ルートペインで `herdr agent start --kind claude` を使って claude を起動し、検出＋入力待ちになるまで同期ブロック）。`agent start` が検出できなければ herdr がエラーを返し `agentStart` が throw するので、シェルだけのタブを残さないよう閉じてから失敗させる。ルートペインがそのまま claude のペインになるため余剰シェルペインの `paneClose` は不要。**渡す `args` は claude のフラグのみで実行ファイル `claude` は含めない**（`--kind` が供給））、`waitForHerdrTask()`（agentステータスのポーリング。`done` または `working`→`idle` で完了、`pane_not_found`/`agent_not_found` で失敗、`blocked` は待機継続）、`buildHerdrTaskResult()`（ペイン出力が空なら空振りとして失敗扱い）、`stopHerdrTask()`（ctrl-c送信 → `waitForAgentGone` → タブクローズ）、`taskTabLabel()`（`ctw:<project>:#<n>`）
- **`src/user-config.ts`** - `config.json`（`~/.config/claude-task-worker/config.json` または `$XDG_CONFIG_HOME` 配下）のロード・検証・対象プロジェクト解決。`UserConfig`（`mode`/`advisor`/`projects`/`projectGroups`）、`loadUserConfig()`（読み込み・検証）、`resolveTargetProjects()`（プロジェクト名/グループ名/予約語 `all` の展開）、`getRunMode()`（`mode` の解決。設定ファイル不在・projects破損でも `"default"` を返し、プロセス内でキャッシュする）、`isAdvisorEnabled()`（`advisor` の解決。`getRunMode()` と同じく設定ファイル不在・破損でも既定＝無効を返し、プロセス内でキャッシュする。後述の「`advisor`（アドバイザーモデル）」参照）、`findProjectNameByPath()`（herdrモードのタブラベル用にパスからプロジェクト名を逆引き）。リポジトリ直下の `claude-task-worker.json` を扱う `src/config.ts` とは別物
- **`src/dispatch-args.ts`** - `--project` ディスパッチ用CLI引数ヘルパー。`PROJECT_INCOMPATIBLE_COMMANDS`（`--project` と併用不可なコマンド一覧: `init`/`install`/`update`/`usage`/`version`）、`parseProjectFilters()`/`hasProjectFilter()`（`--project` の抽出・検出）、`buildForwardedCommand()`（`--project` とその値を除去し他プロジェクトへ転送するコマンド文字列を構築）

### Worker共通ライフサイクル

1. `gh api user` / `gh repo view` で現在ユーザー・リポジトリ情報取得
2. 一定間隔（ワーカーごとに設定）でGitHub APIをポーリング
3. ラベル・アサイン条件でフィルタリング
4. `isRunning()` で重複実行防止
5. トリガーラベル除去 → `cc-in-progress` ラベル付与
6. `.claude/worktrees/<worktreeId>` にワーカー自身がworktreeを生成し（`claude --worktree` は locked worktree の残骸問題があるため不使用）、Claude CLI をそのworktreeをcwdとして起動する（`mode: "default"` は `claude -p` の非同期spawn、`mode: "herdr"` は herdr のタスク専用タブでTUI起動。後述の「`mode`（タスクの実行形態）」参照）
7. 完了時コールバックでラベル・worktree・ローカルブランチをクリーンアップ

サブIssue（`parent` を持つIssue）の worktree は `cc-epic-<parent番号>` から作られる（`issue-worker.ts`）。**分析系スキルもこのベースブランチを「ターゲットブランチ」として明示的に導出する**（`create-issue-from-issue-number` / `update-issue` / `answer-issue-questions` の冒頭ステップ。導出ロジックは `exec-issue` / `create-pr` と同一の parent → upstream → default の順）。worktree 自体は正しく epic ブランチ由来なのに、スキル本文がベースブランチの概念を持たないと、モデルが暗黙にデフォルトブランチをターゲットと見なし、**Epic PR（`cc-epic-<N>` → デフォルトブランチ）が未マージであること**を「マージされていないがどうするか」という本来不要な検討事項・確認事項として description や回答コメントへ書き込む。同ステップでは (1) デフォルトブランチとの差分を論点にしない、(2) Epic PR の未マージは正常状態として確認事項化しない、(3) `gh pr list` の関連PRは `baseRefName == BASE_BRANCH` のものだけを対象にする（Epic PR 自身を除外する）、の3点を規定している。

ワーカー起動時には `removeStaleWorktrees()` が前回の異常終了で残ったworktree（`adj-noun-4桁` の生成名パターンのみ対象）を回収する。実行中タスクのworktree・lockedな対話セッションのworktreeは削除対象から保護される。

### 同期実行ガード（`claude -p` セッションの早期終了防止）

ワーカーは各スキルを `claude -p "<skill> <n>"` の非対話（print）モードで起動する。print モードには再起動ループが無いため、処理が未完のままターンが終わるとプロセスが exit 0 で終了し、ワーカーが「正常完了」と誤認してラベル遷移（`cc-pr-created` 付与や `cc-fix-onetime` 除去）に進み、Issue/PR の状態が壊れる。これを防ぐガードは以下の構成:

1. **spawn 環境変数**（`src/claude-args.ts` の `CLAUDE_SPAWN_ENV`、`process-manager.ts` の spawn で `process.env` に上書きマージ）: 全ワーカー起動に一律注入される。対象プロジェクトのリポジトリ設定に依存させないため、settings.json ではなく spawn 環境変数で渡す（プラグインの settings.json は env を配布できない）。
   - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`: Claude 管理下のバックグラウンド機構（Bash の `run_in_background`・サブエージェントの自動バックグラウンド化）のみを無効化する。`nohup`/`disown`/末尾 `&` によるシェルレベルの detach や `docker compose up -d` 等が起動する切り離しプロセスまでは防げないため、未完のままターンが終わる事故を完全には防止できない（Stop フックによる起動プロセスの後片付けや、下記4のワーカーレベル完了検証が引き続き必要）。プロンプトでのバックグラウンド禁止ルールやツール単位のガードは不要になった（かつて存在した PreToolUse フック `block-async-execution.mjs` と `worker-skill-executor` エージェントは撤去済み）。
   - `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`: 万一バックグラウンド化される経路が残った場合の保険。`claude -p` のバックグラウンドサブエージェント待機（v2.1.182+ でデフォルト10分上限）を無制限にする。ワーカー側にタスク実行時間の上限は設けていない（長時間タスクを途中で強制終了するとラベル・worktreeが中途半端な状態で残るため）。
2. **CLI レベルの `--disallowedTools`**（`src/claude-args.ts` の `DISALLOWED_TOOLS`）: 自律非対話実行では原理的に使い道がない（または有害な）ツールを完全無効化する。対象カテゴリ:
   - 遅延/yield: `Monitor` / `ScheduleWakeup`（後続ウェイクアップ前提だが print モードでは発火せず、プロセスが早期終了する）
   - 対話/承認: `AskUserQuestion` / `EnterPlanMode`（回答・承認するユーザーが存在しない）
   - スコープ外の副作用: `CronCreate` / `CronDelete` / `CronList` / `RemoteTrigger`（クラウド routine・リモート環境への副作用）
   - 環境管理の競合: `EnterWorktree`（ワーカー自前の worktree 管理と競合する）
   - `Exit*`（`ExitPlanMode` / `ExitWorktree`）は「万一その状態で開始した場合の脱出口」として残す。`TaskCreate` 等の進捗管理・`WebFetch`/`LSP`/各種 MCP（正当な用途あり）は無効化しない。
3. **自律実行原則のシステムプロンプト注入**（`src/claude-args.ts`）: `systemPromptFor(model)` の本文を `--append-system-prompt-file <path>` で注入する（`os.tmpdir()/claude-task-worker/append-system-prompt-<pid>-<variant>.txt` へバリアント単位で一度だけ原子的に書き出し、そのパスを渡す `systemPromptFilePath(model)`。`variant` は `opus` / `default` で、opus と sonnet のワーカーが同一プロセスで並走する `all` / `--project` 実行でも互いのファイルを上書きしないようにしている。モデル別の出し分けは後述の「モデル別システムプロンプト」参照）。**文字列を `--append-system-prompt` で直接渡さないのは herdr モードのため**。herdr は agent 引数を `herdr agent start ... -- <args>` としてターゲットシェル経由で起動するが、**改行を含む引数**を `invalid_agent_argument`（"agent arguments cannot be encoded safely for the target shell"）として拒否する。複数行のシステムプロンプトをインラインで渡すと herdr モードのタスク起動が必ずこのエラーで失敗するため、内容をファイルへ逃がして引数から改行を除く。default モード（spawn。シェルを介さないので改行自体は問題ない）でも同じファイル参照を使い、両モードの引数を一致させる。内容は「ワーカーから自動起動されている・ユーザーに質問しない・全ステップを完遂してから終了する・曖昧なら安全側を選び根拠を報告する」に加えて、サブエージェント向けの原則（委譲時に同原則を伝える・子の完了報告を鵜呑みにせず成果物を検証する）も含む。かつてサブエージェントへは `--append-subagent-system-prompt` で直接注入していたが、同フラグは `-p` 非対話モード限定で herdr モードの TUI 起動では使えず、実行形態によって原則の届き方が変わってしまうため、注入経路を `--append-system-prompt` 一本へ統合した（メインエージェントが委譲プロンプトで伝える形になり、注入の確実性は下がるトレードオフを受け入れている）。文面も実行形態に依存しない表現にしてある。スキル本文に自律実行原則を複製しないのは、対話セッションでスキルを手動実行する場合は実在するユーザーと対話してよいため。あわせて**コード探索の原則（CodeGraph 優先）**も同プロンプトに含める（テキスト検索より優先する・**利用可否は codegraph 系 MCP ツールの有無だけで判断する**・無ければ即テキスト検索へ・インデックスのセットアップはしない・返ったソースは読み終えたものとして扱う・委譲時は方針も伝える）。詳細な手順は `plugin/agents/explore-agent.md` にあるが、それはメインエージェント自身が探索する場合や explore-agent 以外のサブエージェントへ委譲する場合には届かないため、全セッション共通の原則としてシステムプロンプト側にも置いている。
4. **ワーカーレベルの完了検証**（`src/workers/exec-issue.ts` / `epic-issue.ts` の `onCompleted`）: 上記をすり抜けて exit 0 で終了しても、期待成果物を検証できるまでラベル遷移しない最後の砦。exec-issue は「Issue がクローズ済み（変更不要パス）」または「作業ブランチ（worktreeId）を head とする PR か Issue を closing 参照する PR の実在」を確認できた場合のみ `cc-pr-created` を付与し、確認できなければ `cc-need-human-check` を付与して Issue に状況コメントを残す。epic-issue は `cc-epic-<N>` を head とする Epic PR の実在確認後にのみ `cc-pr-created` を付ける。`onCompleted` が `false` を返すと `issue-worker.ts` は完了通知ではなく失敗通知（Slack）を送る。

ワーカー起動スキル12個（`exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue-from-issue-number` / `update-issue` / `triage-created-issue` / `triage-pr` / `resolve-pr-conflict` / `check-dependabot` / `create-epic-pr` / `create-ui-design` / `apply-ui-design`）の本文の「実行モードの制約」セクションには、スキル固有のリスク（どのラベル遷移が壊れるか）のみを記述する（自律実行原則は上記 3 の CLI 注入に一元化されており、スキル本文には複製しない）。

### 実装のサブエージェント委譲（`exec-issue` / `fix-review-point`）

両スキルはタスクをサブエージェントへ委譲する設計だが、委譲の是非は**モデル世代で逆方向に振れる**。かつては選定基準（フェーズ2）とブリーフィング（フェーズ3）を書くだけでは**メインエージェントが自分で実装してしまう**（委譲のオーバーヘッドを避ける方向に倒れる）ため、`exec-issue` は「フェーズ3の実装タスク本体は規模を問わず全件委譲」という無条件ルールで押し切っていた。Opus 5 は逆に**以前のモデルより積極的に委譲する**（[Opus 5 のプロンプティング](https://platform.claude.com/docs/ja/build-with-claude/prompt-engineering/prompting-claude-opus-5)）ため、全件委譲を強制すると小粒タスクでコストと時間が倍になるだけになる。この無条件ルールは撤去した。

委譲1回のコストはブリーフィング作成（500〜1500トークン）＋サブエージェント側の再探索（会話履歴を持たないため、対象箇所と経緯を引き直す）で、1ファイル数行の修正では直接編集より一桁高くつく。委譲が本当に効くのは (1) メインのコンテキスト消費を実装ログから隔離できる、(2) 独立タスクを並列化できる、(3) `lightweight-assistant`（sonnet/low）へ単価を落とせる、(4) `frontend-implementer` 等の専門エージェントの前提知識を使える、の4点であり、いずれも小粒タスクでは効かない。

そのため両スキル本文には「実装の委任（判断ロジック）」セクションを置き、**着手前に判定させる3ステップ**を規定している（フェーズ境界ではなくタスクの性質で判定するため、両スキルで条件が揃っている）:

1. **無条件委譲**（1つでも該当したら即委譲）: UI実装・`.pen` 編集、2ファイル以上、新規ファイル作成、着手前に探索が必要（対象パスとシンボル名を即答できない）、20行超、依存/設定/スキーマ変更、並列化できるタスクが他に2件以上。`fix-review-point` はこれに「設計・責務分割・安全性の再考を求める指摘」を加える（要約して渡すと劣化するためコメント全文で委譲する）
2. **直接実装の許可条件**（**すべて**満たす場合のみ）: ステップ1に非該当、単一ファイル・10行以内、対象箇所が既にメインの文脈にある（`file:line` が判明している／`Read` 済み／CodeGraph 出力に含まれる）、変更内容が一意に定まる、他のサブエージェントの待ちを遅らせない
3. **判定が割れたら委譲**（「たぶん小さい」は根拠にならない）

あわせて**委譲の量の制御**を置く: 1タスクに1エージェント（1体で足りるものに複数体を重ねない）・**検証目的でサブエージェントを起動しない**（成果物の確認は `git diff` とテスト実行でメインが行う）・並列起動は対象ファイルが重ならない独立タスクに限る。Opus 5 が過剰に委譲・過剰に検証する方向へ倒れるのを抑えるためのガードで、同ガイドの「サブエージェントの生成の制御」「タスクのスコープと過剰な検証」に対応する。

さらに**滑り坂ガード**を置く。小修正の直接実装を積み上げて実装丸ごとを自分でやってしまう事故を防ぐためで、1回ごとに独立判定する・直後にテストを再実行する（`exec-issue`）／範囲を広げない（`fix-review-point`）・**3回に達したら以降はすべて委譲へ切り替える**の3点。3回直しても収束しない状況は「変更内容が一意に定まる」という許可条件がそもそも成り立っていないことを意味する。

判定の実態を観測できるよう、最終報告に「実装委任の自己監査」（起動したサブエージェントの内訳／直接編集の件数・対象・満たした条件）を必須項目として出力させる。Slack 通知本文に残るため、規則が形骸化していないかを後から追える。

ツール単位の機械的な強制は行っていない。`--disallowedTools` はセッション全体（サブエージェント含む）に効くため `Edit` を落とすと委譲先も動かせず、PreToolUse フックでメイン／サブエージェントを判別できるかは未確認のため。

### Opus 実行スキル/エージェントのプロンプト方針

`WORKER_DEFAULTS`（`src/config.ts`）で `model: "opus"` のワーカー（`exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue`（`create-issue-from-issue-number`）/ `create-ui-design` / `update-issue` / `resolve-conflict`）と、`model: opus` のエージェント（`frontend-implementer` / `pencil-design-updater` / `requirement-todo-organizer`）は、[Opus 5 のプロンプティング](https://platform.claude.com/docs/ja/build-with-claude/prompt-engineering/prompting-claude-opus-5)に合わせて以下を本文に持たせる。いずれも Opus 5 が既定で強く出る挙動（冗長化・スコープ拡大・過剰委譲・過剰検証）を抑える方向の指示で、**モデルが元からやることを繰り返し指示しない**（自己修正・再検証の指示は入れない）方針も含む。

- **スコープの規律**: 依頼された範囲だけを実装/回答/分解し、気づいた別の改善は成果物に混ぜず報告へ1行で挙げる。依頼が誤っていると考える場合も、指摘を1-2行添えたうえで依頼どおりのスコープで完遂する（黙って縮小・拡大・別物への置き換えをしない）。Issue description・TODOリスト・`.pen` は後段の実装スコープそのものになるため、ここが膨らむと実装まで膨らむ
- **成果物の分量**: Issueコメント・PR body・description・最終報告は「必要な実質だけ」。同じ内容の言い換え・埋め草セクション・該当なしの節を書かない。最終報告は結論（何をしたか／どこで止まったか）から書く。Opus 5 はディスクに書くドキュメントも会話も既定で長いため、明示的な分量指示が必要
- **委譲の量**: 前節「実装のサブエージェント委譲」のとおり、1タスク1エージェント・検証目的の起動禁止・並列は独立タスクのみ
- **反復の上限**: ビジュアル一致の詰め（`frontend-implementer` の最大5往復、`pencil-design-updater` の最大5往復／再実行最大3回）に上限を設け、残差分は理由付きで報告して完了させる。「完全に一致するまで」だけを指示すると収束しないケースで無限に詰め続ける
- **サブエージェントは人に質問できない**: `frontend-implementer` / `pencil-design-updater` は自動起動セッションから呼ばれるため、旧文面の「ユーザーに質問する／案内する／確認を求める」を「自力で既定値を選び根拠を報告する」「事実と残課題を報告して終了する」へ置き換えてある（応答するユーザーが常駐しないため、質問して止まると呼び出し元が空の成果を受け取る）

これらのうち「スコープ」「成果物の分量」「委譲の量」「過剰検証の抑止」は、スキル/エージェント本文に加えて **`src/claude-args.ts` の `OPUS_SYSTEM_PROMPT_ADDENDUM`（opus 実行時のみ注入）にも置いてある**（下記「モデル別システムプロンプト」参照）。スキル本文はそのスキルの局所的な規定であり、セッションを跨いだ挙動やサブエージェントには届かないため。

#### モデル別システムプロンプト（`systemPromptFor()`）

`--append-system-prompt-file` で注入する本文は「全モデル共通の基底 ＋ opus のみの追補」の2段構成（`src/claude-args.ts`）。

- **`SYSTEM_PROMPT_BASE`**: 従来の `SYSTEM_PROMPT`（自律実行原則・サブエージェント原則・CodeGraph 優先）。全モデルに注入する
- **`OPUS_SYSTEM_PROMPT_ADDENDUM`**: opus のときだけ基底の末尾に連結する。内容は Opus 5 の既定挙動（冗長化・スコープ拡大・過剰委譲・過剰検証）への逆張り 4 点
- **`systemPromptFor(model)`**: 上記の組み立て。`isOpusModel(model)` は `model` を小文字化した**部分一致**で判定する（`claude-task-worker.json` の `workers.<name>.model` はエイリアス `opus` でもフルID `claude-opus-5` でも指定できるため）。未知の値は「opus ではない」＝基底のみへ倒す

**sonnet 側に追補を持たせていない**のは、追補が Opus 5 固有の既定挙動への調整であり、sonnet では逆に検証や委譲を促す指示が要るケースがあるため。基底のみ＝本機構の導入前と完全に同一の挙動になる（sonnet ワーカーに対する挙動変更はゼロ）。sonnet 向けの調整が必要になった場合は `systemPromptFor()` に sonnet 用の追補を足す形で拡張する。

書き出しファイルは `append-system-prompt-<pid>-<variant>.txt`（`variant` は `opus` / `default`）。**バリアントをファイル名に含めるのは必須**で、共有パスにすると `all` / `--project` 実行で opus と sonnet のワーカーが同一プロセス内で並走した際、後から起動した側の書き込みが先の内容を上書きしてしまう（claude はプロセス起動時にこのファイルを読むため、取り違えた原則が注入される）。

### Sonnet 実行スキル/エージェントのプロンプト方針

`model: "sonnet"` のワーカー（`triage-created-issue` / `triage-pr` / `check-dependabot` / `epic-issue` / `apply-ui-design`、および `DEFAULT_WORKER_CONFIG`）と `model: sonnet` のエージェント（`explore-agent` / `general-purpose-assistant` / `lightweight-assistant`）、`model: sonnet` の補助スキル（`create-review-fix-plan` / `create-pr` / `commit-push` / `check-library` / `resolve-pr-comments`）は、[Sonnet 5 のプロンプティング](https://platform.claude.com/docs/ja/build-with-claude/prompt-engineering/prompting-claude-sonnet-5)に合わせて以下を持たせる。opus 側の調整（冗長化・スコープ拡大・過剰委譲の抑制）とは**方向が違う**点に注意（Sonnet 5 は指示をより文字通りに解釈し、低 effort ではスコープを求められた範囲に限定するため、抑制ではなく「基準の具体化」と「必要な深さの確保」が要る）。

- **定性的な軽重で切らせない**: 「重要な」「軽微な」といった主観語で判定を分けると、Sonnet 5 はその基準に忠実に従って報告・対応を落とす。判定は具体的な基準線で書く。`triage-pr` の二分判定は「不正な動作・テスト失敗・誤解を招く結果・将来の障害につながる設計上の穴を引き起こしうる指摘はすべて対応すべき」「対応不要に落とすのは列挙6項目に具体的に該当する場合のみ」に書き換えてある（旧「非クリティカルパスへの指摘＝対応不要」は、マージゲートである本スキルで取りこぼすと誰も直さないまま PR がマージされるため撤去）
- **例示リストには判定基準を併記する**: Sonnet 5 は列挙されていないケースへ指示を暗黙に一般化しない。「例であり網羅ではない」だけでは列挙外のシグナルを取りこぼすため、`triage-created-issue` のパターンA（人間確認シグナル・確認事項の個別評価）には**リストの当てはめではなく満たすべき基準**を1行で明記してある
- **低 effort エージェントに深追いを強いない/浅すぎさせない**: `explore-agent`（effort: low）は「労力は徹底度で決めるが、問いに答えるのに必要な深さ（呼び出し関係の段数など）は削らない」と明示。`lightweight-assistant`（effort: low）は逆に、探索が必要・2ファイル以上・多段の推論が要る依頼を**呼び出し元へ差し戻す**基準を持たせ、低 effort で押し切らせない
- **`lightweight-assistant` の本文は軽量タスク専用に書き換えた**: 以前は `general-purpose-assistant` のほぼ複製で「包括的な問題分析」「TDD の実践」「レイヤーアーキテクチャの遵守」まで載っており、sonnet/low の単一ステップ用エージェントとしては自己矛盾していた（宣言された用途と本文の要求が食い違う）
- **進捗ナレーションの強制スキャフォールディングを外した**: Sonnet 5 は長いエージェント的トレース中に自前で適度な更新を出すため、「各ステップの結果を報告する」「作業の各段階で状況を報告する」は削除し、「重要な発見・方針転換時のみ」＋「完了報告は結論から」に置き換えた（`general-purpose-assistant` / `lightweight-assistant`）
- **サブエージェントは人に質問できない**: opus 側と同じ理由で、`general-purpose-assistant` / `lightweight-assistant` / `check-library` の「ユーザーに確認する」を「安全側の既定を選んで前提を報告する」「差し戻す」へ置き換えた
- **探索手段の指示を CodeGraph 優先へ統一**: `general-purpose-assistant` に残っていた「LSPツールを最優先」は、システムプロンプトおよび `explore-agent` の CodeGraph 優先方針と矛盾していたため、CodeGraph → LSP → `Grep`/`Glob` の順に修正した

effort は全 sonnet ワーカーで `high` のまま（Sonnet 5 の既定）。同ガイドは「最も難しいコーディング/エージェント的タスクには `xhigh`」を推奨しているが、浅い推論が観測された場合の対処であり、観測なしで上げるとコストだけ増えるため据え置いてある。上げる場合は `claude-task-worker.json` の `workers.<name>.effort` で指定する（プロンプト側で深く考えさせようとするより効果的、というのが同ガイドの指針）。

### 空振りセッションガード（スキルプリアンブル失敗による無限リトライ防止）

SKILL.md のプリアンブル（`!` インライン実行）のコマンドが失敗すると、`claude -p` セッションは**モデル未起動のまま何も出力せず exit 0 で終了する**。ワーカーはこれを正常完了と誤認してラベルを巻き戻すため、トリガーラベルが再装填される triage-pr では毎ポーリングで空振りセッションを起動し続ける無限リトライループになる（実例: `gh pr checkout` プリアンブルが「PRブランチを別worktreeがcheckout中」で失敗し、一晩で約700回の無出力実行と Slack 通知が発生）。対策は3層:

1. **スキル側**: プリアンブルに失敗しうるコマンドを置かない（置く場合は `|| true` で非致命化する）。`gh pr checkout` は本文の「ステップ0」に移し、失敗時はエラー内容を含む結果報告を出して終了させる（`triage-pr` / `check-dependabot`）。
2. **ワーカー側のプリフライト**（`src/workers/pr-worker.ts`）: `deleteLocalBranch` 後もPRブランチが残存する場合（locked worktree・実行中タスク・管理外worktreeがcheckout中）、スキル内の `gh pr checkout` が失敗すると分かっているため claude を起動せずそのtickをスキップし、ブロッカー解消後のポーリングで自然再開させる（`localBranchExists`）。
3. **プロセスレベルの空出力検知**（`src/process-manager.ts` の `buildTaskResult`）: `claude -p` は正常完了時に必ず最終レポートを stdout に出力するため、exit 0 でも stdout が空（空白のみ含む）の実行は失敗として分類し、失敗通知を送る。あわせて stderr を末尾8KBまで保持し、失敗通知に含めて原因調査を可能にする（従来は stderr を破棄していたため失敗通知が空になっていた）。

### Stopフックによる起動プロセスの後片付け（`plugin/scripts/stop-servers.mjs`）

上記の同期実行ガードでバックグラウンドタスク機能を無効化しても、`docker compose up -d` やE2E/テストランナーが起動するWebサーバーのように、claudeプロセスから切り離されて init/launchd に再ペアレントされるサーバー・プロセスは、スキル完了後もポートを掴んだまま残留しうる。ワーカーはスキル終了直後にそのworktreeを削除するため、worktreeをcwdに持つ残留プロセスはリソースを浪費するだけでなくworktree削除の妨げにもなる。

これを防ぐため、ワーカー起動スキルのフロントマターに `Stop` フック（`plugin/scripts/stop-servers.mjs`）を設ける。スキルの `claude -p` セッション終了時に起動プロセスをベストエフォートで停止する（フックは常に exit 0 を返しスキルを異常終了させないが、即座に返るわけではなく、各サブコマンドの `timeout` 分は同期的に待機しうる。支配的なのは `docker compose down` の最大120秒待機）。処理は2段階:

1. **`docker compose down --volumes --remove-orphans`**: 実行cwd直下に compose ファイル（`docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml`）が存在する場合のみ実行。docker未導入・未起動でも無視して継続する。
2. **worktree配下を作業ディレクトリに持つ残留プロセスへ `SIGTERM`**: 実行cwd（worktree、`.claude/worktrees/<adj-noun-NNNN>` で一意）を cwd に持つプロセスだけを対象にする。切り離されたプロセスも起動時の cwd を保持し、worktree名はこの実行に固有なため、「この実行が起動したプロセス」だけを、ユーザー自身や別実行のプロセスに触れずに特定できる。ただし本フック自身の祖先チェーン（node フック・そのシェル・`claude` プロセスはいずれもworktreeをcwdに持つ）は除外し、自プロセスの巻き添え停止を防ぐ。プロセス列挙は Linux では `/proc/<pid>/cwd`、macOS 等では `lsof` を用いる。

判定ロジック（`selectPidsToKill` / `parseLsofCwds` / `isUnder` / `resolveTargetDir`）は純粋関数として export し、`plugin/scripts/stop-servers.test.mjs` でユニットテストする。対象スキルは同期実行ガードと同じ12スキル（`exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue-from-issue-number` / `update-issue` / `triage-created-issue` / `triage-pr` / `resolve-pr-conflict` / `check-dependabot` / `create-epic-pr` / `create-ui-design` / `apply-ui-design`）。

### `advisor`（アドバイザーモデル）

`config.json` のトップレベル `advisor`（boolean、既定 `false`）で、タスク起動時に claude CLI へ `--advisor <model>` を渡すかを切り替える。`mode` と同じくトップレベル一括（プロジェクト単位・ワーカー単位のオン/オフはできない）で、`isAdvisorEnabled()` がプロセス起動時に一度だけ解決してキャッシュするため、実行中に設定ファイルが書き換わってもワーカー間・タスク間で `--advisor` の有無が揺れない。

渡すモデルはリポジトリ直下の `claude-task-worker.json` の `workers.<name>.advisorModel`（`WorkerRuntimeConfig.advisorModel`）で指定する。ゲートは2段:

1. `advisor: false`（既定）なら `advisorModel` の指定に関わらず渡さない。判定はワーカー側（`issue-worker.ts` / `pr-worker.ts`）で行い、無効時は `buildClaudeExecution()` へ空文字を渡す
2. `advisorModel` が空文字（または未指定でその既定が空文字）なら `buildClaudeArgs()` が `--advisor` ごと省く。**値なしの `--advisor` を渡すと後続フラグを値として食われる**ため、必ずモデル名とセットでのみ付ける

`advisorModel` のパースは `parseWorkerEntry()` の他フィールドと違い**空文字を有効値として受け付ける**（「advisor を使わない」の明示指定）。既定値は claude 側の制約（advisor は main モデル以上の能力が必要）に合わせ、`model` が `sonnet` のワーカーは `"opus"`、`model` が `opus` のワーカーは `""` にしてある。

### `mode`（タスクの実行形態）

`config.json` のトップレベル `mode`（`"default"` | `"herdr"`、既定は `"default"`）で、ワーカーが1タスクをどう起動するかを切り替える。プロジェクト単位・ワーカー単位の指定はできない（トップレベル一括のみ）。`getRunMode()` はプロセス起動時に一度だけ解決してキャッシュするため、実行中に設定ファイルが書き換わっても「引数の組み立て（`-p` の有無）」と「実行経路（spawn / herdr）」が食い違わない。

- `"default"`: 従来どおり `claude -p` を子プロセスとしてspawnし、exit code と stdout で成否を判定する
- `"herdr"`: herdr のタスク専用タブで claude をTUI起動し、agentステータスで完了を判定する。`mode: "herdr"` かつ herdr が未導入・未起動の場合はワーカー起動時に `assertRunModeAvailable()`（`src/index.ts`）がエラー終了させる（`"default"` へのサイレントフォールバックはしない）

`mode: "herdr"` の1タスクの流れ（`src/process-manager.ts` の `runViaHerdr()` と `src/herdr-runner.ts`）:

1. `tabCreate` で `ctw:<project>:#<番号>` ラベルのタスク専用タブを `--no-focus` で作り（ユーザーが見ているタブに割り込ませないため）、その**ルートペイン（シェル）で `agentStart`（`herdr agent start --kind claude --pane <id> -- <args>`）を使って** claude(TUI) を起動する。`agent start` はペインのシェルで claude を起動し、**agent として検出され入力待ちになるまで同期的にブロックする**（旧 send-text 方式の「起動コマンド送信 → 自動検出待ちポーリング」を1コマンドで担う）。実行ファイル `claude` は `--kind` が供給するため、`--` の後ろへ渡すのは claude のフラグだけ。ルートペインがそのまま claude のペインになるため、split で余ったシェルペインを `paneClose` する処理は不要。`waitForPaneReady`（シェル初期化中に呼ぶと `agent start` が失敗しうるレース対策で、プロンプト描画を待つ）→ `agentStart`（検出できなければ herdr がエラーを返して throw、シェルだけのタブを閉じてから失敗確定）の順。ワークスペースは herdr が注入する `HERDR_WORKSPACE_ID` から解決するため、`--project` 経由ならそのプロジェクトのワークスペース内に作られる。プロジェクト名は `CTW_PROJECT_NAME`（ディスパッチャーが注入）→ `config.json` の逆引き → cwd のディレクトリ名の順で解決する
2. `waitForHerdrTask()` が agentステータスをポーリングし、**`done`**、または**一度 `working` を観測した後の `idle`** を完了とみなす（後者の seenWorking ガードは起動直後の `idle`/`unknown` を完了と誤判定しないため）。`blocked` は人が herdr のペインで解除する前提で待機を継続し、ステータステーブルには `running:blocked` と表示する。ペイン消失（`pane_not_found`）は失敗扱い
3. 完了時の出力（`claude -p` の stdout・exit code の代替）は **transcript 優先・ペイン内容フォールバック**の2段構え。`agentGet` が返す claude のセッションID（`agent_session.value`）を鍵に `~/.claude/projects/*/<sessionId>.jsonl` を引き、最終アシスタント発言を Slack 通知本文に使う（`src/transcript.ts`）。引けない場合のみ `paneRead --source recent` のペイン内容を使い、空振り検知（内容が空なら失敗）もそちらで行う
   - **ペイン内容をそのまま通知に載せると装飾しか届かない**。TUI のペインは「会話ログ + 空行パディング + 入力ボックス + ステータスバー」で構成され、Slack 通知は末尾1000文字しか載せないため、実際に届くのは罫線・`❯` プロンプト・`ctx 7% │ 5h 26%` といった TUI のクロームだけになる（完了報告は空行パディングより上にあり切り落とされる）
   - transcript のプロジェクトディレクトリ名は cwd のエンコード結果（実測で `dementia_app` → `dementia-app` と不可逆）なので再現しようとせず、UUID であるセッションIDでディレクトリを総なめして探す（`findTranscriptPath()`）
   - サブエージェントの発言（`isSidechain: true`）は除外する。`claude -p` の stdout 相当はメインエージェントの完了報告であり、サブエージェントの報告は途中経過
4. **出力回収 → `stopHerdrTask()` → 完了コールバック**の順で片付ける。claudeがworktreeを掴んだままだと `removeWorktree()` が失敗しうるため、セッション終了はラベル操作・worktree削除より先に行う

#### `done`（未確認完了）ステータスの扱い

herdr の `AgentStatus` は `idle` / `working` / `blocked` / **`done`** / `unknown` の5値（`herdr api schema` の `AgentStatus` enum が正）。`done` は「作業を終えたが、ユーザーがまだそのペインを見ていない」**未確認完了**の状態で、herdr は working から idle へ落ちたペインが非フォーカスだと idle ではなく `done` を返し、ユーザーがそのタブを開いた時点で `idle` へ落とす（検出ロジック自体は idle と判定している。`herdr agent explain <pane>` は `state: idle` を返す）。

ワーカーのタスクタブは誰も開かないため、完了したタスクはほぼ必ず `done` に張り付く。かつて `AgentStatus` に `done` が無く `toAgentStatus()` が `unknown` へ丸めていたため、**タスクが終わってもタブを開くまで完了扱いにならず、タブがクローズせずステータスも `running` のまま**というバグになっていた（ワーカーはそのIssueを掴んだまま無限に待ち続ける）。

`done` は `idle` と違って seenWorking ガードを課さず、観測した時点で即完了とみなす。`done` は working からの遷移でしか現れず起動直後に誤検知する余地が無い一方、ポーリング間隔（`AGENT_POLL_INTERVAL_MS` = 3秒）より短いタスクでは `working` を一度も観測しないまま `done` に到達しうるため、ガードを付けるとその取りこぼしがそのまま無限待ちになる。

`stopHerdrTask()` の ctrl-c は **1コマンドで連続2回**（`herdr pane send-keys <pane> ctrl+c ctrl+c`）送る。Claude Code の TUI は ctrl-c 1回では終了せず（1回目は入力キャンセル）、**間隔を空けた2回でも終了カウントがリセットされて終了しない**ことを実測で確認している。1回しか送らないと claude は後片付けの機会を得られないまま `tab close` で強制終了される。**新方式では claude はタブのルートシェルペインで動くため、claude がグレースフルに終了してもペイン（＝シェル）とタブは残る**（旧方式の split ペインと違いペインは消えない。実測で ctrl-c 後は `pane get` はペイン生存を返し、`agent get` が `agent_not_found` を返す）。そのため終了確認は `waitForAgentGone()`（`agentGet` が `agent_not_found`/`pane_not_found` になるまでポーリング）で行い、その後 `tabClose()` を**必ず**呼んでタブごと片付ける（`CLAUDE_EXIT_TIMEOUT_MS` 内に終了しなければ警告して強制クローズ、既に消えているタブの `tab_not_found` は正常系として握り潰す）

TUI起動時の引数は `buildClaudeArgs()` が組み立て、`-p` の有無以外は両モードで同一にする。環境変数は `buildClaudeEnv()` が組み立て、herdrモードでは print専用の `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` を渡さない。

**通知音はワーカー側から止められない**。herdr のエージェント状態遷移音（`working`→`idle` のたびに鳴る）を抑止する `HERDR_DISABLE_SOUND` を読むのは herdr 本体の sound モジュール（`src/sound.rs`）であり、参照されるのは**サウンドを再生する herdr サーバープロセス自身の環境変数**。タスクペイン（claude 子プロセス）の env に入れても届かないため、かつて `buildClaudeEnv()` が渡していた同変数は撤去した。herdr の socket API（`agent start` / `tab create` / `workspace create` のパラメータ）にもペイン単位のミュートは無い。止める手段は次のいずれかで、いずれもワーカー専用スコープにはできない:

- `~/.config/herdr/config.toml` の `[ui.sound] enabled = false`（herdrサーバー全体。`herdr server reload-config` で適用）
- 同 `[ui.sound.agents] claude = "off"`（claudeエージェント全体。対話セッションも無音になる）
- ワーカー用に別 herdr セッションを `HERDR_DISABLE_SOUND=1 herdr --session <name>` で起動し、その中でディスパッチャーを動かす（サーバーへのenv継承は未検証）

### `--project` ディスパッチ

`src/index.ts` は起動時に `hasProjectFilter()` で `--project` フラグの有無を判定し、指定されている場合はワーカー起動の代わりにディスパッチャーを起動する（複数プロジェクトへ同一コマンドを一括転送する仕組み）。

1. `loadUserConfig()` で `config.json` を読み込み・検証
2. `resolveTargetProjects()` で `--project` に渡されたプロジェクト名・グループ名・`all` を実プロジェクト一覧へ解決
3. `buildForwardedCommand()` で `--project` とその値を取り除いた転送用コマンド文字列を構築
4. `runDispatcher()` が各プロジェクトのディレクトリでherdrワークスペース（ラベル `ctw:<project>`、`--env CTW_PROJECT_NAME=<project>`）を作成し、そのルートペインへ `startWorkerInPane()` で転送コマンドを送信してセッションを起動
5. `monitorSessions()` がセッションの生存監視とステータステーブル描画ループを開始
6. SIGINT/SIGTERM受信時は `shutdownDispatcher()` が全セッションへctrl-cを送信し、終了を待ってからワークスペースをクローズする

#### ワークスペースクローズによるフォーカス移動へのガード（`restoreWorkspaceFocus()`）

herdr は `workspace close` の際、**閉じたワークスペースがフォーカスされていなくても別のワークスペース（実測では番号順で隣接するもの）へフォーカスを移す**。そのため Ctrl-C でディスパッチャーを止めると、まったく無関係のワークスペースを見ていたユーザーの表示が勝手に切り替わる。`tab close` では起きず、`workspace close` 固有の挙動。herdr 側にこれを抑止するオプションは無い（`workspace close` に `--no-focus` 相当のパラメータは存在しない）。

対策として、close の**直前**に `focusedWorkspaceId()` でフォーカス中のワークスペースを控え、close 後に `restoreWorkspaceFocus()` で戻す。控える位置を close 直前に置いているのは、シャットダウン開始時点で控えるとセッション終了待ち（最大10分）の間にユーザーが手動で切り替えた先を巻き戻してしまうため。close 前後の数百ミリ秒に窓を狭めることで巻き戻し事故を避けている。控えたワークスペース自身が close 対象に含まれる場合（ユーザーがディスパッチャーのワークスペースを見ていた場合）は戻す先が消えているため何もせず herdr の既定の遷移に任せる。

適用箇所は `workspaceClose` を呼ぶ3経路すべて: `closeRemainingWorkspaces()`（シャットダウン・force-kill）、`removeSession()`（ワーカー自然終了時の `pollOnce` 経由）、`runDispatcher()` のダングリングワークスペース回収。`removeSession()` は以前 herdr モジュールを自前で動的importしていたが、フォーカス復元を同一インスタンスで行うためと、テストで実バイナリを呼ばずに済ませるため、`pollOnce()` から herdr を受け取るようにしてある。

#### シェル初期化レースへのガード（`startWorkerInPane()`）

`tabCreate` 直後のペインはシェル（`.zshrc` / anyenv 等のプロファイル）を初期化中で、プロンプト描画（zle の起動）より前に `paneSendText`/`paneSendKeys` で送ったテキストは**端末にエコーされるだけでシェルには読まれず捨てられる**。結果、コマンドが実行されないまま空のプロンプトが出て、ワーカーが起動しないまま `pollOnce()` が「セッション終了」と誤判定してタブを閉じ、`[dispatcher] all sessions finished, exiting` で即終了する。転送コマンド自体は端末に残るため、一見「送ったのに動かない」状態に見える。ガードは2段構え:

1. **プロンプト待ち**（`waitForPaneReady()`）: `paneRead()` で「ペインに何か描画されたか」だけを判定する（プロンプト文字列はユーザーのシェル設定依存のため内容は見ない）。`PANE_READY_TIMEOUT_MS` までに描画されなければ警告して送信は行う。
2. **起動確認と再送**（`waitForWorkerStartup()`）: 送信後に `paneProcessInfo()` をポーリングし、フォアグラウンドに `claude-task-worker` プロセスが現れたことを確認する。戻り値は3値: ワーカー検出で `"started"`、`WORKER_STARTUP_TIMEOUT_MS` 以内にフォアグラウンドが `isShellProcess()`（`name`/`cmdline` が `zsh`/`bash`/`sh`、ログインシェル形式 `-zsh` 等含む、と判定するヘルパー）判定のシェルのままタイムアウトすると `"shell"`、フォアグラウンドが非シェル・非ワーカーの無関係なプロセスだと判明した時点でタイムアウトを待たず即座に `"other"` を返す。`startWorkerInPane()` は `"shell"` の場合のみ最大 `SEND_MAX_ATTEMPTS` 回まで再送し、`"other"` は再送せず即座に失敗として打ち切る。これにより、稼働中ワーカーや無関係な非シェルプロセスの標準入力へ文字列を誤って流し込むことはない。全試行で `"started"` を確認できなければそのプロジェクトは失敗扱いにし、タブをクローズしてセッションを登録しない。

起動判定（`isWorkerProcess()`）は `pollOnce()` の生存判定と共有し、「起動したとみなす条件」と「生存しているとみなす条件」を一致させる。なお `herdr pane read` は他コマンドと違い JSON エンベロープではなく端末内容の生テキストを返す（失敗時のみ `{"code","message"}` を返し `error` キーで包まない）ため、`paneRead()` は `execHerdr()` のJSONパース経路を通さない専用実装になっている。

### ラベルフロー

| Worker | トリガーラベル | 完了時 |
|--------|-------------|--------|
| exec-issue | `cc-exec-issue` | `cc-in-progress` 除去 |
| fix-review-point | `cc-fix-onetime` or `cc-fix-repeat` | `cc-in-progress` 除去、`cc-fix-onetime` は除去・`cc-fix-repeat` は維持 |
| create-issue | `cc-triage-scope`（Open な blockedBy を持たない場合のみ） | Issue クローズ |
| update-issue | `cc-update-issue` | `@author Updated` コメント投稿 |
| create-ui-design | `cc-create-ui-design` | PR に `cc-ui-design` + `cc-triage-scope`、Issue に `cc-ui-design-pr-created` を付与 |
| apply-ui-design | `cc-ui-design-pr-created` | Issue に `cc-ui-design-ready` + `cc-exec-issue` を付与 |

### UIデザイン先行ワークフロー（`uiDesign`）

UI実装Issueについて、実装の前に Pencil（`.pen`）でデザインを作り、独立したPRとしてマージしてから実装へ進むフロー。`claude-task-worker.json` の `uiDesign.enabled`（boolean、既定 `false`）・`uiDesign.designDir`（既定 `"designs"`）・`uiDesign.yolo`（boolean、既定 `false`）で制御する。設定は `src/config.ts` の `parseUiDesignEntry()`（不正値は警告して既定値）／`getUiDesignConfig()`（読み込み失敗時は既定＝無効へ倒す）で解決する。

- **`uiDesign.enabled: false` のときは2つのワーカーを起動しない**。判定は `index.ts` ではなくワーカー実装側（`create-ui-design.ts` / `apply-ui-design.ts`）の先頭に置き、`all` / `yolo` からの一括起動でも個別コマンドでも同じ経路を通す。ラベルを消費するワーカーが存在しないため、無効なリポジトリでは人が手動で `cc-create-ui-design` を付けても何も起きず、本機能の追加前と完全に同一の挙動になる
- 経路は `triage-created-issue` のパターンE-1（パターンD通過後・パターンEの手前）で分岐する。UI実装タスクと判定した場合は `cc-exec-issue` を付けずに `cc-create-ui-design` のみを付与する。判定が割れる場合は**デザインを作らない側（パターンE）に倒す**
- デザインPRの head は `cc-ui-design-<Issue番号>` の固定名ブランチ（`cc-epic-<N>` と同じ考え方で、後段が head ref から一意に特定できるようにするため）。ベースブランチは実装PRと揃える（`parent` があれば `cc-epic-<親>`、なければ default）。揃えないと epic 配下でデザインが実装ブランチに存在しない状態になる
- **デザインPRの Issue 参照は `Refs #N` 固定で closing keyword を禁止する**。`Closes` を使うとデザインPRのマージで実装Issueが閉じ、実装フェーズへ進めなくなる
- **`uiDesign.yolo` はデザインPRへ `cc-triage-scope` を付けるかだけを切り替える**（`create-ui-design.ts` の `onCompleted`）。`true` のときだけ付与し、デザインPRのレビュー・マージを既存の `triage-pr` / `fix-review-point` / `resolve-pr-conflict` にそのまま乗せる（新しいマージ機構を作らない）。`.pen` のコンフリクトは `resolve-pr-conflict` → `resolve-pencil-conflict` の既存の委譲が効く。Epic PR ではないため `cc-release-ready` によるマージ保留の対象外。`false`（既定）では `cc-triage-scope` を付けないためどのワーカーもデザインPRを拾わず、人がレビュー・マージするまで `apply-ui-design` の `preflight` が `skip`（マージ待ち）を返し続ける（＝デザインに人が介在する既定）。`cc-ui-design` は yolo に関わらず常に付ける（PRの種別マーカーであり、自動処理の入口ではないため）
- `apply-ui-design` の `preflight` はデザインPRが `MERGED` のときだけ `proceed`、`OPEN` なら `skip`（マージ待ち）、未マージクローズ・PR不在は `cc-need-human-check` を付与して `skip`。同ラベルは `issue-worker.ts` の共通除外ラベルなので無限リトライしない
- `exec-issue` は `cc-ui-design-ready` が付いているのに description に `## UIデザイン` セクションが無い状態を検出したら、**デザインなしで実装せず** `cc-need-human-check` に落とす。復旧はデザイン参照を自動で再生成する場合、`cc-need-human-check` と `cc-ui-design-ready` を外して `cc-ui-design-pr-created` を付け直せば `apply-ui-design` が description を再生成する。`cc-need-human-check` を外さずに `cc-ui-design-pr-created` だけ付け直しても、同ラベルは `issue-worker.ts` の共通除外ラベルのため `apply-ui-design` のポーリング候補から外れたままになり再実行されない

### 確認事項の二段エスカレーション（`triage-created-issue` → `answer-issue-questions` → `cc-need-human-check`）

未回答の確認事項をどこで処理するかの契約。`triage-created-issue` は確認事項の調査（コード探索・ドキュメント精査・外部リンク参照）を一切行わないため、**「`gh` で判断できない＝人間判断が必要」ではない**。この同一視をしていたため、実運用では調査すれば決まる項目まで `cc-need-human-check` に落ち、着手が人待ちで止まっていた。

- **一次トリアージ（`triage-created-issue`）**: 未回答の確認事項があれば内容を問わず `cc-answer-issue-questions` へ委任する（パターンC）。`cc-need-human-check`（パターンA）に落ちるのは、(1) 確認事項とは独立に Issue 全体の扱いが決まらない・人間同士の議論が未決着（経路1）、(2) `answer-issue-questions` が回答を試みてなお解消できなかったと**痕跡で確認できる**場合（経路2）に限る
- **回答（`answer-issue-questions`）**: コメント最終行だけでなく **description 内の確認事項も回答対象**にする（`## 確認事項` セクション、「確認したいこと」「要確認」「TBD」等。実装プラン中の作業手順は対象外）。回答は常にコメントへ書き、description は編集しない（反映は `update-issue` の責務）
- **引き渡しマーカー**: 調査を尽くしても事実で決まらない項目だけを、回答コメント末尾の固定セクション `## 人間判断が必要な確認事項（自動回答不能）` に列挙する。**このセクションの有無だけが `cc-need-human-check` の根拠**であり、0件ならセクションごと省略する（空セクション・「該当なし」も人の手を止めるため禁止）。セクション名は文字列一致で検出するため変更不可。判定基準は「実際に調査済み」「Issue本文の確定方針でも決まらない」「選好・優先度・不可逆な選択に依存する」の3条件をすべて満たすこと
- **ループ防止**: `update-issue` は同セクションに列挙済みの項目を `confirmation_items` として再掲しない。`triage-created-issue` 側でも、実質同一の問いが再掲されていたら「未回答の新規項目」ではなく引き渡し済み（経路2の対象）として扱う。両側に置いているのは、回答不能 → 確認事項として再掲 → 再委任の往復を片側の実装漏れで作らないため
- 委任 → `cc-update-issue` → `update-issue` → 再トリアージ、で往復は1回で決着する

### 要件ルール（`.claude/requirements/`）

対象リポジトリの `.claude/requirements/` に、過去のIssueで確定した**仕様・要件レベルの判断ロジック**を要件タイプ別のマークダウンとして集約する仕組み。ワーカーは介在せず、スキル同士の読み書き契約だけで成立する。

- **書き手**: `update-requirement-rules`（手動起動、`disable-model-invocation: true`）。引数の期間（既定7日）で `cc-triage-scope` / `cc-pr-created` ラベル付きIssueの description とコメントを収集し（`scripts/fetch-recent-requirement-issues.sh`）、複数Issueで反復している判断をルール化して `.claude/requirements/<category>.md` を更新、`commit-push` → `create-pr` でPRを作る（`cc-triage-scope` ラベル + 自分自身をAssignee。`update-coding-guidelines` と同じ経路で、以降のレビュー・マージは `triage-pr` に乗る）
- **読み手**: `create-issue` / `create-issue-from-issue-number` / `answer-issue-questions`。`README.md`（カテゴリ表）を先に読み、**関係するカテゴリファイルだけ**を読む二段構え（全ファイル読み込みはコンテキストを食うだけで判断材料にならない）
- **`CODING_GUIDELINES.md` との棲み分け**: 判定は「そのルールを知っていると **Issue の description（要件・実装プラン・影響範囲）の書き分けが変わるか**」の1問。変わるなら要件ルール、コードを書く段階でしか効かないなら `CODING_GUIDELINES.md`。「責務をどの層に置くか」「エラー時のふるまい」は仕様にも作法にも読めて境界が引けないため、この問いで機械的に倒す（両方に載せると片方だけ更新されて食い違う）
- **採用基準**: 独立した2件以上のIssueでの反復（**同一Epic配下の兄弟Issue群は何件あっても1件と数える** — 同じ設計議論を相互参照しながら繰り返すため、形式的には簡単に2件を満たしてしまう）／一般方針の明示／ラベル語彙・ワーカー間の契約・設定スキーマなど共有語彙に触れる判断は1件でも採用
- **確認事項との関係**: ルールが結論を与えている論点は確認事項として起こさない（人が既に決着させた判断の再確認は着手を止めるだけ）。逆に**Issue本文がルールと矛盾する場合は常にIssue本文が勝つ** — ルールは過去の一般解であり、今回の明示的な依頼を上書きしない
- **削除には根拠を要求する**: 「最近言及がない」は陳腐化の根拠にならない（守られているルールほど再言及されない）。逆の結論の確定・対象機能の消滅・他ドキュメントとの重複のいずれかを確認したときだけ削除・上書きする。カテゴリファイルは最大8個・1ファイル20ルールを上限に統合する
- **原則として分割読みしない**: クラスタリングは全Issueが1つの文脈に載っていないと成立せず、要約だけを受け取るとチャンクをまたいだ同一判断が二重登録される。やむなく分割する場合はサブエージェントに**逐語引用**を返させ、親が引用を突き合わせて再統合する

### デザインシステム定義（`DESIGN.md`）

対象リポジトリのルート `DESIGN.md` に、マージ済みUIデザインPRで確定したビジュアルアイデンティティを集約する仕組み。フォーマットは [google-labs-code/design.md](https://github.com/google-labs-code/design.md)（`@google/design.md`）の仕様に従い、YAML フロントマターの機械可読トークン（`colors` / `typography` / `spacing` / `rounded` / `components`）とマークダウン本文の設計意図の2層構成。要件ルールと同じく**ワーカーは介在せず、スキル/エージェント同士の読み書き契約だけで成立する**。

- **書き手**: `update-design-md`（手動起動、`disable-model-invocation: true`）。引数の期間（既定7日）で `cc-ui-design` ラベル付きの**マージ済み**PRを収集し（`scripts/fetch-recent-ui-design-prs.sh`）、レビューコメントと `.pen` の実データからトークン・原則を抽出して `DESIGN.md` を更新、`designmd lint` を通してから `commit-push` → `create-pr` でPRを作る（`cc-triage-scope` ラベル + 自分自身をAssignee。`update-requirement-rules` / `update-coding-guidelines` と同じ経路）
- **読み手**: `pencil-design-updater` エージェント。作業プロセスのステップ1で `DESIGN.md` を読み、色・フォント・余白・角丸を定義済みトークンの値で指定する（Pencil はトークン参照を解決しないため、`{colors.primary}` ではなく `#1A1C1E` のように実値まで落として `--prompt` / `batch_design` に渡す）
- **`.pen` の中身は diff から読めない**。暗号化バイナリのため `Read` / `Grep` が効かず、変更ファイル一覧だけでは何が変わったか分からない。そこで収集スクリプトは変更ファイルを `pen_files` / `snapshot_files`（`snapshots/` のPNG）/ `other_files` に仕分けて返し、スキルは (1) スナップショット画像を `Read` で見て傾向を掴み、(2) `inspect-pencil-node`（読み取り専用）で Node 属性から正確なトークン値を取る、の2経路で実データに当たる。**推測値は書かない** — 一度書くと次のデザインがそれに合わせて作られ、事後的に「正」になってしまうため
- **収集対象はマージ済みPRのみ**。マージ後なら `.pen` もスナップショットも現在のワークツリーに存在するので、head ブランチが削除済みでも実データを読める（未マージPRを含めると、後で却下された値をトークン化しうる）
- **自分が作るPRに `cc-ui-design` を付けない**。付けると次回実行時に自分自身を収集対象にする（`DESIGN.md` 更新PRはデザインPRではない）
- **採用基準**: 2つ以上のデザインPRまたは2つ以上の独立した画面での反復／「今後は〜」のような適用範囲の明示／`primary` カラー・本文タイポグラフィのような基盤トークン（欠けると後続のデザインが判断できなくなるもの）。いずれにも当てはまらなければ採用しない
- **近い値は統合を疑う**: `#1A1C1E` と `#1A1C1F` が別トークンとして並ぶのはデザインシステムの分岐そのもの。lint の orphaned token 警告（未参照トークン）は削除の合図として使う
- **WCAG コントラスト警告で値を書き換えない**: lint の警告どおりに色を変えるとデザインの実態と `DESIGN.md` が食い違う。デザインの是非は人が決めるため、報告に挙げるだけにする
- **`designmd lint` の終了コードは `error` の有無のみを表す**（`0` = error なし、`1` = error あり、`2` = ファイルが読めない。既定の出力形式は JSON）。error/warning の件数そのものや残 warning の扱いは終了コードに現れないため、常に出力 JSON の `summary.errors` / `summary.warnings` で判断する

### 外部リンクの参照（分析系スキルの調査範囲）

`create-issue` / `create-issue-from-issue-number` / `answer-issue-questions` の調査範囲は `gh` とローカルファイルで閉じない。Issue本文・コメント・`docs/`・README・`.claude/requirements/`・コード内コメントに貼られた URL の先（仕様書・API仕様・ライブラリ公式ドキュメント・別リポジトリのIssue/PR・Figma）に答えがある論点を、リンク先を読まずに「不明」「確認事項」へ倒すと、リンク先に書いてある答えを人へ差し戻すことになる（確認事項コメントは `cc-answer-issue-questions` の回答待ちを発生させ、着手が止まる）。

3スキル共通で「外部リンクの参照」節を持ち、規定は同じ: **収集 → 結論を左右するものだけに絞る → 種類別の手段（一般URLは `WebFetch`、ライブラリ公式ドキュメントは `check-library`（context7 MCP）、GitHubのURLは `gh` の各 view、Figma は Figma MCP、リンク切れは `WebSearch`）→ 辿るのは1段まで → 使ったURLと要点を「参照情報」／回答の「根拠」に残す → 取得不能なら推測で埋めず理由を明記**。確認事項の取捨選択にも「リンク先を読めば一意に決まる論点は外す」を入れてある。

`explore-agent` 側にも同じ方針をステップ4.5として置いている。同エージェントの「一切の変更を行わない」原則が読み取り専用の外部参照まで禁じていると読めたため、`WebFetch` / `WebSearch` / context7 は禁止に含まないことを明記した（禁止されるのは投稿・書き込み）。委譲元の3スキルもプロンプトで同方針を伝える。

## Conventions

- ESM（tsconfig は `module: ESNext` / `moduleResolution: Bundler`）— **相対 import は拡張子を付けない**（`import { x } from "./foo"`）。`.js` も `.ts` も付けない。esbuild バンドルと `tsc`（Bundler 解決）は拡張子なしをそのまま解決するが、`node --experimental-strip-types --test` の ESM リゾルバは拡張子なし・`.js`→`.ts` のどちらも解決できないため、テスト実行時のみ `scripts/test-resolver.mjs`（`register()` で `scripts/test-resolver.hooks.mjs` の resolve フックを登録）が実ファイル（`.ts` 等）へ橋渡しする。`package.json` の `test` スクリプトが `--import ./scripts/test-resolver.mjs` で読み込む。テストでソースを値として読む場合は `import type * as M from "./foo"`（型は拡張子なしで erase される）＋ `const m = (await import("./foo")) as typeof M` の既存パターンに従う
- ログは `[worker-name]` プレフィックス付き
- エラーはtry-catchでログ出力し、ワーカーはクラッシュせず継続
- SIGTERM/SIGINT で全子プロセスを graceful shutdown

## Prerequisites

- GitHub CLI (`gh`) がインストール・認証済み
- Claude Code (`claude`) がインストール済み
- `claude-task-worker` プラグイン（本リポジトリの `plugin/`）がインストール済み
  - `npx claude-task-worker install` で一括セットアップ可能
  - 手動の場合: `claude plugin marketplace add getty104/claude-task-worker` → `claude plugin install claude-task-worker@claude-task-worker`
- CodeGraph (`codegraph`) がインストール済み（`claude-task-worker install` / `update` が面倒を見る）
  - MCP サーバーとして `plugin/.mcp.json` から起動される（`codegraph serve --mcp`）。`explore-agent` およびワーカー起動セッションは**この MCP ツール経由で** CodeGraph を使う。ツールが無い場合、および未インデックスでエラー・空結果が返る場合は `Glob`/`Grep` にフォールバックする
  - プロジェクトごとのインデックス構築は `claude-task-worker init`（内部で `codegraph init`）。未インストール・未初期化でもワーカーは動作する（探索がテキスト検索に落ちるだけ）
- DESIGN.md CLI (`designmd`) がインストール済み（`claude-task-worker install` / `update` が面倒を見る）
  - `update-design-md` スキルが `designmd lint DESIGN.md` で使う。未インストールでも同スキルは動作するが lint を実行できないため、その旨を報告とPR本文に明記して続行する（フォールバックとして `npx -y -p @google/design.md designmd` も試す。パッケージ名兼bin名の `.` を含む `@google/design.md` を直接bin名として呼ぶとWindowsの拡張子関連付けと衝突しうるため、`-p` でパッケージを指定しdotフリーの `designmd` を明示的に呼ぶ）
