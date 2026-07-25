---
name: resolve-pr-comments
description: GitHub PRの未解決Review threadsを一括Resolveします。
model: sonnet
effort: low
context: fork
---

# Resolve PR Comments

GitHubのプルリクエスト（PR）における未解決のレビューコメントを一括でResolveします。

# Instructions

## ステップ1: 未解決Review threadsを一括Resolve

以下のコマンドを実行する。カレントブランチに紐づくOpen PRの未解決Review threadsをすべて取得し、`resolveReviewThread` mutation でResolveする。

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/resolve-pr-comments.sh
```

前提: カレントディレクトリが対象リポジトリで、カレントブランチにOpen PRが存在すること。PRを特定できない場合、スクリプトは `Error: Could not determine PR number.` を出力して終了する。

## ステップ2: 実行結果の確認と報告

スクリプトの標準出力を確認し、次を報告する。

- Resolveしたthread数（`✓ Resolved thread:` の行数）
- 失敗したthreadがあればその内容（`✗ Failed to resolve thread:` の行）
- 未解決threadが元から無かった場合はその旨

失敗したthreadがある場合は、握り潰さず件数とthread IDを明示して報告する。スクリプトはthread単位で失敗を許容して処理を継続するため、最後の `All unresolved threads have been processed.` が出ていても全件成功とは限らない。
