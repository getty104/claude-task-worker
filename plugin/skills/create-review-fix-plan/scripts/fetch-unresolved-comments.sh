#!/usr/bin/env bash
# このスクリプトは GitHub MCP（pull_request_read の get_review_comments）が利用不可な場合の
# フォールバック経路。クラウドセッションでは GitHub プロキシが `gh api graphql` を含む
# `gh` コマンドをフィールドを問わず 403 で拒否するため、MCP が使えるならそちらを優先する。
# 呼び出し元（create-review-fix-plan / triage-pr）の判定・フォールバック方針は
# plugin/references/github-access.md を参照。
#
# 失敗を握りつぶさないこと。「未解決の指摘が0件だった」と「取得に失敗した」は終了コードで
# 区別できなければならない（0件は exit 0 ＋ 空配列、失敗は exit 非0）。呼び出し元の
# `triage-pr` はマージゲートなので、403 や一過性の `gh` 障害を「指摘0件」と誤認すると
# 未対応の指摘を残したまま PR をマージする。
set -euo pipefail

OWNER_REPO="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"
OWNER="$(echo $OWNER_REPO | cut -d'/' -f1)"
REPO="$(echo $OWNER_REPO | cut -d'/' -f2)"
# `set -e` があるため gh 自体の失敗はここで即終了する。値が取れても空/null なら
# 番号を確定できていないので、同じく失敗として扱う（空の結果を返さない）。
if ! PR_NUMBER="$(gh pr view --json number --jq '.number')" || [ -z "$PR_NUMBER" ] || [ "$PR_NUMBER" = "null" ]; then
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
      comments(first: 100) {
        nodes {
          author {
            login
          }
          body
          url
          createdAt
          isMinimized
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
      comments(first: 100) {
        nodes {
          author {
            login
          }
          body
          url
          createdAt
          isMinimized
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
    # 空の結果を返してしまい、呼び出し元が「指摘0件」と誤認するため明示的に失敗させる。
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
      conversation_comments: [
        $first_pr.comments.nodes[] |
        {
          author: .author.login,
          body: .body,
          url: .url,
          created_at: .createdAt,
          is_minimized: .isMinimized
        }
      ],
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

fetch_all_review_threads
