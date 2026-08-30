#!/usr/bin/env bash
set -euo pipefail

# 直近N日に更新された cc-triage-scope / cc-pr-created ラベル付き Issue の
# description と全コメントを収集する。
#
# 使い方:
#   fetch-recent-requirement-issues.sh [日数] [出力先パス]
#
# 出力:
#   stdout には「インデックスJSON」だけを出す（Issue本文は含めない）。
#   本文・コメントを含む完全なJSONは出力先パス（既定: mktemp）へ書き出し、
#   インデックスの output_file に絶対パスを載せる。
#   Issue本文＋全コメントはそのまま読むとコンテキストを食い潰すため、
#   呼び出し側が jq で必要な Issue だけを取り出せるようにしている。
#
# このスクリプトは GitHub MCP 利用不可時のフォールバック経路。GraphQL 直叩きはクラウド
# セッションのプロキシで403になるため、取得は `gh-compat.sh` の REST サブコマンド経由で行う。
# 詳細は plugin/references/github-access.md を参照。

DAYS="${1:-1}"
OUT_FILE="${2:-}"
JOB_LIMIT="${JOB_LIMIT:-10}"
MAX_ISSUES="${MAX_ISSUES:-80}"
LABELS="${LABELS:-cc-triage-scope cc-pr-created}"

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
  OUT_FILE="$(mktemp -t requirement-issues.XXXXXX)"
fi
# 相対パスで渡されても呼び出し側が確実に開けるよう絶対パスへ正規化する
OUT_DIR="$(cd "$(dirname "$OUT_FILE")" && pwd)"
OUT_FILE="${OUT_DIR}/$(basename "$OUT_FILE")"

# ラベルごとに検索して番号を和集合にする（gh の --label は複数指定するとAND条件になるため、
# gh-compat.sh 経由でも同じ理由でラベルごとに引く）。
# 認証失敗（クラウドセッションでの403等）を「該当0件」として握りつぶさないよう、
# 一覧取得の失敗はここで即座にエラー終了させる（呼び出し元が issue_count:0 と誤認しないため）。
# since には SINCE_DATE（その日の 00:00:00Z）を渡す。元の `updated:>=${SINCE_DATE}` と
# 意味を揃えるためで、SINCE_ISO（現在時刻からN日前の時刻）を渡すと対象がより狭くなり、
# 移行前後で出力が変わってしまう。
: > "$TEMP_DIR/numbers.txt"
for LABEL in $LABELS; do
  if ! bash "$(dirname "$0")/../../../scripts/gh-compat.sh" list-issues-updated-since \
    "${SINCE_DATE}T00:00:00Z" "$LABEL" >> "$TEMP_DIR/numbers.txt"; then
    echo "error: gh-compat.sh list-issues-updated-since failed for label '${LABEL}' (auth/network failure, not zero results)" >&2
    exit 1
  fi
done

ISSUE_NUMBERS=$(sort -rn -u "$TEMP_DIR/numbers.txt" | head -n "$MAX_ISSUES")

if [ -z "$ISSUE_NUMBERS" ]; then
  jq -n --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" --arg out "$OUT_FILE" \
    '{period_since:$since, repo:$repo, issue_count:0, output_file:$out, issues:[]}' \
    | tee "$OUT_FILE"
  exit 0
fi

GH_COMPAT="$(dirname "$0")/../../../scripts/gh-compat.sh"

fetch_issue() {
  local issue="$1" out_json="$2"

  local work_dir="$TEMP_DIR/issue_${issue}"
  mkdir -p "$work_dir"
  local meta_file="$work_dir/meta.json"
  local comments_ndjson="$work_dir/comments.ndjson"

  bash "$GH_COMPAT" issue-meta "$issue" > "$meta_file"
  bash "$GH_COMPAT" issue-comments "$issue" > "$comments_ndjson"

  # isMinimized == false フィルタ: REST に isMinimized 相当のフィールドが無いため、
  # GraphQL が使えない環境（クラウド）では非表示（minimized）コメントを除外できず、
  # そのまま取り込まれる（除外できる情報を落とすより取り込む側＝安全側に倒している）。
  # ローカルでは gh-compat.sh が GraphQL で補完した値を返すため、このフィルタは従来どおり効く。
  jq -n \
    --slurpfile meta "$meta_file" \
    --slurpfile comments <(jq -s '.' "$comments_ndjson") \
    '
      ($meta[0]) as $i |
      ($comments[0]) as $c | {
        issue_number: $i.number,
        issue_title: $i.title,
        issue_url: $i.url,
        issue_state: $i.state,
        issue_author: ($i.author.login // "unknown"),
        labels: [$i.labels.nodes[].name],
        created_at: $i.createdAt,
        updated_at: $i.updatedAt,
        body: ($i.body // ""),
        comments: [
          $c[] | select(.isMinimized == false) |
          { author: (.author.login // "unknown"), body: .body, url: .url, created_at: .createdAt }
        ]
      }
    ' > "$out_json"
}

PIDS=()
PIDS_ISSUE=()
FAILED_ISSUES=()

wait_batch() {
  local i
  for i in "${!PIDS[@]}"; do
    if ! wait "${PIDS[$i]}"; then
      echo "warning: failed to fetch issue #${PIDS_ISSUE[$i]}" >&2
      FAILED_ISSUES+=("${PIDS_ISSUE[$i]}")
    fi
  done
  PIDS=()
  PIDS_ISSUE=()
}

for ISSUE in $ISSUE_NUMBERS; do
  fetch_issue "$ISSUE" "$TEMP_DIR/issue_${ISSUE}.json" &
  PIDS+=("$!")
  PIDS_ISSUE+=("$ISSUE")

  if [ "${#PIDS[@]}" -ge "$JOB_LIMIT" ]; then
    wait_batch
  fi
done
wait_batch

if [ "${#FAILED_ISSUES[@]}" -gt 0 ]; then
  echo "warning: ${#FAILED_ISSUES[@]} issue(s) failed to fetch and will be omitted: ${FAILED_ISSUES[*]}" >&2
fi

shopt -s nullglob
FETCHED_FILES=("$TEMP_DIR"/issue_*.json)
shopt -u nullglob

if [ "${#FETCHED_FILES[@]}" -eq 0 ]; then
  # 対象Issueはあったが全件取得に失敗したケース。空振りと区別できるよう警告を残す
  echo "warning: all issue fetches failed; returning empty result" >&2
  jq -n --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" --arg out "$OUT_FILE" \
    '{period_since:$since, repo:$repo, issue_count:0, output_file:$out, issues:[]}' \
    | tee "$OUT_FILE"
  exit 0
fi

# 完全版（本文・コメント入り）を出力先へ書き出す
jq -s --arg since "$SINCE_ISO" --arg repo "$OWNER_REPO" --arg out "$OUT_FILE" '
  {
    period_since: $since,
    repo: $repo,
    issue_count: (. | length),
    output_file: $out,
    issues: (. | sort_by(-.issue_number))
  }
' "$TEMP_DIR"/issue_*.json > "$OUT_FILE"

# stdout にはインデックスだけ返す（本文はコンテキストを食い潰すため載せない）
jq '
  {
    period_since, repo, issue_count, output_file,
    issues: [
      .issues[] | {
        issue_number, issue_title, issue_state, labels, updated_at,
        comment_count: (.comments | length),
        body_chars: (.body | length),
        comment_chars: ([.comments[].body | length] | add // 0)
      }
    ]
  }
' "$OUT_FILE"
