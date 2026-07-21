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
- **`src/commands/install.ts`** - マーケットプレイス追加・プラグインインストール・CLI自体のインストール・CodeGraph CLI のインストールを一括で行うコマンド
- **`src/commands/update.ts`** - プラグイン/マーケットプレイス・CLI自体・CodeGraph CLI の更新コマンド
- **`src/commands/codegraph.ts`** - CodeGraph（`@colbymchenry/codegraph`）連携。`installCodegraphCli()`（`npm install -g` によるインストール）、`upgradeCodegraphCli()`（`codegraph upgrade` による更新。CodeGraph 自身の更新機構を使うことで配布方法の変更に追随できる。未インストール環境では `codegraph` コマンドが無く失敗するため `installCodegraphCli()` へフォールバックする）、`runCodegraphInit()`（`codegraph init`）、`ensureCodegraphGitIgnore()`（グローバル gitignore への `.codegraph/` 追記）、`globalGitIgnorePath()`/`appendIgnoreEntry()`（テスト可能な純粋関数）
  - **`codegraph install` はあえて実行しない**。同コマンドは各エージェントの設定ファイルへ MCP サーバー定義を書き込むが、その役割は本プラグインの `plugin/.mcp.json`（`codegraph serve --mcp`）が担っているため、両方走らせると同じサーバーが二重登録される。CLI のインストールだけを `npm install -g` で行う
  - グローバル gitignore（`~/.config/git/ignore`、`XDG_CONFIG_HOME` があればその配下）へ入れるのは、`.codegraph/` がプロジェクトごとのローカルインデックス（SQLite）でコミット対象ではない一方、対象リポジトリの `.gitignore` を汚したくないため。追記は冪等で、`.codegraph/` と `.codegraph` の両方を登録済みとみなす（`!.codegraph/` のような否定パターンは登録済み扱いにしない）
- **`src/runcat.ts`** - RunCat Neo 用の利用状況スナップショット書き出し。`~/.claude/runcat-usage.json`（`RUNCAT_OUT_FILE` で上書き可）へ一時ファイル + rename で原子的に書き込む。フォーマットは `~/dotfiles/claude/statusline.py` の出力と揃えてある（`buildRuncatSnapshot`/`resetStamp`/`resetHour`）。ただしリセット時刻は `ceilToMinute()` で秒以下を切り上げて分境界に揃える（API は `:59` 秒でリセット時刻を返すため、切り捨て表示だと 1 分手前に見える）。切り上げが日付・時をまたぐ場合はそれぞれ日付付き表示・次の時に繰り上がる。書き出しは `slack.ts` の `buildTokenLimitText()` 経由で行われるため、`usage` コマンド実行時に加えてワーカーのタスク完了/失敗通知のたびに更新される（Slack webhook 未設定でも通知が no-op になるだけでスナップショットは更新される）。ただし利用状況の取得自体は `/tmp/claude-usage-cache.json` の360秒キャッシュを挟むため、値の鮮度は最大6分古くなりうる
- **`src/workers/`** - 各ワーカー実装
- **`src/workers/ui-design.ts`** - UIデザイン先行ワークフローの純粋ヘルパー（`create-ui-design` / `apply-ui-design` が共有）。`designBranchName()`（`cc-ui-design-<N>`）、`hasDesignReference()`（description のデザイン参照セクション判定）、`classifyDesignPr()`（デザインPRの状態 → preflight 判定）、各種 Issue コメント本文。gh 依存を持たないため分岐だけをユニットテストできる
- **`plugin/`** - Claude Code プラグイン本体（`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `scripts/`, `.mcp.json`）
- **`.claude-plugin/marketplace.json`** - このリポジトリを Claude Code マーケットプレイスとして公開するための定義
- **`src/dispatcher.ts`** - ディスパッチャー本体。`runDispatcher()`（herdr疎通確認 → プロジェクトごとに**ワークスペース**を作成しルートペインへコマンド送信。ラベルは `workspaceLabelFor()` で `ctw:` プレフィックス付き（`LABEL_PREFIX`）にし、既存ワークスペースの重複判定も同プレフィックスで行う。ルートタブも同ラベルへ `tabRename()` する）、`startWorkerInPane()`（プロンプト待ち `waitForPaneReady()` → コマンド送信 → 起動確認 `waitForWorkerStartup()` → 未起動なら再送）、`monitorSessions()`（セッション生存監視＋ステータステーブル描画ループの起動）、`renderSessionTable()`（稼働セッション一覧のテーブル描画）、`shutdownDispatcher()`（SIGINT/SIGTERM時、各セッションへctrl-c送信 → 終了待機 → **ワークスペースクローズ**のグレースフルシャットダウン。ワークスペースごと閉じることで herdr モードのタスクタブも一緒に片付く）
- **`src/herdr.ts`** - herdr CLIラッパー。`workspaceCreate`/`workspaceList`/`workspaceClose`/`workspaceFocus`（ワークスペース管理。`workspaceList` の `focused` はフォーカス復元の判定に使う）、`tabCreate`/`tabRename`/`tabClose`/`tabList`（タブ管理）、`agentStart`（argvを直接実行してペイン起動。シェルを経由しないため送信レースが起きない。`tabId` で起動先タブを指定できる）、`agentGet`（agentステータス取得。`agent_session.kind === "id"` のときは claude のセッションIDも返す）、`paneSendText`/`paneSendKeys`（ペインへの入力送信）、`paneRead`（ペインの端末内容取得）、`paneGet`/`paneClose`、`paneProcessInfo`（フォアグラウンドプロセス確認）、`getCurrentWorkspaceId`（herdrが各ペインへ自動注入する `HERDR_WORKSPACE_ID` の読み出し）、`checkHerdrAvailable`（herdr導入・疎通確認）
  - **`--cwd` は必ず絶対パスへ解決してから渡す**（`cwdArgs()`）。`--cwd` を解決するのはワーカーではなく herdr サーバー（別プロセス）のため、相対パスを渡すとワーカーのcwdではなく herdr サーバーのcwd基準で解決される。実測では**エラーにならず黙ってホームディレクトリで起動**するため、worktree を渡したつもりのタスクがリポジトリ外で走る。`getWorktreePath()` は相対パス（`.claude/worktrees/<id>`）を返し、default モードの `spawn({cwd})` はワーカーのcwd基準で正しく解決されるため、この差は herdr モードでだけ牙をむく
  - herdr は大半のコマンドで「終了コード0＋stdoutにJSON」を返すが、一部（実測では存在しないタブへの `tab close`）は「終了コード非0＋**stderr**にJSON」を返す。`runHerdr()` は stdout から error を取れなかった場合のみ stderr も解析し、どちらの形でも `HerdrError`（`code` 付き）にする。取り出せないと `stopHerdrTask()` の「`tab_not_found` は正常系」判定が効かず、claudeがグレースフル終了するたびに偽のエラーログが出る。ただし `result`（成功値）の取得元は stdout のみ
- **`src/transcript.ts`** - Claude Code のセッション transcript（`~/.claude/projects/*/<sessionId>.jsonl`）から最終レポートを取り出す。`findTranscriptPath()`（セッションIDでディレクトリを総なめ）、`extractFinalAssistantText()`（末尾から最初に見つかる非 sidechain のアシスタントテキスト。純粋関数）、`readFinalReport()`。herdr モードで `claude -p` の stdout の代わりに Slack 通知本文を作るために使う
- **`src/herdr-runner.ts`** - herdrモードのタスク実行。`startHerdrTask()`（`tabCreate` → そのタブ限定で `agentStart` → 余ったシェルペインを `paneClose` で1タスク=1タブにする）、`waitForHerdrTask()`（agentステータスのポーリング。`done` または `working`→`idle` で完了、`pane_not_found` で失敗、`blocked` は待機継続）、`buildHerdrTaskResult()`（ペイン出力が空なら空振りとして失敗扱い）、`stopHerdrTask()`（ctrl-c送信 → タブクローズ）、`taskTabLabel()`（`ctw:<project>:#<n>`）
- **`src/user-config.ts`** - `config.json`（`~/.config/claude-task-worker/config.json` または `$XDG_CONFIG_HOME` 配下）のロード・検証・対象プロジェクト解決。`UserConfig`（`mode`/`headroom`/`projects`/`projectGroups`）、`loadUserConfig()`（読み込み・検証）、`resolveTargetProjects()`（プロジェクト名/グループ名/予約語 `all` の展開）、`getRunMode()`（`mode` の解決。設定ファイル不在・projects破損でも `"default"` を返し、プロセス内でキャッシュする）、`getHeadroomEnabled()`（`headroom` の解決。`getRunMode()` と同じくプロセス内でキャッシュし、判定できなければ `false`）、`findProjectNameByPath()`（herdrモードのタブラベル用にパスからプロジェクト名を逆引き）。リポジトリ直下の `claude-task-worker.json` を扱う `src/config.ts` とは別物
- **`src/dispatch-args.ts`** - `--project` ディスパッチ用CLI引数ヘルパー。`PROJECT_INCOMPATIBLE_COMMANDS`（`--project` と併用不可なコマンド一覧: `init`/`install`/`update`/`usage`/`version`）、`parseProjectFilters()`/`hasProjectFilter()`（`--project` の抽出・検出）、`buildForwardedCommand()`（`--project` とその値を除去し他プロジェクトへ転送するコマンド文字列を構築）

### Worker共通ライフサイクル

1. `gh api user` / `gh repo view` で現在ユーザー・リポジトリ情報取得
2. 一定間隔（ワーカーごとに設定）でGitHub APIをポーリング
3. ラベル・アサイン条件でフィルタリング
4. `isRunning()` で重複実行防止
5. トリガーラベル除去 → `cc-in-progress` ラベル付与
6. `.claude/worktrees/<worktreeId>` にワーカー自身がworktreeを生成し（`claude --worktree` は locked worktree の残骸問題があるため不使用）、Claude CLI をそのworktreeをcwdとして起動する（`mode: "default"` は `claude -p` の非同期spawn、`mode: "herdr"` は herdr のタスク専用タブでTUI起動。後述の「`mode`（タスクの実行形態）」参照）
7. 完了時コールバックでラベル・worktree・ローカルブランチをクリーンアップ

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
3. **自律実行原則のシステムプロンプト注入**（`src/claude-args.ts`）: `--append-system-prompt`（`SYSTEM_PROMPT`）で注入する。内容は「ワーカーから自動起動されている・ユーザーに質問しない・全ステップを完遂してから終了する・曖昧なら安全側を選び根拠を報告する」に加えて、サブエージェント向けの原則（委譲時に同原則を伝える・子の完了報告を鵜呑みにせず成果物を検証する）も含む。かつてサブエージェントへは `--append-subagent-system-prompt` で直接注入していたが、同フラグは `-p` 非対話モード限定で herdr モードの TUI 起動では使えず、実行形態によって原則の届き方が変わってしまうため、注入経路を `--append-system-prompt` 一本へ統合した（メインエージェントが委譲プロンプトで伝える形になり、注入の確実性は下がるトレードオフを受け入れている）。文面も実行形態に依存しない表現にしてある。スキル本文に自律実行原則を複製しないのは、対話セッションでスキルを手動実行する場合は実在するユーザーと対話してよいため。あわせて**コード探索の原則（CodeGraph 優先）**も同プロンプトに含める（テキスト検索より優先する・**利用可否は codegraph 系 MCP ツールの有無だけで判断する**・無ければ即テキスト検索へ・インデックスのセットアップはしない・返ったソースは読み終えたものとして扱う・委譲時は方針も伝える）。詳細な手順は `plugin/agents/explore-agent.md` にあるが、それはメインエージェント自身が探索する場合や explore-agent 以外のサブエージェントへ委譲する場合には届かないため、全セッション共通の原則としてシステムプロンプト側にも置いている。
4. **ワーカーレベルの完了検証**（`src/workers/exec-issue.ts` / `epic-issue.ts` の `onCompleted`）: 上記をすり抜けて exit 0 で終了しても、期待成果物を検証できるまでラベル遷移しない最後の砦。exec-issue は「Issue がクローズ済み（変更不要パス）」または「作業ブランチ（worktreeId）を head とする PR か Issue を closing 参照する PR の実在」を確認できた場合のみ `cc-pr-created` を付与し、確認できなければ `cc-need-human-check` を付与して Issue に状況コメントを残す。epic-issue は `cc-epic-<N>` を head とする Epic PR の実在確認後にのみ `cc-pr-created` を付ける。`onCompleted` が `false` を返すと `issue-worker.ts` は完了通知ではなく失敗通知（Slack）を送る。

ワーカー起動スキル12個（`exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue-from-issue-number` / `update-issue` / `triage-created-issue` / `triage-pr` / `resolve-pr-conflict` / `check-dependabot` / `create-epic-pr` / `create-ui-design` / `apply-ui-design`）の本文の「実行モードの制約」セクションには、スキル固有のリスク（どのラベル遷移が壊れるか）のみを記述する（自律実行原則は上記 3 の CLI 注入に一元化されており、スキル本文には複製しない）。

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

### `mode`（タスクの実行形態）

`config.json` のトップレベル `mode`（`"default"` | `"herdr"`、既定は `"default"`）で、ワーカーが1タスクをどう起動するかを切り替える。プロジェクト単位・ワーカー単位の指定はできない（トップレベル一括のみ）。`getRunMode()` はプロセス起動時に一度だけ解決してキャッシュするため、実行中に設定ファイルが書き換わっても「引数の組み立て（`-p` の有無）」と「実行経路（spawn / herdr）」が食い違わない。

- `"default"`: 従来どおり `claude -p` を子プロセスとしてspawnし、exit code と stdout で成否を判定する
- `"herdr"`: herdr のタスク専用タブで claude をTUI起動し、agentステータスで完了を判定する。`mode: "herdr"` かつ herdr が未導入・未起動の場合はワーカー起動時に `assertRunModeAvailable()`（`src/index.ts`）がエラー終了させる（`"default"` へのサイレントフォールバックはしない）

`mode: "herdr"` の1タスクの流れ（`src/process-manager.ts` の `runViaHerdr()` と `src/herdr-runner.ts`）:

1. `tabCreate` で `ctw:<project>:#<番号>` ラベルのタスク専用タブを `--no-focus` で先に作り、`agentStart`（`herdr agent start ... --tab <そのタブ> -- claude <引数>`）でその中にTUIセッションを起動する。`agent start` はタブ内への split でしかペインを作れないため、**先にタブを作らずに起動すると、ワークスペースのアクティブタブ（＝ユーザーが見ているタブ）に一瞬ペインが割り込んでからタスクタブへ移る「ちらつき」が起きる**（かつては `agentStart` → `paneMoveToNewTab` の順で切り出しており、これが原因だった）。split で使い終わった新規タブのルートペイン（シェル）は `paneClose` で閉じ、タブをagentペイン1枚にする。ルートペインを閉じられなくてもagent自体は動いているためタスクは失敗させない（タブごと閉じる `stopHerdrTask()` で片付く）。ワークスペースは herdr が注入する `HERDR_WORKSPACE_ID` から解決するため、`--project` 経由ならそのプロジェクトのワークスペース内に作られる。プロジェクト名は `CTW_PROJECT_NAME`（ディスパッチャーが注入）→ `config.json` の逆引き → cwd のディレクトリ名の順で解決する
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

`stopHerdrTask()` の ctrl-c は **1コマンドで連続2回**（`herdr pane send-keys <pane> ctrl+c ctrl+c`）送る。Claude Code の TUI は ctrl-c 1回では終了せず（1回目は入力キャンセル）、**間隔を空けた2回でも終了カウントがリセットされて終了しない**ことを実測で確認している。1回しか送らないと claude は後片付けの機会を得られないまま `tab close` で強制終了される。claudeがグレースフルに終了するとペインが消え、そのタブに他のペインが無ければタブも自動で消えるため、`tabClose()` は「残っていた場合の強制クローズ」として呼び、既に消えている場合の `tab_not_found` は正常系として握り潰す（`CLAUDE_EXIT_TIMEOUT_MS` 内に消えなければ警告して強制クローズ）

TUI起動時の引数は `buildClaudeArgs()` が組み立て、`-p` の有無以外は両モードで同一にする。環境変数は `buildClaudeEnv()` が組み立て、herdrモードでは print専用の `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` を渡さない。

**通知音はワーカー側から止められない**。herdr のエージェント状態遷移音（`working`→`idle` のたびに鳴る）を抑止する `HERDR_DISABLE_SOUND` を読むのは herdr 本体の sound モジュール（`src/sound.rs`）であり、参照されるのは**サウンドを再生する herdr サーバープロセス自身の環境変数**。タスクペイン（claude 子プロセス）の env に入れても届かないため、かつて `buildClaudeEnv()` が渡していた同変数は撤去した。herdr の socket API（`agent start` / `tab create` / `workspace create` のパラメータ）にもペイン単位のミュートは無い。止める手段は次のいずれかで、いずれもワーカー専用スコープにはできない:

- `~/.config/herdr/config.toml` の `[ui.sound] enabled = false`（herdrサーバー全体。`herdr server reload-config` で適用）
- 同 `[ui.sound.agents] claude = "off"`（claudeエージェント全体。対話セッションも無音になる）
- ワーカー用に別 herdr セッションを `HERDR_DISABLE_SOUND=1 herdr --session <name>` で起動し、その中でディスパッチャーを動かす（サーバーへのenv継承は未検証）

### `headroom`（Headroom 経由でのタスク実行）

`config.json` のトップレベル `headroom`（boolean、既定 `false`）が `true` のとき、タスクを `claude` の直接起動ではなく `headroom wrap claude <HEADROOM_WRAP_OPTIONS> -- <引数>` で起動する（Headroom がローカルプロキシを立て `ANTHROPIC_BASE_URL` を差し替えてコンテキストを圧縮する）。`mode` と同じくトップレベル一括の設定で、`getHeadroomEnabled()` がプロセス起動時に一度だけ解決してキャッシュする。

コマンドの組み立ては `src/claude-args.ts` の `buildClaudeExecution()`（`{ command, args }` を返す）。`mode` とは直交し、default モードでは `spawn` の command に、herdr モードでは `agentStart` の argv 先頭になる。どちらもシェルを経由せず argv を直接実行するためクォートの考慮は不要。

- **claude の引数はすべて `--` の後ろに置く**。`headroom wrap claude` は自前のオプション（`--port` / `--memory` / `--no-mcp` / `--1m` 等）を持ち、`-p` のように衝突しうるフラグは `--` の後ろでないと claude へ届かない（headroom 側は click の `ignore_unknown_options` + `UNPROCESSED` で `--` を消費し、残りを `subprocess.run([claude_bin, *claude_args])` へそのまま渡す）。未知フラグのパススルーに頼らず全引数を後ろへ回すことで、将来 headroom にオプションが増えたときの衝突も防ぐ
- **headroom 自身へ渡すオプション（`HEADROOM_WRAP_OPTIONS`）は逆に `--` の前に置く**。`--` の後ろは claude へ素通しされ headroom には解釈されないため。現在渡しているのは `--1m` / `--memory` / `--no-tokensave` / `--no-serena` の4つ:
  - `--1m`: 1M コンテキストウィンドウを要求させる。ただし**このフラグ単体ではワーカーに効かない**（下記「1M window の解放は `--model` 側で行う」参照）。`--model` を渡さなくなった場合の保険として残している
  - `--memory`: セッション横断の永続メモリを有効化する
  - `--no-tokensave` / `--no-serena`: 重いコードグラフ MCP の自動登録を止める（下記参照）
- **1M window の解放は `--model` へ付ける `[1m]` サフィックスが担う**（`withContext1mSuffix()`）。Claude Code は model id が `[1m]` で終わるときだけ `context-1m` beta ヘッダを送るが、headroom の `--1m` は **`ANTHROPIC_MODEL=<model>[1m]` をセットするだけ**の実装（`wrap.py` の `_resolve_1m_model()`）で、CLI の `--model` が環境変数に勝つため、`--model sonnet` を明示するワーカー起動では素通しされていた。proxy のリクエストログで `anthropic-beta` から `context-1m` が欠落することを実測で確認済み。headroom は `ANTHROPIC_MODEL=claude-opus-4-8[1m] (1M context window)` と成功したかのように表示するため、ログを見ても気づけない。サフィックスはエイリアスへ直接連結してよい（`--model 'sonnet[1m]'` でヘッダが送出されることを実測確認済み。エイリアス→フルモデルIDの変換表は新モデル追加のたびに陳腐化するため持たない）
- **tokensave MCP は `--no-tokensave` で明示的に切る**。ただし**コンテキスト削減が目的ではない**。狙いは (1) headroom がタスク起動のたびに走らせる再登録＋再インデックス（`_setup_tokensave_mcp(..., force=True)` → `_index_tokensave_project()`）を止めること、(2) ワーカーの都合で `~/.claude.json` の**トップレベル** `mcpServers`（＝ユーザーの対話セッション）が書き換わるのを止めること。コード探索は codegraph MCP（`plugin/.mcp.json`）が担い、`--append-system-prompt` の探索方針もそちらを指しているため機能面の損失はない
  - **`--code-graph` を外すだけでは止まらない**。同フラグは「今すぐ index を張れ」の意味しかなく、tokensave の登録自体は `_setup_coding_compressor()` が**既定で**行う
  - **`--no-serena` を併せて渡す必要がある**。`_setup_coding_compressor()` は tokensave が無効だと Serena MCP をバックアップとして登録するため、`--no-tokensave` 単体では別の MCP に置き換わるだけになる
  - 既存の登録は、ledger（`~/.headroom/mcp_installs.json`）が headroom によるインストールを証明する場合に限り `--no-tokensave` が削除する（ユーザーが自分で入れたエントリは残す）
  - **MCP のツール数はコンテキスト肥大の主因ではない**。tokensave はツール81個・schema 約 15.7k tokens 相当だが、headroom が `ENABLE_TOOL_SEARCH=true` を立てて Claude Code のオンデマンドツール読み込みを有効にするため、MCP のツールスキーマはリクエストに載らず名前だけが遅延解決される。同一条件の A/B 実測差は **11 bytes / 3 tokens**（有り: content-length 114,638・tok_before 13,029 → 無し: 114,627・13,026）。ベースラインを占めているのは遅延できない組み込みツールの schema（proxy ログの `tool_search_deferral:15tools:12663tok`）であり、MCP を減らしても縮まない
- exit code は headroom が claude のものを `SystemExit(result.returncode)` で伝播するため、default モードの成否判定はそのまま使える
- **`headroom wrap claude` は claude 起動前に起動バナーを無条件で stdout へ出す**（`--verbose` と無関係で、抑止するオプションも無い）。これをそのまま数えると「exit 0 かつ stdout が空＝空振りセッション」の検知が永久に効かなくなるため、`buildTaskResult()` / `buildHerdrTaskResult()` は `headroom` が有効なとき `stripHeadroomBanner()`（先頭から続く空行 / 2スペース始まりの行を落とす）を通してから空判定する。バナーは claude 起動前にすべて出力され各行が空行か2スペース始まりなので、この形で claude 本体の出力に触れずに除去できる。通知に載せる `output` は元の stdout のままにしてあり、判定を誤っても失敗側（ラベルを進めない安全側）に倒れる
- `headroom: true` で headroom コマンドが PATH に無い場合は `assertHeadroomAvailable()`（`src/index.ts`）がワーカー起動時にエラー終了させる（直接起動へのサイレントフォールバックはしない）

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

UI実装Issueについて、実装の前に Pencil（`.pen`）でデザインを作り、独立したPRとしてマージしてから実装へ進むフロー。`claude-task-worker.json` の `uiDesign.enabled`（boolean、既定 `false`）と `uiDesign.designDir`（既定 `"designs"`）で制御する。設定は `src/config.ts` の `parseUiDesignEntry()`（不正値は警告して既定値）／`getUiDesignConfig()`（読み込み失敗時は既定＝無効へ倒す）で解決する。

- **`uiDesign.enabled: false` のときは2つのワーカーを起動しない**。判定は `index.ts` ではなくワーカー実装側（`create-ui-design.ts` / `apply-ui-design.ts`）の先頭に置き、`all` / `yolo` からの一括起動でも個別コマンドでも同じ経路を通す。ラベルを消費するワーカーが存在しないため、無効なリポジトリでは人が手動で `cc-create-ui-design` を付けても何も起きず、本機能の追加前と完全に同一の挙動になる
- 経路は `triage-created-issue` のパターンE-1（パターンD通過後・パターンEの手前）で分岐する。UI実装タスクと判定した場合は `cc-exec-issue` を付けずに `cc-create-ui-design` のみを付与する。判定が割れる場合は**デザインを作らない側（パターンE）に倒す**
- デザインPRの head は `cc-ui-design-<Issue番号>` の固定名ブランチ（`cc-epic-<N>` と同じ考え方で、後段が head ref から一意に特定できるようにするため）。ベースブランチは実装PRと揃える（`parent` があれば `cc-epic-<親>`、なければ default）。揃えないと epic 配下でデザインが実装ブランチに存在しない状態になる
- **デザインPRの Issue 参照は `Refs #N` 固定で closing keyword を禁止する**。`Closes` を使うとデザインPRのマージで実装Issueが閉じ、実装フェーズへ進めなくなる
- デザインPRのレビュー・マージは既存の `triage-pr` / `fix-review-point` / `resolve-pr-conflict` にそのまま乗せる（新しいマージ機構を作らない）。`.pen` のコンフリクトは `resolve-pr-conflict` → `resolve-pencil-conflict` の既存の委譲が効く。Epic PR ではないため `cc-release-ready` によるマージ保留の対象外
- `apply-ui-design` の `preflight` はデザインPRが `MERGED` のときだけ `proceed`、`OPEN` なら `skip`（マージ待ち）、未マージクローズ・PR不在は `cc-need-human-check` を付与して `skip`。同ラベルは `issue-worker.ts` の共通除外ラベルなので無限リトライしない
- `exec-issue` は `cc-ui-design-ready` が付いているのに description に `## UIデザイン` セクションが無い状態を検出したら、**デザインなしで実装せず** `cc-need-human-check` に落とす。復旧はデザイン参照を自動で再生成する場合、`cc-need-human-check` と `cc-ui-design-ready` を外して `cc-ui-design-pr-created` を付け直せば `apply-ui-design` が description を再生成する。`cc-need-human-check` を外さずに `cc-ui-design-pr-created` だけ付け直しても、同ラベルは `issue-worker.ts` の共通除外ラベルのため `apply-ui-design` のポーリング候補から外れたままになり再実行されない

## Conventions

- ESM (`NodeNext` module) — importは `.js` 拡張子付き
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
