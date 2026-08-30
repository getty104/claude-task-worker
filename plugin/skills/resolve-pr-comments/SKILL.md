---
name: resolve-pr-comments
description: GitHub PRの未解決Review threadsを一括Resolveします。
argument-hint: "[pr-number]"
model: sonnet
effort: low
context: fork
---

# Resolve PR Comments

GitHub PR `$0` の未解決 Review thread を一括で Resolve するスキル。

**呼び出し側の前提**: 本スキルは「対象 PR の指摘に対する修正が既にコミット・push 済み」であることを前提に、未解決スレッドを**内容を問わず全件** Resolve する。修正していない指摘まで Resolve されると、レビュー未対応のまま PR がマージされうる。**修正の push が完了していない段階では呼び出さないこと。**

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **`gh` コマンドを優先し、`gh` が使えない場合に GitHub MCP へフォールバックする**（クラウド実行時のみ優先順位が逆転し、その指示は起動プロンプトで渡される）。判定手順は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する。

Resolve（`resolveReviewThread`）は REST に該当エンドポイントが無いため、`gh` 経路では GraphQL 直叩きになる。クラウドセッション（`claude --cloud`）では GitHub プロキシが GraphQL を 403 で拒否するため、**`gh` フォールバックはクラウド実行では成立しない**。MCP 経路がクラウドで Resolve できる唯一の手段である。

## ステップ0: 対象 PR 番号の確定

`$0` が渡されていればそれを使う。渡されていない場合のみ `bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh pr-for-branch` でカレントブランチの Open PR から導出する。どちらでも番号を確定できない場合は、Resolve を1件も実行せずその旨を報告して終了する（誤った PR のスレッドを Resolve しないため）。

## ステップ1: 未解決 Review thread の取得

GitHub MCP の `pull_request_read`（method: `get_review_comments`）で対象 PR のレビュースレッドを取得する。各スレッドは `isResolved` と node ID（`PRRT_...` 形式）を持つ。

**ページングは取得しきる。** カーソル方式（`perPage` は最大 100、`after` に前ページの `endCursor` を渡す）で、`pageInfo.hasNextPage` が `true` の間は呼び直す。1ページ目で打ち切ると、指摘の多い PR で後続ページのスレッドが未解決のまま残る。

`isResolved: false` のスレッドの node ID を集める。0件なら Resolve は実行せず、ステップ3でその旨を報告して終了する。

MCP が利用不可（ツール未検出・認証エラー・呼び出し失敗）の場合はステップ2-Bのフォールバックへ進む。

## ステップ2-A: Resolve（MCP 経路）

集めた node ID ごとに GitHub MCP の `pull_request_review_write`（method: `resolve_thread`、`threadId: <node ID>`）を呼ぶ。

- 既に Resolve 済みのスレッドへの `resolve_thread` は **no-op** なので、取得と Resolve の間に他者が Resolve しても壊れない
- **1スレッドの失敗で全体を止めない**。失敗した thread ID を記録して次のスレッドへ進む
- 同じスレッドの `resolve_thread` を MCP で再試行しない（`github-access.md` の判定手順3）

MCP の書き込みが失敗した場合、`github-access.md` の「書き込み系操作のフォールバック方針」に従うが、**`resolve_thread` は冪等な no-op なので二重実行の害が無く、失敗の種類を問わずステップ2-Bのフォールバックへ進んでよい**（この点だけが同方針の例外）。

## ステップ2-B: Resolve（`gh` フォールバック）

MCP が使えない場合のみ、共有スクリプトを使う。

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/resolve-pr-comments.sh" <PR番号>
```

スクリプトは `gh api graphql` に依存するため、クラウドセッションでは 403 で失敗する。その場合はスクリプトが非0で終了するので、**成功したことにせず**ステップ3で「Resolve できなかった」と明示して報告する。

## ステップ3: 実行結果の確認と報告

次を報告する。

- 使った経路（GitHub MCP / `gh` フォールバック）。フォールバックした場合はその理由を1行添える
- 対象 PR 番号と、取得した未解決スレッド数（ページング完遂の可否を含む）
- Resolve に成功したスレッド数
- 失敗したスレッドがあれば**件数と thread ID を明示する**。握り潰さない
- 未解決スレッドが元から無かった場合はその旨

「未解決スレッドが0件だった」と「取得そのものに失敗した」は必ず区別して報告する。取得に失敗した場合は Resolve 件数を0と報告するのではなく、失敗として報告すること。
