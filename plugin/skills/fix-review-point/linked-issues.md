# fix-review-point: 関連Issueの連動クローズ

PRをマージした、またはクローズする判断に至ったときに読む。

## マージ後（ベースブランチがデフォルトブランチでない場合）

GitHubの `Closes #<issue番号>` 記法による自動クローズは**デフォルトブランチへのマージ時にのみ**発動する。`cc-epic-<N>` のような非デフォルトブランチへ向いたPRをマージしてもIssueは閉じず、Epic のサブIssueが未完のまま残って `create-epic-pr` の起動条件（全サブIssueのクローズ）が満たされなくなる。そのため、マージ前にベースブランチを控えておき、デフォルトブランチと**一致しない**場合のみ明示的にクローズする。

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。

```bash
BASE_BRANCH=$(gh pr view $0 --json baseRefName -q .baseRefName)
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
```

マージ成功後、`BASE_BRANCH` が `DEFAULT_BRANCH` と一致する場合はGitHubが自動でクローズするためスキップする。一致しない場合はPR本文から関連Issue番号を抽出し、抽出できたすべての番号を `completed`（実装がEpicブランチへ取り込まれた完了クローズ。マージせずクローズする場合の `not_planned` とは異なる）でクローズする。クローズは `gh issue close`（GraphQL 経由でクラウドセッションのゲートに掛かる）ではなく `gh-compat.sh close-issue` を使う。

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。

```bash
gh pr view $0 --json body --jq '.body' | grep -ioE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+'
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh close-issue <issue番号> completed
```

関連Issueが抽出できない場合は、その旨を最終報告に含めること。

## PRクローズ時

実行中に何らかの理由でPRをクローズする判断に至った場合（例: 指摘が別アプローチでの再実装を求めている、要件の陳腐化、別PRで対応済み、コンフリクト解消不能など）は、PRと **関連Issueを必ず連動してクローズする**。PRだけ閉じてIssueをOPENのまま残すと他の作業者が同じスコープに重複着手するため、片側だけのクローズは禁止する。クローズ判断はフェーズ0の安全ガードとは独立に発生し得るため、判断時点でこのルールを適用すること。

手順:

1. クローズ理由を1-3行で言語化する
2. PRに理由を含むコメントを投稿し、PRをクローズする
   ```bash
   gh pr close $0 --comment "<クローズ理由。代替PR/Issueがあればそのリンクを含める>"
   ```
3. 関連Issueを特定する。GitHub MCP が使える場合は `pull_request_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。優先順位:
   - `gh pr view $0 --json closingIssuesReferences -q '.closingIssuesReferences[].number'`（GitHubが自動認識したリンク）
   - 上記が空の場合は `gh pr view $0 --json body -q '.body'` の本文から `Closes #<n>` / `Fixes #<n>` / `Resolves #<n>` を正規表現で抽出する
4. 取得した各Issue番号について状態を確認し、`OPEN` の場合のみ以下を実行する。GitHub MCP が使える場合は `issue_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。
   `gh issue view <n> --json state -q '.state'`
   ```bash
   gh issue comment <n> --body-file - <<EOF
   ## 関連PRクローズに伴うクローズ
   PR #$0 を以下の理由でクローズしました。本Issueの作業はこのPR内では行いません。

   ### クローズ理由
   <理由>

   ### 今後の扱い
   <代替PR/Issueがあればリンク。再着手が必要な場合はその旨と新規Issue番号>
   EOF
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh close-issue <n> not_planned
   ```
5. 最終報告に「PR #$0 とリンクされたIssue #<n> をクローズした理由・代替手段」を必ず明記する
