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
- **`src/commands/update.ts`** - プラグイン/マーケットプレイス・CLI自体の更新コマンド
- **`src/workers/`** - 各ワーカー実装
- **`plugin/`** - Claude Code プラグイン本体（`.claude-plugin/plugin.json`, `skills/`, `agents/`, `hooks/`, `scripts/`, `.mcp.json`）
- **`.claude-plugin/marketplace.json`** - このリポジトリを Claude Code マーケットプレイスとして公開するための定義

### Worker共通ライフサイクル

1. `gh api user` / `gh repo view` で現在ユーザー・リポジトリ情報取得
2. 一定間隔（ワーカーごとに設定）でGitHub APIをポーリング
3. ラベル・アサイン条件でフィルタリング
4. `isRunning()` で重複実行防止
5. トリガーラベル除去 → `cc-in-progress` ラベル付与
6. Claude CLIプロセスを非同期spawn
7. 完了時コールバックでラベルクリーンアップ

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
  - `claude plugin marketplace add getty104/claude-task-worker`
  - `claude plugin install claude-task-worker@claude-task-worker`
