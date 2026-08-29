---
name: solve-github-workflow-problem
description: GitHub Actions ワークフロー実行（run）のIDまたはURLを受け取り、その実行が失敗している場合に原因を調査・特定して修正し、PRを作成します。成功している場合は何もしません。
argument-hint: "[run-id | run-url]"
---

# Solve GitHub Workflow Problem

指定された GitHub Actions の**ワークフロー実行（run）**の結果を確認し、失敗していれば原因を特定して修正PRを作成するスキルです。

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **GitHub MCP を優先し、利用不可なら `gh` コマンドへフォールバックする**。判定手順・`gh` → MCP の対応表・`gh` のまま残す操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する（本文中の `gh` コマンド例は、対応表に該当するものについてはフォールバック手段として読むこと）。

## ステップ0: 引数のパース

`$ARGUMENTS` から run ID（と、URL 形式なら `owner/repo`）を取り出す。受け付ける形式:

| 形式 | 例 |
|---------|------------|
| run ID（数値のみ） | `1234567890` |
| run URL | `https://github.com/<owner>/<repo>/actions/runs/<run-id>` |
| run URL（ジョブ・クエリ付き） | `https://github.com/<owner>/<repo>/actions/runs/<run-id>/job/<job-id>` |

```bash
ARG=$(printf '%s' "$ARGUMENTS" | tr -d '[:space:]')
RUN_ID=$(printf '%s' "$ARG" | grep -oE '^[0-9]+$|/actions/runs/[0-9]+' | grep -oE '[0-9]+$')
REPO=$(printf '%s' "$ARG" | grep -oE '^https?://github\.com/[^/]+/[^/]+' | sed -E 's#^https?://github\.com/##')
CURRENT_REPO=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh owner-repo)
REPO="${REPO:-$CURRENT_REPO}"
```

`RUN_ID` が取れない（run ID でも run URL でもない）場合は、その旨を報告して終了する。

```bash
if [ -z "$RUN_ID" ]; then
  echo "対象として不正です（run ID / run URL のいずれの形式にも一致しません）"
  exit 1
fi
```

### 対象リポジトリの確認

`REPO` が `CURRENT_REPO` と一致しない場合、**修正は行わない**。原因の調査結果だけを報告して終了する（作業ディレクトリのリポジトリと別リポジトリのコードは修正できないため）。

## ステップ1: 実行結果の取得

> GitHub MCP が使える場合は `actions_get` を使う。以下は MCP 利用不可時のフォールバック。

```bash
gh run view "$RUN_ID" --repo "$REPO" \
  --json databaseId,displayTitle,workflowName,workflowDatabaseId,headBranch,headSha,status,conclusion,createdAt,url,attempt
```

- `status` が `completed` でない（実行中・キュー待ち）: **何もしない**。実行中である旨を報告して終了する
- `conclusion` が `success` / `skipped` / `cancelled`: **何もしない**。その旨を報告して終了する
- `conclusion` が `action_required` / `neutral` / `stale`: 人手対応が必要である旨を報告して終了する
- `conclusion` が `failure` / `timed_out` / `startup_failure`: ステップ2へ進む

run が存在しない（コマンドが失敗する）場合も何もせず報告して終了する。

## ステップ2: 失敗原因の調査と特定

> GitHub MCP が使える場合は `actions_get`（ジョブ・ステップ一覧）/ `get_job_logs`（`failed_only: true`、失敗ステップのログ）を使う。以下は MCP 利用不可時のフォールバック。

```bash
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

同一ワークフローの直近の実行を確認し、**対象runと同じ `headSha`（同じコード）**で成功しているrunがあるかを見る。別コミットの成功runを「同じコード」と誤認しないよう、`headSha` の一致を必ず確認すること。ワークフローの指定にはステップ1で取得した `workflowDatabaseId`（数値ID）を使う（同名ワークフローが複数存在すると名前では一意に解決できないため）。

> GitHub MCP が使える場合は `actions_list` を使う。以下は MCP 利用不可時のフォールバック。

```bash
gh run list --repo "$REPO" --workflow "$WORKFLOW_DATABASE_ID" --all --limit 10 \
  --json databaseId,headSha,conclusion,createdAt
```

一過性と判断でき（対象runと同じ `headSha` を持つ成功runが存在する）、かつ対象runがまだ再実行されていない（ステップ1の `attempt` が `1`）場合に限り、**1回だけ**再実行して終了する。

> GitHub MCP が使える場合は `actions_run_trigger` を使う。以下は MCP 利用不可時のフォールバック。

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
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
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

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。

```bash
PR_NUMBER=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh pr-for-branch)
gh pr view "$PR_NUMBER" --json assignees,labels
gh pr edit "$PR_NUMBER" --add-assignee "@me" --add-label cc-triage-scope
```

PR 本文には、対象ワークフロー・失敗した run の URL・特定した原因・修正内容を記載する。

## 注意事項

- 作業ディレクトリを確認してから編集を行うこと（作業ディレクトリ: !`pwd`）
- デフォルトブランチに直接コミットしないこと
- 失敗の原因が特定できない場合、推測で修正を入れない。調査した内容と分からなかった点を報告して終了する

## 出力

- **対象run**: run URL / ワークフロー名 / ブランチ / status / conclusion
- **判定**: 成功（対応不要） / 実行中（対応不要） / 修正あり / 再実行 / 対応不可（人手）
- **原因**: 特定した一次原因（該当時）
- **修正内容**: 変更したファイルと修正の要点（該当時）
- **PR**: 作成した PR の URL（該当時）
