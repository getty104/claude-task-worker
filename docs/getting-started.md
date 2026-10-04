# 1. はじめに（ハンズオン）

インストールから、1件の Issue を自動で PR にするまでを手を動かして確認する。所要時間は 15〜30 分程度（タスクの実行時間を除く）。

## 0. 前提

- Node.js 22.13 以上
- `gh` がインストール済みで `gh auth login` 済み
- `claude`（Claude Code）がインストール済みでサインイン済み
- `git` / `jq`
- 試してよい GitHub リポジトリ（push 権限があるもの。最初は検証用リポジトリを推奨）

## 1. インストール

```bash
npx claude-task-worker install
```

CLI 本体・Claude Code プラグイン・補助 CLI（CodeGraph など）がまとめて入る。終わったら開いている Claude Code セッションを再起動する。

確認:

```bash
claude-task-worker version
claude-task-worker list-workers
```

`list-workers` にプリセットのワーカー（`exec-issue` など）が並べば OK。

## 2. 対象リポジトリの初期化

```bash
cd ~/src/my-app
claude-task-worker init
git add -A && git commit -m "chore: setup claude-task-worker" && git push
```

`init` は次を作る。

- GitHub ラベル（`cc-exec-issue`、`cc-triage-scope` など）
- Issue テンプレート・GitHub Actions ワークフロー
- `claude-task-worker.json`（リポジトリ設定）
- `.gitignore` への `claude-task-worker.local.json` 登録
- CodeGraph のインデックス

> ワーカーは worktree を**リモートのデフォルトブランチ**から作る。`init` で作ったファイルは push しておく。

## 3. 最初のタスクを実行する

いちばん単純な経路は「実装してほしい内容を書いた Issue に `cc-exec-issue` を付ける」こと。

1. Issue を作る。例: タイトル「README にライセンス節を追加」、本文に何をしてほしいかを書く
2. **Assignee を自分にする**（ワーカーは自分が Assignee の Issue/PR しか拾わない）
3. ラベル `cc-exec-issue` を付ける

```bash
gh issue create --title "README にライセンス節を追加" \
  --body "README.md の末尾に MIT ライセンスである旨の節を追加する" \
  --assignee @me --label cc-exec-issue
```

ワーカーを起動する:

```bash
claude-task-worker exec-issue
```

1 分以内に Issue が拾われ、ステータステーブルに行が現れる。Issue には `cc-in-progress` が付き、完了すると PR が作られて Issue に `cc-pr-created` が付く。止めるときは Ctrl-C（もう一度押すと強制終了）。

## 4. 全ワーカーで回す

日常運用ではワーカーをまとめて起動する。

```bash
claude-task-worker all
```

`all` は Issue の分析 → 実装 → レビュー対応までのワーカーを一括で動かす。PR のトリアージ（自動マージ判定）まで任せる場合は `yolo` を使う（[2章](./workflows.md)参照）。

## 5. Slack 通知（任意）

```bash
export CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
claude-task-worker all
```

タスクの完了・失敗ごとに最終報告が届く。

## 次に読む

- ラベルの流れと運用: [2. 日常の使い方](./workflows.md)
- 独自のワーカーを作る: [3. カスタムワーカーを作る](./custom-worker.md)
