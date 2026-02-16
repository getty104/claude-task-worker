# claude-task-worker

GitHub IssueやPRを定期ポーリングし、Claude CLIに処理を委譲するCLIツール。

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

`dev-ready` ラベルが付いた自分にアサインされたIssueを定期的に取得し、Claude CLIで処理を実行する。

- `dev-ready` ラベルを外し、`in-progress` ラベルを付与
- `claude -p /exec-issue <issue番号>` を非同期で実行

```bash
claude-task-worker exec-issue
```

### fix-review-point

未解決のレビューコメントがあるPRを定期的に取得し、Claude CLIで修正を実行する。

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
