#!/usr/bin/env bash
# GitHub 参照/更新のうち、クラウドセッションの GraphQL ゲートで 403 になる操作を
# 「REST / git のローカル導出」へ寄せるヘルパー。
#
# なぜ必要か: クラウドセッション（`claude --cloud`）の GitHub プロキシは操作名単位の
# アローリストで、`gh (issue|pr) view --json` はフィールドを問わず GraphQL 経由になり
# 403 で落ちる（実測は docs/cloud-graphql-proxy-limits.md）。加えてクラウド VM の gh は
# 一方 REST（`gh api repos/{o}/{r}/...`）と git のローカル導出はゲートを通らない。
#
# gh のバージョンを上げても解決しない: 2026-08-29 に gh 2.98.0 で `GH_DEBUG=api` を取ったところ、
# `--json parent` / `blockedBy`、`gh issue edit --add-blocked-by` / `--add-sub-issue`、`gh issue create`、
# `gh pr view --json mergeable` はいずれも GraphQL エンドポイントを叩いていた。フラグやフィールドの
# 有無ではなく転送経路の問題なので、REST へ寄せる以外に手が無い。
#
# 各サブコマンドは「REST / git を第一手段、失敗したら従来の gh へフォールバック」で、
# ローカル実行の挙動を変えない。REST 側のエンドポイント仕様が将来変わってもフォール
# バックが受けるため、片方が壊れても機能自体は止まらない。
#
# 使い方: bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh <subcommand> [args...]
set -uo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: gh-compat.sh <subcommand> [args...]

  default-branch                     デフォルトブランチ名を出力する
  owner-repo                         <owner>/<repo> を出力する
  parse-owner-repo <remote-url>      リモートURLから <owner>/<repo> を切り出す（純粋関数・テスト用）
  issue-parent <issue-number>        parent Issue の番号を出力する（parent 無しなら空・exit 0）
  issue-deps <issue-number>          {"blockedBy":[..],"blocking":[..]} を出力する
  add-blocked-by <issue> <num>...    <issue> をブロックする Issue を追加する
  add-blocking <issue> <num>...      <issue> がブロックする Issue を追加する
  add-sub-issue <parent> <child>...  <parent> のサブIssueとして追加する
  pr-mergeable <pr-number>           CONFLICTING / MERGEABLE / UNKNOWN を出力する
  pr-for-branch [branch]             カレント（または指定）ブランチの Open PR 番号を出力する
  list-issues-updated-since <since> [label]  since以降に更新されたIssue番号を降順で出力する（PRは除外）
  list-prs-updated-since <since>     since以降に更新されたPR番号を降順で出力する
  list-prs-merged-since <since> <label>      labelが付きsince以降にマージされたPR番号をmergedAt降順で出力する
  pr-meta <pr-number>                PRのメタデータ（1行JSON）を出力する
  pr-review-comments <pr-number>     PRのレビュースレッドをNDJSONで出力する
  pr-conversation-comments <pr-number>       PRの会話コメントをNDJSONで出力する
  pr-files <pr-number>               PRの変更ファイル一覧をNDJSONで出力する
  issue-meta <issue-number>          Issueのメタデータ（1行JSON）を出力する
  issue-comments <issue-number>      IssueのコメントをNDJSONで出力する
USAGE
  exit 64
}

# リモートURL → <owner>/<repo>。SSH（git@host:owner/repo.git）と
# HTTPS（https://host/owner/repo.git）の両方、末尾の .git 有無に対応する。
parse_owner_repo() {
  printf '%s\n' "$1" | sed -E 's#\.git$##; s#^git@[^:]+:##; s#^ssh://[^/]+/##; s#^https?://[^/]+/##'
}

resolve_default_branch() {
  local b
  b=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')
  if [ -n "$b" ]; then printf '%s\n' "$b"; return 0; fi
  gh repo view --json defaultBranchRef -q .defaultBranchRef.name 2>/dev/null
}

resolve_owner_repo() {
  local url or
  url=$(git remote get-url origin 2>/dev/null)
  if [ -n "$url" ]; then
    or=$(parse_owner_repo "$url")
    # owner/repo の2要素になっていることだけ確かめる（ホスト名混じりの誤爆を弾く）
    case "$or" in
      */*/*|*/) or="" ;;
      */*) : ;;
      *) or="" ;;
    esac
    if [ -n "$or" ]; then printf '%s\n' "$or"; return 0; fi
  fi
  gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null
}

# Issue 番号 → データベースID。Issue Dependencies / sub-issues の POST は
# 番号ではなく id を要求するため必要。
issue_id() {
  gh api "repos/${OWNER_REPO}/issues/$1" --jq '.id' 2>/dev/null
}

cmd_issue_parent() {
  local n="$1" out rc status_line
  out=$(gh api "repos/${OWNER_REPO}/issues/${n}/parent" --jq '.number' 2>/dev/null)
  rc=$?
  if [ $rc -eq 0 ]; then
    printf '%s\n' "$out"; return 0
  fi
  # 404 は「parent が無い」の正常系。403/5xx/network 等それ以外の失敗は「親なし」と誤認せず区別する。
  status_line=$(gh api "repos/${OWNER_REPO}/issues/${n}/parent" -i 2>/dev/null | head -1)
  case "$status_line" in
    *" 404 "*) printf '\n'; return 0 ;;
  esac
  gh issue view "$n" --json parent --jq '.parent.number // empty' 2>/dev/null
}

cmd_issue_deps() {
  local n="$1" blocked blocking
  blocked=$(gh api --paginate --slurp "repos/${OWNER_REPO}/issues/${n}/dependencies/blocked_by" \
    --jq '[.[][] | select(.state=="open") | .number]' 2>/dev/null)
  blocking=$(gh api --paginate --slurp "repos/${OWNER_REPO}/issues/${n}/dependencies/blocking" \
    --jq '[.[][] | select(.state=="open") | .number]' 2>/dev/null)
  if [ -n "$blocked" ] || [ -n "$blocking" ]; then
    printf '{"blockedBy":%s,"blocking":%s}\n' "${blocked:-[]}" "${blocking:-[]}"
    return 0
  fi
  gh issue view "$n" --json blockedBy,blocking \
    --jq '{blockedBy:[.blockedBy[]|select(.state=="OPEN")|.number],blocking:[.blocking[]|select(.state=="OPEN")|.number]}' 2>/dev/null
}

# <blocked> をブロックする Issue として <blocker> を登録する。
link_blocked_by() {
  local blocked="$1" blocker="$2" id
  id=$(issue_id "$blocker")
  if [ -n "$id" ] && gh api -X POST "repos/${OWNER_REPO}/issues/${blocked}/dependencies/blocked_by" \
    -H "X-GitHub-Api-Version: 2022-11-28" -F "issue_id=${id}" >/dev/null 2>&1; then
    return 0
  fi
  gh issue edit "$blocked" --add-blocked-by "$blocker" >/dev/null 2>&1
}

cmd_add_blocked_by() {
  local n="$1"; shift
  local rc=0 m
  for m in "$@"; do link_blocked_by "$n" "$m" || rc=1; done
  return $rc
}

# blocking は blocked_by の逆向き。REST に blocking の POST は無いため、
# 相手側の blocked_by として登録する。
cmd_add_blocking() {
  local n="$1"; shift
  local rc=0 m
  for m in "$@"; do link_blocked_by "$m" "$n" || rc=1; done
  return $rc
}

cmd_add_sub_issue() {
  local parent="$1"; shift
  local rc=0 child id
  for child in "$@"; do
    id=$(issue_id "$child")
    if [ -n "$id" ] && gh api -X POST "repos/${OWNER_REPO}/issues/${parent}/sub_issues" \
      -H "X-GitHub-Api-Version: 2022-11-28" -F "sub_issue_id=${id}" >/dev/null 2>&1; then
      continue
    fi
    gh issue edit "$parent" --add-sub-issue "$child" >/dev/null 2>&1 || rc=1
  done
  return $rc
}

cmd_pr_mergeable() {
  local n="$1" v
  # REST の mergeable は算出中に null を返す。GraphQL の UNKNOWN と同じ扱いにする。
  if v=$(gh api "repos/${OWNER_REPO}/pulls/${n}" --jq '.mergeable' 2>/dev/null) && [ -n "$v" ]; then
    case "$v" in
      true) printf 'MERGEABLE\n'; return 0 ;;
      false) printf 'CONFLICTING\n'; return 0 ;;
      null) printf 'UNKNOWN\n'; return 0 ;;
    esac
  fi
  gh pr view "$n" --json mergeable -q .mergeable 2>/dev/null || printf 'UNKNOWN\n'
}

# カレントブランチに対応する Open PR の番号。MCP は PR 番号を要求するので代替できず、
# `gh pr view --json number` は GraphQL 経由でクラウドでは 403 になる。
# 同一 head ブランチに複数の Open PR がある場合は、誤って別PRを指すのを避けるため失敗として返す
# （呼び出し元は既存の空チェックで安全に停止する）。REST 呼び出し自体が失敗した場合のみ gh へフォールバックする。
cmd_pr_for_branch() {
  local branch="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}" out count
  [ -n "$branch" ] || return 1
  if out=$(gh api "repos/${OWNER_REPO}/pulls" -f state=open -f "head=${OWNER_REPO%%/*}:${branch}" \
    --jq '[.[].number]' 2>/dev/null); then
    count=$(printf '%s' "$out" | jq 'length' 2>/dev/null)
    [ "$count" = "1" ] || return 1
    printf '%s\n' "$(printf '%s' "$out" | jq '.[0]')"
    return 0
  fi
  gh pr view "$branch" --json number --jq '.number' 2>/dev/null
}

# REST の GET を全ページ取得する共通ヘルパー。単一の JSON 配列を stdout に返す
# （呼び出し側は `.[]` で列挙するだけでよい）。変換は必ずここで受け取った生JSONを
# ローカルの jq へパイプして行うこと（`gh api --jq` にロジックを載せると、gh をスタブへ
# 差し替えるユニットテストが変換結果を検証できなくなる）。
#
# `gh api --paginate` は使わない。GitHub が返す `Link: <...>; rel="next"` ヘッダは
# `repositories/{id}/issues?...&page=2` という数値IDパスで、クラウドセッションの
# プロキシはこれを "Numeric-ID repository paths ... are not supported through this
# proxy" として拒否する。`--paginate` はそのURLをそのまま辿るため、1ページ目は成功しても
# 2ページ目以降で必ず落ちる（実測）。`-f page=N` を明示して `repos/{owner}/{repo}/...`
# のパスのまま辿ればプロキシを通る（実測確認済み）ため、ここではその方式を使う。
rest_get_all_pages() {
  local path="$1"; shift
  local page=1 chunk n tmp
  tmp=$(mktemp) || return 1
  while :; do
    if ! chunk=$(gh api -X GET "$path" "$@" -f per_page=100 -f "page=${page}" 2>/dev/null); then
      rm -f "$tmp"; return 1
    fi
    # 配列でない応答（エラーオブジェクト等）が紛れ込んだ場合は部分的な結果を返さず失敗させる
    if ! n=$(printf '%s' "$chunk" | jq 'if type=="array" then length else error("not an array") end' 2>/dev/null); then
      rm -f "$tmp"; return 1
    fi
    printf '%s\n' "$chunk" >> "$tmp"
    [ "$n" -lt 100 ] && break
    page=$((page + 1))
    # 安全弁: 想定外に終わらないページングで無限ループしない
    [ "$page" -gt "${GH_COMPAT_MAX_PAGES:-20}" ] && break
  done
  jq -sc 'add // []' "$tmp"
  local rc=$?
  rm -f "$tmp"
  return $rc
}

# PR本文から closing keyword（close/closes/closed/fix/fixes/fixed/resolve/resolves/resolved、
# 大文字小文字区別なし）で参照されている Issue 番号を抽出し、{number,title} の配列(JSON文字列)にする。
# REST の PR には GraphQL の closingIssuesReferences に相当する資源が無いため、本文をパースして
# 導出する代替実装。GitHub の UI 上で手動リンクされた closing 参照（本文に書かれていないもの）は
# 本文からは分からないため拾えない — これは REST 化に伴う既知の制約。
extract_closing_issues() {
  local body="$1" nums num raw t results=()
  nums=$(printf '%s' "$body" | grep -ioE '\b(close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b[[:space:]]*:?[[:space:]]*#[0-9]+' \
    | grep -oE '[0-9]+' | sort -un)
  for num in $nums; do
    raw=$(gh api -X GET "repos/${OWNER_REPO}/issues/${num}" 2>/dev/null)
    if [ -n "$raw" ]; then
      # タイトルを引けない番号（削除済み・アクセス不可等）はその要素ごと落とす
      t=$(printf '%s' "$raw" | jq -c 'if .title then {number, title} else empty end' 2>/dev/null)
      [ -n "$t" ] && results+=("$t")
    fi
  done
  if [ "${#results[@]}" -eq 0 ]; then
    printf '[]'
  else
    printf '%s\n' "${results[@]}" | jq -sc '.'
  fi
}

# レビュースレッドの isResolved は REST に同等資源（スレッド）が無いため、GraphQL で
# best-effort に補完する。1発の first:100 のみでページングはしない
# （収集対象のレビュースレッドが100件を超えることは実運用上稀で、超過分は
# 既定値（null）のまま残しても後続の判定を大きくは損なわないため）。
# クラウドセッションでの403を含む失敗は完全に握りつぶし、呼び出し元は空マップとして扱う。
fetch_review_thread_resolved_map() {
  local n="$1" q result owner repo
  owner="${OWNER_REPO%%/*}"; repo="${OWNER_REPO#*/}"
  q='query($owner:String!,$repo:String!,$pr:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$pr){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{databaseId}}}}}}}'
  if result=$(gh api graphql -f query="$q" -F owner="$owner" -F repo="$repo" -F pr="$n" 2>/dev/null); then
    printf '%s' "$result" | jq -c '
      [.data.repository.pullRequest.reviewThreads.nodes[]
        | select(.comments.nodes[0].databaseId != null)
        | {(.comments.nodes[0].databaseId | tostring): .isResolved}]
      | add // {}
    ' 2>/dev/null
  fi
}

# コメントの isMinimized は REST に同等表現が無いため、GraphQL で best-effort に補完する
# （kind: "pr" | "issue"）。上限・失敗時の扱いは fetch_review_thread_resolved_map と同じ。
fetch_comments_minimized_map() {
  local kind="$1" n="$2" q result owner repo filter
  owner="${OWNER_REPO%%/*}"; repo="${OWNER_REPO#*/}"
  if [ "$kind" = "pr" ]; then
    q='query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){comments(first:100){nodes{databaseId isMinimized}}}}}'
    filter='[.data.repository.pullRequest.comments.nodes[] | select(.databaseId != null) | {(.databaseId | tostring): .isMinimized}] | add // {}'
  else
    q='query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){issue(number:$n){comments(first:100){nodes{databaseId isMinimized}}}}}'
    filter='[.data.repository.issue.comments.nodes[] | select(.databaseId != null) | {(.databaseId | tostring): .isMinimized}] | add // {}'
  fi
  if result=$(gh api graphql -f query="$q" -F owner="$owner" -F repo="$repo" -F n="$n" 2>/dev/null); then
    printf '%s' "$result" | jq -c "$filter" 2>/dev/null
  fi
}

cmd_list_issues_updated_since() {
  local since="$1" label="${2:-}" raw args=()
  args=(-f state=all -f "since=${since}")
  [ -n "$label" ] && args+=(-f "labels=${label}")
  if raw=$(rest_get_all_pages "repos/${OWNER_REPO}/issues" "${args[@]}"); then
    printf '%s' "$raw" | jq -r '[.[] | select(has("pull_request") | not) | .number] | sort | reverse | .[]'
    return 0
  fi
  local date="${since%%T*}" fargs=(--state all)
  [ -n "$label" ] && fargs+=(--label "$label")
  gh issue list "${fargs[@]}" --search "updated:>=${date}" --json number --jq '.[].number' --limit 200 2>/dev/null
}

cmd_list_prs_updated_since() {
  local since="$1" raw
  if raw=$(rest_get_all_pages "repos/${OWNER_REPO}/issues" -f state=all -f "since=${since}"); then
    printf '%s' "$raw" | jq -r '[.[] | select(has("pull_request")) | .number] | sort | reverse | .[]'
    return 0
  fi
  local date="${since%%T*}"
  gh pr list --state all --search "updated:>=${date}" --json number --jq '.[].number' --limit 100 2>/dev/null
}

cmd_list_prs_merged_since() {
  local since="$1" label="$2" raw
  # `since` は issues エンドポイントでは updated_at にしか効かないため、ここで得られるのは
  # 「since 以降にマージされた PR」の超集合（since より前にマージ済みだが最近更新された PR も含む）。
  # そのため merged_at 自体で改めてクライアント側フィルタしたうえで降順ソートする。
  if raw=$(rest_get_all_pages "repos/${OWNER_REPO}/issues" -f state=closed -f "labels=${label}" -f "since=${since}"); then
    printf '%s' "$raw" | jq -r --arg since "$since" '
      [.[] | select(has("pull_request") and (.pull_request.merged_at != null) and (.pull_request.merged_at >= $since))]
      | sort_by(.pull_request.merged_at) | reverse | .[].number
    '
    return 0
  fi
  local date="${since%%T*}"
  gh pr list --state merged --label "$label" --search "merged:>=${date}" --json number,mergedAt --jq 'sort_by(.mergedAt)|reverse|.[].number' --limit 200 2>/dev/null
}

cmd_pr_meta() {
  local n="$1" raw body closing
  raw=$(gh api -X GET "repos/${OWNER_REPO}/pulls/${n}" 2>/dev/null) || return 1
  body=$(printf '%s' "$raw" | jq -r '.body // ""')
  closing=$(extract_closing_issues "$body")
  printf '%s' "$raw" | jq -c --argjson closing "$closing" '
    {
      number: .number,
      title: .title,
      url: .html_url,
      body: (.body // ""),
      mergedAt: .merged_at,
      baseRefName: .base.ref,
      headRefName: .head.ref,
      author: {login: (.user.login // "unknown")},
      mergeCommit: (if .merge_commit_sha then {oid: .merge_commit_sha} else null end),
      labels: {nodes: (.labels | map({name: .name}))},
      closingIssuesReferences: {nodes: $closing}
    }
  '
}

cmd_pr_review_comments() {
  local n="$1" raw grouped map="{}" m
  raw=$(rest_get_all_pages "repos/${OWNER_REPO}/pulls/${n}/comments") || return 1
  # `(.in_reply_to_id // .id)` をスレッドIDとしてグルーピングする（REST にスレッド資源が無いため）。
  # `_root_id` は GraphQL 補完のための内部キーで、最終出力には含めない。
  grouped=$(printf '%s' "$raw" | jq -c '
    (. | group_by(.in_reply_to_id // .id)) as $groups |
    $groups[] |
    ((map(select(.in_reply_to_id == null)) | .[0]) // .[0]) as $root |
    {
      isResolved: null,
      isOutdated: ($root.line == null),
      path: $root.path,
      line: $root.line,
      _root_id: $root.id,
      comments: { nodes: (sort_by(.created_at) | map({author: {login: (.user.login // "unknown")}, body: .body, url: .html_url, createdAt: .created_at})) }
    }
  ')
  [ -n "$grouped" ] || return 0
  if [ -z "${GH_COMPAT_NO_GRAPHQL:-}" ]; then
    m=$(fetch_review_thread_resolved_map "$n")
    [ -n "$m" ] && map="$m"
  fi
  printf '%s\n' "$grouped" | jq -c --argjson map "$map" '
    . as $t |
    ($map[($t._root_id | tostring)]) as $r |
    {
      isResolved: (if $r == null then $t.isResolved else $r end),
      isOutdated: $t.isOutdated,
      path: $t.path,
      line: $t.line,
      comments: $t.comments
    }
  '
}

# PR会話コメント（issue-comments）と Issueコメントは REST では同一エンドポイントなので共有する。
# isMinimized の GraphQL 補完だけが kind（"pr" / "issue"）で分岐する。
comments_ndjson() {
  local kind="$1" n="$2" raw map="{}" m
  raw=$(rest_get_all_pages "repos/${OWNER_REPO}/issues/${n}/comments") || return 1
  if [ -z "${GH_COMPAT_NO_GRAPHQL:-}" ]; then
    m=$(fetch_comments_minimized_map "$kind" "$n")
    [ -n "$m" ] && map="$m"
  fi
  printf '%s' "$raw" | jq -c --argjson map "$map" '
    .[] |
    ($map[(.id | tostring)]) as $m |
    {
      author: {login: (.user.login // "unknown")},
      body: .body,
      url: .html_url,
      createdAt: .created_at,
      isMinimized: (if $m == null then false else $m end)
    }
  '
}

cmd_pr_conversation_comments() { comments_ndjson pr "$1"; }
cmd_issue_comments() { comments_ndjson issue "$1"; }

cmd_pr_files() {
  local n="$1" raw
  raw=$(rest_get_all_pages "repos/${OWNER_REPO}/pulls/${n}/files") || return 1
  printf '%s' "$raw" | jq -c '
    .[] |
    {
      path: .filename,
      additions: .additions,
      deletions: .deletions,
      changeType: (
        {"added":"ADDED","removed":"DELETED","modified":"MODIFIED","renamed":"RENAMED","copied":"COPIED","changed":"CHANGED","unchanged":"CHANGED"} as $map
        | ($map[.status] // (.status | ascii_upcase))
      )
    }
  '
}

cmd_issue_meta() {
  local n="$1" raw
  raw=$(gh api -X GET "repos/${OWNER_REPO}/issues/${n}" 2>/dev/null) || return 1
  # REST の state は小文字（open/closed）だが呼び出し元は GraphQL 語彙（OPEN/CLOSED）を前提にしている
  printf '%s' "$raw" | jq -c '
    {
      number: .number,
      title: .title,
      url: .html_url,
      state: (.state | ascii_upcase),
      body: (.body // ""),
      createdAt: .created_at,
      updatedAt: .updated_at,
      author: {login: (.user.login // "unknown")},
      labels: {nodes: (.labels | map({name: .name}))}
    }
  '
}

[ $# -ge 1 ] || usage
sub="$1"; shift

case "$sub" in
  parse-owner-repo) [ $# -eq 1 ] || usage; parse_owner_repo "$1" ;;
  default-branch)
    b=$(resolve_default_branch)
    [ -n "$b" ] || { echo "gh-compat: failed to resolve the default branch" >&2; exit 1; }
    printf '%s\n' "$b" ;;
  owner-repo)
    or=$(resolve_owner_repo)
    [ -n "$or" ] || { echo "gh-compat: failed to resolve <owner>/<repo>" >&2; exit 1; }
    printf '%s\n' "$or" ;;
  *)
    OWNER_REPO="${GH_COMPAT_OWNER_REPO:-$(resolve_owner_repo)}"
    [ -n "$OWNER_REPO" ] || { echo "gh-compat: failed to resolve <owner>/<repo>" >&2; exit 1; }
    case "$sub" in
      issue-parent)   [ $# -eq 1 ] || usage; cmd_issue_parent "$1" ;;
      issue-deps)     [ $# -eq 1 ] || usage; cmd_issue_deps "$1" ;;
      add-blocked-by) [ $# -ge 2 ] || usage; cmd_add_blocked_by "$@" ;;
      add-blocking)   [ $# -ge 2 ] || usage; cmd_add_blocking "$@" ;;
      add-sub-issue)  [ $# -ge 2 ] || usage; cmd_add_sub_issue "$@" ;;
      pr-mergeable)   [ $# -eq 1 ] || usage; cmd_pr_mergeable "$1" ;;
      pr-for-branch)  [ $# -le 1 ] || usage; cmd_pr_for_branch "${1:-}" ;;
      list-issues-updated-since)
        { [ $# -ge 1 ] && [ $# -le 2 ]; } || usage
        cmd_list_issues_updated_since "$@" ;;
      list-prs-updated-since) [ $# -eq 1 ] || usage; cmd_list_prs_updated_since "$1" ;;
      list-prs-merged-since)  [ $# -eq 2 ] || usage; cmd_list_prs_merged_since "$1" "$2" ;;
      pr-meta)                [ $# -eq 1 ] || usage; cmd_pr_meta "$1" ;;
      pr-review-comments)     [ $# -eq 1 ] || usage; cmd_pr_review_comments "$1" ;;
      pr-conversation-comments) [ $# -eq 1 ] || usage; cmd_pr_conversation_comments "$1" ;;
      pr-files)                [ $# -eq 1 ] || usage; cmd_pr_files "$1" ;;
      issue-meta)               [ $# -eq 1 ] || usage; cmd_issue_meta "$1" ;;
      issue-comments)           [ $# -eq 1 ] || usage; cmd_issue_comments "$1" ;;
      *) usage ;;
    esac ;;
esac
