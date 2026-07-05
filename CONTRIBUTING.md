# Contributing to claude-task-worker

`claude-task-worker` へのコントリビューションに興味を持っていただきありがとうございます。このドキュメントでは、開発環境のセットアップ方法と、Issue・Pull Requestの出し方について説明します。

## 開発環境のセットアップ

```bash
git clone https://github.com/getty104/claude-task-worker.git
cd claude-task-worker
npm install
npm run build
```

主なコマンド:

| コマンド | 説明 |
|---|---|
| `npm run build` | TypeScript の型チェックと `dist/` へのビルド |
| `npm run dev` | Watch モード（型チェックの自動再実行） |
| `npm run lint` | ESLint によるチェック |
| `npm run lint:fix` | ESLint による自動修正 |
| `npm run format` | Prettier によるフォーマット |
| `npm run format:check` | Prettier のフォーマットチェック（CIで実行） |

ローカルでCLIを試す場合は `npm link` でグローバルに `claude-task-worker` コマンドを有効化できる。

```bash
npm link
claude-task-worker init
```

## コーディング規約

このリポジトリのアーキテクチャや規約は [CLAUDE.md](./CLAUDE.md) にまとまっている。変更を加える前に一読することを推奨する。

- ESM (`NodeNext` module) — importは `.js` 拡張子付き
- ログは `[worker-name]` / `[command-name]` プレフィックス付き
- エラーはtry-catchでログ出力し、ワーカーはクラッシュせず継続させる
- 新しいワーカー・コマンドを追加する場合は既存の実装パターン（`src/workers/`, `src/commands/`）に倣う

## Issue の立て方

バグ報告・機能要望は [Issue テンプレート](https://github.com/getty104/claude-task-worker/issues/new/choose) から作成してください。再現手順・期待する挙動・実際の挙動をできるだけ具体的に記載してもらえると助かります。

セキュリティに関する脆弱性は公開Issueではなく [SECURITY.md](./SECURITY.md) の手順に従って報告してください。

## Pull Request の出し方

1. リポジトリを Fork するか、ブランチを作成する。
2. 変更を実装し、以下を確認する。
   ```bash
   npm run build
   npm run lint
   npm run format:check
   ```
3. コミットメッセージは変更内容が分かるように簡潔に記述する（日本語・英語どちらでも可）。
4. Pull Request を作成し、[PRテンプレート](./.github/PULL_REQUEST_TEMPLATE.md) に沿って変更概要とテスト内容を記載する。
5. レビューでの指摘には可能な範囲で対応する。

## 開発フローの自動化について

このリポジトリ自身の開発フロー（Issueの実装・レビュー指摘対応・PR作成など）は、本リポジトリが提供する `claude-task-worker` CLI と同梱の Claude Code プラグイン（`plugin/`）を使って自動化されている（[README.md](./README.md) 参照）。コントリビューションにあたって必須ではないが、興味があれば試してみてほしい。

## ライセンス

コントリビューションした内容は、本リポジトリの [LICENSE](./LICENSE)（MIT License）の下でライセンスされることに同意したものとみなします。
