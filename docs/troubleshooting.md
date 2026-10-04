# 6. トラブルシューティング

## Issue/PR が拾われない

上から順に確認する。

1. **Assignee が自分か**。ワーカーは `gh` でログインしているユーザーが Assignee のものだけを拾う（`gh api user --jq .login` で確認）
2. **トリガーラベルが付いているか**。Issue 系で複数ある場合はすべて必要
3. **除外ラベルが付いていないか**。`cc-in-progress` / `cc-need-human-check` は全ワーカー共通の除外
4. **Open な blockedBy が無いか**。依存先の Issue がクローズされるまで拾わない
5. **そのワーカーが起動しているか**。`all` には `triage-created-issue` / `triage-pr` / `check-dependabot` が含まれない（`yolo` には含まれる）。`workers.<name>.enabled: false` のワーカーも起動しない。`claude-task-worker list-workers` で有効/無効を確認する
6. **`--epic` / `--label` で絞っていないか**

## `cc-in-progress` が付いたまま残っている

ワーカーが異常終了するとラベルが残る。ワーカーが動いていないことを確認してから `cc-in-progress` を外す。worktree の残骸は次回起動時に自動で回収される。

## `cc-need-human-check` が付いた

Issue/PR に理由のコメントが残っている。よくある原因:

| 原因 | 対処 |
|---|---|
| 確認事項のうち人が決める必要があるものが残った | 回答をコメントし、ラベルを外して `cc-update-issue` を付ける |
| `exec-issue` が終わったのに PR を確認できなかった | PR が作られていればラベルを外して `cc-pr-created` を付ける。無ければラベルを外して `cc-exec-issue` を付け直す |
| PR の CI がコードでは直せない理由で失敗した（API 上限・シークレット不足など） | 原因を解消してラベルを外す |
| コンフリクトが自動解消できなかった | 手で解消して push し、ラベルを外す |
| クラウド実行がタイムアウトした | [5章](./cloud.md#失敗したとき) |

ラベルを外せばワーカーが再び拾う。

## 同じ Issue/PR を何度も処理している

- **カスタムワーカー**: 完了後にトリガーラベルが外れても、ほかの経路で付け直されていないか確認する。`onCompleted` で付けるラベルを `excludeLabels` に入れておくと止まる（[3章](./custom-worker.md#step-2-ワーカーを定義する)）
- **スキルが何も出力せずに終わる**: スキル冒頭の `!` コマンドが失敗している可能性がある。ワーカーは空出力を失敗として通知するので、失敗通知の stderr を確認する

## カスタムワーカーが読み込まれない

`claude-task-worker list-workers` を実行し、エラーメッセージに従う（[3章 Step 3](./custom-worker.md#step-3-設定ファイルに登録する)）。

`--inherit-config` を使っているのにパックのワーカーが出ない場合は、起動コマンドに `--inherit-config` を付け忘れていないか確認する。`already defined in` のエラーが出る場合は、パックのワーカーファイルをリポジトリ側の `workerFiles` にも書いていないか確認する（配列はパックの値に追記されるため、同じファイルを2回読み込む。[4章 Step 8](./config-package.md#step-8-リポジトリごとの差分を書く)）。

## スキルが見つからない（`Unknown slash command` など）

- リポジトリのスキル（`.claude/skills/`）: デフォルトブランチへ push されているか。ワーカーは worktree をリモートのデフォルトブランチから作る
- プラグインのスキル: `claude plugin list` でインストール済みか。`command` は `/<プラグイン名>:<スキル名>`
- クラウド実行: VM のセットアップスクリプトでプラグインを入れているか

## herdr モードで `running:blocked` のまま

claude が権限確認などで入力を待っている。herdr でそのタスクのタブ（`ctw:<project>:#<番号>`）を開いて応答する。`config.json` の `permission` が `bypassPermissions` / `dontAsk` 以外だと起きやすい。

## ログの見方

- ステータステーブルの下の Logs に、`[ワーカー名]` 付きでポーリング・スキップ理由・エラーが出る
- `--debug` を付けると各タスクの最終報告が Issue/PR にコメントされる
- Slack 通知を設定していれば、失敗通知に stderr の末尾が載る
