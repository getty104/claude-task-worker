#!/bin/bash

# SessionStart: クラウドセッションで Playwright MCP の CDP 接続先（http://localhost:9222）を用意する。
#
# plugin/.mcp.json の Playwright MCP は `--cdp-endpoint http://localhost:9222` で起動済みの Chrome に
# 接続し、自分ではブラウザを起動しない。ローカルではユーザーがリモートデバッグ付きの Chrome を
# 起動しておく前提だが、クラウド VM には起動する人がいないため、ここで headless の Chrome を立てる。
# 環境キャッシュに残らないプロセスなので、セットアップスクリプト（cloud-setup）ではなく毎セッション
# 走るこのフックに置く。ローカルセッションでは何もしない（ユーザーの Chrome を勝手に起動しない）。

PORT=9222

# クラウド判定は setup-codegraph.sh と同じ。
if [ -z "$CLAUDE_CODE_REMOTE" ] &&
    [ -z "$CLAUDE_CODE_CLOUD_SESSION_ID" ] &&
    [ -z "$CLAUDE_CODE_REMOTE_SESSION_ID" ] &&
    [ -z "$CLAUDE_CODE_ENVIRONMENT_KIND" ]; then
    exit 0
fi

# 既に接続先があれば何もしない（resume のたびに二重起動しないため）。
curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && exit 0

CHROME=""
for c in google-chrome google-chrome-stable /opt/google/chrome/chrome; do
    if command -v "$c" >/dev/null 2>&1; then
        CHROME="$c"
        break
    fi
done
# `claude-task-worker install` が走っていなければ Chrome が無い。
[ -n "$CHROME" ] || exit 0

# cwd をリポジトリ外にするのは、Stop フック（stop-servers.mjs）が worktree 配下を cwd に持つ
# プロセスを停止するため。セッションをまたいで使う Chrome を巻き込ませない。
cd / || exit 0
nohup "$CHROME" --headless=new --no-sandbox --no-first-run --no-default-browser-check \
    --remote-debugging-port="$PORT" --user-data-dir="${TMPDIR:-/tmp}/claude-task-worker-chrome-cdp" \
    about:blank >/dev/null 2>&1 &

# MCP の初回接続に間に合うよう、接続先が立つまで最大10秒待つ。
i=0
while [ "$i" -lt 20 ]; do
    curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1 && exit 0
    sleep 0.5
    i=$((i + 1))
done
echo "Chrome did not open the CDP endpoint on port ${PORT}. Playwright MCP browser tools may fail."
exit 0
