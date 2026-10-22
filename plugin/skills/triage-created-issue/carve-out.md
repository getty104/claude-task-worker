# triage-created-issue: 反証シグナル4項目目（carve-out）の後続Issue起票

パターンAの反証シグナル4項目目に該当し、後回しにした不具合を追跡する後続Issueがまだ無いときに読む。

反証シグナル4項目目に該当し、後回し対象の不具合を追跡する後続Issueがまだ無い場合、本スキル自身が以下の手順で起票する。

トリガーラベルはAND条件であり競合しない: 後続Issueには`cc-triage-scope`のみを付与し`cc-issue-created`は付けない。`triage-created-issue`ワーカーは両ラベルが揃って初めてマッチする（`src/workers/triage-created-issue.ts`、`--label`複数指定のAND一致）ため、`cc-issue-created`が無い間は後続Issueが同ワーカーに拾われず、`create-issue`ワーカー（トリガーラベル`cc-triage-scope`単独）との競合は起きない。

1. 起票前に、分離元Issueのコメント履歴を固定マーカー `## 後続Issue起票済み（carve-out）` で走査する。ヒットした場合は起票をスキップし、記載されている既存の後続Issue番号を再利用する。
2. ヒットしない場合、`gh-compat.sh create-issue` で起票する（`gh issue create` と GitHub MCP の `issue_write` は使わない。前者は GraphQL 経由でクラウドでは 403 になり、後者は labels / assignees の渡し忘れで黙って欠落する）。初期ラベルは`cc-triage-scope`のみ（`cc-issue-created`を付けると`create-issue`ワーカーの分析フェーズをスキップし、実装プランのない素のdescriptionのまま`triage-created-issue`→`exec-issue`に流れてしまう）。Assignee には実行中のユーザー（`@me`）を付ける（ワーカーはラベルと Assignee の両方で Issue を拾うため、欠けると後続Issueが放置される）。`blockedBy`関係は付与しない（`-is:blocked`によりワーカーの検索クエリから除外され、分離元Issueがクローズするまで放置されるため）。
   ```bash
   bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh create-issue \
     --title "<後回しにした不具合のタイトル>" \
     --label "cc-triage-scope" \
     --assignee "@me" \
     --body-file - <<'EOF'
   <不具合の内容。分離元Issue #$0 を参照する旨を明記>
   EOF
   ```
3. 起票直後・分離元Issueへのコメント投稿前に、もう一度同じ固定マーカーで分離元Issueのコメント履歴を走査する（並行実行で他プロセスが同じ起票を行っていないかの再確認）。既存の後続Issue番号がすでに記録されていた場合、直前に自分が作成した後続Issueは重複とみなし`gh-compat.sh close-issue <番号> not_planned`でクローズしたうえで、既存番号を採用してステップ4に進む。
4. 分離元Issue・後続Issueそれぞれの本文（description）に相手のIssue番号を明記して相互参照する。本文更新とマーカーコメント投稿の2段階で行う：
   - 後続Issue側はステップ2の`--body`で参照済み
   - 分離元Issue側は既存descriptionを保持したまま末尾に参照を追記する。`exec-issue`など後続処理はdescriptionのみを読むため、コメントだけでは本文に参照が残らない

   固定パス（例: `/tmp/issue-$0-body.md`）は同一Issueへの並行実行で衝突しうるため`mktemp`で一意な一時ファイルを確保する。`view`と`edit`の間の外部更新に備え、`edit`直前に本文を再取得し、(a) 追記予定の参照文言がすでに含まれていないか、(b) このステップ開始時点の内容と一致しているかを検証してから書き戻す：

   > GitHub MCP が使える場合は本文取得に `issue_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。

   ```bash
   BODY_FILE="$(mktemp -t issue-$0-body-XXXXXX.md)"
   trap 'rm -f "$BODY_FILE"' EXIT

   ORIGINAL_BODY="$(gh issue view $0 --json body --jq .body)"
   REFERENCE_LINE='既知の不具合の分離・後回し（carve-out）として、後続Issue #<後続Issue番号> を起票済み。'
   printf '%s\n\n---\n\n%s\n' "$ORIGINAL_BODY" "$REFERENCE_LINE" > "$BODY_FILE"

   # edit直前に最新本文を再取得し、無条件の上書き（ロスト・アップデート）を避ける
   LATEST_BODY="$(gh issue view $0 --json body --jq .body)"
   if grep -qF '既知の不具合の分離・後回し（carve-out）として、後続Issue #' <<<"$LATEST_BODY"; then
     : # 他プロセスが既に参照を追記済み。重複追記せずステップ5へ進む
   elif [ "$LATEST_BODY" != "$ORIGINAL_BODY" ]; then
     : # ステップ1〜3で確認した内容と矛盾する外部変更を検知。carve-outとしての進行を中止し、ステップ6のパターンAへフォールバックする
   else
     gh issue edit $0 --body-file "$BODY_FILE"
   fi
   ```
   いずれの分岐でも「参照文言が本文に反映されている」（既存分含む）ことを確認できて初めて次に進んでよい。矛盾検知の分岐に入った場合はステップ6に従う。
5. 本文更新に続けて、重複検出・通知用の固定マーカー（後続Issue番号入り）を分離元Issueへコメント投稿する。
   ```bash
   gh issue comment $0 --body-file - <<'EOF'
   ## 後続Issue起票済み（carve-out）

   既知の不具合の分離・後回しとして、以下の後続Issueを起票しました。

   - 後続Issue: #<後続Issue番号>

   本Issueは推奨案のとおり進行します。
   EOF
   ```
6. ステップ2〜5（起票・本文更新・マーカーコメント投稿）のいずれかが失敗した場合、carve-outとして進行する前提が欠けたことになるため、この項目を事実確認で解消可能な項目として扱うのを中止する。パターンA本来の人間確認フロー（「該当する場合の処理」節）に戻り、失敗した操作の内容とエラーを「自動で進められない理由」に明記して`cc-need-human-check`を付与する。ステップ4の本文再取得で検知した外部変更との矛盾も、本文更新が完了しなかった＝ステップ4の失敗として同じくパターンAへフォールバックする。
