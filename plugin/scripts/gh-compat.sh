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
  add-label <number> <label>...      Issue/PR にラベルを**追加**する（既存ラベルは維持）
  remove-label <number> <label>      Issue/PR からラベルを1つ外す（他のラベルは維持）
  close-issue <number> [reason]      Issue をクローズする（reason は completed / not_planned。既定 completed）
  add-assignee <number> <login>...   Issue/PR に Assignee を**追加**する（@me はログインユーザー）
  create-issue --title T --body-file F [--label L]... [--assignee A]...
                                     Issue を作成し URL を出力する（ラベル・Assignee も同じ1回のREST呼び出しで付く）
  create-pr --title T --body-file F --base B [--head H] [--draft] [--label L]... [--assignee A]...
                                     PR を作成し URL を出力する（続けてラベル・Assignee を付ける）
USAGE
  exit 64
}

# リモートURL → <owner>/<repo>。SSH（git@host:owner/repo.git）と
# HTTPS（https://host/owner/repo.git）の両方、末尾の .git 有無に対応する。
parse_owner_repo() {
  printf '%s\n' "$1" | sed -E 's#\.git$##; s#^git@[^:]+:##; s#^ssh://[^/]+/##; s#^https?://[^/]+/##'
}

resolve_default_branch() {
  local b or
  b=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')
  if [ -n "$b" ]; then printf '%s\n' "$b"; return 0; fi
  # クラウド VM の作業ツリーには refs/remotes/origin/HEAD が無く、フォールバックの
  # `gh repo view --json` も GraphQL ゲートで 403 になるため、間に REST を挟む。
  # これが無いとクラウドでは default-branch が必ず失敗し、`exec-issue` / `fix-review-point`
  # のフェーズ0が「デフォルトブランチ名の取得失敗＝中断」の fail-safe で常に中断する（#353）。
  # `default-branch` は OWNER_REPO を設定する `*)` 分岐より手前で処理されるので、
  # ここで解決する（GH_COMPAT_OWNER_REPO による上書きも同じ意味で効かせる）。
  or="${GH_COMPAT_OWNER_REPO:-$(resolve_owner_repo)}"
  if [ -n "$or" ]; then
    b=$(gh api "repos/${or}" --jq '.default_branch // empty' 2>/dev/null)
    if [ -n "$b" ]; then printf '%s\n' "$b"; return 0; fi
  fi
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

# ラベルの追加・削除。MCP の `issue_write` / `pull_request_write`（method: update）は
# labels を**全置換**するため、「1つ足す」つもりの呼び出しで他のラベルが黙って消える
# （実測: cc-cloud-done を付けたセッションが cc-triage-scope と cc-in-progress を巻き添えで
# 落とし、記録PRが誰にも拾われないまま10時間放置された）。REST の labels エンドポイントは
# 追加・単体削除の専用APIなので置換事故が起きない。`gh issue edit --add-label` は GraphQL
# 経由でクラウドでは 403 になるため、フォールバックに留める。
# Issue と PR は番号空間を共有するので、PR にもそのまま issues/<n>/labels が使える。
cmd_add_label() {
  local n="$1"; shift
  local rc=0 l args=()
  for l in "$@"; do args+=(-f "labels[]=${l}"); done
  if gh api -X POST "repos/${OWNER_REPO}/issues/${n}/labels" \
    -H "X-GitHub-Api-Version: 2022-11-28" "${args[@]}" >/dev/null 2>&1; then
    return 0
  fi
  for l in "$@"; do gh issue edit "$n" --add-label "$l" >/dev/null 2>&1 || rc=1; done
  return $rc
}

cmd_remove_label() {
  local n="$1" l="$2"
  # 付いていないラベルの削除は REST が 404 を返す。冪等にしたいので gh 側も試して終わる。
  if gh api -X DELETE "repos/${OWNER_REPO}/issues/${n}/labels/${l}" \
    -H "X-GitHub-Api-Version: 2022-11-28" >/dev/null 2>&1; then
    return 0
  fi
  gh issue edit "$n" --remove-label "$l" >/dev/null 2>&1
}

# Issue のクローズ。`gh issue close` は GraphQL の closeIssue mutation を叩くため
# （gh 2.98.0 で `GH_DEBUG=api` により確認）、クラウドセッションのゲートに掛かりうる。
# Epic フローではサブIssueを閉じる経路がこのコマンドしか無く（base が非デフォルトブランチの
# PR は GitHub が自動クローズしない）、ここが落ちると Issue が open のまま取り残される。
# REST の issues エンドポイントは state / state_reason をそのまま受けるので置き換えられる。
# 既にクローズ済みの Issue に対しても 200 を返すため冪等。
cmd_close_issue() {
  local n="$1" reason="${2:-completed}"
  case "$reason" in
    completed|not_planned) : ;;
    *) echo "gh-compat: close-issue: reason must be completed or not_planned" >&2; return 64 ;;
  esac
  if gh api -X PATCH "repos/${OWNER_REPO}/issues/${n}" \
    -H "X-GitHub-Api-Version: 2022-11-28" -f state=closed -f "state_reason=${reason}" >/dev/null 2>&1; then
    return 0
  fi
  # gh 側の --reason はハイフン区切り（not planned は "not planned"）
  if [ "$reason" = "not_planned" ]; then
    gh issue close "$n" --reason "not planned" >/dev/null 2>&1
  else
    gh issue close "$n" --reason completed >/dev/null 2>&1
  fi
}

# @me → ログインユーザー名。REST の assignees はログイン名しか受け付けない。
resolve_login() {
  if [ "$1" = "@me" ]; then gh api user --jq .login 2>/dev/null; else printf '%s\n' "$1"; fi
}

# Assignee の追加。`gh issue edit --add-assignee` は GraphQL 経由でクラウドでは 403 になり、
# MCP にも追加専用の手段が無い（`issue_write` の update は assignees を全置換する）。
cmd_add_assignee() {
  local n="$1"; shift
  local rc=0 a login args=()
  for a in "$@"; do
    login=$(resolve_login "$a")
    if [ -n "$login" ]; then args+=(-f "assignees[]=${login}"); else rc=1; fi
  done
  if [ ${#args[@]} -gt 0 ] && gh api -X POST "repos/${OWNER_REPO}/issues/${n}/assignees" \
    -H "X-GitHub-Api-Version: 2022-11-28" "${args[@]}" >/dev/null 2>&1; then
    return $rc
  fi
  rc=0
  for a in "$@"; do gh issue edit "$n" --add-assignee "$a" >/dev/null 2>&1 || rc=1; done
  return $rc
}

# 引数を JSON の文字列配列にする。bash 3.2（macOS 既定）は set -u 下で空配列の "${a[@]}" を
# unbound 扱いするため、呼び出し側は ${a[@]+"${a[@]}"} で展開して渡す。
json_array() { jq -cn '$ARGS.positional' --args "$@"; }

# create-issue / create-pr の引数。gh issue create / gh pr create と同じ綴りにして、
# スキル本文の置き換えを機械的にする。
parse_create_opts() {
  TITLE="" BODY_FILE="" BASE="" HEAD="" DRAFT=false LABELS=() ASSIGNEES=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --draft) DRAFT=true; shift; continue ;;
      --title|--body-file|--base|--head|--label|--assignee) [ $# -ge 2 ] || return 64 ;;
      *) echo "gh-compat: unknown option: $1" >&2; return 64 ;;
    esac
    case "$1" in
      --title) TITLE="$2" ;;
      --body-file) BODY_FILE="$2" ;;
      --base) BASE="$2" ;;
      --head) HEAD="$2" ;;
      --label) LABELS+=("$2") ;;
      --assignee) ASSIGNEES+=("$2") ;;
    esac
    shift 2
  done
  [ -n "$TITLE" ] && [ -n "$BODY_FILE" ] || { echo "gh-compat: --title and --body-file are required" >&2; return 64; }
  [ "$BODY_FILE" = "-" ] && BODY_FILE=/dev/stdin
  return 0
}

# Issue の作成。`gh issue create` は GraphQL の createIssue mutation でクラウドでは 403 になり、
# 代わりに使われていた MCP の `issue_write`（create）は labels / assignees を渡し忘れると
# 黙って欠落する（cc-triage-scope と Assignee の無い Issue はワーカーに拾われない）。
# REST の POST issues は labels / assignees を同じ呼び出しで受けるので、作成と付与が分かれない。
# 作成は gh へフォールバックしない: 応答喪失時に二重起票しうるうえ、REST が通らない環境では
# gh（GraphQL）も通らない。
# Assignee の解決失敗は cmd_create_pr と同じ契約（ベストエフォート作成＋非0終了）に揃える:
# 解決できた login だけで作成を進め、1件でも解決に失敗していれば URL を出力したうえで非0で返す
# （Issue を1件も作らない方が「@me 解決の一時失敗で起票が止まる」事故として重いため）。
cmd_create_issue() {
  parse_create_opts "$@" || return 64
  local a login logins=() rc=0 url
  for a in ${ASSIGNEES[@]+"${ASSIGNEES[@]}"}; do
    login=$(resolve_login "$a")
    if [ -n "$login" ]; then logins+=("$login"); else rc=1; fi
  done
  url=$(jq -cn --arg title "$TITLE" --rawfile body "$BODY_FILE" \
    --argjson labels "$(json_array ${LABELS[@]+"${LABELS[@]}"})" \
    --argjson assignees "$(json_array ${logins[@]+"${logins[@]}"})" \
    '{title: $title, body: $body, labels: $labels, assignees: $assignees}' |
    gh api -X POST "repos/${OWNER_REPO}/issues" -H "X-GitHub-Api-Version: 2022-11-28" --input - --jq .html_url) ||
    { echo "gh-compat: create-issue: failed to create the issue" >&2; return 1; }
  printf '%s\n' "$url"
  if [ "$rc" -ne 0 ]; then
    echo "gh-compat: create-issue: ${url} was created but resolving assignees failed" >&2
  fi
  return $rc
}

# PR の作成。`gh pr create` は GraphQL 経由でクラウドでは 403 になり、MCP の
# `create_pull_request` は labels / assignees の引数自体を持たない（付与が別手順になり欠落する）。
# REST の POST pulls も labels / assignees を受けないため、作成直後に同じスクリプト内で付ける。
# 付与に失敗しても PR は作成済みなので、URL を出力したうえで非0で終える（呼び出し元は
# 作り直さず add-label / add-assignee だけを再実行する）。
cmd_create_pr() {
  parse_create_opts "$@" || return 64
  local out url n rc=0
  [ -n "$HEAD" ] || HEAD=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  [ -n "$BASE" ] || BASE=$(resolve_default_branch)
  [ -n "$HEAD" ] && [ "$HEAD" != "HEAD" ] && [ -n "$BASE" ] ||
    { echo "gh-compat: create-pr: failed to resolve --head / --base" >&2; return 1; }
  out=$(jq -cn --arg title "$TITLE" --rawfile body "$BODY_FILE" --arg head "$HEAD" --arg base "$BASE" \
    --argjson draft "$DRAFT" '{title: $title, body: $body, head: $head, base: $base, draft: $draft}' |
    gh api -X POST "repos/${OWNER_REPO}/pulls" -H "X-GitHub-Api-Version: 2022-11-28" --input - \
      --jq '"\(.html_url) \(.number)"') || { echo "gh-compat: create-pr: failed to create the pull request" >&2; return 1; }
  url="${out% *}" n="${out##* }"
  printf '%s\n' "$url"
  if [ ${#LABELS[@]} -gt 0 ] && ! cmd_add_label "$n" "${LABELS[@]}"; then
    echo "gh-compat: create-pr: ${url} was created but adding labels failed" >&2; rc=1
  fi
  if [ ${#ASSIGNEES[@]} -gt 0 ] && ! cmd_add_assignee "$n" "${ASSIGNEES[@]}"; then
    echo "gh-compat: create-pr: ${url} was created but adding assignees failed" >&2; rc=1
  fi
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
      add-label)      [ $# -ge 2 ] || usage; cmd_add_label "$@" ;;
      remove-label)   [ $# -eq 2 ] || usage; cmd_remove_label "$1" "$2" ;;
      close-issue)    [ $# -ge 1 ] && [ $# -le 2 ] || usage; cmd_close_issue "$1" "${2:-completed}" ;;
      add-assignee)   [ $# -ge 2 ] || usage; cmd_add_assignee "$@" ;;
      create-issue)   cmd_create_issue "$@" ;;
      create-pr)      cmd_create_pr "$@" ;;
      *) usage ;;
    esac ;;
esac
