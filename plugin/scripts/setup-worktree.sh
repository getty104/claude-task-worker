#!/bin/bash

set -e

CURRENT_DIR=$(pwd)

if [[ ! "$CURRENT_DIR" =~ /.claude/worktrees/[^/]+$ ]]; then
    echo "Not in a .claude/worktrees/<dir> directory. Skipping setup."
    exit 0
fi

ROOT_DIR="$(cd "../../../" && pwd)"

if [ -f "$ROOT_DIR/.env" ]; then
    cp "$ROOT_DIR/.env" .env
    echo "Copied .env"
fi

# .codegraph/ はグローバル gitignore 登録のローカルインデックスのため、worktree には現れない。
# ルートがインデックス済み（= ユーザーがこのリポジトリの CodeGraph 利用を選択済み）の場合のみ worktree 側でも構築する。
if command -v codegraph >/dev/null 2>&1 && [ -d "$ROOT_DIR/.codegraph" ] && [ ! -d .codegraph ]; then
    echo "Building CodeGraph index (codegraph init)..."
    codegraph init || echo "codegraph init failed. Continuing without CodeGraph index."
fi
