#!/usr/bin/env bash
set -euo pipefail

# クラウド VM（Claude Code on the web）の環境セットアップスクリプト。
# claude.ai の環境設定（Environment setup script）から呼ばれる想定。
#
# プラグイン・CLI 自体・CodeGraph / DESIGN.md / Pen CLI をまとめて導入する
# `npx claude-task-worker install` を実行するだけに絞る。
#
# plugin/scripts/ 配下ではなく scripts/ に置くのは、plugin/scripts/ は
# プラグインが配布するフック（Stop フック等）用でありクラウドVMセットアップ
# とは用途が異なるため。

npx claude-task-worker install
