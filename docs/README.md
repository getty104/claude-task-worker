# claude-task-worker マニュアル

claude-task-worker の使い方をまとめたマニュアル。コマンド・設定キーの一覧はリポジトリ直下の [README](../README.md) を、内部設計は [CLAUDE.md](../CLAUDE.md) を参照。

## 目次

| ドキュメント | 内容 |
|---|---|
| [1. はじめに（ハンズオン）](./getting-started.md) | インストールから最初の Issue を PR にするまで |
| [2. 日常の使い方](./workflows.md) | ラベルの流れ・Epic・人間確認・ワーカーの選び方 |
| [3. カスタムワーカーを作る（ハンズオン）](./custom-worker.md) | 独自ラベルで動くワーカーとスキルを作って動かす |
| [4. 設定とカスタムワーカーのパッケージ化（ハンズオン）](./config-package.md) | `--inherit-config` で複数リポジトリへ同じ設定・ワーカー・スキル・ラベルを配る |
| [5. クラウド実行](./cloud.md) | `--cloud` の前提条件・セットアップ・制約 |
| [6. トラブルシューティング](./troubleshooting.md) | 止まった・動かない・ループするときの確認手順 |

## 全体像

```
   GitHub (Issue / PR + ラベル)
              │ poll（ラベル + 自分が Assignee）
              ▼
     claude-task-worker（ワーカー）
              │ worktree を作り、スキルを起動
              ▼
       Claude Code CLI
   + claude-task-worker plugin（スキル）
```

- **ワーカー**: GitHub をポーリングし、トリガーラベルが付いた「自分が Assignee の」Issue/PR を見つけるとスキルを起動するプロセス
- **スキル**: Claude Code のスラッシュコマンド。実際の作業（実装・レビュー対応・トリアージ）をする
- **ラベル**: ワーカー間のバトン。ワーカーはラベルを付け替えて次のワーカーへ仕事を渡す

ワーカーは「ラベルを見てスキルを呼ぶ」だけなので、ラベルとスキルを用意すれば自分のワーカーを足せる（[3章](./custom-worker.md)）。
