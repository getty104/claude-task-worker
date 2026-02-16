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
claude-task-worker create-issue    # Poll create-issue labeled issues
claude-task-worker update-issue    # Poll update-issue labeled issues
claude-task-worker all             # Run all workers concurrently
```

## Architecture

ポーリングベースのCLIツール。GitHub Issues/PRを定期監視し、Claude CLIプロセスを起動してAI駆動タスクを実行する。

### コア構成

- **`src/index.ts`** - CLI エントリポイント。コマンドルーティング
- **`src/gh.ts`** - GitHub CLI (`gh`) ラッパー。全GitHub操作を集約
- **`src/process-manager.ts`** - 子プロセス管理。リアルタイムステータステーブル表示、プロセスライフサイクル管理
- **`src/commands/init.ts`** - GitHub ラベル初期作成コマンド
- **`src/workers/`** - 各ワーカー実装

### Worker共通ライフサイクル

1. `gh api user` / `gh repo view` で現在ユーザー・リポジトリ情報取得
2. 30秒間隔でGitHub APIをポーリング
3. ラベル・アサイン条件でフィルタリング
4. `isRunning()` で重複実行防止
5. トリガーラベル除去 → `in-progress` ラベル付与
6. Claude CLIプロセスを非同期spawn
7. 完了時コールバックでラベルクリーンアップ

### ラベルフロー

| Worker | トリガーラベル | 完了時 |
|--------|-------------|--------|
| exec-issue | `dev-ready` | `in-progress` 除去 |
| fix-review-point | `fix-onetime` or `fix-repeat` | `in-progress` 除去、`fix-onetime` は除去・`fix-repeat` は維持 |
| create-issue | `create-issue` | Issue クローズ |
| update-issue | `update-issue` | `@author Updated` コメント投稿 |

## Conventions

- ESM (`NodeNext` module) — importは `.js` 拡張子付き
- ログは `[worker-name]` プレフィックス付き
- エラーはtry-catchでログ出力し、ワーカーはクラッシュせず継続
- SIGTERM/SIGINT で全子プロセスを graceful shutdown

## Prerequisites

- GitHub CLI (`gh`) がインストール・認証済み
- Claude Code (`claude`) がインストール済み
- [base-tools](https://github.com/getty104/claude-code-marketplace) がインストール済み
