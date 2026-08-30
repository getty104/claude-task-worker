#!/usr/bin/env bash
set -euo pipefail

# このスクリプトは GitHub MCP 利用不可時のフォールバック経路。GraphQL 経由の gh
# コマンド（内部が GraphQL の一覧・照会系サブコマンド）はクラウドセッションの
# プロキシで403になるため、取得は `gh-compat.sh` の REST サブコマンド経由で行う
# （ローカル実行では同スクリプト内で GraphQL による補完が働く）。詳細は
# plugin/references/github-access.md を参照。

DAYS="${1:-1}"
JOB_LIMIT="${JOB_LIMIT:-10}"

GH_COMPAT="$(dirname "$0")/../../../scripts/gh-compat.sh"

OWNER_REPO="$(bash "$GH_COMPAT" owner-repo)"

if date -v-1d >/dev/null 2>&1; then
  SINCE_DATE="$(date -v-"${DAYS}"d +%Y-%m-%d)"
  SINCE_ISO="$(date -u -v-"${DAYS}"d +%Y-%m-%dT%H:%M:%SZ)"
else
  SINCE_DATE="$(date -d "${DAYS} days ago" +%Y-%m-%d)"
  SINCE_ISO="$(date -u -d "${DAYS} days ago" +%Y-%m-%dT%H:%M:%SZ)"
fi

# `${SINCE_DATE}T00:00:00Z`（その日の00:00:00Z以降）を渡すのは、旧実装が持って
# いた「updated:>=<日付>」という日付粒度の意味を揃えるため。SINCE_ISO（現在
# 時刻からDAYS日前の時刻）を渡すと対象範囲がより狭くなり、移行前後で出力が
# 変わってしまう。
if ! PR_NUMBERS=$(bash "$GH_COMPAT" list-prs-updated-since "${SINCE_DATE}T00:00:00Z"); then
  echo "error: failed to list PRs updated since ${SINCE_DATE}" >&2
  exit 1
fi

TEMP_DIR=$(mktemp -d)
WORK_DIR="$TEMP_DIR/work"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$TEMP_DIR"' EXIT

if [ -z "$PR_NUMBERS" ]; then
  jq -n --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" \
    '{period_since:$since, repo:$repo, pr_count:0, prs:[]}'
  exit 0
fi

fetch_pr() {
  local pr="$1"
  local out_file="$2"
  local since="$3"

  local pr_work_dir="$WORK_DIR/pr_${pr}"
  mkdir -p "$pr_work_dir"
  local meta_file="$pr_work_dir/meta.json"
  local threads_ndjson="$pr_work_dir/threads.ndjson"
  local comments_ndjson="$pr_work_dir/comments.ndjson"

  bash "$GH_COMPAT" pr-meta "$pr" > "$meta_file"
  bash "$GH_COMPAT" pr-review-comments "$pr" > "$threads_ndjson"
  bash "$GH_COMPAT" pr-conversation-comments "$pr" > "$comments_ndjson"

  # REST に同等表現が無いフィールドの縮退（gh-compat.sh の契約どおり）:
  # - is_resolved: REST にレビュースレッドという資源が無いため、GraphQL が
  #   使えない環境（クラウド）では null になる。ローカルでは gh-compat.sh の
  #   GraphQL 補完が値を埋める。
  # - conversation_comments の isMinimized == false フィルタ: REST に
  #   isMinimized 相当が無いため、GraphQL が使えない環境では非表示
  #   （minimized）コメントを除外できず取り込まれる。落とすより取り込む側
  #   （安全側）に倒している。
  jq -n --arg since "$since" \
    --slurpfile meta "$meta_file" \
    --slurpfile threads <(jq -s '.' "$threads_ndjson") \
    --slurpfile comments <(jq -s '.' "$comments_ndjson") \
    '
      ($meta[0]) as $pr |
      ($threads[0]) as $threads |
      ($comments[0]) as $comments | {
        pr_number: $pr.number,
        pr_title: $pr.title,
        pr_url: $pr.url,
        pr_author: ($pr.author.login // "unknown"),
        review_comments: [
          $threads[] | . as $t |
          $t.comments.nodes[] | select(.createdAt >= $since) |
          {
            path: $t.path, line: $t.line,
            is_resolved: $t.isResolved, is_outdated: $t.isOutdated,
            author: (.author.login // "unknown"),
            body: .body, url: .url, created_at: .createdAt
          }
        ],
        conversation_comments: [
          $comments[] | select(.createdAt >= $since) | select(.isMinimized == false) |
          { author: (.author.login // "unknown"), body: .body, url: .url, created_at: .createdAt }
        ]
      }
    ' > "$out_file"
}

PIDS=()
PIDS_PR=()
FAILED_PRS=()

wait_batch() {
  local i
  for i in "${!PIDS[@]}"; do
    if ! wait "${PIDS[$i]}"; then
      echo "warning: failed to fetch review comments for PR #${PIDS_PR[$i]}" >&2
      FAILED_PRS+=("${PIDS_PR[$i]}")
    fi
  done
  PIDS=()
  PIDS_PR=()
}

for PR in $PR_NUMBERS; do
  fetch_pr "$PR" "$TEMP_DIR/pr_${PR}.json" "$SINCE_ISO" &
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

jq -s --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" '
  map(select(
    (.review_comments | length > 0) or (.conversation_comments | length > 0)
  )) as $non_empty |
  {
    period_since: $since,
    repo: $repo,
    pr_count: ($non_empty | length),
    prs: $non_empty
  }
' "$TEMP_DIR"/pr_*.json
