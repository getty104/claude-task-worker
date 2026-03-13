# claude-task-worker

GitHub Issues/PRを定期ポーリングし、Claude Codeに処理を委譲するCLIツール。

[base-tools](https://github.com/getty104/claude-code-marketplace) プラグインと組み合わせることで、GitHub Issue の実装からPRのレビュー対応までを自動化する。

## アーキテクチャ

claude-task-worker がGitHubラベルを検知してタスクを起動し、base-tools プラグインのスキルが実際の処理を担う。

```
┌─────────────────────────────────────────────────────┐
│                   GitHub                            │
│  Issue (cc-exec-issue)  ──┐                         │
│  Issue (cc-create-issue) ─┤                         │
│  Issue (cc-update-issue) ─┤    ┌──────────────────┐ │
│  PR (cc-fix-onetime)    ──┼───▶│claude-task-worker│ │
│  PR (cc-fix-repeat)     ──┘    └────────┬─────────┘ │
└─────────────────────────────────────────┼───────────┘
                                          │ invoke
                                          ▼
                               ┌─────────────────────┐
                               │    Claude Code CLI   │
                               │  + base-tools plugin │
                               └─────────────────────┘
```

### Worker と base-tools スキルの対応

| Label | Worker | 呼び出されるスキル | 間隔 |
|---|---|---|---|
| `cc-exec-issue` | `exec-issue` | `/base-tools:exec-issue` | 30秒 |
| `cc-create-issue` | `create-issue` | `/base-tools:create-issue` | 30秒 |
| `cc-update-issue` | `update-issue` | `/base-tools:update-issue` | 30秒 |
| `cc-fix-onetime` | `fix-review-point` | `/base-tools:fix-review-point` | 30秒 |
| `cc-fix-repeat` | `fix-review-point` | `/base-tools:fix-review-point`（繰り返し） | 30秒 |
| ― | `triage-issues` | `/base-tools:triage-issues` | 10分 |
| ― | `triage-prs` | `/base-tools:triage-prs` | 10分 |

## セットアップ

### 前提条件

- [GitHub CLI (`gh`)](https://cli.github.com/) がインストール・認証済みであること
- [Claude Code (`claude`)](https://docs.anthropic.com/en/docs/claude-code) がインストール済みであること
- [base-tools](https://github.com/getty104/claude-code-marketplace) プラグインがインストール済みであること

### インストール

```bash
npm install
npm run build
npm link
```

### 初期化

対象リポジトリで実行すると、必要なGitHubラベル・Issueテンプレート・GitHub Actionsワークフローが作成される。

```bash
claude-task-worker init
```

作成されるラベル:

| ラベル名 | 色 | 用途 |
|---------|-----|------|
| `cc-create-issue` | 🔵 blue | Issue作成トリガー |
| `cc-update-issue` | 🟡 yellow | Issue更新トリガー |
| `cc-exec-issue` | 🟣 purple | Issue実行トリガー |
| `cc-fix-onetime` | 🔴 red | PR修正トリガー（1回） |
| `cc-fix-repeat` | 🟠 light red | PR修正トリガー（繰り返し） |
| `cc-in-progress` | 🟢 green | 処理中ステータス |
| `cc-created-issue` | 🟠 orange | Issue作成完了マーク |

## コマンド

```bash
claude-task-worker <command>
```

### exec-issue

`cc-exec-issue` ラベルが付いた自分にアサインされたIssueを定期取得し、Claude Codeで処理を実行する。（30秒間隔）

- `cc-in-progress` ラベルを付与
- `claude -p "/base-tools:exec-issue <issue番号>" --worktree` を非同期で実行
- 完了後、`cc-exec-issue` ラベルを除去

```bash
claude-task-worker exec-issue
```

### fix-review-point

`cc-fix-onetime` または `cc-fix-repeat` ラベルが付いたPRを定期取得し、Claude Codeで修正を実行する。（30秒間隔）

- CI完了済みで `cc-in-progress` がないPRが対象
- `cc-in-progress` ラベルを付与
- `claude -p "/base-tools:fix-review-point <ブランチ名>" --worktree` を非同期で実行
- 完了後:
  - `cc-in-progress` ラベルを除去
  - `cc-fix-onetime` の場合: ラベルを除去（1回限り）
  - `cc-fix-repeat` の場合: ラベルを維持（次回のポーリングで再度チェック）

```bash
claude-task-worker fix-review-point
```

### create-issue

`cc-create-issue` ラベルが付いたIssueを定期取得し、Claude CodeでIssue作成を実行する。（30秒間隔）

- `cc-in-progress` ラベルを付与
- `claude -p "/base-tools:create-issue #<issue番号>" --worktree` を非同期で実行
- 完了後、`cc-create-issue` と `cc-in-progress` ラベルを除去し、`cc-created-issue` ラベルを付与

`init` コマンドを実行すると、Issueテンプレート（`.github/ISSUE_TEMPLATE/cc-create-issue.yml`）と自動アサイン用のGitHub Actionsワークフローが作成される。このテンプレートを使ってIssueを作成すると、`cc-create-issue` ラベルの付与と作成者へのアサインが自動で行われるため、ワーカーが即座にIssueを検知して処理を開始できる。

```bash
claude-task-worker create-issue
```

### update-issue

`cc-update-issue` ラベルが付いたIssueを定期取得し、最新コメントの依頼内容に基づいてClaude CodeでIssue更新を実行する。（30秒間隔）

- `cc-update-issue` ラベルを外し、`cc-in-progress` ラベルを付与
- Issueの最新コメントを取得し、`claude -p "/base-tools:update-issue"` を非同期で実行
- 完了後、`cc-update-issue` と `cc-in-progress` ラベルを除去

```bash
claude-task-worker update-issue
```

### triage-issues

全Issueを定期取得し、`cc-in-progress` ラベルがないIssueをClaude Codeで自動トリアージする。（10分間隔）

```bash
claude-task-worker triage-issues
```

### triage-prs

全PRを定期取得し、CI完了済みで `cc-in-progress` ラベルがないPRをClaude Codeで自動トリアージする。（10分間隔）

```bash
claude-task-worker triage-prs
```

### usage

現在のClaude API使用状況をSlackに通知する。

```bash
claude-task-worker usage
```

### all

通常ワーカー4つ（exec-issue, fix-review-point, create-issue, update-issue）を同時にポーリングする。

```bash
claude-task-worker all
```

### yolo

すべてのワーカー6つ（通常4つ + triage-issues + triage-prs）を同時にポーリングする。

```bash
claude-task-worker yolo
```

## Slack通知

環境変数 `CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL` にSlack Incoming Webhook URLを設定すると、各ワーカーのタスク完了時・失敗時にSlackへ通知が送信される。

```bash
export CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
claude-task-worker all
```

通知にはClaude APIの使用状況（5時間/7日間の利用率とリセット時刻）も含まれる。未設定の場合、通知は送信されない。

## プロセス管理

実行中のタスクはリアルタイムのステータステーブルで表示される。

- タスクID・タイトル・ステータス（running/completed/failed）・開始時刻・経過時間を表示
- 同一Issue/PRの重複実行を自動防止
- SIGTERM/SIGINTで全子プロセスをgraceful shutdown

## 開発

```bash
npm install
npm run build    # TypeScript → dist/
npm run dev      # Watch mode (auto-rebuild)
```

## ライセンス

MIT
