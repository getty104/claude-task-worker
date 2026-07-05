#!/usr/bin/env bash
set -euo pipefail

DAYS="${1:-1}"
JOB_LIMIT="${JOB_LIMIT:-10}"

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

PR_NUMBERS=$(gh pr list --state all --search "updated:>=${SINCE_DATE}" --json number --jq '.[].number' --limit 100)

TEMP_DIR=$(mktemp -d)
WORK_DIR="$TEMP_DIR/work"
mkdir -p "$WORK_DIR"
trap 'rm -rf "$TEMP_DIR"' EXIT

if [ -z "$PR_NUMBERS" ]; then
  jq -n --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" \
    '{period_since:$since, repo:$repo, pr_count:0, prs:[]}'
  exit 0
fi

fetch_review_threads() {
  local owner="$1"
  local repo="$2"
  local pr="$3"
  local threads_ndjson="$4"

  local cursor=""
  local has_next="true"

  : > "$threads_ndjson"

  while [ "$has_next" = "true" ]; do
    local args=(-f query='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
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
    }' -F owner="$owner" -F repo="$repo" -F pr="$pr")
    if [ -n "$cursor" ]; then
      args+=(-F cursor="$cursor")
    fi

    local result
    result=$(gh api graphql "${args[@]}")

    echo "$result" | jq -c '.data.repository.pullRequest.reviewThreads.nodes[]' >> "$threads_ndjson"
    has_next=$(echo "$result" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage')
    cursor=$(echo "$result" | jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor')
  done
}

fetch_conversation_comments() {
  local owner="$1"
  local repo="$2"
  local pr="$3"
  local comments_ndjson="$4"

  local cursor=""
  local has_next="true"

  : > "$comments_ndjson"

  while [ "$has_next" = "true" ]; do
    local args=(-f query='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          comments(first: 100, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes { author { login } body url createdAt isMinimized }
          }
        }
      }
    }' -F owner="$owner" -F repo="$repo" -F pr="$pr")
    if [ -n "$cursor" ]; then
      args+=(-F cursor="$cursor")
    fi

    local result
    result=$(gh api graphql "${args[@]}")

    echo "$result" | jq -c '.data.repository.pullRequest.comments.nodes[]' >> "$comments_ndjson"
    has_next=$(echo "$result" | jq -r '.data.repository.pullRequest.comments.pageInfo.hasNextPage')
    cursor=$(echo "$result" | jq -r '.data.repository.pullRequest.comments.pageInfo.endCursor')
  done
}

fetch_pr() {
  local pr="$1"
  local out_file="$2"
  local since="$3"
  local owner="$4"
  local repo="$5"

  local pr_work_dir="$WORK_DIR/pr_${pr}"
  mkdir -p "$pr_work_dir"
  local meta_file="$pr_work_dir/meta.json"
  local threads_ndjson="$pr_work_dir/threads.ndjson"
  local comments_ndjson="$pr_work_dir/comments.ndjson"

  gh api graphql \
    -f query='query($owner:String!,$repo:String!,$pr:Int!) {
      repository(owner:$owner, name:$repo) {
        pullRequest(number:$pr) {
          number title url author { login }
        }
      }
    }' \
    -F owner="$owner" -F repo="$repo" -F pr="$pr" \
    | jq -c '.data.repository.pullRequest' > "$meta_file"

  fetch_review_threads "$owner" "$repo" "$pr" "$threads_ndjson"
  fetch_conversation_comments "$owner" "$repo" "$pr" "$comments_ndjson"

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
  fetch_pr "$PR" "$TEMP_DIR/pr_${PR}.json" "$SINCE_ISO" "$OWNER" "$REPO" &
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
