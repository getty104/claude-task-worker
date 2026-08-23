---
name: solve-github-workflow-problem
description: GitHub Actions ワークフローのURLを受け取り、その最新実行が失敗している場合に原因を調査・特定して修正し、PRを作成します。最新実行が成功している場合は何もしません。
argument-hint: "[workflow-url]"
---

# Solve GitHub Workflow Problem

指定された GitHub Actions ワークフローの**最新の実行結果**を確認し、失敗していれば原因を特定して修正PRを作成するスキルです。

# Instructions

## ステップ0: 引数のパース

`$ARGUMENTS` に渡された URL から `owner` / `repo` / ワークフローの識別子を取り出す。受け付ける形式:

| URL 形式 | 取り出すもの |
|---------|------------|
| `https://github.com/<owner>/<repo>/actions/workflows/<file>.yml` | ワークフローファイル名 |
| `https://github.com/<owner>/<repo>/actions/runs/<run-id>` | run ID（そのrunが属するワークフローを対象にする） |
| `https://github.com/<owner>/<repo>/actions/workflows/<file>.yml?query=...` | クエリ文字列を捨ててファイル名 |

```bash
URL=$(printf '%s' "$ARGUMENTS" | tr -d '[:space:]')
REPO=$(printf '%s' "$URL" | sed -E 's#^https?://github\.com/([^/]+/[^/]+)/.*#\1#')
WORKFLOW=$(printf '%s' "$URL" | sed -E 's#.*/actions/workflows/([^/?#]+).*#\1#;t;d')
RUN_ID=$(printf '%s' "$URL" | sed -E 's#.*/actions/runs/([0-9]+).*#\1#;t;d')
```

`REPO` が取れない（URLがGitHub ActionsのURLでない）場合は、その旨を報告して終了する。

`WORKFLOW` と `RUN_ID` がどちらも空（ワークフローURL・run URLのいずれの形式にも一致しない）場合は、対象URLとして不正である旨を報告して終了する。

```bash
if [ -z "$WORKFLOW" ] && [ -z "$RUN_ID" ]; then
  echo "対象URLとして不正です（ワークフローURL / run URLのいずれの形式にも一致しません）"
  exit 1
fi
```

`RUN_ID` だけが取れた場合は、そのrunが属するワークフローを `workflowDatabaseId`（数値ID）で引き当てる。同名ワークフローが複数存在すると `workflowName` では一意に解決できないため、数値IDを使う:

```bash
if [ -z "$WORKFLOW" ] && [ -n "$RUN_ID" ]; then
  WORKFLOW=$(gh run view "$RUN_ID" --repo "$REPO" --json workflowDatabaseId -q .workflowDatabaseId)
fi
```

### 対象リポジトリの確認

```bash
CURRENT_REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
```

`REPO` が `CURRENT_REPO` と一致しない場合、**修正は行わない**。原因の調査結果だけを報告して終了する（作業ディレクトリのリポジトリと別リポジトリのコードは修正できないため）。

## ステップ1: 最新実行結果の取得

```bash
gh run list --repo "$REPO" --workflow "$WORKFLOW" --all --limit 1 \
  --json databaseId,displayTitle,headBranch,headSha,status,conclusion,createdAt,url
```

無効化されたワークフローのrunも対象にするため `--all` を付ける（`--all` が無いと `gh run list --workflow` は無効化されたワークフローのrunを返さない）。

- `status` が `completed` でない（実行中・キュー待ち）: **何もしない**。実行中である旨を報告して終了する
- `conclusion` が `success` / `skipped` / `cancelled`: **何もしない**。その旨を報告して終了する
- `conclusion` が `action_required` / `neutral` / `stale`: 人手対応が必要である旨を報告して終了する
- `conclusion` が `failure` / `timed_out` / `startup_failure`: ステップ2へ進む

実行履歴が1件も無い場合も何もせず報告して終了する。

## ステップ2: 失敗原因の調査と特定

```bash
RUN_ID=<ステップ1のdatabaseId>

# 失敗したジョブ・ステップの一覧（成功系のskipped/cancelledを誤って拾わないよう、失敗値だけを明示的に指定する）
gh run view "$RUN_ID" --repo "$REPO" --json jobs \
  -q '.jobs[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure") | {name, conclusion, steps: [.steps[] | select(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure") | .name]}'

# 失敗したステップのログ
gh run view "$RUN_ID" --repo "$REPO" --log-failed
```

ログが長い場合は失敗したジョブに絞る（`gh run view --job <job-id> --log`）。

ログから**エラーの一次原因**（最初に失敗した箇所）を特定する。後続のエラーは一次原因の波及であることが多いため、ログの末尾ではなく**最初のエラー**を起点に読むこと。

原因を次のいずれかに分類する:

- **A. リポジトリ内の変更で直せる**: テスト失敗・型エラー・Lintエラー・ビルドエラー・ワークフロー定義（`.github/workflows/*.yml`）の誤り・依存関係の不整合・アクションの非推奨/廃止バージョン
- **B. リポジトリ内の変更では直せない**: シークレット/権限不足、外部サービス障害、レート制限、APIクレジット枯渇、CIランナー障害
- **C. 一過性の可能性がある**: ネットワーク到達不能、イメージ取得失敗、キャッシュ破損、flakyテスト

原因箇所の特定にはコード探索を使う（CodeGraph MCP ツールが使える場合はそれを優先し、無ければ `Grep` / `Glob`）。ワークフロー定義自体の問題は `.github/workflows/` を直接確認する。

### C（一過性）の場合

同一ワークフローの直近の実行を確認し、**対象runと同じ `headSha`（同じコード）**で成功しているrunがあるかを見る。別コミットの成功runを「同じコード」と誤認しないよう、`headSha` の一致を必ず確認すること。

```bash
gh run list --repo "$REPO" --workflow "$WORKFLOW" --limit 10 \
  --json databaseId,headSha,conclusion,createdAt
```

一過性と判断でき（対象runと同じ `headSha` を持つ成功runが存在する）、かつ対象runがまだ再実行されていない（`gh run view "$RUN_ID" --repo "$REPO" --json attempt -q .attempt` が `1`）場合に限り、**1回だけ**再実行して終了する。

```bash
gh run rerun "$RUN_ID" --repo "$REPO" --failed
```

再実行済み（`attempt` が2以上）で同じ失敗が続いている場合は、一過性ではないものとして A または B で扱う。

### B（直せない）の場合

修正・PR作成は行わない。原因と、人が対応すべき内容（どのシークレットが足りないか等）を報告して終了する。

## ステップ3: 修正とPR作成（Aの場合のみ）

### 3-1. 作業ブランチの作成

デフォルトブランチ上で作業しないこと。

```bash
DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)
git fetch origin "$DEFAULT_BRANCH"
git switch -c "fix-workflow-$(date +%Y%m%d%H%M%S)" "origin/$DEFAULT_BRANCH"
```

失敗が特定のブランチ（`headBranch`）でのみ発生しており、そのブランチの修正が必要な場合は、デフォルトブランチではなく `headBranch` を分岐元にする。

### 3-2. 修正の実施

特定した一次原因を修正する。

- **スコープは失敗原因の解消だけ**に限定する。調査中に気づいた別の問題・リファクタは行わず、最終報告に1行で挙げるだけにする
- 可能な範囲でローカルで検証する（失敗したテストの再実行、型チェック、Lint、ビルド）。ワークフロー定義の修正は `gh workflow view` や YAML の構文確認で妥当性を確かめる
- 症状ではなく原因を直す。テストが落ちているからテストを削る・スキップする、といった対処はしない（テスト自体が誤っていると特定できた場合を除く）

### 3-3. コミットとPR作成

1. `commit-push` skill でコミットと push を行う
2. `create-pr` skill で PR を作成する（引数は渡さない）

`create-pr` は PR 本文のテンプレート適用・ベースブランチの決定・`gh api user --jq '.login'` で取得したユーザーの Assignee 追加・`cc-triage-scope` ラベルの付与を行う。

PR 作成後、Assignee とラベルが実際に付いていることを確認する。付いていなければ補う。

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
gh pr view "$PR_NUMBER" --json assignees,labels
gh pr edit "$PR_NUMBER" --add-assignee "@me" --add-label cc-triage-scope
```

PR 本文には、対象ワークフロー・失敗した run の URL・特定した原因・修正内容を記載する。

## 注意事項

- 作業ディレクトリを確認してから編集を行うこと（作業ディレクトリ: !`pwd`）
- デフォルトブランチに直接コミットしないこと
- 失敗の原因が特定できない場合、推測で修正を入れない。調査した内容と分からなかった点を報告して終了する

## 出力

- **対象ワークフロー**: 名前と URL
- **最新実行**: run URL / ブランチ / status / conclusion
- **判定**: 成功（対応不要） / 実行中（対応不要） / 修正あり / 再実行 / 対応不可（人手）
- **原因**: 特定した一次原因（該当時）
- **修正内容**: 変更したファイルと修正の要点（該当時）
- **PR**: 作成した PR の URL（該当時）
