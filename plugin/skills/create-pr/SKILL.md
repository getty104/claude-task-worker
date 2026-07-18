---
name: create-pr
description: GitHubでPull Request（PR）を作成します。PRのdescriptionには指定されたテンプレートを使用し、必要な情報を記載します。PR作成後、PRのURLを報告します。
argument-hint: "[issue-number]"
model: sonnet
effort: medium
context: fork
---

# Create Pull Request

GitHubでPull Request（PR）を作成するスキルです。呼び出された際には、Instructionsに従ってPRの作成を行ってください。

# Instructions

## PR作成ルール

- PRのdescriptionのテンプレートは`.github/PULL_REQUEST_TEMPLATE.md`を参照し、それに従うこと
- テンプレート内でコメントアウトされている箇所は必ず削除すること
- PRのdescriptionには`Closes #$0`と記載すること
- `gh api user --jq '.login'`で取得したユーザーをAssigneesに追加すること
- PRのベースブランチは「ベースブランチの決定」の手順で決定したブランチにすること
- PRに`cc-triage-scope`ラベルを付与すること

## ベースブランチの決定

ベースブランチは以下の優先順で決定する。必ず 1 → 2 → 3 の順に試すこと。

1. **Epicブランチの確定的導出**: Issue `$0` が parent（Epic Issue）を持つ場合、`cc-epic-<parent番号>` をベースにする
2. **upstream（追跡ブランチ）からの確定的導出**: 現在のブランチの upstream が origin の別ブランチを指している場合、それをベースにする（ワーカーが worktree 作成時に `--track` で分岐元を記録している）
3. **分岐元ブランチの推定（fallback）**: 1・2 のいずれでも決まらない場合のみ、merge-base距離で分岐元を推定する

### 1. Epicブランチの確定的導出

サブIssue（parentを持つIssue）の作業ブランチは `cc-epic-<parent番号>` から派生しているため、PRも同ブランチへ向ける。後述のmerge-base推定は、epicブランチ作成直後（デフォルトブランチと同一コミットを指す状態）に複数の候補ブランチが同点になり、アルファベット順のタイブレークで**誤ったepicブランチ**を選ぶことがある。そのためparentからの確定的導出を必ず先に試す。

```bash
git fetch origin --prune

BASE_BRANCH=""

# Issue 番号が指定されている場合のみ実行
if [ -n "$0" ]; then
  # gh issue view が失敗した場合はエラーを報告して中断
  PARENT=$(gh issue view "$0" --json parent --jq '.parent.number // empty') || {
    echo "Error: Failed to retrieve Issue #$0" >&2
    exit 1
  }
  if [ -n "${PARENT}" ] && git rev-parse --verify --quiet "refs/remotes/origin/cc-epic-${PARENT}" >/dev/null; then
    BASE_BRANCH="cc-epic-${PARENT}"
  fi
fi
```

引数のIssue番号が渡されていない場合（`$0`が空）は本ステップをスキップし、`BASE_BRANCH` を空のままステップ2へ進む。Issue番号が指定されているが `gh issue view` の実行に失敗した場合（ネットワークエラー・権限不足等）はエラーメッセージを出力して処理を中断する。

### 2. upstream（追跡ブランチ）からの確定的導出

ワーカーは worktree 作成時に `git worktree add --track` で分岐元ブランチを upstream として記録している（例: デフォルトブランチ由来なら `origin/main`、epic 由来なら `origin/cc-epic-<N>`）。手動で `git checkout -b <branch> origin/<base>` した場合も既定で同じ upstream が付く。これは「どのブランチから派生したか」の確定情報なので、merge-base 推定より必ず先に使う。

```bash
if [ -z "${BASE_BRANCH}" ]; then
  CURRENT=$(git rev-parse --abbrev-ref HEAD)
  UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)
  UPSTREAM=${UPSTREAM#origin/}
  # upstream が未設定・自分自身（push -u した作業ブランチ）・origin に実在しない場合は採用しない
  if [ -n "${UPSTREAM}" ] && [ "${UPSTREAM}" != "${CURRENT}" ] \
    && git rev-parse --verify --quiet "refs/remotes/origin/${UPSTREAM}" >/dev/null; then
    BASE_BRANCH="${UPSTREAM}"
  fi
fi
```

### 3. 分岐元ブランチの推定（fallback）

「現在のブランチの分岐元ブランチ」は、リモートトラッキングブランチ（`refs/remotes/origin/`配下）のうち、現在のブランチ自身を除き、HEADから最も近い merge-base を持つものとして推定する。Epic ブランチや任意の中間ブランチから派生した作業ブランチでも、その派生元へPRを向けられるようにするための仕組み。

**距離が同点の場合はデフォルトブランチを最優先する**こと。デフォルトブランチと同一コミットを指すブランチ（作成直後の epic ブランチや並行タスクのPRブランチ）が存在すると距離が同点になり、単純なアルファベット順タイブレークでは `origin/cc-epic-*` が `origin/main` より先に来て**無関係な epic ブランチがベースに選ばれる**ため。

```bash
if [ -z "${BASE_BRANCH}" ]; then
  DEFAULT_BRANCH=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
  CURRENT=$(git rev-parse --abbrev-ref HEAD)

  BASE_BRANCH=$(
    git for-each-ref --format='%(refname:short)' refs/remotes/origin/ |
      grep '^origin/' | grep -v '^origin/HEAD$' |
      while read b; do
        [ "$b" = "origin/${CURRENT}" ] && continue
        mb=$(git merge-base "$b" HEAD 2>/dev/null) || continue
        [ -n "$mb" ] || continue
        dist=$(git rev-list --count "${mb}..HEAD" 2>/dev/null) || continue
        if [ "$b" = "origin/${DEFAULT_BRANCH}" ]; then pref=0; else pref=1; fi
        echo "$dist $pref $b"
      done | sort -k1,1n -k2,2n -k3,3 | head -1 | awk '{print $3}' | sed 's|^origin/||'
  )

  # 候補が見つからない場合（孤立ブランチ等）はデフォルトブランチに fallback する
  if [ -z "${BASE_BRANCH}" ]; then
    BASE_BRANCH="${DEFAULT_BRANCH}"
  fi
fi
```

距離が同点の場合はデフォルトブランチ → refname のアルファベット順の優先度で採用する。期待しないブランチがベースに選ばれた場合は `--base` を明示的に指定して上書きする。

## Command Examples

```bash
gh pr create \
  --title "PRタイトル" \
  --body "$(printf 'Closes #%s\n\nPRの本文' "$0")" \
  --base "${BASE_BRANCH}" \
  --assignee "$(gh api user --jq '.login')" \
  --label "cc-triage-scope"
```
