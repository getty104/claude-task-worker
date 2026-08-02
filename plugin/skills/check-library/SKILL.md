---
name: check-library
description: ライブラリの情報を確認するためのスキル。Next.js、shadcn、その他のライブラリについて、適切なMCPサーバーを使用して最新のドキュメントと使用方法を取得します。
model: sonnet
effort: low
context: fork
---

# Check Library

適切なMCPサーバーを選択してライブラリの最新ドキュメントと使用方法を取得するスキル。

# Instructions

ライブラリ名に応じて、以下の優先順位でMCPサーバーを使用する。

## 実行ルール

### 1. Next.js関連の場合 → next-devtools MCP

```bash
# 最初に初期化（セッション開始時に1回のみ）
mcp__plugin_getty104_next-devtools__init

# ドキュメント検索
mcp__plugin_getty104_next-devtools__nextjs_docs
  action: "search"
  query: "<検索キーワード>"

# ドキュメント取得（パスが分かっている場合）
mcp__plugin_getty104_next-devtools__nextjs_docs
  action: "get"
  path: "<ドキュメントパス>"
```

### 2. shadcn関連の場合 → shadcn MCP

```bash
# shadcn MCPツールを使用
# 利用可能なツールはListMcpResourcesToolで確認可能
```

### 3. その他のライブラリの場合 → context7 MCP

```bash
# ライブラリIDの解決
mcp__plugin_getty104_context7__resolve-library-id
  libraryName: "<ライブラリ名>"

# ドキュメント取得
mcp__plugin_getty104_context7__get-library-docs
  context7CompatibleLibraryID: "<resolve-library-idで取得したID>"
  topic: "<オプション: 特定のトピック>"
  page: 1
```

## 使用例

examples.mdを参照してください。

## 注意事項

- ライブラリ名が曖昧な場合は問い返さず、`package.json` の依存関係に一致するライブラリを優先して選ぶ。それでも複数候補が残る場合は、`resolve-library-id` の検索結果上位の候補で調べたうえで「どのライブラリとして解釈したか」を結果に明記する
- context7では必ず `resolve-library-id` でライブラリIDを解決してから `get-library-docs` を使用する
