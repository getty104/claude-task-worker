---
name: create-ui-design
description: "Create or update the Pencil (`.pen`) design for a UI implementation Issue before any code is written, then open a design-only PR. Takes the Issue number as argument, extracts the design requirements from the Issue description and comments, delegates `.pen` edits to the pencil-design-updater agent, exports snapshot PNGs, pushes them on the fixed `cc-ui-design-<Issue number>` branch, and opens a PR that references the Issue with `Refs #<N>` (never a closing keyword)."
argument-hint: "[issue-number]"
disable-model-invocation: true
hooks:
  Stop:
    - matcher: ""
      hooks:
        - type: command
          command: node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-servers.mjs"
---

# Create UI Design

UI実装Issue `$0` に対して、実装に先立って Pencil のデザイン（`.pen`）を作成・更新し、デザインのみの独立したPRを作るスキルです。Instructionsに従って順に実行し、各フェーズの「完了条件」を満たさないまま次のフェーズに進まないこと。

**このスキルはコードを実装しない**。差分は `.pen` とスナップショット PNG のみに限定する。実装は本デザインPRのマージ後に `exec-issue` が担当する。

# Instructions

## 実行モードの制約

本スキル固有のリスク: 本スキルは `claude-task-worker` の `create-ui-design` ワーカー（`cc-create-ui-design` ラベル）から自動起動され、ワーカーはスキルプロセスの同期完了を根拠にラベル遷移（`cc-ui-design-pr-created` の付与、デザインPRへの `cc-triage-scope` / `cc-ui-design` 付与）を進める。処理が未完のままターンを終えると、デザインPR未作成のままトリガーラベルが外れてIssueが停滞したり、デザインなしで実装フェーズへ流れたりする状態壊れが起きる。

> **プリアンブル（`!` インライン実行）に失敗しうるコマンドを置かないこと**: プリアンブルのコマンドが失敗すると、セッションはモデル未起動のまま何も出力せず exit 0 で終了し、ワーカーが空振り実行を延々と繰り返す。`pencil` の疎通確認はフェーズ0の本文で行う。

## フェーズ0: 事前チェック

以下を順に確認し、判断は自動で行う。ユーザーには質問しない。

### 0-1. 作業ディレクトリとIssueの確認

- `pwd` で `.claude/worktrees/` 配下にいることを確認する。worktree外なら **中断**（デフォルトブランチで作業してはならない）
- `gh issue view $0 --json number,title,body,state,labels,comments` でIssueが `OPEN` であることを確認する。CLOSEDなら **中断**
- `git status --short` で未コミット変更があれば `git stash push -u -m "create-ui-design auto-stash $0"` で自動退避し、その旨を最終報告に明記する

### 0-2. Pencil の疎通確認

```bash
pencil version
pencil status
```

いずれかが失敗する（未インストール・未認証など）場合は、デザインを作らずに以下を実行して終了する。**この場合デザインPRは作らない。**

1. Issue に理由（実行したコマンドとエラー出力の要約）をコメントする
   ```bash
   gh issue comment $0 --body-file - <<'EOF'
   ## Pencil を利用できないためデザインを作成できません（要人手確認）

   `create-ui-design` は Pencil CLI が必要ですが、実行環境で利用できませんでした。

   ## 実行したコマンドとエラー

   ~~~text
   <コマンドとエラー出力の要約>
   ~~~

   ## 対応後の進め方

   - Pencil をインストール・認証したうえで、`cc-need-human-check` ラベルを外し `cc-create-ui-design` ラベルを付け直してください
   - デザインなしで実装へ進める場合は、`cc-need-human-check` ラベルを外し `cc-ui-design-ready` と `cc-exec-issue` ラベルを付けてください
   EOF
   ```
2. `gh issue edit $0 --add-label "cc-need-human-check"` を実行する
3. 最終報告に「Pencil 利用不可・`cc-need-human-check` 付与済み」と原因を明記して終了する

### 0-3. デザイン配置先の解決

リポジトリ直下の `claude-task-worker.json` の `uiDesign.designDir` を読む。既定値 `designs` を使ってよいのは「ファイルが存在しない」場合、または「ファイルは存在するがキー未設定（`jq` が `null` を返す）」場合のみに限る。`jq` がexit code非0で終わる場合（JSON構文エラー・権限エラーなどでファイルを読めない場合）は、意図した `designDir` と異なる場所へデザイン成果物を作ってしまう危険があるため、既定値へフォールバックせず安全側に倒す。

```bash
if [ ! -f claude-task-worker.json ]; then
  DESIGN_DIR="designs"
elif DESIGN_DIR=$(jq -r '.uiDesign.designDir // "designs"' claude-task-worker.json); then
  :
else
  JQ_EXIT=$?
  echo "failed to read claude-task-worker.json (jq exit ${JQ_EXIT})" >&2
  DESIGN_DIR=""
fi
```

`DESIGN_DIR` が空文字列のまま（=上記の `jq` 失敗）の場合は、デザインを作らずフェーズ0-2と同じ手順（Issueへの理由コメント + `cc-need-human-check` 付与）でスキルを終了する。この場合デザインPRは作らない。

**完了条件**: worktree内・Issue OPEN・`pencil` 疎通OK・`DESIGN_DIR` が空文字列でなく確定していること。

## フェーズ1: デザイン要件の抽出

フェーズ0-1で取得したdescriptionとコメント履歴から、以下を抽出する。

- 対象画面・コンポーネント（何を作る/変えるのか）
- 構成要素（要素の一覧と階層・配置）
- 状態バリエーション（空・ローディング・エラー・選択中・権限差など、Issueが要求するもの）
- 既存デザイン・既存実装との関係（既存画面の改修なのか新規なのか）

### デザイン不要と判明した場合

抽出の結果「このIssueはUI変更を伴わない」と判断した場合（サーバーサイドのみ、文言差し替えのみ、レイアウトに影響しない微修正など）は、デザインを作らずに以下を実行して終了する。

1. Issue に判断理由をコメントする
   ```bash
   gh issue comment $0 --body-file - <<'EOF'
   ## UIデザインは不要と判断しました

   ## 判断理由
   <UI変更を伴わないと判断した根拠を具体的に>

   デザインPRは作成せず、そのまま実装フェーズへ進めます。
   EOF
   ```
2. 実装トリガーを付与する（`cc-ui-design-ready` は付けない。exec-issue のフェーズ0ガードは同ラベルがあると `## UIデザイン` セクションの存在を前提にするため、デザイン不要経路では付与せず `cc-exec-issue` のみで実装へ戻す）
   ```bash
   gh issue edit $0 --add-label "cc-exec-issue"
   ```
3. 最終報告に「デザイン不要・実装フェーズへ復帰」と理由を明記して終了する

**完了条件**: 対象画面・構成要素・状態バリエーションが列挙できているか、デザイン不要として終了していること。

## フェーズ2: 既存デザインの調査

`DESIGN_DIR` 配下の `.pen` を列挙し、対象画面に対応する既存ファイルがあるかを確認する。

```bash
ls -1 "${DESIGN_DIR}"/*.pen 2>/dev/null || echo "(no existing .pen)"
```

- 対象画面に対応する既存 `.pen` がある場合は、`inspect-pencil-node` スキルで現状の構造・スタイルを取得したうえで、**新規作成ではなく更新**する
- ない場合は新規作成する

`.pen` は暗号化バイナリのため `Read` / `Grep` で開かない。構造の把握は必ず `inspect-pencil-node` スキル経由で行う。

**完了条件**: 「更新する既存パス」または「新規作成するパス」のいずれかが確定していること。

- 新規: `<DESIGN_DIR>/$0-<kebab-slug>.pen`（`<kebab-slug>` はIssueタイトルから導く短い英小文字ケバブケース）
- 更新: 既存パスをそのまま上書き

## フェーズ3: デザインの作成・更新

`pencil-design-updater` エージェントに委譲する（`.pen` の編集は `edit-pencil-design` スキル経由でのみ行う。直接編集は禁止）。

ブリーフィングには以下をすべて含める（サブエージェントは会話履歴を持たないため）:

```text
【背景】Issue #$0「<title>」: <要約 1-2行>

【対象ファイル】
<新規作成なら作成先パス / 更新なら既存パス>（新規/更新の別を明記）

【デザインする内容】
- 対象画面・コンポーネント: <フェーズ1の抽出結果>
- 構成要素と配置: <要素の一覧と階層>
- 状態バリエーション: <空・ローディング・エラー等。無ければ「なし」>

【既存デザインとの関係】
<更新の場合は inspect-pencil-node で把握した現状構造の要約。新規なら「新規作成」>

【完了条件】
- `edit-pencil-design` スキル経由で `.pen` を作成/更新すること（直接編集は禁止）
- 編集・作成したNodeのスクリーンショットを `<DESIGN_DIR>/snapshots/` に PNG 出力すること
- `.pen` とスナップショット PNG 以外のファイルを変更しないこと

【作業ディレクトリ】
<worktreeの絶対パス>
```

サブエージェントの完了報告を鵜呑みにせず、`git status --short` で `.pen` とスナップショット PNG が実際に生成・更新されていることを検証する。生成されていなければ再委譲する（最大2回）。2回試行しても生成できない場合は、フェーズ0-2と同じ手順で `cc-need-human-check` を付与し、失敗ログを含めて終了する。

**完了条件**: `.pen` とスナップショット PNG が `git status --short` に現れており、他のファイルに差分がないこと。

## フェーズ4: デザインブランチの作成とpush

再実行時に既存ブランチが残っていても失敗しないよう、先に存在確認してから作成/切り替えを分岐する。

```bash
BRANCH="cc-ui-design-$0"
git fetch origin "${BRANCH}" 2>/dev/null || true
if git rev-parse --verify --quiet "refs/remotes/origin/${BRANCH}" >/dev/null; then
  git switch -C "${BRANCH}" "origin/${BRANCH}"
elif git rev-parse --verify --quiet "refs/heads/${BRANCH}" >/dev/null; then
  git switch "${BRANCH}"
else
  git switch -c "${BRANCH}"
fi
git status --short | awk '{print $2}' | grep -E '\.pen$|/snapshots/.+\.png$' | xargs -r git add --
git status --short
```

**ステージするのは `.pen` ファイルと `snapshots/` 配下のPNGファイルのallowlistのみ**とし、`git add "${DESIGN_DIR}"` のようなディレクトリ丸ごとaddは行わない。ステージ後、`git status --short` を再確認し、allowlist外のファイル（ステージされずに残っている変更・元々trackedな変更として存在していたもの、いずれも含む）が1件でも残っている場合は、**それらを `git restore --staged` / `git checkout --` で破棄してはならない**。ユーザーの意図しないtracked変更まで巻き込んで消し去る危険があるため、破棄せず以下を実行して終了する。

```bash
NON_ALLOWED=$(git status --short | awk '{print $2}' | grep -vE '\.pen$|/snapshots/.+\.png$' || true)
```

`NON_ALLOWED` が空でない場合は、フェーズ0-2と同じ手順（Issueへの理由コメント + `cc-need-human-check` 付与）でスキルを終了する。この場合デザインPRは作らない。`NON_ALLOWED` が空の場合のみフェーズ4の続き（コミット・push）へ進む。

`cc-ui-design-$0` は本スキルの実行だけが書き込むブランチのため、リモートに同名ブランチが残っていても `--force-with-lease` で上書きして安全に収束させる。

```bash
git commit -m "design: Issue #$0 のUIデザインを追加"
if git ls-remote --exit-code origin "${BRANCH}" >/dev/null 2>&1; then
  git fetch origin "${BRANCH}"
  git push --force-with-lease -u origin "${BRANCH}"
else
  LS_REMOTE_STATUS=$?
  if [ "${LS_REMOTE_STATUS}" -eq 2 ]; then
    git push -u origin "${BRANCH}"
  else
    echo "failed to check remote branch existence (exit ${LS_REMOTE_STATUS}), possibly auth/network error" >&2
    exit 1
  fi
fi
```

`git ls-remote --exit-code` は「リモートに一致する参照がない」場合のみ exit code 2 を返す（認証・ネットワーク失敗など他の異常は 2 以外）。exit 2 ならリモート未存在と確定できるため素の `push -u` に進み、それ以外は原因不明のエラーとして即座に失敗させる。

push（またはリモート存在確認）に失敗した場合はエラー出力を最終報告に含め、フェーズ0-2と同じ手順で `cc-need-human-check` を付与して終了する。

**完了条件**: `cc-ui-design-$0` ブランチが remote に存在すること。

## フェーズ5: デザインPRの作成

ベースブランチは実装PRと揃える（Epic配下のIssueでは、デザインが実装ブランチに存在しない事態を防ぐため）。

```bash
BASE_BRANCH=""
if ! PARENT=$(gh issue view "$0" --json parent --jq '.parent.number // empty'); then
  echo "failed to resolve issue parent" >&2
  exit 1
fi
if [ -n "${PARENT}" ] && git rev-parse --verify --quiet "refs/remotes/origin/cc-epic-${PARENT}" >/dev/null; then
  BASE_BRANCH="cc-epic-${PARENT}"
else
  BASE_BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's@^origin/@@')
fi
ME=$(gh api user --jq '.login')
```

PR本文は `--body-file -` + heredoc（`<<'EOF'` クォート版）で渡す。プレースホルダは heredoc に渡す前に実値へ置換しておくこと。

```bash
gh pr create \
  --title "design: <Issueタイトル>" \
  --base "${BASE_BRANCH}" \
  --assignee "${ME}" \
  --body-file - <<'EOF'
## 概要
Issue #$0「<Issueタイトル>」のUIデザインです。実装は含まず、`.pen` とスナップショットPNGのみを変更しています。

## デザインの意図
<なぜこの画面構成にしたのかを1-3行で>

## 主要な構成
- <要素・レイアウトの説明>

## 状態バリエーション
- <空・ローディング・エラー等。無ければ「なし」>

## スナップショット
- `<DESIGN_DIR>/snapshots/<node>.png`

Refs #$0
EOF
```

**`Closes #$0` / `Fixes #$0` などの closing keyword は絶対に使わない。** デザインPRのマージで実装Issueが閉じてしまい、実装フェーズへ進めなくなるため。参照は必ず `Refs #$0` にする。

ラベルは付与しない（`cc-triage-scope` / `cc-ui-design` はワーカーが `onCompleted` で付与する）。

### PR作成の検証

```bash
gh pr list --head "cc-ui-design-$0" --state open --json number,url
```

- PRが実在する場合: そのURLを最終報告に含めて正常終了する
- PRが実在しない場合: フェーズ0-2と同じ手順で Issue にPR未作成の旨と原因をコメントし、`cc-need-human-check` を付与して終了する

**完了条件**: `cc-ui-design-$0` を head とするOpen PRの実在が確認できていること。

## フェーズ6: 最終報告

以下を1-5行で報告して終了する。

- 作成/更新した `.pen` のパス（新規/更新の別）
- 出力したスナップショット PNG のパス
- デザインPRのURLとベースブランチ
- （該当時）デザイン不要と判断した理由、または `cc-need-human-check` を付与した理由

## 中断条件

以下のいずれかに該当する場合のみ、理由を1-2行で出力して即中断する。

- 引数が空、または Issue 番号として解釈できない
- worktree外で実行されている
- `gh issue view` でIssueが見つからない、または `CLOSED`

## 注意事項

- **コードを実装しない**: 本スキルの差分は `.pen` とスナップショット PNG のみ。実装は `exec-issue` の責務
- **`.pen` を直接編集しない**: 暗号化バイナリのため、編集は `pencil-design-updater` エージェント（`edit-pencil-design` スキル）経由に限る。読み取りは `inspect-pencil-node` スキル
- **closing keyword を使わない**: PR本文の Issue 参照は `Refs #$0` のみ
- **未完の処理を残したまま完了報告してターンを終えない**: ターンを終えるとプロセスが正常終了し、ワーカーがデザインPR未作成のまま完了扱いでラベル遷移を進めてしまう
- **ユーザーに判断を求めない**: 中断条件以外はすべて本スキル内のルールで自動決定し、曖昧な場合は安全側（デザインを作らず `cc-need-human-check` に落とす側）を選んで根拠を最終報告に明記する
