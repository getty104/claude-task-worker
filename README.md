# claude-task-worker

GitHub Issues/PRを定期ポーリングし、Claude Codeに処理を委譲するCLIツール。

[base-tools](https://github.com/getty104/claude-code-marketplace) プラグインと組み合わせることで、GitHub Issue の実装からPRのレビュー対応、Dependabot PRの対応までを自動化する。

## アーキテクチャ

claude-task-worker がGitHubラベルを検知してタスクを起動し、base-tools プラグインのスキルが実際の処理を担う。

```
┌──────────────────────────────────────────┐
│                 GitHub                   │
│                                          │
│  Issue (cc-exec-issue)              ──┐  │
│  Issue (cc-create-issue)            ──┤  │
│  Issue (cc-update-issue)            ──┤  │
│  Issue (cc-answer-issue-questions)  ──┤  │
│  Issue (cc-triage-scope)            ──┤  │
│  PR    (cc-fix-onetime)             ──┤  │
│  PR    (cc-triage-scope)            ──┤  │
│  PR    (dependencies, Dependabot)   ──┤  │
└───────────────────────────────────────┼──┘
                                        │
                                        ▼
                         ┌────────────────────────┐
                         │   claude-task-worker   │
                         └───────────┬────────────┘
                                     │ invoke
                                     ▼
                         ┌────────────────────────┐
                         │    Claude Code CLI     │
                         │  + base-tools plugin   │
                         └────────────────────────┘
```

### Worker と base-tools スキルの対応

| Worker | トリガーラベル | 呼び出されるスキル | 間隔 |
|---|---|---|---|
| `exec-issue` | `cc-exec-issue` | `/base-tools:exec-issue` | 30秒 |
| `create-issue` | `cc-create-issue` | `/base-tools:create-issue` | 30秒 |
| `update-issue` | `cc-update-issue` | `/base-tools:update-issue` | 30秒 |
| `answer-issue-questions` | `cc-answer-issue-questions` | `/base-tools:answer-issue-questions` | 30秒 |
| `fix-review-point` | `cc-fix-onetime` | `/base-tools:fix-review-point` | 30秒 |
| `triage-issue` | `cc-triage-scope` (Issue) | `/base-tools:triage-issue` | 15分 |
| `triage-pr` | `cc-triage-scope` (PR) | `/base-tools:triage-pr` | 5分 |
| `check-dependabot` | `dependencies` (PR) | `/base-tools:check-dependabot` | 1時間 |

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

対象リポジトリで実行すると、必要なGitHubラベル・Issueテンプレート・GitHub Actionsワークフロー・設定ファイルが作成される。

```bash
claude-task-worker init
```

作成されるラベル:

| ラベル名 | 用途 |
|---------|------|
| `cc-create-issue` | Issue作成トリガー |
| `cc-update-issue` | Issue更新トリガー |
| `cc-answer-issue-questions` | Issue確認事項への回答トリガー |
| `cc-exec-issue` | Issue実行トリガー |
| `cc-fix-onetime` | PR修正トリガー（1回） |
| `cc-triage-scope` | トリアージ対象マーク（Issue/PR） |
| `cc-in-progress` | 処理中ステータス |
| `cc-issue-created` | Issue作成完了マーク |
| `cc-pr-created` | PR作成完了マーク |

作成されるファイル:

- `.github/ISSUE_TEMPLATE/cc-create-issue.yml` — `cc-create-issue` ラベル付きIssue作成用テンプレート
- `.github/workflows/assign-creator-on-cc-create-issue.yml` — Issue作成者を自動アサインするワークフロー
- `claude-task-worker.json` — 設定ファイル（コマンド実行ディレクトリ直下）

## コマンド

```bash
claude-task-worker <command>
```

### exec-issue

`cc-exec-issue` ラベルが付いた自分にアサインされたIssueを定期取得し、Claude Codeで処理を実行する。（30秒間隔）

- `cc-in-progress` ラベルを付与
- `/base-tools:exec-issue <issue番号> --triage-scope` を非同期で実行
- 完了後、`cc-exec-issue` ラベルを除去し、`cc-pr-created` ラベルを付与

### fix-review-point

`cc-fix-onetime` ラベルが付いたPRを定期取得し、Claude Codeで修正を実行する。（30秒間隔）

- CI完了済みで `cc-in-progress` がないPRが対象
- 完了後、設定ファイルに `fixReviewPointCallbackCommentMessage` が設定されていればPRにコメント投稿

### create-issue

`cc-create-issue` ラベルが付いたIssueを定期取得し、Claude CodeでIssue作成を実行する。（30秒間隔）

`init` コマンドで作成されるIssueテンプレートを使えば、`cc-create-issue` ラベル付与と作成者アサインが自動で行われ、ワーカーが即座に検知・処理を開始する。

### update-issue

`cc-update-issue` ラベルが付いたIssueを定期取得し、最新コメントの依頼内容に基づいてClaude CodeでIssue更新を実行する。（30秒間隔）

### answer-issue-questions

`cc-answer-issue-questions` ラベルが付いたIssueを定期取得し、Issueに記載された確認事項への回答をClaude Codeで生成する。（30秒間隔）

- 完了後、`cc-update-issue` ラベルを付与して update-issue ワーカーに引き継ぎ

### triage-issue

`cc-triage-scope` ラベルが付いたIssueを定期取得し、Claude Codeでトリアージを実行する。（15分間隔）

- `cc-pr-created` / `cc-create-issue` / `cc-update-issue` / `cc-answer-issue-questions` / `cc-exec-issue` のいずれかが付いているIssueは除外

### triage-pr

`cc-triage-scope` ラベルが付いたPRを定期取得し、Claude Codeでトリアージを実行する。（5分間隔）

- `cc-fix-onetime` が付いているPRは除外

### check-dependabot

`dependencies` ラベルが付いたDependabot PRを定期取得し、依存ライブラリのバージョンアップ内容を確認する。（1時間間隔）

- `cc-triage-scope` が付いているPRは除外
- 完了後、`cc-triage-scope` ラベルを付与して triage-pr ワーカーに引き継ぎ

### all

通常ワーカー5つ（exec-issue, fix-review-point, create-issue, update-issue, answer-issue-questions）を同時にポーリングする。

### yolo

すべてのワーカー8つ（`all` + triage-issue + triage-pr + check-dependabot）を同時にポーリングする。

### usage

現在のClaude API使用状況をSlackに通知する。

## 設定ファイル

コマンドを実行したディレクトリ直下の `claude-task-worker.json` を読み込む。

| キー | 型 | デフォルト | 説明 |
|---|---|---|---|
| `maxConcurrentTasks` | number | 4 | 同時実行可能なタスクの最大数 |
| `fixReviewPointCallbackCommentMessage` | string | - | fix-review-point 完了時にPRへ投稿するコメント（未設定の場合は投稿しない） |
| `workers` | object | `{}` | ワーカーごとに Claude CLI の `--model` / `--effort` を上書きする設定（詳細は下記） |

### ワーカーごとのモデル・effort 設定

`workers` キーにワーカー名ごとの設定オブジェクトを指定することで、Claude CLI に渡す `--model` / `--effort` を個別に上書きできる。未指定のワーカー・フィールドは下記のワーカー別デフォルト値が使用される。

| ワーカー名 | デフォルト `model` | デフォルト `effort` |
|---|---|---|
| `answer-issue-questions` | `opus` | `high` |
| `create-issue` | `opus` | `high` |
| `update-issue` | `sonnet` | `high` |
| `exec-issue` | `sonnet` | `high` |
| `fix-review-point` | `sonnet` | `high` |
| `triage-issue` | `sonnet` | `high` |
| `triage-pr` | `sonnet` | `high` |
| `check-dependabot` | `sonnet` | `high` |

各フィールドの値:

| フィールド | 型 | 説明 |
|---|---|---|
| `model` | string | Claude CLI の `--model` に渡す値（例: `sonnet`, `opus`, `haiku`） |
| `effort` | string | Claude CLI の `--effort` に渡す値（例: `high`, `medium`, `low`） |

設定例:

```json
{
  "maxConcurrentTasks": 2,
  "workers": {
    "exec-issue":        { "model": "opus",   "effort": "high" },
    "fix-review-point":  { "model": "sonnet", "effort": "high" },
    "triage-pr":         { "effort": "medium" },
    "check-dependabot":  { "model": "haiku" }
  }
}
```

> 💡 **推奨:** 重い実装タスク（`exec-issue`, `fix-review-point`）では `/advisor` を有効にすることを推奨する。事前/事後に強力なレビューモデルへ相談することで、アプローチの誤りや見落としを早期に検出でき、完了率と品質が向上する。各ワーカーが呼び出すスキルのプロンプト内で `advisor` ツールを活用する運用を推奨。

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
