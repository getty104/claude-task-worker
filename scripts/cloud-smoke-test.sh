#!/usr/bin/env bash
set -euo pipefail

# クラウド実行（workers.<name>.cloud: true）の実クラウドセッションによる
# smoke test を補助するスクリプト。docs/cloud-smoke-test.md から参照される。
#
# 自動判定できる範囲（事前条件・実行前後のスナップショット差分・ラベル遷移・
# closing参照PR候補の列挙）だけを担う。claude.ai上のセッション表示・最終報告
# コメント投稿・Slack通知の到達性は目視項目のため、このスクリプトでは判定しない
# （チェックリストとして印字するのみ）。クラウドセッションの作成・削除など
# 副作用を伴う操作は一切行わない。
#
# 使い方:
#   cloud-smoke-test.sh preflight [worker-name]
#   cloud-smoke-test.sh snapshot <before|after>
#   cloud-smoke-test.sh check-labels <issue-number>
#   cloud-smoke-test.sh check-pr <issue-number> <base-branch> <started-epoch-ms>
#   cloud-smoke-test.sh checklist
#   cloud-smoke-test.sh --help

SNAPSHOT_DIR="${CLOUD_SMOKE_TEST_SNAPSHOT_DIR:-/tmp/cloud-smoke-test}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-task-worker"
USER_CONFIG_PATH="$CONFIG_DIR/config.json"
REPO_CONFIG_PATH="claude-task-worker.json"
EXPECTED_CLAUDE_VERSION="2.1.247"
EXPECTED_HERDR_VERSION="0.8.2"

ok_count=0
ng_count=0

report() {
  # report <OK|NG> <message>
  local status="$1"
  local message="$2"
  if [ "$status" = "OK" ]; then
    ok_count=$((ok_count + 1))
  else
    ng_count=$((ng_count + 1))
  fi
  printf '[%s] %s\n' "$status" "$message"
}

usage() {
  sed -n '3,20p' "$0" | sed 's/^# \{0,1\}//'
}

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command not found: $cmd" >&2
    exit 1
  fi
}

cmd_preflight() {
  local worker_name="${1:-}"

  require_cmd gh
  require_cmd jq

  # 1. mode: "herdr"
  if [ -f "$USER_CONFIG_PATH" ]; then
    local mode
    mode="$(jq -r '.mode // "default"' "$USER_CONFIG_PATH" 2>/dev/null || echo "default")"
    if [ "$mode" = "herdr" ]; then
      report OK "mode: herdr ($USER_CONFIG_PATH)"
    else
      report NG "mode is \"$mode\", expected \"herdr\" ($USER_CONFIG_PATH)"
    fi
  else
    report NG "config.json not found: $USER_CONFIG_PATH"
  fi

  # 2. workers.<name>.cloud: true
  if [ -n "$worker_name" ]; then
    if [ -f "$REPO_CONFIG_PATH" ]; then
      local cloud
      cloud="$(jq -r --arg w "$worker_name" '.workers[$w].cloud // false' "$REPO_CONFIG_PATH" 2>/dev/null || echo "false")"
      if [ "$cloud" = "true" ]; then
        report OK "workers.$worker_name.cloud: true ($REPO_CONFIG_PATH)"
      else
        report NG "workers.$worker_name.cloud is not true ($REPO_CONFIG_PATH)"
      fi
    else
      report NG "$REPO_CONFIG_PATH not found"
    fi
  else
    report NG "worker-name not given; skipped workers.<name>.cloud check"
  fi

  # 3. claude auth status --json
  if command -v claude >/dev/null 2>&1; then
    local auth_json loggedIn authMethod apiProvider apiKeySource
    auth_json="$(claude auth status --json 2>/dev/null || true)"
    if [ -n "$auth_json" ] && echo "$auth_json" | jq -e . >/dev/null 2>&1; then
      loggedIn="$(echo "$auth_json" | jq -r '.loggedIn // false')"
      authMethod="$(echo "$auth_json" | jq -r '.authMethod // ""')"
      apiProvider="$(echo "$auth_json" | jq -r '.apiProvider // ""')"
      apiKeySource="$(echo "$auth_json" | jq -r '.apiKeySource // ""')"
      if [ "$loggedIn" = "true" ] && [ "$apiProvider" = "firstParty" ] && [ "$authMethod" = "claude.ai" ] \
        && [ -z "$apiKeySource" ] && [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
        report OK "claude auth status: signed in (claude.ai / firstParty)"
      else
        report NG "claude auth status does not satisfy cloud prerequisites (loggedIn=$loggedIn authMethod=$authMethod apiProvider=$apiProvider apiKeySource=$apiKeySource ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-unset})"
      fi
    else
      report NG "claude auth status --json did not return valid JSON"
    fi
  else
    report NG "claude command not found"
  fi

  # 4. herdr reachability
  if command -v herdr >/dev/null 2>&1; then
    local herdr_version
    herdr_version="$(herdr --version 2>/dev/null || echo "")"
    if [ -n "$herdr_version" ]; then
      report OK "herdr reachable: $herdr_version"
    else
      report NG "herdr --version returned no output"
    fi
  else
    report NG "herdr command not found"
  fi

  # version staleness note (informational, not counted OK/NG)
  if command -v claude >/dev/null 2>&1; then
    local claude_version
    claude_version="$(claude --version 2>/dev/null || echo "")"
    echo "[INFO] claude --version: $claude_version (docs/cloud-smoke-test.md was last measured against $EXPECTED_CLAUDE_VERSION; re-measure S-1/S-2 if newer)"
  fi
  if command -v herdr >/dev/null 2>&1; then
    echo "[INFO] herdr --version: $(herdr --version 2>/dev/null || echo unknown) (docs/cloud-smoke-test.md was last measured against $EXPECTED_HERDR_VERSION; re-measure S-1/S-2 if newer)"
  fi

  echo ""
  echo "preflight summary: OK=$ok_count NG=$ng_count"
}

cmd_snapshot() {
  local phase="${1:?usage: cloud-smoke-test.sh snapshot <before|after>}"
  mkdir -p "$SNAPSHOT_DIR"
  local worktrees_file="$SNAPSHOT_DIR/${phase}.worktrees.txt"
  local branches_file="$SNAPSHOT_DIR/${phase}.branches.txt"
  git worktree list >"$worktrees_file"
  git branch --list >"$branches_file"
  echo "snapshot ($phase) written to $worktrees_file / $branches_file"

  if [ "$phase" = "after" ]; then
    local before_worktrees="$SNAPSHOT_DIR/before.worktrees.txt"
    local before_branches="$SNAPSHOT_DIR/before.branches.txt"
    if [ -f "$before_worktrees" ] && [ -f "$before_branches" ]; then
      echo ""
      echo "--- git worktree list diff (before -> after) ---"
      if diff "$before_worktrees" "$worktrees_file"; then
        report OK "no worktree diff"
      else
        report NG "worktree diff detected (see above)"
      fi
      echo "--- git branch --list diff (before -> after) ---"
      if diff "$before_branches" "$branches_file"; then
        report OK "no local branch diff"
      else
        report NG "local branch diff detected (see above)"
      fi
      echo ""
      echo "snapshot summary: OK=$ok_count NG=$ng_count"
    else
      echo "[INFO] no 'before' snapshot found in $SNAPSHOT_DIR; run 'snapshot before' first to get a diff"
    fi
  fi
}

cmd_check_labels() {
  local issue_number="${1:?usage: cloud-smoke-test.sh check-labels <issue-number>}"
  require_cmd gh
  require_cmd jq
  # 取得失敗を「ラベルが無い」と取り違えると cc-in-progress 除去を誤ってOKと報告するため、
  # 失敗はここで打ち切る。
  local labels
  if ! labels="$(gh issue view "$issue_number" --json labels --jq '.labels[].name')"; then
    report NG "failed to fetch labels for #$issue_number"
    echo ""
    echo "check-labels summary: OK=$ok_count NG=$ng_count"
    return
  fi
  echo "labels on #$issue_number:"
  echo "$labels" | while IFS= read -r label; do echo "  - $label"; done
  echo ""
  if echo "$labels" | grep -qx "cc-in-progress"; then
    report NG "cc-in-progress is still present on #$issue_number"
  else
    report OK "cc-in-progress has been removed from #$issue_number"
  fi
  if echo "$labels" | grep -qx "cc-cloud-done"; then
    report NG "cc-cloud-done is still present on #$issue_number (worker may not have detected completion yet, or removal failed)"
  else
    report OK "cc-cloud-done has been removed from #$issue_number"
  fi
  if echo "$labels" | grep -qx "cc-pr-created"; then
    report OK "cc-pr-created is present on #$issue_number"
  elif echo "$labels" | grep -qx "cc-need-human-check"; then
    report OK "cc-need-human-check is present on #$issue_number (PR not found; check manually)"
  else
    report NG "neither cc-pr-created nor cc-need-human-check is present on #$issue_number"
  fi
  echo ""
  echo "check-labels summary: OK=$ok_count NG=$ng_count"
}

cmd_check_pr() {
  local issue_number="${1:?usage: cloud-smoke-test.sh check-pr <issue-number> <base-branch> <started-epoch-ms>}"
  local base_branch="${2:?usage: cloud-smoke-test.sh check-pr <issue-number> <base-branch> <started-epoch-ms>}"
  local started_ms="${3:?usage: cloud-smoke-test.sh check-pr <issue-number> <base-branch> <started-epoch-ms>}"
  require_cmd gh
  require_cmd jq

  local owner_repo
  owner_repo="$(gh repo view --json nameWithOwner --jq '.nameWithOwner')"

  # selectOwnedClosingPr() (src/workers/exec-issue.ts) と同じ判定材料で候補を列挙する:
  # Issueをclosing参照、state MERGED/OPEN、baseRefNameが一致、createdAtがタスク起動時刻以降・現在時刻以前。
  # first は listPrsClosingIssue() (src/gh.ts) と同じ 10 に揃える（広く取ると実装が見ないPRを拾って false OK になる）。
  local now_ms
  now_ms="$(( $(date +%s) * 1000 ))"

  local candidates
  # shellcheck disable=SC2016 # GraphQL uses $vars bound via -f/-F, not shell expansion.
  candidates="$(gh api graphql -f query='
query($owner: String!, $repo: String!, $issue: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issue) {
      closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
        nodes {
          number
          state
          baseRefName
          headRefName
          createdAt
          url
        }
      }
    }
  }
}' -f owner="$(echo "$owner_repo" | cut -d/ -f1)" -f repo="$(echo "$owner_repo" | cut -d/ -f2)" -F issue="$issue_number" \
    --jq '.data.repository.issue.closedByPullRequestsReferences.nodes')"

  echo "closing-referenced PR candidates for #$issue_number:"
  echo "$candidates" | jq -r '.[] | "  - #\(.number) state=\(.state) base=\(.baseRefName) createdAt=\(.createdAt) \(.url)"'
  echo ""

  local matched
  matched="$(echo "$candidates" | jq --arg base "$base_branch" --argjson started "$started_ms" --argjson now "$now_ms" '
    [.[] | select((.state == "MERGED" or .state == "OPEN") and .baseRefName == $base)
         | select((.createdAt | fromdateiso8601 * 1000) as $created | $created >= $started and $created <= $now)]')"

  local matched_count
  matched_count="$(echo "$matched" | jq 'length')"
  if [ "$matched_count" -ge 1 ]; then
    report OK "found $matched_count matching PR(s) (base=$base_branch, $started_ms <= createdAt <= $now_ms)"
    echo "$matched" | jq -r '.[] | "  - #\(.number) \(.url)"'
  else
    report NG "no PR matches base=$base_branch and $started_ms <= createdAt <= $now_ms"
  fi
  echo ""
  echo "check-pr summary: OK=$ok_count NG=$ng_count"
}

cmd_checklist() {
  cat <<'EOF'
人の目視が必要な項目（このスクリプトでは自動判定しない。docs/cloud-smoke-test.md 参照）:
  [ ] claude.ai/code 上でクラウドセッションが作成され、対象タスクの内容で走っている（基準2）
  [ ] クラウドセッションが最終報告コメント（見出し: ## claude-task-worker 実行結果）を投稿した（基準7）
  [ ] クラウドセッションが cc-cloud-done ラベルを付与した（基準7）
  [ ] ワーカーが cc-cloud-done を検知し、ラベルを除去した（基準7。check-labels で確認）
  [ ] Slack に完了/失敗通知が届き、本文に最終報告コメントの内容と https://claude.ai/code/<id> が載っている（基準5）
  [ ] クラウドセッションを claude.ai/code の一覧から削除した（後片付け）
  [ ] テスト用Issue/PRをクローズした（後片付け）
EOF
}

main() {
  local sub="${1:-}"
  case "$sub" in
    preflight)
      shift || true
      cmd_preflight "$@"
      ;;
    snapshot)
      shift || true
      cmd_snapshot "$@"
      ;;
    check-labels)
      shift || true
      cmd_check_labels "$@"
      ;;
    check-pr)
      shift || true
      cmd_check_pr "$@"
      ;;
    checklist)
      cmd_checklist
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      echo "Error: unknown subcommand: $sub" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
if [ "$ng_count" -gt 0 ]; then
  exit 1
fi
