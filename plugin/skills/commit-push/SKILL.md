---
name: commit-push
description: コード変更を適切なgitコミット戦略でgit commitし、pushします。基本的には既存のgitコミットへのsquash戦略を採用し、必要に応じてブランチ全体のgitコミット履歴を再構成します。実装完了時やユーザーがgit commitを依頼した時に使用します。
model: sonnet
effort: medium
context: fork
---

# Commit and Push Code Changes

**このスキルが呼び出された時点で commit と push の実行依頼は既に確定しています。ユーザーへの挨拶・自己紹介・「何を手伝いますか」のような確認質問は一切禁止。ステップ1（`git status` と `git log` の確認）から即座に実行を開始してください。**

ユーザーから追加の指示や引数は渡されません。デフォルトブランチからの差分・作業ツリーの状態を自分で確認し、Instructions に従って戦略を選択・実行します。基本は既存gitコミットへのsquash戦略です。

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **`gh` コマンドを優先し、`gh` が使えない場合に GitHub MCP へフォールバックする**（本文中の `gh` コマンド例はそのまま第一手段として読む）。**クラウド実行時のみ優先順位が逆転して GitHub MCP が第一手段になる**が、その指示は起動プロンプトで渡されるので、指示が無ければローカル実行として扱う。判定手順・`gh` ↔ MCP の対応表・MCP に代替が無い操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する。

## 実行ステップ

### ステップ0: 作業ディレクトリの確認

本スキルは単独でも他スキル（`exec-issue` / `fix-review-point` / `create-pr` 等）からの委譲でも起動される。いずれのケースでも、呼び出し元が用意した作業コンテキストを尊重するため、**現在地を変更しない・新規worktreeを作らない**ことを徹底する。

```bash
pwd
```

判定:

- **`.claude/worktrees/` 配下にいる場合**: そのworktree内で全ての作業（`git status` / `git commit` / `git push` 等）を完結させる。`cd`でworktreeの外やリポジトリのルートに移動しない
- **`.claude/worktrees/` 配下にいない場合（リポジトリのルート・通常のクローン等）**: その場で作業する。`.claude/worktrees/` 配下への移動や新規worktree作成はしない

**理由**: 本スキルは `context: fork` のサブエージェントとして起動される場合、親エージェントと同じ作業ディレクトリで実行される。作業ディレクトリを勝手に動かすと、親の期待する変更対象と実際にcommitされる変更対象がずれ、リモートに誤った差分がpushされる。

本スキルはデフォルトブランチ上でも実行できる。その場合の制約はステップ1のモード判定に従う。

### ステップ1: ブランチとgitコミット履歴の確認

```bash
git status
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)

# 分岐元（BASE_BRANCH）を確定する。upstream を最優先し、無ければデフォルトブランチへ倒す。
# ワーカーは worktree 作成時に `git worktree add --track origin/<base>` で分岐元を upstream に記録している。
BASE_BRANCH=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null | sed 's|^origin/||')
if [ -z "${BASE_BRANCH}" ] || [ "${BASE_BRANCH}" = "${CURRENT_BRANCH}" ]; then
  BASE_BRANCH="${DEFAULT_BRANCH}"
fi

# BASE_BRANCH が確定した場合のみ git log を実行
if [ -n "${BASE_BRANCH}" ]; then
  git log --oneline --graph "origin/${BASE_BRANCH}..HEAD"
fi
```

確認事項: 現在のブランチ名／分岐元（`BASE_BRANCH`）から何gitコミット進んでいるか／各gitコミットの内容と粒度

`CURRENT_BRANCH` が `HEAD`（detached HEAD）の場合は push 先を確定できないため、**commitもpushもせず中断**し、状況を報告して終了する。

**差分の基準を `DEFAULT_BRANCH` ではなく `BASE_BRANCH` にすること**。epic ブランチ（`cc-epic-<N>`）等から派生した作業ブランチでデフォルトブランチを基準にすると、**分岐元に既に載っている他タスクのgitコミットが「このブランチのgitコミット」として並ぶ**。それを既存gitコミットとみなして戦略A（`--amend`）を選ぶと、他タスクのgitコミットを書き換えて自分の変更を混ぜ込むことになる（実際に epic 配下のサブIssueで発生した事故）。

取得した `CURRENT_BRANCH` と `DEFAULT_BRANCH` から、以降のモードを決める:

- **デフォルトブランチモード**（`CURRENT_BRANCH` と `DEFAULT_BRANCH` が一致する場合、**または `DEFAULT_BRANCH` の取得に失敗した場合**）: 公開済み履歴を壊さないため、ステップ2では**戦略B（新規gitコミット）のみ**を採用し（`--amend`＝戦略A・interactive rebase＝戦略Cは使わない）、ステップ5では**force無しのfast-forward push**（`git push origin HEAD`）を使う。取得失敗時もこのモードへ倒すのは、判定できない状態で force push してデフォルトブランチ履歴を壊す事故を避けるため（fail-safe。取得失敗時は `git log` の差分確認はスキップしてよい）。
- **通常モード**（両者が一致せず、かつ `DEFAULT_BRANCH` も取得できている場合）: feature branch上での作業とみなす。ステップ2の戦略A/B/Cすべてを選べ、ステップ5は `--force-with-lease` 付きpushを使う。

いずれのモードでも、**push 先は必ず `CURRENT_BRANCH`**（ステップ5参照）。`BASE_BRANCH` は差分の基準とPRのベース決定に使う情報であり、push の宛先ではない。

### ステップ2: gitコミット戦略の判断

> **デフォルトブランチモードでは戦略Bのみを使う**。デフォルトブランチの履歴は既にリモートへ公開されており、`--amend`（戦略A）や interactive rebase（戦略C）で書き換えると他のクローン・CI・オープン中のPRと齟齬が出るため。以下の戦略A/Cは通常モード（feature branch）でのみ選択できる。

> **`git log origin/${BASE_BRANCH}..HEAD` が空（＝このブランチ独自のgitコミットが1件も無い）なら、通常モードでも戦略Bのみを使う**。このとき `HEAD` が指しているのは分岐元のgitコミット（他タスクが作ったもの）であり、`--amend` するとそれを書き換えて自分の変更を混ぜ込むことになる。「既存のgitコミット」とは `origin/${BASE_BRANCH}..HEAD` に現れるgitコミットだけを指す。

#### 戦略A: Squash（基本戦略）

以下を満たす場合、既存のgitコミットにsquashする: **`origin/${BASE_BRANCH}..HEAD` にこのブランチのgitコミットが存在し**、変更内容が既存のgitコミットと同じテーマ・機能に関連し、gitコミットを分ける合理的な理由がない。

```bash
git add -A
git commit --amend
```

gitコミットメッセージを適切に更新すること。

#### 戦略B: 新規gitコミット

以下の場合は新規gitコミットを作成: ブランチに初めてのgitコミット（`origin/${BASE_BRANCH}..HEAD` が空）／既存のgitコミットとは異なる独立した変更／gitコミットを分けることで履歴がより理解しやすくなる。

```bash
git add -A
git commit
```

#### 戦略C: Interactive Rebase（gitコミット再構成）

以下の場合はブランチ全体を再構成: 複数の小さなgitコミットの論理的な整理／順序変更／不要なgitコミットの削除／意味のある単位への再編成。

```bash
git rebase -i "origin/${BASE_BRANCH}"
```

再構成の対象はステップ1で確定した `BASE_BRANCH` 以降のみ。デフォルトブランチを起点にすると、分岐元に既に載っている他タスクのgitコミットまで書き換え対象に入る。

エディタでの操作: `pick`=そのまま維持／`squash`（`s`）=前のgitコミットと統合／`reword`（`r`）=メッセージ変更／行の順序変更=gitコミット順の変更

### ステップ3: gitコミットメッセージのガイドライン

```
<type>: <subject>

<body>

<footer>
```

- **Type**: `feat`（新機能）/ `fix`（バグ修正）/ `refactor`（リファクタリング）/ `test`（テスト追加・修正）/ `docs`（ドキュメント変更）/ `chore`（ビルドプロセスやツールの変更）
- **Subject**: 50文字以内、命令形で記述（例: "add"ではなく"Add"）、末尾にピリオドを付けない
- **Body（オプション）**: 何を変更したかではなく、なぜ変更したか（理由と背景）を記述。72文字で折り返す
- **Footer（オプション）**: Issue番号への参照（例: `Closes #123`）、Breaking changesの記述

### ステップ4: git commit後の確認

```bash
git log -1 --stat
git status
```

gitコミットが正しく作成されたか／意図したファイルがすべて含まれているか／メッセージが適切か

### ステップ5: 変更のpush

**push 先は常に `CURRENT_BRANCH`**。refspec を `HEAD:${CURRENT_BRANCH}` の形で明示し、宛先を取り違える余地を残さない。`git status` が表示する upstream（`Your branch is up to date with 'origin/<base>'`）は**分岐元であって push 先ではない**。ワーカーの worktree は `--track` で分岐元（例: `origin/cc-epic-<N>`）を upstream に持つため、upstream へ push すると共有ブランチへ直接コミットが載り、PRを作れなくなる（実際に発生した事故）。

ステップ1で判定したモードに応じてpush方法を分ける。

- **通常モード（feature branch）**: rebaseやamendで履歴が変わり得るため `--force-with-lease` を使う。

```bash
git push origin "HEAD:${CURRENT_BRANCH}" --force-with-lease
```

- **デフォルトブランチモード**: 新規コミットを積んだだけのfast-forwardなので、force系フラグは**付けずに**通常pushする。デフォルトブランチへ `--force` / `--force-with-lease` を使うと公開履歴を巻き戻す事故につながるため絶対に付けない。

```bash
git push origin "HEAD:${CURRENT_BRANCH}"
```

デフォルトブランチモードのpushがnon-fast-forwardで弾かれた場合は、リモートに未取得のコミットがある状態。force pushで押し込まず、`git fetch` してから `git log origin/${DEFAULT_BRANCH}..HEAD` と `git log HEAD..origin/${DEFAULT_BRANCH}` で差分を確認し、追従（`git pull --ff-only` など）してから再pushする。

## 重要な注意事項

1. **コメントは残さない**: コード内の説明コメントは削除する
2. **原子的なgitコミット**: 各gitコミットは独立して意味を持たせる
3. **一貫性**: プロジェクトの既存のgitコミットスタイルに従う
4. **作業ディレクトリを動かさない**: ステップ0の判定に従う
5. **デフォルトブランチ上では履歴を書き換えない**: ステップ1のモード判定に従い、新規コミットの追加とforce無しのfast-forward pushに限定する
6. **push 先は現在ブランチ以外にしない**: upstream・分岐元・epic ブランチ（`cc-epic-<N>`）など、`CURRENT_BRANCH` 以外を宛先にする refspec は使わない
7. **分岐元のgitコミットを書き換えない**: `--amend` / interactive rebase の対象は `origin/${BASE_BRANCH}..HEAD` に現れるgitコミットに限る

## 戦略選択のフローチャート

```
デフォルトブランチにいる？（DEFAULT_BRANCH 取得失敗も Yes 扱い）
  ├─ Yes（デフォルトブランチモード）→ 新規gitコミットのみ作成 → force無しで push origin HEAD:${CURRENT_BRANCH}
  └─ No（feature branch / 通常モード）→ ↓
origin/${BASE_BRANCH}..HEAD にgitコミットがある？
  ├─ No（HEAD は分岐元のgitコミット）→ 新規gitコミット作成（--amend 禁止）→ --force-with-lease で push origin HEAD:${CURRENT_BRANCH}
  └─ Yes → 変更は既存のgitコミットと同じテーマ？
      ├─ Yes → Squash（git commit --amend）→ --force-with-lease で push origin HEAD:${CURRENT_BRANCH}
      └─ No → gitコミットを分ける合理性がある？
          ├─ Yes → 新規gitコミット作成 → --force-with-lease で push origin HEAD:${CURRENT_BRANCH}
          └─ 履歴を整理したい → Interactive Rebase（origin/${BASE_BRANCH} 起点）→ --force-with-lease で push origin HEAD:${CURRENT_BRANCH}
```
