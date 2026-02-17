# claude-task-worker

GitHub IssueやPRを定期ポーリングし、Claude Codeに処理を委譲するCLIツール。

## インストール

```bash
npm install
npm run build
npm link
```

## 使い方

```bash
claude-task-worker <worker-type>
```

### exec-issue

`dev-ready` ラベルが付いた自分にアサインされたIssueを定期的に取得し、Claude Codeで処理を実行する。

- `dev-ready` ラベルを外し、`in-progress` ラベルを付与
- `claude -p /exec-issue <issue番号>` を非同期で実行

```bash
claude-task-worker exec-issue
```

### fix-review-point

未解決のレビューコメントがあるPRを定期的に取得し、Claude Codeで修正を実行する。

- `in-progress` ラベルが付いていないPRが対象
- `in-progress` ラベルを付与
- `claude -p /fix-review-point <ブランチ名>` を非同期で実行

```bash
claude-task-worker fix-review-point
```

### all

すべてのワーカーを同時にポーリングする。

```bash
claude-task-worker all
```

### create-issue

`create-issue` ラベルが付いたIssueを定期的に取得し、Claude CodeでIssue作成を実行する。

- `create-issue` ラベルを外し、`in-progress` ラベルを付与
- `claude -p /create-issue <Issue本文>` を非同期で実行
- 完了後、Issueをクローズ

```bash
claude-task-worker create-issue
```

### update-issue

`update-issue` ラベルが付いたIssueを定期的に取得し、最新コメントの依頼内容に基づいてClaude CodeでIssue更新を実行する。

- `update-issue` ラベルを外し、`in-progress` ラベルを付与
- `claude -p /update-issue` を非同期で実行
- 完了後、依頼者にメンションしてコメント

```bash
claude-task-worker update-issue
```

### init

必要なGitHubラベルを作成する。

```bash
claude-task-worker init
```

## Slack通知

環境変数 `CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL` にSlack Incoming Webhook URLを設定すると、各ワーカーのタスク開始時・完了時・失敗時にSlackへ通知が送信される。

```bash
export CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
claude-task-worker all
```

未設定の場合、通知は送信されない。

## 前提条件

- [GitHub CLI (`gh`)](https://cli.github.com/) がインストール・認証済みであること
- [Claude Code (`claude`)](https://docs.anthropic.com/en/docs/claude-code) がインストール済みであること
- [base-tools](https://github.com/getty104/claude-code-marketplace) がインストール済みであること

## 開発

```bash
npm install
npm run build
```

## ライセンス

MIT
