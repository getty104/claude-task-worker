#!/usr/bin/env bash
# `resolve-pr-comments` スキルが GitHub MCP（pull_request_review_write の resolve_thread）を
# 使えない場合のフォールバック経路。クラウドセッションでは `gh api graphql` /
# `gh (issue|pr) view --json` がプロキシで403になるため、この経路は成立しない
# （その場合は非0で終了し、呼び出し側が「Resolve できなかった」と報告できるようにする）。
# 詳細は plugin/references/github-access.md を参照。
#
# 失敗を握りつぶさないこと。「未解決スレッドが0件だった」と「取得・Resolve に失敗した」は
# 終了コードで区別できなければならない（0件は exit 0、失敗は exit 非0）。
set -euo pipefail

OWNER_REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
OWNER="$(echo $OWNER_REPO | cut -d'/' -f1)"
REPO="$(echo $OWNER_REPO | cut -d'/' -f2)"
# `set -e` があるため gh 自体の失敗はここで即終了する。値が取れても空/null なら
# 番号を確定できていないので、同じく失敗として扱う（別PRのスレッドを触らないため）。
if ! PR_NUMBER="${1:-$(gh pr view --json number --jq '.number')}" || [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
  echo "Error: Could not determine PR number. Make sure the current branch has an open PR." >&2
  exit 1
fi

fetch_all_review_threads() {
  local cursor=""
  local has_next_page=true
  local temp_dir=$(mktemp -d)
  local page_num=0

  while [ "$has_next_page" = "true" ]; do
    if [ -z "$cursor" ]; then
      gh api graphql -f query="
query {
  repository(owner: \"${OWNER}\", name: \"${REPO}\") {
    pullRequest(number: ${PR_NUMBER}) {
      number
      title
      url
      state
      author {
        login
      }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            ... on User {
              login
            }
          }
        }
      }
      reviewThreads(first: 100) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            isResolved
            isOutdated
            path
            line
            comments(last: 100) {
              nodes {
                author {
                  login
                }
                body
                url
                createdAt
              }
            }
          }
        }
      }
    }
  }
}" > "${temp_dir}/page_${page_num}.json"
    else
      gh api graphql -f query="
query(\$cursor: String) {
  repository(owner: \"${OWNER}\", name: \"${REPO}\") {
    pullRequest(number: ${PR_NUMBER}) {
      number
      title
      url
      state
      author {
        login
      }
      reviewRequests(first: 100) {
        nodes {
          requestedReviewer {
            ... on User {
              login
            }
          }
        }
      }
      reviewThreads(first: 100, after: \$cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            isResolved
            isOutdated
            path
            line
            comments(last: 100) {
              nodes {
                author {
                  login
                }
                body
                url
                createdAt
              }
            }
          }
        }
      }
    }
  }
}" -f cursor="$cursor" > "${temp_dir}/page_${page_num}.json"
    fi

    has_next_page=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.hasNextPage' "${temp_dir}/page_${page_num}.json")
    cursor=$(jq -r '.data.repository.pullRequest.reviewThreads.pageInfo.endCursor' "${temp_dir}/page_${page_num}.json")

    # hasNextPage を読めない＝レスポンスがエラー本文（403 など）か空。ここで打ち切ると
    # 「未解決0件」と区別できない結果を返してしまうため、明示的に失敗させる。
    if [ "$has_next_page" != "true" ] && [ "$has_next_page" != "false" ]; then
      echo "Error: could not read reviewThreads.pageInfo from the GraphQL response (page ${page_num}). Response head:" >&2
      head -c 500 "${temp_dir}/page_${page_num}.json" >&2
      echo >&2
      rm -rf "$temp_dir"
      return 1
    fi

    if [ "$cursor" = "null" ]; then
      cursor=""
    fi
    
    page_num=$((page_num + 1))
  done

  jq -s '
    .[0].data.repository.pullRequest as $first_pr |
    {
      pr_number: $first_pr.number,
      title: $first_pr.title,
      url: $first_pr.url,
      state: $first_pr.state,
      author: $first_pr.author.login,
      requested_reviewers: [$first_pr.reviewRequests.nodes[].requestedReviewer.login],
      unresolved_threads: [
        .[].data.repository.pullRequest.reviewThreads.edges[] |
        select(.node.isResolved == false) |
        {
          thread_id: .node.id,
          path: .node.path,
          line: .node.line,
          is_outdated: .node.isOutdated,
          comments: [
            .node.comments.nodes[] |
            {
              author: .author.login,
              body: .body,
              url: .url,
              created_at: .createdAt
            }
          ]
        }
      ]
    }
  ' "${temp_dir}"/page_*.json

  rm -rf "$temp_dir"
}

REVIEW_DATA=$(fetch_all_review_threads)

THREAD_IDS=$(echo "$REVIEW_DATA" | jq -r '.unresolved_threads[].thread_id')

resolved=0
failed=0
# パイプの `while` はサブシェルになりカウンタが伝播しないため、here-string で回す。
while read -r thread_id; do
  [ -n "$thread_id" ] && [ "$thread_id" != "null" ] || continue
  echo "Resolving thread: $thread_id"
  if gh api graphql -f query="
mutation {
  resolveReviewThread(input: {threadId: \"$thread_id\"}) {
    thread {
      id
      isResolved
    }
  }
}"; then
    echo "✓ Resolved thread: $thread_id"
    resolved=$((resolved + 1))
  else
    echo "✗ Failed to resolve thread: $thread_id" >&2
    failed=$((failed + 1))
  fi
done <<< "$THREAD_IDS"

echo "Processed ${resolved} resolved / ${failed} failed unresolved thread(s)."

# 1件でも Resolve に失敗したら非0で終える。呼び出し側（`resolve-pr-comments` スキル）が
# 「全件成功」と誤認しないようにするため。0件だった場合は正常終了（exit 0）。
if [ "$failed" -gt 0 ]; then
  exit 1
fi
