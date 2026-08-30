#!/usr/bin/env bash
set -euo pipefail

# 直近N日にマージされた `cc-ui-design` ラベル付きPR（UIデザインPR）の
# レビューコメント・会話コメント・変更ファイル一覧を収集する。
#
# 使い方:
#   fetch-recent-ui-design-prs.sh [日数] [出力先パス]
#
# 出力:
#   stdout には「インデックスJSON」だけを出す（コメント本文は含めない）。
#   本文を含む完全なJSONは出力先パス（既定: mktemp）へ書き出し、
#   インデックスの output_file に絶対パスを載せる。
#   コメント全文をそのまま読むとコンテキストを食い潰すため、
#   呼び出し側が jq で必要なPRだけを取り出せるようにしている。
#
# 変更ファイルは3種類に仕分けて返す:
#   - pen_files:      `.pen`（暗号化バイナリなので Read できない。Pencil MCP / CLI 経由で調べる）
#   - snapshot_files: パスに `snapshots/` ディレクトリを含む `.png` / `.jpg` 等の画像
#                     （`.pen` と同階層の `snapshots/` に出る Pencil のエクスポート結果のみを対象にし、
#                      README/docs 配下等の無関係な画像を混入させない）
#   - other_files:    それ以外（pen_files にも snapshot_files にも該当しないもの）
#
# このスクリプトは GitHub MCP 利用不可時のフォールバック経路。GraphQL 直叩きはクラウド
# セッションのプロキシで403になるため、取得は `gh-compat.sh` の REST サブコマンド経由で行う。
# 詳細は plugin/references/github-access.md を参照。

DAYS="${1:-1}"
OUT_FILE="${2:-}"
JOB_LIMIT="${JOB_LIMIT:-10}"
MAX_PRS="${MAX_PRS:-50}"
LABEL="${LABEL:-cc-ui-design}"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "error: days must be a non-negative integer (got: ${DAYS})" >&2
  exit 1
fi

OWNER_REPO="$(bash "$(dirname "$0")/../../../scripts/gh-compat.sh" owner-repo)"

if date -v-1d >/dev/null 2>&1; then
  SINCE_DATE="$(date -v-"${DAYS}"d +%Y-%m-%d)"
  SINCE_ISO="$(date -u -v-"${DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"
else
  SINCE_DATE="$(date -d "${DAYS} days ago" +%Y-%m-%d)"
  SINCE_ISO="$(date -u -d "${DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

if [ -z "$OUT_FILE" ]; then
  OUT_FILE="$(mktemp -t ui-design-prs.XXXXXX)"
fi
# 相対パスで渡されても呼び出し側が確実に開けるよう絶対パスへ正規化する
OUT_DIR="$(cd "$(dirname "$OUT_FILE")" && pwd)"
OUT_FILE="${OUT_DIR}/$(basename "$OUT_FILE")"

empty_result() {
  jq -n --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" --arg out "$OUT_FILE" --arg label "$LABEL" \
    '{period_since:$since, repo:$repo, label:$label, pr_count:0, output_file:$out, prs:[]}' \
    | tee "$OUT_FILE"
}

GH_COMPAT="$(dirname "$0")/../../../scripts/gh-compat.sh"

# MAX_PRS で切り捨てる基準はPR番号ではなくマージ日時（降順）にする。
# 番号順で切ると、長期間openだった低番号PRが直近マージされた場合に
# 本来含めるべき直近マージPRが除外されてしまう（list-prs-merged-since は merged_at 降順で返す）。
# 認証失敗（クラウドセッションでの403等）を「該当0件」として握りつぶさないよう、
# 一覧取得の失敗はここで即座にエラー終了させる（呼び出し元が pr_count:0 と誤認しないため）。
# since には `${SINCE_DATE}T00:00:00Z`（その日の 00:00:00Z）を渡す。元の
# `merged:>=${SINCE_DATE}`（日付粒度）と意味を揃えるためで、SINCE_ISO（現在時刻から
# N日前の時刻）を渡すと対象がより狭くなり、移行前後で出力が変わってしまう。
if ! PR_NUMBERS_ALL=$(bash "$GH_COMPAT" list-prs-merged-since "${SINCE_DATE}T00:00:00Z" "$LABEL"); then
  echo "error: gh-compat.sh list-prs-merged-since failed for label '${LABEL}' (auth/network failure, not zero results)" >&2
  exit 1
fi

PR_NUMBERS=$(echo "$PR_NUMBERS_ALL" | head -n "$MAX_PRS")

if [ -z "$PR_NUMBERS" ]; then
  empty_result
  exit 0
fi

fetch_pr() {
  local pr="$1" out_json="$2"

  local work_dir="$TEMP_DIR/pr_${pr}"
  mkdir -p "$work_dir"
  local meta_file="$work_dir/meta.json"
  local threads_ndjson="$work_dir/threads.ndjson"
  local comments_ndjson="$work_dir/comments.ndjson"
  local files_ndjson="$work_dir/files.ndjson"

  bash "$GH_COMPAT" pr-meta "$pr" > "$meta_file"
  bash "$GH_COMPAT" pr-review-comments "$pr" > "$threads_ndjson"
  bash "$GH_COMPAT" pr-conversation-comments "$pr" > "$comments_ndjson"
  bash "$GH_COMPAT" pr-files "$pr" > "$files_ndjson"

  # REST に同等表現が無いフィールドの縮退:
  # - is_resolved: REST にレビュースレッドという資源が無いため、GraphQLが使えない環境
  #   （クラウド）では null になる。ローカルでは gh-compat.sh の GraphQL 補完が値を埋める。
  # - conversation_comments の isMinimized == false フィルタ: REST に isMinimized 相当が
  #   無いため、GraphQLが使えない環境では非表示（minimized）コメントを除外できず取り込まれる
  #   （落とすより取り込む側＝安全側に倒している）。
  # - related_issues（closingIssuesReferences）: REST に同等資源が無いため、pr-meta は
  #   PR本文の closing keyword（`Closes #N` 等）から導出する。GitHubのUIで手動リンクされた
  #   closing 参照は本文に現れないため取れない。なお cc-ui-design の運用ではデザインPRが
  #   `Refs #N`（closing keyword ではない）を使うため、そもそも related_issues は空になる
  #   のが正常。
  jq -n \
    --slurpfile meta "$meta_file" \
    --slurpfile threads <(jq -s '.' "$threads_ndjson") \
    --slurpfile comments <(jq -s '.' "$comments_ndjson") \
    --slurpfile files <(jq -s '.' "$files_ndjson") \
    '
      ($meta[0]) as $pr |
      ($threads[0]) as $threads |
      ($comments[0]) as $comments |
      ($files[0]) as $files |
      ($files | map(.path)) as $paths | {
        pr_number: $pr.number,
        pr_title: $pr.title,
        pr_url: $pr.url,
        pr_body: ($pr.body // ""),
        pr_author: ($pr.author.login // "unknown"),
        merged_at: $pr.mergedAt,
        merge_commit: ($pr.mergeCommit.oid // null),
        base_ref: $pr.baseRefName,
        head_ref: $pr.headRefName,
        labels: [$pr.labels.nodes[].name],
        related_issues: [$pr.closingIssuesReferences.nodes[] | {number, title}],
        pen_files: [$paths[] | select(test("\\.pen$"))],
        snapshot_files: [$paths[] | select((test("\\.pen$") | not) and test("(^|/)snapshots/") and test("(?i)\\.(png|jpe?g|webp|gif|svg)$"))],
        other_files: [$paths[] | select((test("\\.pen$") or (test("(^|/)snapshots/") and test("(?i)\\.(png|jpe?g|webp|gif|svg)$"))) | not)],
        review_comments: [
          $threads[] | . as $t |
          $t.comments.nodes[] |
          {
            path: $t.path, line: $t.line,
            is_resolved: $t.isResolved, is_outdated: $t.isOutdated,
            author: (.author.login // "unknown"),
            body: .body, url: .url, created_at: .createdAt
          }
        ],
        conversation_comments: [
          $comments[] | select(.isMinimized == false) |
          { author: (.author.login // "unknown"), body: .body, url: .url, created_at: .createdAt }
        ]
      }
    ' > "$out_json"
}

PIDS=()
PIDS_PR=()
FAILED_PRS=()

wait_batch() {
  local i
  for i in "${!PIDS[@]}"; do
    if ! wait "${PIDS[$i]}"; then
      echo "warning: failed to fetch PR #${PIDS_PR[$i]}" >&2
      FAILED_PRS+=("${PIDS_PR[$i]}")
    fi
  done
  PIDS=()
  PIDS_PR=()
}

for PR in $PR_NUMBERS; do
  fetch_pr "$PR" "$TEMP_DIR/pr_${PR}.json" &
  PIDS+=("$!")
  PIDS_PR+=("$PR")

  if [ "${#PIDS[@]}" -ge "$JOB_LIMIT" ]; then
    wait_batch
  fi
done
wait_batch

if [ "${#FAILED_PRS[@]}" -gt 0 ]; then
  echo "warning: ${#FAILED_PRS[@]} PR(s) failed to fetch and will be omitted: ${FAILED_PRS[*]}" >&2
fi

shopt -s nullglob
FETCHED_FILES=("$TEMP_DIR"/pr_*.json)
shopt -u nullglob

if [ "${#FETCHED_FILES[@]}" -eq 0 ]; then
  # 対象PRはあったが全件取得に失敗したケース。空振りと区別できるよう警告を残す
  echo "warning: all PR fetches failed; returning empty result" >&2
  empty_result
  exit 0
fi

# 完全版（コメント本文入り）を出力先へ書き出す
jq -s --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" --arg out "$OUT_FILE" --arg label "$LABEL" '
  {
    period_since: $since,
    repo: $repo,
    label: $label,
    pr_count: (. | length),
    output_file: $out,
    prs: (. | sort_by(.merged_at) | reverse)
  }
' "${FETCHED_FILES[@]}" > "$OUT_FILE"

# stdout にはインデックスだけ返す（コメント本文はコンテキストを食い潰すため載せない）
jq '
  {
    period_since, repo, label, pr_count, output_file,
    prs: [
      .prs[] | {
        pr_number, pr_title, merged_at, base_ref, head_ref, related_issues,
        pen_files, snapshot_files,
        other_file_count: (.other_files | length),
        review_comment_count: (.review_comments | length),
        conversation_comment_count: (.conversation_comments | length),
        comment_chars: (
          ([.review_comments[].body | length] | add // 0)
          + ([.conversation_comments[].body | length] | add // 0)
        )
      }
    ]
  }
' "$OUT_FILE"
