---
name: update-coding-guidelines
description: 直近N日（デフォルト1日）のPRレビューで繰り返し指摘されている観点のうち「実際に修正すべき」と判断できるものを集約し、リポジトリルートのCODING_GUIDELINES.mdを生成・更新したうえで、commit-push + create-prでPRを作成する。サイズが膨らみすぎないよう既存ルールとの統合・圧縮も行う。
disable-model-invocation: true
argument-hint: "[期間（日数、省略時は1）] [関連Issue番号（任意）]"
allowed-tools: Bash(gh:*), Bash(git:*), Bash(jq:*), Bash(bash:*), Bash(pwd), Bash(ls:*), Bash(date:*), Bash(wc:*), Read, Write, Edit, Skill
hooks:
  Stop:
    - matcher: ""
      hooks:
        - type: command
          command: node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-servers.mjs"
---

# Update Coding Guidelines

直近N日（デフォルト1日）のPRレビューコメントを収集し、繰り返し指摘されているかつ対応すべきと判断できる観点をリポジトリルートの`CODING_GUIDELINES.md`に集約するスキル。Instructionsに従い、収集→クラスタリング→ガイドライン更新→PR作成まで一貫して実行する。

## このスキルがやること・やらないこと

**やること**: 直近N日に更新されたPRのレビューコメント・会話コメントの横断収集（解決済みも含む）／同種の指摘の意味的クラスタリングと2回以上出現するものの抽出／「実際に修正すべき」観点だけのルール化／`CODING_GUIDELINES.md`への追記・既存ルールとの統合・圧縮／`commit-push`でコミット・push（必要なら専用feature branchへ切替）／`create-pr`でPR作成とPR URL返却／作成したPRに`gh api user`の自分自身をAssignee・`cc-triage-scope`ラベルを付与／編集差分のサマリ報告

**絶対にやらないこと**:
- レビューコメントへの返信・Resolve・既存PRへの編集（読み取りのみ）
- `CODING_GUIDELINES.md`以外のファイルの編集（`claude-task-worker.json`の`lastRun`は`claude-task-worker`ワーカーが別PRで更新するため、本スキルは同ファイルに一切触らない）
- 単発（2回未満）の指摘のルール化（ノイズ防止）
- スタイル好み・命名の主観・スコープ外提案など「対応不要寄り」の項目のルール化
- 既存ルールと意味重複する項目の別ルールとしての追加（必ず統合・圧縮する）
- デフォルトブランチ上での直接コミット（必ずfeature branchに切り替えてから`commit-push`を呼ぶ）

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **`gh` コマンドを優先し、`gh` が使えない場合に GitHub MCP へフォールバックする**（本文中の `gh` コマンド例はそのまま第一手段として読む）。**クラウド実行時のみ優先順位が逆転して GitHub MCP が第一手段になる**が、その指示は起動プロンプトで渡されるので、指示が無ければローカル実行として扱う。判定手順・`gh` ↔ MCP の対応表・MCP に代替が無い操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する。

## 実行モードの制約

本スキル固有のリスク: 本スキルは `claude-task-worker` の `update-coding-guidelines` ワーカーから24時間おきに自動起動され、ワーカーは起動時刻を `claude-task-worker.json` の `lastRun` へ記録する別PRを作ったうえで、次の24時間の実行を抑止する。処理が未完のままターンを終えると、その日の分の収集・ルール化が行われないまま実行済みとして扱われ、取りこぼしたレビューコメントは二度と対象期間に入らない（対象期間は常に直近N日で、遡らない）。

## フェーズ0: 事前チェック・引数パース

- カレントディレクトリがgitリポジトリのルートであることを確認する（`git rev-parse --show-toplevel`の出力と一致するか）。一致しない場合は「リポジトリルートで実行してください」と返して終了する
- 既存の`CODING_GUIDELINES.md`があれば全文を`Read`で読み込み、現在のルール構成・項目数・トーンを把握する

### 引数パース

`$ARGUMENTS`を空白区切りで最大2トークンに分解する。

- 1番目: 期間（日数）。省略時または非数値の場合は`1`
- 2番目: 関連Issue番号（任意）。`#`プレフィックスは除去して数値部分のみ保持

例: `/update-coding-guidelines` → 日数=1, Issue番号=なし ／ `/update-coding-guidelines 7 #123` → 日数=7, Issue番号=123

Issue番号はフェーズ5でcreate-prに渡す。指定なしの場合はPR本文の`Closes #N`行を省略する。

**完了条件**: リポジトリルートにいることが確認でき、既存`CODING_GUIDELINES.md`があれば内容を把握済みで、日数と任意Issue番号が確定していること。

## フェーズ1: レビューコメント収集

GitHub MCP が使える場合は対応表のツール（`list_pull_requests` / `pull_request_read` の `get_review_comments` 等）で同等の収集を行う。以下のスクリプトは MCP 利用不可時のフォールバックとして使う。

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/fetch-recent-review-comments.sh <フェーズ0で確定した日数>
```

第1引数には日数のみを渡す（`$ARGUMENTS`をそのまま渡すとIssue番号トークンが余計な引数になる）。引数なしの場合はスクリプト側の`DAYS="${1:-1}"`でデフォルト1日が使われる。

返却されるJSONの構造:

- `period_since`: 収集起点のISO8601タイムスタンプ
- `repo`: `owner/name`
- `pr_count`: 対象PR数
- `prs[]`:
  - `pr_number` / `pr_title` / `pr_url` / `pr_author`
  - `review_comments[]`: コード行に紐づくレビューコメント（`path` / `line` / `is_resolved` / `is_outdated` / `author` / `body` / `url` / `created_at`）
  - `conversation_comments[]`: PRのConversationタブに投稿されたコメント（`author` / `body` / `url` / `created_at`）

`pr_count`が0の場合は「対象期間に新規レビューコメントなし」と報告して終了する（CODING_GUIDELINES.mdは更新しない）。

### ノイズ除外

スクリプト側で`isMinimized: true`の会話コメントは除外済みだが、以下も**ルール化対象から外す**（クラスタリング対象には含めるが、抽出条件の判断時に除外する）:

- PR作成者自身のコメント（セルフコメント・進捗報告）
- ボット起動コマンド（`/gemini review`等）やCIの自動投稿
- 「LGTM」「マージしてOK」等の承認のみのコメント
- 雑談・ねぎらい・絵文字のみのコメント

**完了条件**: スクリプトの実行結果が手元にあり、ルール化判断の対象となる「人間レビュアーからの修正要求コメント」が抽出できていること。

## フェーズ2: クラスタリングと対応要否判定

収集したコメント群を**意味ベース**でクラスタリングする。字面が違っても同種の指摘は同じクラスタにまとめ（例: 「nullチェックが漏れている」「`undefined`の可能性がある」「optional chainingを使うべき」→「null/undefined安全性」クラスタ）、逆に同じキーワードでも文脈が違えば別クラスタにする。

### クラスタ採用基準（**両方を満たすもののみ採用**）

1. **繰り返し出現**: 同種の指摘が**2回以上**（異なるPR / 異なるレビュアー / 異なる箇所）出現している
   - 同一PRで複数行に同じ指摘がある場合は「1回」として扱う（同一作者の同種指摘の重複は1カウント）
   - 異なるPR・異なるレビュアー間で発生していれば確実に2回以上とみなす

2. **対応すべき類型**: 以下のいずれかに該当する
   - バグ・正確性: ロジックエラー・不正動作・欠落エッジケース
   - セキュリティ脆弱性: 認証バイパス・XSS・SQLi・データ漏洩
   - 型安全性: 型エラー・unsafeキャスト・nullable処理漏れ
   - 破壊的変更・後方互換性: APIコントラクト違反・マイグレーション抜け
   - テストカバレッジ: 重要分岐の未テスト・モック過多
   - パフォーマンス: N+1・無限ループ可能性・重い同期処理
   - データ整合性: レースコンディション・バリデーション漏れ
   - Lint/ビルドブロッカー: パイプライン失敗を招く違反

### 採用しないもの

- 純粋なスタイル好み（フォーマット・改行・空白）
- 主観的な命名提案（既存規約に従っていれば）
- まだ必要のない抽象化提案（過剰設計）
- スコープ外のリファクタ提案
- 既存規約と矛盾する提案

出現1回の指摘は重要そうでも採用しない（再発時に改めて拾う）。「対応すべき類型」に含まれない繰り返し指摘も採用しない。

**完了条件**: クラスタごとに「何の問題か」「何回出現したか」「採用/不採用とその理由」「代表的なコメントURL（2件まで）」が言語化できていること。

## フェーズ3: CODING_GUIDELINES.md の生成・更新

### 既存ファイルがない場合

以下のテンプレートでリポジトリルートに新規作成する。

```markdown
# Coding Guidelines

このドキュメントは、過去のPRレビューで繰り返し指摘された観点をルール化したものです。
新規コード作成・既存コード修正時の自己レビューチェックリストとして参照してください。

## 更新ルール

- 同種の指摘が2回以上出現した場合のみルール化する
- ルールは「やるべきこと」を肯定形で書く
- 似た項目は統合し、ドキュメント全体のサイズを抑える
- 各ルールには代表的なPRコメントへのリンクを1〜2件添える

---

## <カテゴリ名>

### <ルールタイトル>

<ルール本文。1〜3行で簡潔に。「なぜ」を含める>

参考: [<PR番号 or 簡潔な説明>](<コメントURL>)
```

### 既存ファイルがある場合

採用クラスタごとに以下のいずれかを行う（ルール数の単調増加はドキュメントを死蔵させるため、意味重複があれば必ず統合する）:

1. **既存ルールと意味重複**: 既存ルールの本文を一般化して内包させる。本文を書き換え、参考リンクを追記する。**新規ルールとして追加しない**
2. **既存カテゴリに収まる新規ルール**: 該当カテゴリの末尾に新ルールを追加する
3. **新規カテゴリが必要**: ファイル末尾に新カテゴリを追加し、その下に新ルールを書く

### サイズ圧縮ルール（**毎回必ず適用**）

- **全体行数**: 300行を超えたら最も似ているルール同士を統合する（具体的な指摘より「何を守るべきか」を抽象化する方向で）
- **重複表現**: 同一カテゴリ内に「Aすべき」「Aを忘れない」「Aし忘れていないか」のような表現重複があれば1つにまとめる
- **参考リンク**: 1ルールあたり最大2件まで。古い順に削って2件に絞る
- **使われなくなった指摘**: 直近6ヶ月のレビューに同種の指摘が出現していなくても「廃止候補」の目印を付けず**そのままにする**（削除判断は別スキルの責務）

### 書き方の原則

- ルール本文は**肯定形**（「〜してください」「〜を必ず行う」）。「〜しないでください」より「代替を〜する」と書く方が行動につながる
- ルール1つにつき**1段落・最大3行**。長い場合はサブセクションに分割する
- **「なぜ」を含める**: 機械的な禁止ではなく、回避したい問題を1行で示す。例: 「null可能性を放置するとランタイムクラッシュを招くため、optional chainingまたは早期returnで処理する」
- **コード例は最小限**: 必要な場合のみ3〜5行で示す。長い例はリンク参照に留める

**完了条件**: `CODING_GUIDELINES.md`が更新されており、追加/変更したルール、統合・圧縮した既存ルール、ファイル全体の行数が把握できていること。

`git status`で差分が発生していなければ「ガイドライン更新差分なし」と報告してこのスキルを終了する（フェーズ4以降のコミット・PR作成は実行しない）。

## フェーズ4: feature branch への切替

`commit-push`はカレントブランチにコミット・pushするため、デフォルトブランチ上で実行すると本番ブランチに直コミットが入る。必ずfeature branchへ切り替える。

```bash
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

- `CURRENT_BRANCH = DEFAULT_BRANCH`の場合: `chore/update-coding-guidelines-$(date +%Y%m%d-%H%M%S)`形式のブランチを`git checkout -b`で作成して切り替える（同名が存在する場合は末尾サフィックスでユニーク化）
- `CURRENT_BRANCH ≠ DEFAULT_BRANCH`の場合: そのまま使用する（既に作業ブランチ上にいると判断）

切替後にもう一度`git status`で`CODING_GUIDELINES.md`が変更ファイルとして見えていることを確認する（ブランチ切替で差分が消えていないこと）。

**完了条件**: デフォルトブランチではない、かつ`CODING_GUIDELINES.md`の差分が見えるブランチ上にいること。

## フェーズ5: commit-push + create-pr

### 5-1. commit-push skillの呼び出し

`Skill`ツールで`commit-push`を引数なしで呼び出す（commit-push側がカレントブランチの差分とコミット履歴を自分で確認して戦略を選ぶ）。

### 5-2. create-pr skillの呼び出し

`Skill`ツールで`create-pr`を呼び出す。`create-pr`は`context: fork`のサブエージェントとして起動され本スキルの会話文脈は引き継がれないため、引数として渡せるのはIssue番号文字列のみ。

- フェーズ0でIssue番号が指定されていた場合: そのIssue番号を引数として渡す（`$0`に展開され、PR本文に`Closes #<Issue番号>`が記載される）
- 指定されていない場合: 引数なしで呼び出す。`create-pr`のテンプレートは無条件で`Closes #$0`を本文に入れるため、空展開の`Closes #`行が本文に残る（5-4で後処理する）

PR作成後、create-prが返却するPR URLを記録しておく。以降のフェーズでPR番号が必要な箇所は、この記録済みURLの末尾から抽出する（`PR_NUMBER="${PR_URL##*/}"`）。URLを取得できなかった場合はフェーズ5-3・5-4を実行せず、フェーズ6の出力に「PR URL未取得」と明記して終了する。

### 5-3. Assignee・ラベルの付与確認（**毎回必ず実行**）

`create-pr`側でもAssignee（`gh api user`のログインユーザー）と`cc-triage-scope`ラベルを付ける手順になっているが、`context: fork`で結果を検証できないため、本スキル側で実際に付いているかを確認し、欠けていれば`gh pr edit`で補う。

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）/ `get_me` を使う。以下は MCP 利用不可時のフォールバック。

```bash
PR_URL="<create-prが返却したPR URL>"
PR_NUMBER="${PR_URL##*/}"
[ -n "$PR_NUMBER" ] || exit 1  # PR_URL未取得時は実行せず中断（前掲の方針どおり）
GH_USER=$(gh api user --jq '.login')

# 現状を確認
gh pr view "$PR_NUMBER" --json assignees,labels \
  --jq '{assignees: [.assignees[].login], labels: [.labels[].name]}'

# 欠けていても冪等に付与できるため、そのまま実行してよい
gh pr edit "$PR_NUMBER" --add-assignee "$GH_USER" --add-label "cc-triage-scope"
```

- `--add-assignee` / `--add-label` は既に付与済みでもエラーにならないため、確認結果によらず実行してよい
- `cc-triage-scope`ラベルがリポジトリに存在せず`gh pr edit`が失敗する場合は、`gh label create cc-triage-scope`で作成してから再実行する
- Assignee付与が権限等で失敗してもPR作成自体は成功しているため、フェーズ6の出力に「Assignee付与失敗」と明記して続行する

### 5-4. Issue番号なしのケースの後処理（**Issue番号が未指定の場合のみ実行**）

`create-pr`が残した`Closes #`（数字なし）行を削除する。

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。

```bash
PR_URL="<create-prが返却したPR URL>"
PR_NUMBER="${PR_URL##*/}"
[ -n "$PR_NUMBER" ] || exit 1  # PR_URL未取得時は実行せず中断（前掲の方針どおり）
gh pr view "$PR_NUMBER" --json body --jq '.body' \
  | sed -E '/^Closes #[[:space:]]*$/d' \
  | gh pr edit "$PR_NUMBER" --body-file -
```

正規表現は行末（`$`）まで`#`の後ろに数字がないことを条件にしているため、数字付きの`Closes #123`は削除されない。Issue番号が指定されていたケースではこのステップはスキップする。

**完了条件**: PRが作成されており、PR URLが手元にあり、Assignee（自分自身）と`cc-triage-scope`ラベルが付与済みで、Issue番号未指定ケースでは本文の`Closes #`空行が削除されていること。

## フェーズ6: 出力

呼び出し元に以下を構造化して返す。

```markdown
## 収集結果
- 期間: <SINCE> 〜 現在
- 対象PR数: <n>
- 抽出した指摘クラスタ数: <m>（うち採用 <k> 件）

## CODING_GUIDELINES.md 更新サマリ
- ファイル: <新規作成 / 既存更新>
- 追加ルール: <n>件
  - <カテゴリ>: <ルールタイトル>（出典PR: #<num1>, #<num2>）
- 統合・圧縮した既存ルール: <n>件
  - <旧ルールタイトル> ← <新指摘> として一般化
- 更新後の総行数: <n>行（前回: <n>行）

## 採用しなかったクラスタ（参考）
- <クラスタ名>: <理由（出現1回のみ / スタイル好みのため 等）>

## PR
- ブランチ: <feature branch名>
- PR URL: <URL>
- Assignee: <ログインユーザー名>（付与失敗時はその旨と理由）
- ラベル: cc-triage-scope（付与失敗時はその旨と理由）
- 関連Issue: #<num>（指定なしの場合は「なし」）
```

## 注意事項

- **差分なしならPR作成スキップ**: フェーズ3完了時点で差分がなければフェーズ4以降を実行しない（空コミット・空PRを作らない）
- **作業対象はリポジトリルートのみ**: worktreeで実行する場合、対象は当該worktreeのルートにある`CODING_GUIDELINES.md`とする
