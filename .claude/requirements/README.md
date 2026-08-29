# Requirements

過去のIssueで確定した仕様・要件レベルの判断ロジックをタイプ別に集約したものです。
`create-issue` / `create-issue-from-issue-number` / `answer-issue-questions` が仕様作成・回答の前提として読み込みます。

## カテゴリ

| ファイル | 扱う範囲 | ルール数 |
|---|---|---|
| [configuration.md](configuration.md) | 配布・共有される設定ファイルの判断 | 4 |
| [label-vocabulary.md](label-vocabulary.md) | ラベル語彙の追加とラベル遷移の扱い | 3 |
| [worker-skill-contract.md](worker-skill-contract.md) | ワーカープロセスとタスクセッションの契約 | 3 |
| [investigation-records.md](investigation-records.md) | 調査タスクの成果物の扱い | 1 |

## メンテナンス

- 更新は `/update-requirement-rules [日数]` で行う（手動編集も可）
- 採用基準: 独立した2件以上のIssueで同じ判断が反復している（同一Epic配下は1件と数える）／一般方針として明示されている／ラベル語彙・契約などリポジトリ全体の共有語彙を確定させている
- 扱うのは「descriptionの書き分けが変わる判断」。コードを書く段階でしか効かない作法は `CODING_GUIDELINES.md` の担当
- 現実と食い違うルールは削除・上書きする。増やすことより一貫していることを優先する
