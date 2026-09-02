---
name: breakdown-issues
description: "依頼された内容（自然言語の説明、または既存のIssue番号）を要件とTODOに分解し、タスクごとにGitHub Issueを作成するスキル。タスクの整理・分解、複数Issueの一括作成、依存関係の明示が必要な場合に使用する。「この機能をIssueに分けて」「タスクを洗い出してIssueにして」「PRDのIssue #123 を分解して」といったリクエストで発動する。"
argument-hint: "[task-description | issue-number]"
---

# Breakdown Issues

依頼された内容を requirement-todo-organizer エージェントで要件・TODOに分解し、各タスクをGitHub Issueとして作成するスキル。

引数は2形態を受け付ける。どちらでも作成する子Issueは同じで、違いは**親（Epic）Issue を新規作成するか、既存Issueを Epic に格上げするか**だけ。

- **自然言語のタスク説明**: その内容を分解し、親Issueを新規作成する
- **既存のIssue番号**（数値のみ・`#`付き数値・Issue URL）: そのIssueの description を分解対象とし、**そのIssue自身を親（Epic）にする**（`/create-prd` が作った PRD Issue を分解する経路）

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **`gh` コマンドを優先し、`gh` が使えない場合に GitHub MCP へフォールバックする**（本文中の `gh` コマンド例はそのまま第一手段として読む）。**クラウド実行時のみ優先順位が逆転して GitHub MCP が第一手段になる**が、その指示は起動プロンプトで渡されるので、指示が無ければローカル実行として扱う。判定手順・`gh` ↔ MCP の対応表・MCP に代替が無い操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する。

## 実行ステップ

### 1. デフォルトブランチへの移動

デフォルトブランチに移動し、`git pull origin`で最新状態にする。

### 2. タスクの分解

引数:

$ARGUMENTS

#### 2-1. 引数の判定と分解対象の確定

引数が**数値のみ**（例: `123`）・**`#`付き数値**（例: `#123`）・**Issue URL**（`.../issues/<番号>`）のいずれかなら「Issue番号モード」、それ以外は「タスク説明モード」として扱う。

Issue番号モードの場合は対象Issueの本文を取得し、それを分解対象にする。取得に失敗した（存在しない・権限が無い）場合は中断する。

```bash
EPIC_ISSUE_NUMBER=<引数から切り出した番号>
gh issue view "$EPIC_ISSUE_NUMBER" --json number,title,body,state
```

Issue が `CLOSED` の場合は、分解して良いか `AskUserQuestion` で確認してから進む。

#### 2-2. 分解

requirement-todo-organizer サブエージェントを使用して、確定した分解対象（タスク説明モードなら引数の依頼内容、Issue番号モードなら取得した Issue のタイトル＋本文）を要件定義・TODO分解する。

### 3. タスクの不明点のブラッシュアップ

ステップ2で分解した要件・TODOに不明点や曖昧な点があれば、`AskUserQuestion`ツールでユーザーに質問する。

- 回答を受けて要件・TODOを更新し、不明点がなくなるまで繰り返す
- 不明点がない場合はスキップする

### 4. 親（Epic）Issue の確定

子Issueは後段でこの親Issueの sub-issue として作成するため、先に親番号（`EPIC_ISSUE_NUMBER`）を確定させる。親Issueは全体像と進捗を1つの番号で追えるようにするサマリとして機能する。

#### 4-a. Issue番号モード: 引数のIssueを Epic に格上げする

新しい親Issueは**作らない**（同じ内容のIssueが2つ並び、どちらを追えばよいか分からなくなるため）。引数で渡されたIssueに `cc-epic-issue` ラベルを付け、その番号をそのまま `EPIC_ISSUE_NUMBER` として使う。本文は書き換えない（分解対象そのものであり、PRD として人がレビューした内容を上書きしない）。

```bash
gh issue edit "$EPIC_ISSUE_NUMBER" --add-label "cc-epic-issue"
```

ラベル付与に失敗した場合は中断する（Epic として扱われないIssueに sub-issue だけ生やすと、`create-epic-pr` などのEpicフローに乗らない）。ラベルが既に付いている場合は成功として扱う（冪等）。

確定したらステップ5へ進む（4-b は実行しない）。

#### 4-b. タスク説明モード: 親（Epic）Issue を新規作成する

子Issueを作る前に、ステップ2で分解した全TODOを束ねる「親Issue（Epic）」を1つ作成する。

- **ラベル**: `cc-epic-issue`（親 Epic Issue であることを示す。必ず付与）
- **タイトル**: 依頼内容全体のサマリを短くまとめたもの（例：「ユーザー認証機能の実装」）
- **アサイン**: 自分（`$ME`）
- **本文**: 依頼内容の全体像（背景・ゴール）を1-3段落で簡潔に。この時点では子Issue番号のリンクは含めない（GitHub UI の sub-issue 表示で十分追える。必要なら最終ステップで `gh issue edit` で追記してもよい）

`post-scope-issue-body` のフォーマットは個別TODO用のスコープIssue向け（要件・参照情報・優先度・見積もり規模）であり、Epicサマリには合わないため、親Issueはこのスキル内で直接 `gh issue create` する。

GitHub MCP が使える場合はログインユーザー取得に `get_me` を使う。以下は MCP 利用不可時のフォールバック。

```bash
ME=$(gh api user --jq '.login')

EPIC_ISSUE_URL=$(gh issue create \
  --title "<Epicタイトル>" \
  --assignee "$ME" \
  --label "cc-epic-issue" \
  --body-file - <<'EOF'
## 概要
（依頼内容の全体像を1-3段落で）

## 背景・ゴール
（このEpicが達成すべきゴール、なぜ必要か）
EOF
)

EPIC_ISSUE_NUMBER=$(basename "$EPIC_ISSUE_URL")
```

`gh issue create` が失敗した場合はそのまま中断する（親Issueが無い状態で子Issueだけ作っても sub-issue 関係が貼れず、本スキルの趣旨を満たさないため）。

### 5. 子IssueをサブIssueとして一括作成（post-scope-issue-body へ委譲）

ステップ2で洗い出した各TODOに対して、ステップ4で作った親Issueの sub-issue として GitHub Issue を作成する。

#### 責務の分担

本文整形・投稿前チェック・`gh issue create` の実行は `post-scope-issue-body` スキルに委譲する。本文テンプレート・投稿前チェックリスト・heredoc 投稿コマンドは `post-scope-issue-body` 側に集約されており、本スキル内では再記述しない。本スキルでは「TODOの整理」「作成順序の制御」「親Issue番号と依存先Issue番号の確定と YAML への受け渡し」のみを担う。

#### 依存関係の表現方法

依存関係は本文の `## 依存関係` セクションには書かず、GitHub ネイティブの relationships（blocked-by）を使う。`post-scope-issue-body` の YAML 入力に `blocked_by:` を渡して貼る（GitHub UI で関係性が表示され、本文との二重管理によるズレも避けられる）。

#### 作成順序

依存関係のないタスク（依存先が「なし」のもの）から先に作成し、依存先のIssue番号が確定してから依存タスクのIssueを作成する。`post-scope-issue-body` は1回の呼び出しで1つのIssueを作成して URL と Issue 番号を返すので、順に呼び出し、後続TODOの `blocked_by:` リストに先行Issueの番号を入れてから次の呼び出しを行う。

#### 各TODOごとの呼び出し

TODO 1件ごとに、以下の YAML ブロックを**そのまま args として** Skill tool で `post-scope-issue-body` を起動する（`post-scope-issue-body` は args を YAML として機械的にパースする規約）。

```yaml
mode: create
title: <TODOのタスク名をそのまま>
sections:
  概要: |
    （1-3行）
  要件: |
    - ...
    （無ければ "なし"）
  参照情報: |
    - ドキュメント: `<path>` — <説明>
    （無ければ "なし"）
  優先度: High  # High / Medium / Low のいずれか
  見積もり規模: M  # S / M / L / XL のいずれか
# ステップ4で確定した親Issue番号。全TODOで同じ値を渡す。
parent: <EPIC_ISSUE_NUMBER>
# 依存先がある場合のみ書く。先行して作成済みのIssue番号を入れる。依存先が無い場合は項目ごと省略。
blocked_by: [<先行TODOで確定済みのIssue番号>, ...]
```

Skill tool 呼び出しは `Skill(skill='post-scope-issue-body', args=<上記YAML文字列>)`（必要なら plugin namespace 付きで `claude-task-worker:post-scope-issue-body`）。args は改行を含む複数行文字列としてそのまま渡す。返ってきた Issue 番号は後続TODOの `blocked_by:` 用に保持する。

`post-scope-issue-body` の失敗（gh コマンド失敗・本文チェック不通過・`--parent`/`--blocked-by` の検証エラー等）はそのまま中断条件となる。エラーメッセージを最終報告に含め、既に作成済みのIssue（親Issueと作成済みの子Issue）は残したまま中断する。

### 6. 作成結果の報告

全Issueの作成が完了したら、以下を報告する。結論（親Issue番号と子Issue件数）から書き、各項目は1行に収める。分解内容の再掲・言い換えは書かない。

- 親Issue（Epic）の番号・タイトル・URL（Issue番号モードでは「既存Issueを Epic に格上げした」旨を1行で添える）
- 作成した子Issueの一覧（番号・タイトル・blocked-by先）
- 依存関係図（テキストベース。依存が2段以上あるときだけ出す）
- 推奨される実行順序
