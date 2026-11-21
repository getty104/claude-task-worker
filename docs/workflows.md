# 2. 日常の使い方

## ラベルの流れ

ワーカーはラベルを見て動き、ラベルを付け替えて次のワーカーへ渡す。人が介入するときもラベルを付け外しするだけでよい。

```text
[Issue]
  cc-triage-scope ──create-issue──▶ 実装プランを description に書く + cc-issue-created
        │
        ▼ triage-created-issue（yolo のみ）
        ├─ 確認事項あり     → cc-answer-issue-questions ──answer-issue-questions──▶ cc-update-issue ──update-issue──▶ 再トリアージ
        ├─ 人の判断が必要   → cc-need-human-check（停止）
        ├─ UI デザインが必要 → cc-create-ui-design（uiDesign.enabled 時のみ）
        └─ 着手可能         → cc-exec-issue
                                   │ exec-issue
                                   ▼
[PR]  cc-triage-scope ──triage-pr（yolo のみ）──▶ マージ / cc-fix-onetime / cc-resolve-conflict
                                                     │ fix-review-point / resolve-conflict
                                                     └──▶ cc-triage-scope に戻る
```

主なラベル:

| ラベル | 付ける人 | 意味 |
|---|---|---|
| `cc-triage-scope` | 人 / ワーカー | ワーカーのキューへ入れる（Issue: 分析待ち、PR: トリアージ待ち） |
| `cc-exec-issue` | 人 / ワーカー | この Issue を実装して PR にする |
| `cc-update-issue` | 人 | コメントの内容を description に反映し直す |
| `cc-answer-issue-questions` | 人 / ワーカー | 確認事項にコードベースを調べて回答する |
| `cc-fix-onetime` | 人 / ワーカー | PR のレビュー指摘・CI 失敗に1回対応する |
| `cc-resolve-conflict` | 人 / ワーカー | PR のコンフリクトを解消する |
| `cc-in-progress` | ワーカー | 処理中（手で付けると対象外になる） |
| `cc-need-human-check` | ワーカー / 人 | 人の確認待ち。付いている間はどのワーカーも触らない。外すと再開する |

## `all` と `yolo` の使い分け

| コマンド | 自動化の範囲 | 向いている運用 |
|---|---|---|
| `claude-task-worker all` | Issue 分析・実装・レビュー対応。ルーティング（`triage-created-issue`）と PR のマージ判定（`triage-pr`）は人が行う | 着手判断とマージを人が握りたい |
| `claude-task-worker yolo` | 上記に加えてルーティング・PR のマージ判定・Dependabot 対応まで | 人は `cc-need-human-check` が付いたものだけ見る |
| `claude-task-worker <ワーカー名>` | そのワーカーだけ | 試験運用・特定の工程だけ自動化 |

`all` 運用での人の作業は次の3つになる。

1. 分析済み Issue（`cc-issue-created`）を読んで `cc-exec-issue` を付ける
2. PR をレビューし、指摘があればコメントして `cc-fix-onetime` を付ける
3. マージする

## 依頼の出し方

- **Issue テンプレートから起票**: `init` が置いたテンプレートを使うと `cc-triage-scope` と `cc-issue-request` が付き、起票者が Assignee になる。`create-issue` が実装プランを書く
- **Issue を直接作って `cc-exec-issue`**: 依頼内容が明確で分析が不要な場合
- **Claude Code から起票**: `/claude-task-worker:create-issue <依頼内容>` で実装プラン付きの Issue を作る。大きな依頼は `/claude-task-worker:breakdown-issues` で複数 Issue に分解する

どの経路でも **Assignee が自分（ワーカーを動かしている `gh` ユーザー）であること**が拾われる条件。

## Epic（親子 Issue）

サブ Issue を持つ親 Issue に `cc-epic-issue` を付けると、サブ Issue の PR はデフォルトブランチではなく `cc-epic-<親番号>` ブランチへ集約される。サブ Issue が全部クローズされると `epic-issue` ワーカーがまとめ PR を作る。まとめ PR は `triage-pr` がマージ可能と判断しても `cc-release-ready` を付けるだけで、リリース（マージ）は人が行う。

特定の Epic だけを処理したいときは `--epic` で絞る。

```bash
claude-task-worker all --epic 120
```

## 人の確認が必要になったとき

`cc-need-human-check` が付いた Issue/PR には理由のコメントが残る。対応したらラベルを外せばワーカーが再開する。よくある原因と対処は [6. トラブルシューティング](./troubleshooting.md) を参照。

## ワーカーの個別設定

リポジトリ直下の `claude-task-worker.json` でワーカーごとにモデル・間隔・同時実行数・有効/無効を変えられる。

```json
{
  "workers": {
    "exec-issue": { "maxConcurrentTasks": 3 },
    "check-dependabot": { "enabled": false }
  }
}
```

個人の環境だけで変えたい値は `claude-task-worker.local.json`（コミットしない）に書く。キーの一覧は [README](../README.md#ワーカーごとの設定) を参照。複数リポジトリで同じ設定を使い回す方法は [4章](./config-package.md)。

## 複数リポジトリを同時に回す（`--project`）

[herdr](https://herdr.dev) を入れ、`~/.config/claude-task-worker/config.json` にプロジェクトを登録すると、1コマンドで複数リポジトリのワーカーを起動できる。

```json
{
  "projects": {
    "app-a": "/Users/me/src/app-a",
    "app-b": "/Users/me/src/app-b"
  },
  "projectGroups": { "frontend": ["app-a", "app-b"] }
}
```

```bash
claude-task-worker all --project all
claude-task-worker exec-issue --project frontend
```
