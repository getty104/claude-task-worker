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
- **`src/commands/init.ts`** - GitHub ラベル初期作成コマンド
- **`src/commands/install.ts`** - マーケットプレイス追加・プラグインインストール・CLI自体のインストールを一括で行うコマンド
- **`src/commands/update.ts`** - プラグイン/マーケットプレイス・CLI自体の更新コマンド
- **`src/workers/`** - 各ワーカー実装
- **`plugin/`** - Claude Code プラグイン本体（`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `scripts/`, `.mcp.json`）
- **`.claude-plugin/marketplace.json`** - このリポジトリを Claude Code マーケットプレイスとして公開するための定義
- **`src/dispatcher.ts`** - ディスパッチャー本体。`runDispatcher()`（herdr疎通確認 → プロジェクトごとにタブ作成しコマンド送信。作成タブのラベルは `tabLabelFor()` で `ctw:` プレフィックス付き（`TAB_LABEL_PREFIX`）にし、既存タブの重複判定も同プレフィックスで行う）、`monitorSessions()`（セッション生存監視＋ステータステーブル描画ループの起動）、`renderSessionTable()`（稼働セッション一覧のテーブル描画）、`shutdownDispatcher()`（SIGINT/SIGTERM時、各セッションへctrl-c送信 → 終了待機 → タブクローズのグレースフルシャットダウン）
- **`src/herdr.ts`** - herdr CLIラッパー。`tabCreate`/`tabClose`/`tabList`（タブ管理）、`paneSendText`/`paneSendKeys`（ペインへの入力送信）、`paneProcessInfo`（フォアグラウンドプロセス確認）、`checkHerdrAvailable`（herdr導入・疎通確認）
- **`src/projects-config.ts`** - `projects.json`（`~/.config/claude-task-worker/projects.json` または `$XDG_CONFIG_HOME` 配下）のロード・検証・対象プロジェクト解決。`ProjectsConfig`（`projects`/`projectGroups` のネスト構造）、`loadProjectsConfig()`（読み込み・検証）、`resolveTargetProjects()`（プロジェクト名/グループ名/予約語 `all` の展開）
- **`src/dispatch-args.ts`** - `--project` ディスパッチ用CLI引数ヘルパー。`PROJECT_INCOMPATIBLE_COMMANDS`（`--project` と併用不可なコマンド一覧: `init`/`install`/`update`/`usage`/`version`）、`parseProjectFilters()`/`hasProjectFilter()`（`--project` の抽出・検出）、`buildForwardedCommand()`（`--project` とその値を除去し他プロジェクトへ転送するコマンド文字列を構築）

### Worker共通ライフサイクル

1. `gh api user` / `gh repo view` で現在ユーザー・リポジトリ情報取得
2. 一定間隔（ワーカーごとに設定）でGitHub APIをポーリング
3. ラベル・アサイン条件でフィルタリング
4. `isRunning()` で重複実行防止
5. トリガーラベル除去 → `cc-in-progress` ラベル付与
6. `.claude/worktrees/<worktreeId>` にワーカー自身がworktreeを生成し（`claude --worktree` は locked worktree の残骸問題があるため不使用）、Claude CLIプロセスをcwd指定で非同期spawn
7. 完了時コールバックでラベル・worktree・ローカルブランチをクリーンアップ

ワーカー起動時には `removeStaleWorktrees()` が前回の異常終了で残ったworktree（`adj-noun-4桁` の生成名パターンのみ対象）を回収する。実行中タスクのworktree・lockedな対話セッションのworktreeは削除対象から保護される。

### 同期実行ガード（`claude -p` セッションの早期終了防止）

ワーカーは各スキルを `claude -p "<skill> <n>"` の非対話（print）モードで起動する。print モードには再起動ループが無いため、スキル内でエージェントが処理をバックグラウンド化（`Bash(run_in_background:true)` / バックグラウンド `Agent` / `Monitor` / `ScheduleWakeup`）してターンを終えると、後続処理（E2E・テスト・commit/push・PR作成）の完了前にプロセスが exit 0 で終了してしまい、ワーカーが「正常完了」と誤認してラベル遷移（`cc-pr-created` 付与や `cc-fix-onetime` 除去）に進み、Issue/PR の状態が壊れる。

これを防ぐため、2層のガードを設ける。

1. **CLI レベルの `--disallowedTools`**（`src/claude-args.ts` の `DISALLOWED_TOOLS`）: ワーカーが `claude -p` を起動する際（`issue-worker.ts` / `pr-worker.ts`）、自律非対話実行では原理的に使い道がない（または有害な）ツールを完全無効化する。全ワーカー起動に一律適用される。対象カテゴリ:
   - 遅延/yield: `Monitor` / `ScheduleWakeup`（後続ウェイクアップ前提でプロセスが早期終了する）
   - 対話/承認: `AskUserQuestion` / `EnterPlanMode`（回答・承認するユーザーが存在しない）
   - スコープ外の副作用: `CronCreate` / `CronDelete` / `CronList` / `RemoteTrigger`（クラウド routine・リモート環境への副作用）
   - 環境管理の競合: `EnterWorktree`（ワーカー自前の worktree 管理と競合する）
   - `Exit*`（`ExitPlanMode` / `ExitWorktree`）は「万一その状態で開始した場合の脱出口」として残す。`Bash`/`Agent`（フォアグラウンドなら正当）や `TaskCreate` 等の進捗管理・`WebFetch`/`LSP`/各種 MCP（正当な用途あり）は無効化しない。
2. **スキルフロントマターの `PreToolUse` フック**（`plugin/scripts/block-async-execution.mjs`, matcher `Bash|Agent|Monitor|ScheduleWakeup`）: フォアグラウンドなら正当だがバックグラウンド実行が問題になる `Bash`（`run_in_background:true` / `&` 制御演算子 / `nohup`・`disown`・`setsid`）と `Agent`（`run_in_background:false` を明示しない呼び出し）を条件付きで deny し、フォアグラウンド同期実行への切り替えを促す。時間のかかる E2E テスト等も待ってから次に進む挙動が強制される。対象スキル: `exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue-from-issue-number` / `update-issue` / `triage-created-issue` / `triage-pr` / `resolve-pr-conflict` / `check-dependabot` / `create-epic-pr`。

いずれもスキル本文の「バックグラウンド実行禁止」プロンプトを補完するハードガード。

### Stopフックによる起動プロセスの後片付け（`plugin/scripts/stop-servers.mjs`）

上記の同期実行ガードでフォアグラウンド実行を強制しても、`docker compose up -d` やE2E/テストランナーが起動するWebサーバーのように、claudeプロセスから切り離されて init/launchd に再ペアレントされるサーバー・プロセスは、スキル完了後もポートを掴んだまま残留しうる。ワーカーはスキル終了直後にそのworktreeを削除するため、worktreeをcwdに持つ残留プロセスはリソースを浪費するだけでなくworktree削除の妨げにもなる。

これを防ぐため、ワーカー起動スキルのフロントマターに `Stop` フック（`plugin/scripts/stop-servers.mjs`）を設ける。スキルの `claude -p` セッション終了時に起動プロセスをベストエフォートで停止する（フックは常に exit 0 を返しスキルを異常終了させないが、即座に返るわけではなく、各サブコマンドの `timeout` 分は同期的に待機しうる。支配的なのは `docker compose down` の最大120秒待機）。処理は2段階:

1. **`docker compose down --volumes --remove-orphans`**: 実行cwd直下に compose ファイル（`docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml`）が存在する場合のみ実行。docker未導入・未起動でも無視して継続する。
2. **worktree配下を作業ディレクトリに持つ残留プロセスへ `SIGTERM`**: 実行cwd（worktree、`.claude/worktrees/<adj-noun-NNNN>` で一意）を cwd に持つプロセスだけを対象にする。切り離されたプロセスも起動時の cwd を保持し、worktree名はこの実行に固有なため、「この実行が起動したプロセス」だけを、ユーザー自身や別実行のプロセスに触れずに特定できる。ただし本フック自身の祖先チェーン（node フック・そのシェル・`claude` プロセスはいずれもworktreeをcwdに持つ）は除外し、自プロセスの巻き添え停止を防ぐ。プロセス列挙は Linux では `/proc/<pid>/cwd`、macOS 等では `lsof` を用いる。

判定ロジック（`selectPidsToKill` / `parseLsofCwds` / `isUnder` / `resolveTargetDir`）は純粋関数として export し、`plugin/scripts/stop-servers.test.mjs` でユニットテストする。対象スキルは同期実行ガードと同じ10スキル（`exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue-from-issue-number` / `update-issue` / `triage-created-issue` / `triage-pr` / `resolve-pr-conflict` / `check-dependabot` / `create-epic-pr`）。

### `--project` ディスパッチ

`src/index.ts` は起動時に `hasProjectFilter()` で `--project` フラグの有無を判定し、指定されている場合はワーカー起動の代わりにディスパッチャーを起動する（複数プロジェクトへ同一コマンドを一括転送する仕組み）。

1. `loadProjectsConfig()` で `projects.json` を読み込み・検証
2. `resolveTargetProjects()` で `--project` に渡されたプロジェクト名・グループ名・`all` を実プロジェクト一覧へ解決
3. `buildForwardedCommand()` で `--project` とその値を取り除いた転送用コマンド文字列を構築
4. `runDispatcher()` が各プロジェクトのディレクトリでherdrタブを作成し、転送コマンドを送信してセッションを起動
5. `monitorSessions()` がセッションの生存監視とステータステーブル描画ループを開始
6. SIGINT/SIGTERM受信時は `shutdownDispatcher()` が全セッションへctrl-cを送信し、終了を待ってからタブをクローズする

### ラベルフロー

| Worker | トリガーラベル | 完了時 |
|--------|-------------|--------|
| exec-issue | `cc-exec-issue` | `cc-in-progress` 除去 |
| fix-review-point | `cc-fix-onetime` or `cc-fix-repeat` | `cc-in-progress` 除去、`cc-fix-onetime` は除去・`cc-fix-repeat` は維持 |
| create-issue | `cc-triage-scope`（Open な blockedBy を持たない場合のみ） | Issue クローズ |
| update-issue | `cc-update-issue` | `@author Updated` コメント投稿 |

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
