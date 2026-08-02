# Check Library - Examples

check-libraryスキルの具体的な使用例。

## 例1: Next.js関連（App Router / Server Actionsなど）

```bash
# 1. Next.js DevTools MCPの初期化
mcp__plugin_getty104_next-devtools__init

# 2. キーワードで検索
mcp__plugin_getty104_next-devtools__nextjs_docs
  action: "search"
  query: "nested layouts app router"

# 3. 詳細なドキュメントを取得（検索結果からパスを特定）
mcp__plugin_getty104_next-devtools__nextjs_docs
  action: "get"
  path: "app/building-your-application/routing/layouts-and-templates"
```

他のNext.jsトピックも同様に `action: "search"` の `query` を変えて検索する（例: `"server actions forms"`）。

## 例2: shadcn/uiのコンポーネントを追加

```bash
# shadcn MCPのツールを確認
ListMcpResourcesTool
  server: "shadcn"

# 利用可能なツールに応じて適切なツールでコンポーネント情報を取得
```

インストール方法・バリエーション・カスタマイズオプションを取得できる。

## 例3: 一般ライブラリ（context7）

React Query (TanStack Query) の例。Zod / Tailwind CSS / Prisma など他の一般ライブラリも同じ流れ（`resolve-library-id` → `get-library-docs`）で調べる。

```bash
# 1. ライブラリIDを解決
mcp__plugin_getty104_context7__resolve-library-id
  libraryName: "tanstack query"

# 2. トピックを指定してドキュメントを取得
mcp__plugin_getty104_context7__get-library-docs
  context7CompatibleLibraryID: "/tanstack/query"
  topic: "useQuery"
  page: 1

# 3. 追加で調べたい場合はtopicを変えて再取得
```

複数ライブラリを組み合わせた実装（例: Next.js App Router + React Hook Form + Zod、shadcnのForm + React Hook Form）は、各ライブラリを担当するMCPを順に使い、統合パターン（`topic: "server actions"` / `topic: "integration react-hook-form"` 等）を調べる。

## ライブラリ選択のポイント

### 1. Next.js関連の判定基準（Next.js DevTools MCPを使用）

以下のキーワードが含まれる場合:
- Next.js、App Router、Pages Router
- Server Components、Server Actions
- Route Handlers、Middleware
- next/image、next/link、next/font
- generateStaticParams、generateMetadata

### 2. shadcn/ui関連の判定基準（shadcn MCPを使用）

以下のキーワードが含まれる場合:
- shadcn/ui、shadcn
- Radix UI（shadcnのベース）
- Button、Card、Dialog、Form などのshadcnコンポーネント名

### 3. Context7使用の判定基準（上記以外の一般的なライブラリ）

- React Query (TanStack Query)
- Zod、Yup などのバリデーションライブラリ
- Tailwind CSS
- Prisma、Drizzle などのORM
- Axios、SWR などのデータフェッチングライブラリ
- その他のnpmパッケージ

## 効果的な使用方法

- **トピック指定**: Context7では `topic` を指定せず取得するのではなく、具体的なトピック（例: `"useQuery mutations error handling"`）を指定する
- **ページネーション**: 情報が不足する場合は `page` を増やして追加取得する（`page: 1`で基本情報 → `page: 2`で詳細情報）
- **ライブラリ名解決**: `resolve-library-id` は一般的な呼び方でも検索可能（例: `"react-hook-form"` / `"react hook form"` / `"rhf"` のいずれでも動作）
