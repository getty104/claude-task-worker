#!/bin/bash

# SessionStart: クラウドセッション（Claude Code on the web）で CodeGraph のインデックスを構築する。
#
# クラウド VM はリポジトリの fresh clone から始まるため `.codegraph/` を持たない。
# セットアップスクリプト（`claude-task-worker cloud-setup`）で作る手もあるが、同スクリプトは
# 環境キャッシュが無いときしか走らず、キャッシュはリポジトリを問わず再利用されるため、
# 毎セッションのインデックスを保証できない。SessionStart フックは resume を含む毎セッションで
# 走るのでここに置く。
#
# **ローカルセッションでは何もしない**。ローカルでインデックスを作るかはユーザーの選択であり、
# プラグインを有効にしただけで開いたリポジトリすべてに `.codegraph/` を作るべきではない
# （worktree での構築は setup-worktree.sh が「ルートがインデックス済み＝選択済み」を条件に行う）。
# クラウドは claude-task-worker のワーカーがタスクを走らせる場所なので、この判断は不要。

set -e

# クラウド VM の判定。claude がリモートセッションへ注入する環境変数のいずれかがあればクラウド。
# 複数見るのは、どれが設定されるかがバージョンによって変わりうるため（1つでも当たれば成立し、
# 全て外れた場合はローカル扱い＝何もしない、という安全側に倒れる）。
if [ -z "$CLAUDE_CODE_REMOTE" ] &&
    [ -z "$CLAUDE_CODE_CLOUD_SESSION_ID" ] &&
    [ -z "$CLAUDE_CODE_REMOTE_SESSION_ID" ] &&
    [ -z "$CLAUDE_CODE_ENVIRONMENT_KIND" ]; then
    exit 0
fi

# CLI 未導入（`claude-task-worker install` が走っていない）なら何もしない。
command -v codegraph >/dev/null 2>&1 || exit 0

# 構築済みなら作り直さない（resume のたびに再構築しないため）。
[ ! -d .codegraph ] || exit 0

# リポジトリの外（クローン前など）では対象が無い。
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

echo "Building CodeGraph index (codegraph init)..."
codegraph init || echo "codegraph init failed. Continuing without CodeGraph index."
