# 定期ワーカー: 更新したドキュメントのPRを作る

`update-coding-guidelines` / `update-requirement-rules` / `update-design-md` が、更新したドキュメントをPRにするときの手順。各スキルは「ブランチ名に入れるスキル名」と「差分を確認する対象ファイル」を指定してここを読む。

## 1. feature branch への切替

`commit-push` はカレントブランチにコミット・pushするため、デフォルトブランチ上で呼ぶと本番ブランチへ直コミットが入る。

```bash
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

- `CURRENT_BRANCH = DEFAULT_BRANCH` なら `chore/<スキル名>-$(date +%Y%m%d-%H%M%S)` を `git checkout -b` で作って切り替える（同名があればサフィックスで一意にする）
- 違うならそのまま使う（既に作業ブランチ上にいる）

切替後に `git status` で対象ファイルの差分が残っていることを確認する。

## 2. commit-push

`Skill` ツールで `commit-push` を引数なしで呼ぶ（差分と履歴を見て戦略を選ぶのは commit-push 側）。

## 3. create-pr

`Skill` ツールで `create-pr` を呼ぶ。`create-pr` は `context: fork` で本スキルの文脈を引き継がないため、渡せるのは Issue 番号の文字列だけ。

- Issue 番号が指定されていれば渡す（PR本文に `Closes #<番号>` が入る）
- 指定されていなければ引数なしで呼ぶ（空展開の `Closes #` 行が残るので 5 で消す）

返却された PR URL を記録し、PR 番号はその末尾から取る（`PR_NUMBER="${PR_URL##*/}"`）。URL を取得できなかった場合は 4・5 を実行せず、出力に「PR URL未取得」と書いて終える。

## 4. Assignee・ラベルの付与確認（毎回行う）

`triage-pr` はラベル（`cc-triage-scope`）と Assignee（自分自身）の両方でPRを拾うため、どちらかが欠けるとPRは誰にもマージされずに残る。`create-pr` 側にも付与手順はあるが、fork のため結果を検証できないので、ここで冪等に付け直す。

```bash
PR_NUMBER="${PR_URL##*/}"
[ -n "$PR_NUMBER" ] || exit 1
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-label "$PR_NUMBER" cc-triage-scope
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-assignee "$PR_NUMBER" @me
```

- どちらも付与済みでもエラーにならない（REST の追加専用API。既存のラベル・Assignee は消えない）
- `cc-triage-scope` ラベルがリポジトリに無くて失敗した場合は `gh label create cc-triage-scope` で作ってから再実行する
- Assignee の付与が権限等で失敗してもPR自体はできているので、出力に「Assignee付与失敗」と理由を書いて続行する

## 5. Issue 番号なしの場合の後処理

`create-pr` が残した `Closes #`（数字なし）の行を消す。GitHub MCP が使える場合は `pull_request_read`（method: `get`）で本文を取り、`update_pull_request` で `body` だけを更新する。以下は MCP 利用不可時のフォールバック。

```bash
gh pr view "$PR_NUMBER" --json body --jq '.body' \
  | sed -E '/^Closes #[[:space:]]*$/d' \
  | gh pr edit "$PR_NUMBER" --body-file -
```

正規表現は `#` の後ろに数字が無い行だけに一致するので、`Closes #123` は消えない。

**完了条件**: デフォルトブランチ以外でPRが作成され、PR URL が手元にあり、Assignee（自分自身）と `cc-triage-scope` が付いていて、Issue 番号なしの場合は `Closes #` の空行が消えていること。
