# 汎用サブエージェントの effort 指定

`explore-agent`（haiku）/ `general-purpose-assistant`（sonnet）/ `lightweight-assistant`（haiku）は**定義に `effort` を持たない**。思考量は呼び出し元が Agent ツールの `effort` パラメータでタスクごとに決める。

- **`effort` は毎回必ず指定する**。省略するとタスクの重さと無関係な値で走る
- 選べるのは `low` / `medium` / `high` の3つ。`xhigh` / `max` は使わない（Haiku 5.5 / Sonnet 5.5 ガイド: 思考と応答が大幅に長くなる。その品質が要る作業は呼び出し元が自分で行うか、opus のエージェントへ回す）
- 迷ったら1段上を選ぶ。`low` は長いエージェントプロンプトで検索の省略・早期停止・チェックの省略が起きやすく、`medium` へ上げると早期停止がおよそ半減する（Haiku 5.5 ガイド）
- 「よく考えて」のような文言をプロンプトに足して思考量を上げようとしない。効かない（思考量は effort が決める）

## 選び方

| エージェント | `low` | `medium`（既定） | `high` |
|---|---|---|---|
| `explore-agent` | 対象のファイル名・シンボル名が分かっていて、その所在を1か所確かめるだけ | 徹底度 `quick` / `medium` の調査（実装箇所・呼び出し元・テストの特定） | 徹底度 `very thorough`、または影響範囲・呼び出し関係を複数段たどる調査 |
| `general-purpose-assistant` | 使わない | 対象と完了条件が具体的に決まっている単一の関心事（失敗ログ付きのテスト/Lint修正、指示が一意な修正、逐語引用を返すだけの読み取り分担） | 複数ファイルにまたがる実装、原因調査を伴う作業、設計・責務分割・安全性の再考を求めるレビュー指摘への対応 |
| `lightweight-assistant` | コード変更を伴わない参照だけ（値・所在の確認） | コード・設定の変更を伴う軽量タスク | 使わない（そこまで要るなら `general-purpose-assistant` へ） |

参照: [Haiku 5.5 のプロンプティング](https://platform.claude.com/docs/ja/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5) / [Sonnet 5.5 のプロンプティング](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5)
