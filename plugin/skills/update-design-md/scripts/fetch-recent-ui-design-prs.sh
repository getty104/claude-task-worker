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

DAYS="${1:-7}"
OUT_FILE="${2:-}"
JOB_LIMIT="${JOB_LIMIT:-10}"
MAX_PRS="${MAX_PRS:-50}"
LABEL="${LABEL:-cc-ui-design}"

if ! [[ "$DAYS" =~ ^[0-9]+$ ]]; then
  echo "error: days must be a non-negative integer (got: ${DAYS})" >&2
  exit 1
fi

OWNER_REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
OWNER="$(echo "$OWNER_REPO" | cut -d'/' -f1)"
REPO="$(echo "$OWNER_REPO" | cut -d'/' -f2)"

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

# `merged:>=DATE` の検索は「マージ済み」だけを拾うので --state merged と併せて二重に絞る
# MAX_PRS で切り捨てる基準はPR番号ではなくマージ日時（降順）にする。
# 番号順で切ると、長期間openだった低番号PRが直近マージされた場合に
# 本来含めるべき直近マージPRが除外されてしまう。
PR_NUMBERS=$(gh pr list \
  --state merged \
  --label "$LABEL" \
  --search "merged:>=${SINCE_DATE}" \
  --json number,mergedAt \
  --jq 'sort_by(.mergedAt) | reverse | .[].number' \
  --limit 200 | head -n "$MAX_PRS")

if [ -z "$PR_NUMBERS" ]; then
  empty_result
  exit 0
fi

fetch_paginated() {
  # $1: 対象フィールド名（reviewThreads / comments / files）に応じたGraphQLクエリを受け取り、
  # ページングしてノードを NDJSON へ落とす汎用ヘルパー。
  local query="$1" path="$2" out_ndjson="$3" owner="$4" repo="$5" pr="$6"
  local cursor="" has_next="true"

  : > "$out_ndjson"

  while [ "$has_next" = "true" ]; do
    local args=(-f query="$query" -F owner="$owner" -F repo="$repo" -F pr="$pr")
    if [ -n "$cursor" ]; then
      args+=(-F cursor="$cursor")
    fi

    local result
    result=$(gh api graphql "${args[@]}")

    echo "$result" | jq -c ".data.repository.pullRequest.${path}.nodes[]" >> "$out_ndjson"
    has_next=$(echo "$result" | jq -r ".data.repository.pullRequest.${path}.pageInfo.hasNextPage")
    cursor=$(echo "$result" | jq -r ".data.repository.pullRequest.${path}.pageInfo.endCursor")
  done
}

REVIEW_THREADS_QUERY='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved isOutdated path line
          comments(first: 100) {
            nodes { author { login } body url createdAt }
          }
        }
      }
    }
  }
}'

COMMENTS_QUERY='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      comments(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { author { login } body url createdAt isMinimized }
      }
    }
  }
}'

FILES_QUERY='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType }
      }
    }
  }
}'

fetch_pr() {
  local pr="$1" out_json="$2" owner="$3" repo="$4"

  local work_dir="$TEMP_DIR/pr_${pr}"
  mkdir -p "$work_dir"
  local meta_file="$work_dir/meta.json"
  local threads_ndjson="$work_dir/threads.ndjson"
  local comments_ndjson="$work_dir/comments.ndjson"
  local files_ndjson="$work_dir/files.ndjson"

  gh api graphql \
    -f query='query($owner:String!,$repo:String!,$pr:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          number title url body mergedAt baseRefName headRefName
          author { login }
          mergeCommit { oid }
          labels(first: 30) { nodes { name } }
          closingIssuesReferences(first: 10) { nodes { number title } }
        }
      }
    }' \
    -F owner="$owner" -F repo="$repo" -F pr="$pr" \
    | jq -c '.data.repository.pullRequest' > "$meta_file"

  fetch_paginated "$REVIEW_THREADS_QUERY" "reviewThreads" "$threads_ndjson" "$owner" "$repo" "$pr"
  fetch_paginated "$COMMENTS_QUERY" "comments" "$comments_ndjson" "$owner" "$repo" "$pr"
  fetch_paginated "$FILES_QUERY" "files" "$files_ndjson" "$owner" "$repo" "$pr"

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
  fetch_pr "$PR" "$TEMP_DIR/pr_${PR}.json" "$OWNER" "$REPO" &
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
