# triage-created-issue: パターンF（Epic化とサブIssueへの分割）の処理

パターンFの判定基準に該当したときに読む。手順の順序はそれぞれ理由のある契約なので入れ替えない。

1. 冪等性の確認: 変更単位（タイトル付き）を先に確定させ、本Issueの既存sub-issueを取得する（`gh api --paginate repos/{owner}/{repo}/issues/$0/sub_issues --jq '.[] | {number, title}'`。既定は1ページ30件のため `--paginate` で全件を取る）。既存sub-issueはタイトルで変更単位と照合し、一致したものは新規作成せず採用する。既存sub-issueがあってもステップ4へ飛ばず、ステップ2〜4を「未完了の操作だけを行う」形で順に実行する（前回の途中失敗からの再実行で、子の重複作成や `blockedBy` の設定漏れを残さないため）
2. 照合で見つからなかった変更単位ごとにサブIssueを作成し、**作成のたびに直ちに**本Issueへ紐付ける（作成と紐付けの間で失敗すると、親を持たない子は次回の照合で見つからず重複作成されるため、その窓を1件分に狭める）。`gh-compat.sh create-issue` を使う（`gh issue create` は GraphQL 経由でクラウドでは 403 になり、MCP の `issue_write` は labels / assignees の渡し忘れで黙って欠落するため使わない）。**作成時はラベルを付けず**、Assignee は `@me` のみ指定する（`cc-triage-scope` は `create-issue` ワーカーのトリガーのため、親子関係・`blockedBy` の設定前に付けると、親なし・未ブロックのIssueとして拾われ、デフォルトブランチ起点・順序無視で処理されうる。付与はステップ4で行う）
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh create-issue \
     --title "<変更単位のタイトル>" \
     --assignee "@me" \
     --body-file - <<'EOF'
   ## 概要
   Epic #$0 の一部。<この単位で行う変更>

   ## 要件
   <親Issueの要件・実装プランのうち、この単位が担う部分を転記（親の確定内容を書き換えない）>

   ## 完了条件
   <この単位を単独でマージできる状態>
   EOF
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-sub-issue $0 <作成した子>
   ```
3. 順序がある単位には blockedBy を貼る（先行単位が close されるまで後続が `exec-issue` に拾われないようにするため）。再実行時は `gh-compat.sh issue-deps <後続の子>` の `blockedBy` に先行の子が含まれていないものだけを貼る
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-blocked-by <後続の子> <先行の子>
   ```
   本Issue（親）とサブIssueの間には blockedBy を貼らない（親はサブIssueが全て閉じるまで close されないため、サブIssueが永久に拾われなくなる）
4. 全サブIssue（採用した既存の子を含む）に `cc-triage-scope` を付ける。ステップ2・3がすべて成功してから付ける（理由はステップ2のとおり）。`add-label` は冪等なので再実行で付け直してよい
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-label <子1> cc-triage-scope
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-label <子2> cc-triage-scope
   ```
5. 本Issueに `cc-epic-issue` を付ける（sub-issue の紐付けが済んでから付ける。先に付けると、紐付け途中の部分集合だけで `epic-issue` ワーカーの完了判定が走りうる）
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh add-label $0 cc-epic-issue
   ```
6. 本Issueへマーカーコメントを投稿する（既に固定マーカー `## Epic化しました（サブIssueへ分割）` のコメントがあれば投稿しない）
   ```bash
   gh issue comment $0 --body-file - <<'EOF'
   ## Epic化しました（サブIssueへ分割）

   ## 分割した理由
   <判定基準のどれに該当したか、変更単位の切り方>

   ## サブIssue
   - #<子1>: <タイトル>
   - #<子2>: <タイトル>（#<子1> の完了後に着手）

   各サブIssueは通常のフロー（分析 → トリアージ → 実装）で処理され、全て完了すると Epic PR が作成されます。
   EOF
   ```

`cc-exec-issue` は付与しない（本Issue自体は実装しない）。ステップ2〜6のいずれかが失敗した場合は、作成済みのサブIssueは残したまま（ステップ1の冪等性確認で再採用される。紐付け前に失敗した子は再採用されないため、その番号も理由に明記する）、パターンAの「該当する場合の処理」に従い、失敗した操作とエラーを「自動で進められない理由」に明記して `cc-need-human-check` を付与する。
