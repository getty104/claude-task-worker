# High Quality Commit - Reference Guide

高品質なgitコミットを作成するための詳細ガイダンス。

## gitコミット戦略の詳細

### Squash戦略（デフォルト）

- **使用タイミング**: 継続的な開発中の機能追加・バグ修正の繰り返し／レビュー指摘対応や微調整／同じ機能に関連する複数の変更を一つにまとめたい場合
- **メリット**: 履歴がクリーンになり、レビュー時に一つの論理的な変更として見やすい

```bash
git add -A
git commit --amend          # メッセージを編集して統合
git commit --amend --no-edit # メッセージを変えずに統合
```

- **注意点**: push済みコミットのamendはforce pushが必要。チーム開発では他の人がそのコミットをベースにしていないか確認する

### 新規gitコミット戦略

- **使用タイミング**: 明確に異なる機能や修正／分けることで履歴の理解が容易になる／各コミットが独立してビルド・テスト可能な場合
- **メリット**: 履歴が詳細に残り、git bisectでの問題追跡や特定変更のみのrevertが容易

### Interactive Rebase戦略

- **使用タイミング**: PR作成前の履歴整理／小さなコミットの論理的な統合／順序変更／不要なコミット（WIP、fixupなど）の削除

```bash
# デフォルトブランチとの差分で対話的にrebase（gh repo view --json defaultBranchRef は単独取得ツールがMCPに無いため gh のまま残す）
git rebase -i "origin/$(gh repo view --json defaultBranchRef -q .defaultBranchRef.name)"

# または、最新のN個のコミットをrebase
git rebase -i HEAD~3
```

エディタでの操作例（4コミットを2つの論理的なコミットに統合）:

```
pick abc1234 feat: add user model
squash def5678 fix: typo in user model
pick ghi9012 feat: add user controller
squash jkl3456 fix: validation logic
```

## gitコミットメッセージのベストプラクティス

### 良い例

```
feat: add user profile editing feature

Allow users to update their profile information including:
- Display name
- Email address
- Profile picture
- Bio

Implemented with form validation and real-time preview.

Closes #456
```

### 避けるべき例

```
# 悪い例1: 不明確
update files

# 悪い例2: 詳細すぎる実装の説明
Changed UserController.ts line 45 to use async/await instead of promises

# 悪い例3: 複数の無関係な変更
Fix bug and add feature and update docs
```

### Type選択のガイド

- **feat**: ユーザーに見える新機能
- **fix**: ユーザーに影響するバグ修正
- **refactor**: 動作を変えないコードの改善
- **perf**: パフォーマンス改善
- **test**: テストの追加・修正
- **docs**: ドキュメントのみの変更
- **style**: コードフォーマット、セミコロンなど
- **chore**: ビルド、依存関係の更新など

## トラブルシューティング

- **amendしたコミットがpushできない**（リモート履歴と相違）: `git push --force-with-lease` で安全に強制push
- **rebase中にコンフリクト**: ファイルを編集して解決後、`git add .` → `git rebase --continue`。中止する場合は `git rebase --abort`
- **誤ってamendしてしまった**: `git reflog` で以前の状態を確認し、`git reset --hard HEAD@{1}` で戻る
