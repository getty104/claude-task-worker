---
name: update-design-md
description: 直近N日（デフォルト1日）にマージされた `cc-ui-design` ラベル付きPR（UIデザインPR）から確定したビジュアルアイデンティティ（カラー・タイポグラフィ・スペーシング・コンポーネント）をリポジトリルートの `DESIGN.md`（google-labs-code/design.md フォーマット）へ集約・更新し、`design.md` CLI の lint を通してから commit-push + create-pr でPRを作成する（`cc-triage-scope` ラベル + 自分自身をAssignee）。`DESIGN.md` は pencil-design-updater がデザイン時の前提として読み込む。
disable-model-invocation: true
argument-hint: "[期間（日数、省略時は1）] [関連Issue番号（任意）]"
allowed-tools: Bash(gh:*), Bash(git:*), Bash(jq:*), Bash(bash:*), Bash(pencil:*), Bash(claude-task-worker:*), Bash(designmd:*), Bash(npx:*), Bash(pwd), Bash(ls:*), Bash(date:*), Bash(wc:*), Bash(mkdir:*), Bash(find:*), Read, Write, Edit, Glob, Grep, Agent, Skill
hooks:
  Stop:
    - matcher: ""
      hooks:
        - type: command
          command: node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-servers.mjs"
---

# Update DESIGN.md

収集 → デザイン判断の抽出 → `DESIGN.md` の作成・更新 → lint 通過 → PR作成まで一貫して実行する。フォーマットは [google-labs-code/design.md](https://github.com/google-labs-code/design.md) の仕様（YAML フロントマターのデザイントークン + マークダウン本文の設計意図）に従う。

## なぜこれをやるのか

デザインPRごとの決定がレビューコメントと `.pen` の中身にしか残らないと、次のデザインが過去の決定を知らずに別の値を使い、デザインシステムが画面ごとに分岐し、実装側もどれが正か判断できない。`DESIGN.md` は**エージェントが読める単一の正**で、`pencil-design-updater` は次のデザインをその前提の上で作る。裏を返すと、**肥大化・陳腐化すると逆効果**（読み込みコストが上がり、現実と食い違うトークンが誤ったデザインを生む）ため、「追加」と同じ重みで「統合・上書き・削除」を行う。

## このスキルがやること・やらないこと

**やること**: 直近N日にマージされた `cc-ui-design` ラベル付きPRの収集（レビューコメント・会話コメント・変更ファイル一覧）／`.pen` の実データ（トークン値）の読み取り専用調査（`inspect-pencil-node`）とスナップショット画像の確認／リポジトリルート `DESIGN.md` の作成・更新（トークンと設計意図）／`designmd lint` のエラー・警告解消／`commit-push` でのコミット・push（必要なら専用feature branchへ切替）／`create-pr` でのPR作成 + Assignee（自分自身）と `cc-triage-scope` ラベルの付与／追加・上書き・削除の差分サマリ報告

**絶対にやらないこと**:
- **収集対象の** PR / Issue への書き込み（コメント・ラベル・再オープンなど。収集は読み取りのみ。フェーズ7で自分が作成したPRへラベル・Assigneeを付けるのはこの制限の対象外）
- `DESIGN.md` 以外のファイルの編集（`.pen`・ソースコード・`CODING_GUIDELINES.md`・`.claude/requirements/` を含む。`claude-task-worker.json` は `uiDesign.designDir` の読み取りだけに使い、`lastRun` は `claude-task-worker` ワーカーが別PRで更新するため書き換えない）
- **`.pen` の編集**（`save()` を呼ぶ操作）。調査は `inspect-pencil-node` の読み取り専用手順のみ。デザイン側の修正が必要と判断した場合も、報告に1行挙げるだけにする
- 実データの裏付けがない値の記載（「よくある値」で埋めない。読み取れなかった項目は書かない。推測値は、次のデザインがそれに合わせて作られた時点で「正」になってしまう）
- 1つのPRでしか使われていない画面固有の装飾のトークン化（後述の採用基準）
- デフォルトブランチ上での直接コミット（必ずfeature branchに切り替えてから `commit-push` を呼ぶ）

---

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **GitHub MCP を優先し、利用不可なら `gh` コマンドへフォールバックする**。判定手順・`gh` → MCP の対応表・`gh` のまま残す操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する（本文中の `gh` コマンド例は、対応表に該当するものについてはフォールバック手段として読むこと）。

## 実行モードの制約

本スキル固有のリスク: 本スキルは `claude-task-worker` の `update-design-md` ワーカーから24時間おきに自動起動され（`uiDesign.enabled` が `true` のリポジトリのみ）、ワーカーは起動時刻を `claude-task-worker.json` の `lastRun` へ記録する別PRを作ったうえで、次の24時間の実行を抑止する。処理が未完のままターンを終えると、その日の分の収集・トークン化が行われないまま実行済みとして扱われ、取りこぼしたデザインPRは二度と対象期間に入らない（対象期間は常に直近N日で、遡らない）。

## フェーズ0: 事前チェック・引数パース

### リポジトリと既存ファイルの確認

- `git rev-parse --show-toplevel` の出力とカレントディレクトリの一致を確認する。一致しなければ「リポジトリルートで実行してください」と返して終了する
- リポジトリルートの `DESIGN.md` が存在すれば `Read` で全文読み込み、現在のトークン構成・セクション構成・記法を把握する（以降「既存 DESIGN.md」）
- `claude-task-worker.json` があれば `uiDesign.designDir` を読み（未設定なら `designs`）、`.pen` の探索先として控える

### `design.md` CLI の解決（フェーズ5で必ず使う）

```bash
if designmd --version >/dev/null 2>&1; then
  DESIGN_MD_CMD="designmd"
elif npx -y -p @google/design.md designmd --version >/dev/null 2>&1; then
  DESIGN_MD_CMD="npx -y -p @google/design.md designmd"
else
  DESIGN_MD_CMD=""
fi
```

- `designmd` はグローバルインストール（`claude-task-worker install` / `update` が `npm install -g @google/design.md@latest` を実行する）で入る。同パッケージの bin は `design.md` と `designmd` の2つだが、`.` を含む前者は環境（特にWindowsの拡張子関連付け）と衝突しうるため **`designmd` を既定で使う**。npx フォールバックも `-p @google/design.md designmd` の形でパッケージ名とbin名を分離し、dotフリーの `designmd` だけを呼ぶ
- どちらも使えない場合（`DESIGN_MD_CMD` が空）も作業は続行してよいが、フェーズ5の lint は実行できない。その場合はフォーマット仕様（フェーズ4）に手作業で厳密に従い、**「lint 未実行」をフェーズ8の報告とPR本文に必ず明記する**（lint 済みと誤認されると、壊れた `DESIGN.md` が後続のデザインの前提になる）

### 引数パース

`$ARGUMENTS` を空白区切りで最大2トークンに分解する。

- 1番目: 期間（日数）。省略時または非数値の場合は `1`
- 2番目: 関連Issue番号（任意）。`#` プレフィックスは除去して数値部分のみ保持

例: `/update-design-md` → 日数=1, Issue番号=なし ／ `/update-design-md 14 #123` → 日数=14, Issue番号=123

Issue番号はフェーズ7で `create-pr` に渡す。指定なしの場合はPR本文の `Closes #N` 行を省略する。

**完了条件**: リポジトリルートにいることが確認でき、既存 `DESIGN.md`（あれば）の内容を把握済みで、`DESIGN_MD_CMD` と日数・任意Issue番号が確定していること。

## フェーズ1: デザインPRの収集

GitHub MCP が使える場合は対応表のツール（`list_pull_requests` / `search_pull_requests` / `pull_request_read` 等）で同等の収集を行い、下記「MCP経路の `output_file` 契約」に従って自分で `output_file` を作る。以下のスクリプトは MCP 利用不可時のフォールバックとして使う。

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/fetch-recent-ui-design-prs.sh <フェーズ0で確定した日数>
```

第1引数には日数のみを渡す（`$ARGUMENTS` をそのまま渡すとIssue番号トークンが余計な引数になる）。

stdout に返るのは**インデックスJSONのみ**で、コメント全文は `output_file` のパスに書き出されている。インデックスの構造:

- `period_since` / `repo` / `label` / `pr_count` / `output_file`
- `prs[]`: `pr_number` / `pr_title` / `merged_at` / `base_ref` / `head_ref` / `related_issues` / `pen_files` / `snapshot_files` / `other_file_count` / `review_comment_count` / `conversation_comment_count` / `comment_chars`

`pr_count` が0の場合は「対象期間にマージ済みデザインPRなし」と報告して終了する（`DESIGN.md` は更新しない）。

### MCP経路の `output_file` 契約

MCP経路でもフェーズ2以降（`jq` でのPR単位読み出し、`merge_commit` によるファイル復元）はフォールバック経路と同じ手順を使うため、**`output_file` に書き出すJSONの構造（キー名・値の意味）をフォールバックスクリプトと完全に一致させる**。

1. `list_pull_requests` / `search_pull_requests`（`state: closed`, `label: cc-ui-design`, `sort: updated` 等でマージ日時降順に絞り込み）で対象PR番号を確定する（マージ済みのみ。`merged_at` が null のものは除外）
2. PRごとに `pull_request_read`（`get`）で本文・メタデータ、`get_files` で変更ファイル一覧、`get_review_comments` でレビュースレッド、`get`（もしくは Issue コメント相当）で会話コメントを取得する
3. 取得した内容から、PRごとに次のオブジェクトを組み立てる（フォールバックスクリプトの `fetch_pr` が生成する構造と同一）:
   - `pr_number` / `pr_title` / `pr_url` / `pr_body`（本文、なければ `""`）/ `pr_author`（作成者ログイン、不明なら `"unknown"`）/ `merged_at` / `merge_commit`（マージコミットSHA、取得不能なら `null`）/ `base_ref` / `head_ref` / `labels`（名前の配列）/ `related_issues`（closing issue の `{number, title}` 配列。REST に同等資源が無いため PR本文の closing keyword から導出する経路では、GitHub UI で手動リンクされた closing 参照は含まれない）
   - `pen_files`: 変更ファイルパスのうち `.pen` で終わるもの
   - `snapshot_files`: `.pen` ではなく、パスに `snapshots/` を含み、拡張子が `png`/`jpg`/`jpeg`/`webp`/`gif`/`svg`（大小文字無視）のもの
   - `other_files`: 上記2つに該当しない残り
   - `review_comments[]`: レビュースレッドの各コメントを `{path, line, is_resolved, is_outdated, author, body, url, created_at}` に展開（`path`/`line` はスレッド単位の値をコメントへ複写。`is_resolved` は GraphQL が使えない環境（クラウド）では `null` になりうる）
   - `conversation_comments[]`: 会話コメントのうち非表示（minimized）ではないものを `{author, body, url, created_at}` に展開
4. 全PR分を `merged_at` 降順に並べ、`{period_since, repo, label, pr_count, output_file, prs: [...]}` の形に組んで `Write` ツールでファイル（例: スクラッチパス配下の一時ファイル）へ書き出す。`period_since` はフェーズ0で確定した日数から算出したISO8601、`output_file` は書き出し先自身の絶対パス、`pr_count` は `prs` の件数
5. 以降の手順（フェーズ1「本文の読み出し」・フェーズ2の `merge_commit` によるファイル復元）は、この `output_file` を `<output_file>` として同じ `jq` コマンドでそのまま使う

`pr_count` が0の場合の扱いはフォールバック経路と同じ（「対象期間にマージ済みデザインPRなし」と報告して終了、`DESIGN.md` は更新しない）。

### 本文の読み出し

```bash
# 1件だけ読む
jq '.prs[] | select(.pr_number == 123)' <output_file>

# レビューコメントと会話コメントだけをまとめて読む
jq -r '.prs[] | select(.pr_number | IN(101,102,103)) |
  "=== #\(.pr_number) \(.pr_title)\n\(.pr_body)\n--- review ---\n" +
  ([.review_comments[] | "[\(.author)] \(.path):\(.line // "-")\n\(.body)"] | join("\n\n")) +
  "\n--- conversation ---\n" +
  ([.conversation_comments[] | "[\(.author)] \(.body)"] | join("\n\n"))' <output_file>
```

**分割して読まない**。フェーズ2の統合は「複数のデザインPRで繰り返し使われている値」を見つける作業であり、全PRが1つの文脈に載っていないと「1回きりの値」と「デザインシステムの値」を区別できない。残コンテキストで読み切れない場合のみ、`general-purpose-assistant` サブエージェントへPR単位で担当させ、**具体的な値（色コード・px値・フォント名）を逐語で**返させる（要約させると値が丸められてトークンにできない）。

**完了条件**: 対象PRのレビューコメント・会話コメント・変更ファイル一覧を把握していること。

## フェーズ2: `.pen` の更新内容の調査

`.pen` は暗号化バイナリのため `Read` / `Grep` では中身が見えず、**diff からは何も読み取れない**。必ず以下の2経路で実データに当たる。

### 2-0. マージコミット時点のファイルを一時ディレクトリへ復元する

**現在のワークツリーの内容をそのまま調査対象にしてはいけない**。ワークツリーは「対象期間の最後の状態」でしかなく、あるPRのマージ後に別のPRが同じ `.pen` / スナップショットを変更していれば、古いPRの出典に新しいPRの値を誤って紐づけてしまう。各PRの調査は必ずそのPRの `merge_commit` 時点の内容に対して行う。

`merge_commit`（`mergeCommit.oid`）はインデックスJSONには含まれず、フェーズ1の `output_file`（完全版）にのみ含まれる。

```bash
jq '.prs[] | {pr_number, merge_commit, pen_files, snapshot_files}' <output_file>
```

PRごとに一時ディレクトリへ復元する:

```bash
TMPDIR_DESIGN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_DESIGN"' EXIT

mkdir -p "$TMPDIR_DESIGN/<pr_number>"
git show "<merge_commit>:<path>" > "$TMPDIR_DESIGN/<pr_number>/$(basename <path>)"
```

`pen_files` / `snapshot_files` の各パスに対してこれを繰り返す。`git show` が失敗する場合（マージコミットが取得できない・shallow cloneで対象コミットが無い・その後のPRでファイル自体が削除された等）はそのファイルの復元をスキップし、失敗した旨と理由をフェーズ8の報告に残す。以降の 2-1 / 2-2 は、復元できたファイルだけを対象にする（現在のワークツリー上のパスは調査対象にしない）。

### 2-1. スナップショット画像（まず最初に見る）

2-0 で復元した `snapshot_files`（Pencilのエクスポート結果PNG）を `Read` で**画像として**開き、全体の配色・タイポグラフィの雰囲気・レイアウトの粒度を把握する。ここで得られるのは「傾向」であり、正確なトークン値は 2-2 で取る。

### 2-2. Node属性の読み取り（正確なトークン値の取得元）

2-0 で復元した `pen_files` を対象に、`Skill` ツールで `inspect-pencil-node` を起動して読み取り専用で属性を取得する（`merge_commit` 時点の内容をそのまま復元しているだけなので Pencil CLI で通常どおり開ける）。

取得すべきもの（`inspect-pencil-node` の `execute` + `Get` visitor の指定方法を使い分ける。CLI 0.3.5 では読み取りも画像出力も `execute` に一本化されている）:

- **再利用可能コンポーネント**（`Get(n => n.reusable && Print(...))`）— デザインシステムのコンポーネント定義そのもの。最優先
- **テキストNode**（`Get(n => n.type === "text" && Print(...))`）— `fontFamily` / `fontSize` / `fontWeight` / `lineHeight` / `letterSpacing` の実値
- **トップレベル / フレーム**（`Get((n, c) => { c.skipChildren(); Print(...) })`、または `Get(n => n.type === "frame" && Print(...))`）— 背景色・枠線・角丸（`rounded`）・パディング（`spacing`）の実値

`pencil` CLI が未インストール・未認証で調査できない場合は、そこで打ち切って 2-1 のスナップショットから読み取れた範囲だけを使い、**「`.pen` の属性値は未取得」であることを報告に明記する**（推測値でトークンを埋めない）。

**完了条件**: 実データに基づく色・タイポグラフィ・スペーシング・角丸・コンポーネントの候補値が、出典（PR番号 / `merge_commit` / `.pen` パス / Node名）付きで手元にあること。一時ディレクトリは調査完了後（`trap` により正常終了・異常終了のいずれでも）削除される。

## フェーズ3: デザイン判断の抽出

フェーズ1のコメントとフェーズ2の実データから、**再利用可能なデザイン判断**を抽出する。

### 何を拾うか

- **トークン値**: 繰り返し現れる色・フォント・サイズ・余白・角丸の実値（`.pen` の実データが根拠）
- **役割の割り当て**: どの色を primary / secondary / tertiary / neutral のどれとして使うか、どのタイポグラフィをどの用途に使うか
- **レビューで確定した原則**: 「〜は使わない」「〜の場合は〜にそろえる」というレビュー指摘とその解決。**指摘そのものではなく、そこから確定した一般則**を拾う
- **コンポーネントの構成**: ボタン・カード・入力欄などの背景色・文字色・角丸・余白の組み合わせ

### 拾わないもの

- そのPR固有の実装事実（Node ID・ファイルパス・PR番号そのもの）
- まだ決着していない議論・保留になったコメント
- 1画面にしか出てこない装飾（採用基準を満たさないもの）
- レビューの経緯（`DESIGN.md` は設計基準であって議事録ではない）

### 採用基準

以下の**いずれか**を満たす値・原則を採用する:

1. **反復**: 2つ以上のデザインPR、または1つのPR内の2つ以上の独立した画面・コンポーネントで同じ値・同じ原則が使われている
2. **明示された一般方針**: 1回しか現れなくても、レビューコメントやPR本文が「今後は〜」「全画面で〜にそろえる」のように**そのPRを超える適用範囲を明示**している
3. **基盤トークン**: 出現が1回でも、`primary` カラー・本文タイポグラフィのように**デザインシステムの土台になり、欠けると後続のデザインが判断できなくなる**もの

基準1〜3のいずれにも当てはまらず迷う場合は採用しない。次のデザインPRで同じ値が現れたときに改めて拾えばよく、根拠の薄いトークンを置くほうが害が大きい（`pencil-design-updater` がそれを前提にデザインを作ってしまう）。

### 既存 DESIGN.md との突き合わせ

**既存 `DESIGN.md` が無い初回実行では、この突き合わせを丸ごとスキップする**（全件が自明に「新規」になる）。スキップした旨をフェーズ8の報告に1行残す。

既存がある場合は、抽出した各項目を次のいずれかに分類する:

- **新規**: 既存トークン・既存セクションに対応するものがない
- **統合**: 既存トークンと実質同じ値・同じ役割 → 既存トークンを使い、新規トークンを追加しない（**近い値ほど統合を疑う**。`#1A1C1E` と `#1A1C1F` が別トークンとして並ぶのはデザインシステムの崩壊の始まり）
- **上書き**: 既存トークンと**同じ役割で違う値**が新しいPRで確定している → 既存の値を新しい値へ書き換える。判断がつかない場合は既存を維持し、フェーズ8の報告に「要確認」として1行挙げる
- **不採用**: 採用基準を満たさない

**完了条件**: 項目ごとに「トークン名（または原則） / 値 / 役割 / 出典PR / 新規・統合・上書き・不採用の別」が確定していること。

## フェーズ4: `DESIGN.md` の更新

配置先はリポジトリルートの `DESIGN.md` 固定（`pencil-design-updater` がこのパスを読む）。既存があれば `Edit` で部分更新し、無ければ `Write` で新規作成する。

### ファイル構造

`DESIGN.md` は **YAML フロントマター（機械可読なトークン）** と **マークダウン本文（人間・エージェント向けの設計意図）** の2層で構成する。

```markdown
---
version: alpha
name: <デザインシステム名>
description: <1行>
colors:
  primary: "#1A1C1E"
  secondary: "#6C7278"
  neutral: "#FFFFFF"
typography:
  h1:
    fontFamily: Public Sans
    fontSize: 48px
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: -0.02em
  label-md:
    fontFamily: Public Sans
    fontSize: 14px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: 0em
spacing:
  sm: 8px
  md: 16px
rounded:
  md: 8px
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    typography: "{typography.label-md}"
---

# <デザインシステム名>

## Overview
...
```

### YAML フロントマターの規則

- フロントマターは**ファイル先頭**に置き、開始・終了とも `---` のみの行にする
- トップレベルキー: `version`（`alpha`）/ `name` / `description` / `omitted` / `colors` / `typography` / `spacing` / `rounded` / `components`。**これ以外のキーを増やさない**（lint が「認識されないキーは無視される」と警告する）
- **色**: CSS のカラー文字列。`#RRGGBB` を既定にする。`primary` は必須（無いと lint が警告する）
- **タイポグラフィ**: `fontFamily` / `fontSize` / `fontWeight` / `lineHeight` / `letterSpacing`。`fontSize` / `letterSpacing` は `px` / `em` / `rem` のいずれかの単位付き文字列。`lineHeight` は単位付き文字列か**単位なし数値（推奨。fontSize の倍率）**
- **spacing / rounded**: `xs` / `sm` / `md` / `lg` / `xl` のようなスケール名をキーにした単位付き文字列
- **components**: コンポーネント名をキーに、`{colors.primary}` の形式で他トークンを参照する。**参照は必ず実在するトークンを指す**（壊れた参照は lint の error）
- **定義したトークンはどこかで参照させる**（本文かコンポーネントで使わないと「orphaned token」警告になる）
- **意図的に持たないセクション**は `omitted` に列挙して警告を抑止する（理由も書ける）:
  ```yaml
  omitted:
    - spacing
    - section: rounded
      reason: "角丸を使わないデザイン方針のため"
  ```

### マークダウン本文の規則

セクションは `##` 見出しで、**次の順序**で書く（存在するものだけ書けばよいが、順序を崩すと lint が警告する）:

1. **Overview**（別名: Brand & Style）— ブランドの性格・想定ユーザー・UIが与えるべき印象
2. **Colors** — 各パレットの役割と使いどころ
3. **Typography** — フォントの選定理由と各レベルの用途
4. **Layout**（別名: Layout & Spacing）
5. **Elevation & Depth**（別名: Elevation）
6. **Shapes**
7. **Components**
8. **Do's and Don'ts**

本文の書き方:

- **トークンが正、本文は根拠**。本文には「なぜその値なのか」「どういう場面で使うのか」を書く。値の羅列を本文で繰り返さない（両方に書くと片方だけ更新されて食い違う）
- **各セクション本文は最大6文**。超えるならデザインシステムではなく画面仕様を書いている
- **「Do's and Don'ts」にはレビューで確定した禁止事項を書く**（フェーズ3で拾った一般則の置き場所）。指摘の引用ではなく規則の形（「〜する」「〜しない」）で書く
- 出典PR番号は本文に散らさず、末尾の HTML コメントに1行でまとめる（lint の対象外で、次回実行時の突き合わせに使える）:
  ```markdown
  <!-- sources: #101, #104, #109 (updated: 2026-08-01) -->
  ```

### 整理・圧縮（既存 `DESIGN.md` がある場合は**毎回必ず適用**）

- **近似トークンの統合**: 知覚できない差の色・1px差のサイズは1つに寄せ、寄せた側を全参照元から差し替える
- **未参照トークンの削除**: どのコンポーネント・本文からも参照されていないトークンは削除する（lint の orphaned token 警告と一致させる）
- **陳腐化の上書き**: より新しいPRで**同じ役割に違う値**が確定していれば上書きする。「最近使われていない」は削除理由にならない（安定して守られている値ほど再言及されない）
- **本文の圧縮**: 前置き・言い換え・「なお」「また」での継ぎ足しを削る

**完了条件**: `DESIGN.md` が更新され、追加・統合・上書き・削除したトークン数を把握できていること。

`git status` で差分が発生していなければ「DESIGN.md 更新差分なし」と報告してこのスキルを終了する（フェーズ5以降は実行せず、空コミット・空PRを作らない）。

## フェーズ5: lint 通過（`DESIGN_MD_CMD` が使える場合は**必須**）

```bash
$DESIGN_MD_CMD lint --format json DESIGN.md
```

出力は `findings[]`（`severity` / `path` / `message` / `rule`）と `summary`（`errors` / `warnings` / `infos`）。終了コードは `error` の有無だけを表す（`0` = error なし、`1` = error あり、`2` = ファイルが読めない）ため、error/warning が0件かどうかの判定は `jq '.summary'` で `summary.errors` / `summary.warnings` を見る（warning は終了コードに現れないため、残 warning の扱いは常に `summary.warnings` で判断する）。

- **error は1件残らず解消する**（壊れた/循環したトークン参照、未知のコンポーネントサブトークン）
- **warning も原則すべて解消する**。解消手段は2つ: 実データに基づいて値・構成を直すか、意図的な省略なら `omitted` に理由付きで登録する。**「実データが無いので埋められない」項目を warning 潰しのためだけに捏造しない** — その場合は `omitted` を使う
  - `primary` カラー欠落 → `colors.primary` を定義する
  - タイポグラフィ欠落 → `typography` を定義するか `omitted` に入れる
  - WCAG コントラスト比 4.5:1 未満 → **値を変えず、まず出典を確認する**。デザインの実値がそうなっているなら、勝手に色を変えず `DESIGN.md` はそのままにし、フェーズ8の報告に「コントラスト比不足の指摘あり（対象: <component>、比率: <n>）」として挙げる（デザインの是非は人が決める）
  - orphaned token → 本文またはコンポーネントから参照させるか、トークン自体を削除する
  - セクション順序 → 上記の正順に並べ替える
  - 未知のトップレベルキー → 削除するか正しいキー名へ直す
- **info は放置してよい**（トークン数サマリ・省略セクションの通知）
- 修正 → 再 lint の反復は**最大5回**。5回で解消しない warning は、残っている内容と解消しない理由をフェーズ8の報告に明記して先へ進む（error が残っている場合のみ、PRを作らずそこで報告して終了する）

**完了条件**: lint の error が0件で、残った warning とその理由が把握できていること。`DESIGN_MD_CMD` が空の場合は「lint 未実行」を確定させたこと。

## フェーズ6: feature branch への切替

`commit-push` はカレントブランチにコミット・pushするため、デフォルトブランチ上で実行すると本番ブランチへ直コミットが入る。必ずfeature branchへ切り替える。

```bash
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
```

- `CURRENT_BRANCH = DEFAULT_BRANCH` の場合: `chore/update-design-md-$(date +%Y%m%d-%H%M%S)` 形式のブランチを `git checkout -b` で作成して切り替える（同名が存在する場合はサフィックスでユニーク化）
- `CURRENT_BRANCH ≠ DEFAULT_BRANCH` の場合: そのまま使用する

切替後に `git status` で `DESIGN.md` の差分が残っていることを確認する。

**完了条件**: デフォルトブランチではない、かつ差分が見えるブランチ上にいること。

## フェーズ7: commit-push + create-pr

### 7-1. commit-push skill の呼び出し

`Skill` ツールで `commit-push` を引数なしで呼び出す（commit-push 側がカレントブランチの差分と履歴を見て戦略を選ぶ）。

### 7-2. create-pr skill の呼び出し

`Skill` ツールで `create-pr` を呼び出す。`create-pr` は `context: fork` のサブエージェントとして起動され本スキルの文脈を引き継がないため、渡せるのはIssue番号文字列のみ。

- フェーズ0でIssue番号が指定されていた場合: そのIssue番号を引数として渡す（PR本文に `Closes #<番号>` が入る）
- 指定されていない場合: 引数なしで呼び出す（空展開の `Closes #` 行が残るため 7-4 で後処理する）

PR作成後、返却されたPR URLを記録する。以降のフェーズでPR番号が必要な箇所は、この記録済みURLの末尾から抽出する（`PR_NUMBER="${PR_URL##*/}"`）。URLを取得できなかった場合はフェーズ7-3・7-4を実行せず、フェーズ8の出力に「PR URL未取得」と明記して終了する。

### 7-3. Assignee・ラベルの付与確認（**毎回必ず実行**）

`create-pr` 側でも付与手順はあるが、`context: fork` で結果を検証できないため本スキル側で確認・補完する。

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）/ `get_me` を使う。以下は MCP 利用不可時のフォールバック。

```bash
PR_URL="<create-prが返却したPR URL>"
PR_NUMBER="${PR_URL##*/}"
[ -n "$PR_NUMBER" ] || exit 1  # PR_URL未取得時は実行せず中断（前掲の方針どおり）
GH_USER=$(gh api user --jq '.login')

gh pr view "$PR_NUMBER" --json assignees,labels \
  --jq '{assignees: [.assignees[].login], labels: [.labels[].name]}'

gh pr edit "$PR_NUMBER" --add-assignee "$GH_USER" --add-label "cc-triage-scope"
```

- `--add-assignee` / `--add-label` は付与済みでもエラーにならないため、確認結果によらず実行してよい
- `cc-triage-scope` ラベルが存在せず失敗する場合は `gh label create cc-triage-scope` を実行してから再試行する
- Assignee付与が権限等で失敗してもPR作成自体は成功しているため、フェーズ8の出力に「Assignee付与失敗」と理由を明記して続行する
- **`cc-ui-design` ラベルは付けない**。このPRはデザインPRではなくドキュメント更新PRであり、付けると次回実行時に自分自身を収集対象にしてしまう

### 7-4. Issue番号なしのケースの後処理（**Issue番号未指定の場合のみ**）

> GitHub MCP が使える場合は `pull_request_read`（method: `get`）を使う。以下は MCP 利用不可時のフォールバック。

```bash
PR_URL="<create-prが返却したPR URL>"
PR_NUMBER="${PR_URL##*/}"
[ -n "$PR_NUMBER" ] || exit 1  # PR_URL未取得時は実行せず中断（前掲の方針どおり）
gh pr view "$PR_NUMBER" --json body --jq '.body' \
  | sed -E '/^Closes #[[:space:]]*$/d' \
  | gh pr edit "$PR_NUMBER" --body-file -
```

行末（`$`）まで数字がないことを条件にしているため、正常な `Closes #123` は削除されない。

**完了条件**: PRが作成され、URLが手元にあり、Assignee と `cc-triage-scope` ラベルが付与済みで、Issue番号未指定ケースでは空の `Closes #` 行が削除されていること。

## フェーズ8: 出力

```markdown
## 収集結果
- 期間: <period_since> 〜 現在（<日数>日）
- 対象デザインPR数: <n>（#<num>, #<num>, ...）
- `.pen` 調査: <調査したファイル数>件 / スナップショット確認: <n>枚（調査不能だった場合はその理由）
- 初回実行（既存 DESIGN.md なし）の場合はその旨と、突き合わせ・整理圧縮をスキップした旨

## DESIGN.md 更新サマリ
- 新規トークン: <n>件
  - `colors.primary`: `#1A1C1E`（出典: #<num>）
- 統合: <n>件
  - `colors.ink` ← `colors.ink-alt`（`#1A1C1F` は知覚差なしのため統合）
- 上書き: <n>件
  - `typography.body.fontSize`: 15px → 16px（根拠: #<num>）
- 削除: <n>件
  - `colors.accent-old`（未参照）
- 本文セクション: <更新したセクション名の列挙>
- トークン合計: colors <n> / typography <n> / spacing <n> / rounded <n> / components <n>

## lint 結果
- 実行コマンド: <DESIGN_MD_CMD> lint --format json DESIGN.md（未実行の場合は「lint 未実行（CLI 利用不可）」と理由）
- error: 0件
- 残った warning: <なし / 内容と解消しない理由>

## 採用しなかった項目（参考）
- <値・原則>: <理由（1画面のみの装飾で反復なし 等）>

## 要確認（人の判断が必要）
- <既存と新しい値が衝突して自動で決められなかった項目 / コントラスト比不足の指摘 等。なければ「なし」>

## PR
- ブランチ: <feature branch名>
- PR URL: <URL>
- Assignee: <ログインユーザー名>（失敗時はその旨と理由）
- ラベル: cc-triage-scope（失敗時はその旨と理由）
- 関連Issue: #<num>（指定なしなら「なし」）
```

---

## 注意事項

- **値は必ず実データ由来**: `.pen` の Node 属性かスナップショット画像から読み取った値だけを書く
- **統合を追加より優先**: トークン数の単調増加はデザインシステムの分岐そのもの。近い値は疑ってかかる
- **自分のPRに `cc-ui-design` を付けない**（フェーズ7-3参照）
