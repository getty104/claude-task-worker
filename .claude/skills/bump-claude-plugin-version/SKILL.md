---
name: bump-claude-plugin-version
description: claude-task-workerプラグインのバージョンをインクリメントし、commit-pushでコミット・プッシュしたうえでPRを作成する。引数で `major` / `minor` / `patch` を受け取り、対応する部分をインクリメントする（省略時は `patch`）。「バージョンを上げて」「バージョンアップ」「bump version」「メジャーバージョンを上げて」などのリクエストで使用する。
---

# Bump Claude Plugin Version

`plugin/.claude-plugin/plugin.json` のバージョンをインクリメントし、変更をコミット・プッシュしたうえでPRを作成するスキルです。引数で `major` / `minor` / `patch` を受け取り、対応する部分をインクリメントします。

## 実行ステップ

### ステップ0: バンプ種別を決定

引数（`$ARGUMENTS`）でバンプ種別を受け取る。

- `major` … メジャーバージョンをインクリメント
- `minor` … マイナーバージョンをインクリメント
- `patch` … パッチバージョンをインクリメント

判定ルール：

- 引数が上記いずれかであれば、それを採用する（大文字小文字は区別しない。`major`/`minor`/`patch` のほか、先頭一致で `maj`/`min`/`pat` のような省略や、日本語の「メジャー」「マイナー」「パッチ」も同義として解釈してよい）
- 引数が空、または上記のいずれにも該当しない場合は **`patch`** をデフォルトとして採用する

### ステップ1: 現在のバージョンを取得

以下のコマンドで現在のバージョンを取得：

```bash
cat plugin/.claude-plugin/plugin.json | jq -r '.version'
```

### ステップ2: バージョンをインクリメント

取得したバージョンを `major.minor.patch` に分解し、ステップ0で決定したバンプ種別に応じて新しいバージョンを算出する。**インクリメントした桁より下位の桁は 0 にリセットする。**

現在のバージョンが `1.2.3` の場合の例：

| バンプ種別 | 新バージョン |
|------------|--------------|
| `major`    | `2.0.0`      |
| `minor`    | `1.3.0`      |
| `patch`    | `1.2.4`      |

### ステップ3: plugin.json を更新

`plugin/.claude-plugin/plugin.json` の `version` フィールドを新しいバージョンに更新する。

### ステップ4: コミットとプッシュ

変更を現在のブランチにコミット・プッシュする。

### ステップ5: PRを作成

pushしたブランチから、デフォルトブランチへのPRを作成する。バージョンバンプはIssueに紐づかないchore作業のため、`create-pr` スキル（`Closes #<Issue>` と `cc-triage-scope` ラベルを前提とする）は使わず、`gh pr create` で直接作成する。

- タイトル: `chore(plugin): Bump version to <新バージョン>`
- ベースブランチ: デフォルトブランチ（`gh repo view --json defaultBranchRef -q .defaultBranchRef.name`）
- Assignees: `gh api user --jq '.login'` で取得した自分自身
- 本文: バージョンを `<旧バージョン>` から `<新バージョン>` に更新した旨を記載

```bash
gh pr create \
  --title "chore(plugin): Bump version to <新バージョン>" \
  --body "claude-task-worker プラグインのバージョンを <旧バージョン> から <新バージョン> に更新（<バンプ種別> bump）。" \
  --base "$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)" \
  --assignee "$(gh api user --jq '.login')"
```

作成後、PRのURLを報告する。既に同一ブランチのPRが存在する場合は新規作成せず、そのURLを報告する。
