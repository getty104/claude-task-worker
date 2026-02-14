# claude-task-worker

GitHub IssueやPRを定期ポーリングし、Claude CLIに処理を委譲するCLIツール。

## インストール

```bash
npm install -g claude-task-worker
```

## 使い方

```bash
claude-task-worker <worker-type> <interval-minutes>
```

### exec-issue

`dev-ready` ラベルが付いた自分にアサインされたIssueを定期的に取得し、Claude CLIで処理を実行する。

- `dev-ready` ラベルを外し、`in-progress` ラベルを付与
- `claude -p /exec-issue <issue番号>` を非同期で実行

```bash
claude-task-worker exec-issue 5
```

### fix-review-point

未解決のレビューコメントがあるPRを定期的に取得し、Claude CLIで修正を実行する。

- `in-progress` ラベルが付いていないPRが対象
- `in-progress` ラベルを付与
- `claude -p /fix-review-point <ブランチ名>` を非同期で実行

```bash
claude-task-worker fix-review-point 3
```

## 前提条件

- [GitHub CLI (`gh`)](https://cli.github.com/) がインストール・認証済みであること
- [Claude CLI (`claude`)](https://docs.anthropic.com/en/docs/claude-code) がインストール済みであること

## 開発

```bash
npm install
npm run build
```

## ライセンス

MIT
