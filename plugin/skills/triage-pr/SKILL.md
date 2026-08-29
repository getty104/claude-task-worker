---
name: triage-pr
description: Triage a single GitHub PR by PR number. Check out the PR's branch, detect conflicts with the target branch via `gh pr status` (and label the PR with `cc-resolve-conflict` if any are found), collect unresolved review comments and CI status and judge only whether each item must be fixed, then take action (add cc-fix-onetime label if fixes are needed; if release-ready, add cc-release-ready label for an Epic PR marked `cc-epic-issue` instead of merging, otherwise merge the PR).
argument-hint: "[pr-number]"
hooks:
  Stop:
    - matcher: ""
      hooks:
        - type: command
          command: node "${CLAUDE_PLUGIN_ROOT}/scripts/stop-servers.mjs"
---

# Triage PR

指定されたPR番号のPRに対して、コンフリクト検知から修正要否の判定、最終アクション（ラベル付与またはマージ）までを一貫して実行するスキルです。

## このスキルがやること・やらないこと

**やること**:
- ステップ1のコンフリクト検知（`gh pr status`で確認し、コンフリクトがあれば`cc-resolve-conflict`ラベル付与のみで終了）
- ステップ2の未解決レビューコメント・CIステータスの収集と、各項目が「修正すべきか」の二分判定のみ
- ステップ3のアクション: 修正が必要なら`cc-fix-onetime`ラベル付与 / マージ可能なら、Epic PR（`cc-epic-issue`付き）は`cc-release-ready`ラベル付与（マージしない）、通常PRはマージ / CI失敗が差分の変更では直せない場合は失敗ジョブの1回だけの再実行（C-1）を経て`cc-need-human-check`ラベル付与＋理由コメント投稿（C-2）

**絶対にやらないこと**:
- **PRのコード修正・実装**: 「対応すべき」と判定された項目があってもコードを変更しない。修正の実行は`cc-fix-onetime`付与後の別スキル（`fix-review-point`など）の責務
- **コンフリクト解消の直接実行**: rebase・コンフリクトファイルの編集・force-pushは行わない。検知したら`cc-resolve-conflict`を付けて終了し、解消は同ラベルをトリガーに別スキル（`resolve-pr-conflict`等）が担当する
- **修正プランの作成**: `create-review-fix-plan` スキルを呼び出してはならない。修正方針・タスク分解・影響範囲の見積もりは `cc-fix-onetime` を拾う `fix-review-point` 側の責務であり、ここで作ると同じ分析をPRごとに二重に行いトークンを無駄に消費する。本スキルは「修正すべきコメントが1件でもあるか」だけを判定する
- **新規コミットの作成**: コミット・push・commit amendを行わない
- **テスト追加・Lint修正・リファクタリング**: 評価対象であっても実行せずラベル付与にとどめる

ファイル編集ツール（`Edit` / `Write` / `MultiEdit` / `NotebookEdit`）はこのスキルの本文では一切呼び出さない。コードを触る作業はすべて「ラベル付与 → 別スキルが拾って実行」の流れに委ねる（ステップ1の`cc-resolve-conflict`、ステップ3パターンAの`cc-fix-onetime`）。

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **GitHub MCP を優先し、利用不可なら `gh` コマンドへフォールバックする**。判定手順・`gh` → MCP の対応表・`gh` のまま残す操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する（本文中の `gh` コマンド例は、対応表に該当するものについてはフォールバック手段として読むこと）。

!`git fetch -p >/dev/null 2>&1 || true`

> **プリアンブル（`!` インライン実行）に失敗しうるコマンドを置かないこと**: プリアンブルのコマンドが失敗すると、セッションはモデル未起動のまま何も出力せず exit 0 で終了し、ワーカーが空振り実行を延々と繰り返す。プリアンブルには `|| true` で非致命化したコマンドだけを置き、`gh pr checkout` のような失敗しうるコマンドは本文のステップ0で実行する。

## 実行モードの制約

本スキル固有のリスク: 本スキルは `claude-task-worker` の `triage-pr` ワーカー（`cc-triage-scope` ラベル）から自動起動され、ワーカーはスキルプロセスの同期完了を根拠に `cc-fix-onetime` の付与やマージ、`cc-triage-scope` の除去を進める。処理が未確定のままターンを終えると、判定未確定のまま `cc-fix-onetime` が付かず `fix-review-point` ワーカーへの引き継ぎが空振りしたり、マージ判定前にラベルが外れてPRが放置される状態壊れが起きる。

## 実行内容

### ステップ0: PRブランチのcheckout

ローカル作業ツリーへのcheckoutはGitHub MCPで代替できないため`gh`のまま行う。

```bash
gh pr checkout $ARGUMENTS
```
**クラウド実行時は実行しない。** クラウドセッションはワーカーが `--on-branch` で指定した PR の head ブランチ上で開始しており、既に目的のブランチにいる（`gh pr checkout` は GraphQL 経由でもあり、クラウドでは 403 で失敗する）。ワーカーが起動プロンプトへ同じ趣旨の指示を入れているが、`git rev-parse --abbrev-ref HEAD` が既に対象PRの head ブランチを指している場合も同様に checkout を省略してよい。

このコマンドが**失敗した場合**（典型例: `fatal: '<branch>' is already used by worktree at ...` — PRブランチが別のworktreeでcheckout中）は、**後続のステップに進まず**、エラー出力をそのまま含めて「判定: エラー」で結果報告を行い終了する。ラベル操作・自前のリトライは行わない（ブロッカー解消後のポーリングで自動的に再実行される）。

### ステップ1: コンフリクト検知とラベル付与

対象PRの `mergeable` を取得してコンフリクトの有無を判定する。GitHub MCP の `pull_request_read`（method: `get`）を優先し、利用不可なら以下にフォールバックする。

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh pr-mergeable $ARGUMENTS
```

返る値は `CONFLICTING` / `MERGEABLE` / `UNKNOWN` の3値。`gh-compat.sh` は REST（`repos/{o}/{r}/pulls/{n}` の `mergeable`）を第一手段にし、失敗時のみ `gh pr view --json mergeable` へフォールバックする。

`gh pr status` は使わない。カレントブランチというローカル文脈に依存するうえ、現在のユーザーに関連するPR（作成者・レビュアー・assignee）しか表示しないため対象PRが載るとは限らず、さらに GraphQL 経由なのでクラウドセッションでは 403 になる。

返却値 `MERGEABLE` / `CONFLICTING` / `UNKNOWN` のうち `CONFLICTING` のときコンフリクトありと判定する。`UNKNOWN` の場合はGitHub側で判定中のため、数秒のスリープ後に1回だけリトライする。

判定に応じて分岐する。

- **マージ可能（`MERGEABLE`）**: ステップ2に進む
- **コンフリクトあり（`CONFLICTING`）**: `cc-resolve-conflict` ラベルを付与して終了する。ステップ2・3には進まない（コンフリクト解消前に修正要否の判定やマージを行っても意味がないため）

  ```bash
  gh pr edit $ARGUMENTS --add-label "cc-resolve-conflict"
  ```

- **判定不能（`UNKNOWN` のままリトライ後も継続する場合）**: マージ可能性が未確定のまま先へ進むのは危険なため、**後続のステップに進まず**、ラベル操作は一切行わずに「判定: エラー」で結果報告を行い終了する（ステップ0の失敗時と同様の扱い）。自前のリトライはこの1回のみとする（ブロッカー解消後のポーリングで自動的に再実行される）

### ステップ2: 修正要否の判定（**判定のみ・実行禁止**）

**修正プラン（`create-review-fix-plan`）は生成しない**（「やること・やらないこと」参照）。本スキルが必要とするのは「修正すべき項目が1件でもあるか」という真偽値だけなので、判定に必要な最小限の情報だけを集める。

**重要**: 判定は内部的な思考にとどめ、ファイルの編集・コミット・pushは行わない。対応すべき項目があると判断したら **コードに手を加えず** ステップ3のパターンA（ラベル付与）へ進むこと。裏取りのための`Read`/`Grep`/codegraph参照は許容するが、判定が変わらない範囲では省略する。

#### 2-1. 判定材料の収集

以下を **同一メッセージ内で並列に実行** する。

未解決のインラインレビューコメントは GitHub MCP の `pull_request_read`（method: `get_review_comments`）を優先して取得する。**`get_review_comments` はレビュースレッド専用で、Conversationタブの会話コメントは返さない**ため、会話コメントは PR が Issue 番号空間を共有することを利用して `issue_read`（method: `get_comments`）を別途呼ぶ。どちらか一方でも利用不可なら以下の共有スクリプトへフォールバックする（同スクリプトは両方を1回で返す）。

**ページングは取得しきる。** `get_review_comments` はカーソル方式（`after` に前ページの `endCursor` を渡す）で、応答の `pageInfo.hasNextPage` が `true` の間は `after` を更新して呼び直す。会話コメント（PRはIssue番号を共有するため `issue_read` の method: `get_comments`）はオフセット方式（`page` / `perPage`）で、返り件数が `perPage` 未満になるまで `page` を進めて呼び直す。1ページ目だけで打ち切ると、指摘・コメントが多いPRで後続ページの指摘を取りこぼす。

```bash
bash "${CLAUDE_SKILL_DIR}/../create-review-fix-plan/scripts/fetch-unresolved-comments.sh"
```

```bash
CHECKS_JSON=$(gh pr checks $ARGUMENTS --json state,name,link,workflow 2>&1)
CHECKS_EXIT=$?
```

上記のCI状況取得は、GitHub MCP の `pull_request_read`（method: `get_status` / `get_check_runs`）を優先し、利用不可なら`gh pr checks`にフォールバックする。

```bash
gh pr view $ARGUMENTS --json title,body,labels
```

上記のPR本文・ラベル取得は、GitHub MCP の `pull_request_read`（method: `get`）を優先し、利用不可なら`gh pr view`にフォールバックする。

- 1つ目（`fetch-unresolved-comments.sh` またはMCPの`get_review_comments` ＋ `get_comments`）は未解決のインラインレビューコメント（`unresolved_threads[]`）とConversationタブの一般コメント（`conversation_comments[]`）を返す。インラインだけでは行外の指摘を取りこぼすため両方を対象にする。MCP経路でも同じキー（`thread_id` / `path` / `line` / `is_outdated` / `comments[]` と `author` / `body` / `url` / `created_at` / `is_minimized`）で抽出すること。カレントブランチのPRを対象とするため、ステップ0の `gh pr checkout` 済みであることが前提
- **取得に失敗した場合は「未解決の指摘0件」に倒さない。** スクリプトが非0で終了した場合、または MCP がエラーを返した場合は、`gh pr checks` のパース失敗時と同じ扱いにする: **後続のステップに進まず**、ラベル操作は一切行わずに出力内容をそのまま含めて「判定: エラー」で結果報告を行い終了する。本スキルはマージゲートであり、403 や一過性の `gh` 障害を指摘なしと誤認すると未対応の指摘を残したままPRをマージする。正常に0件だった場合（スクリプトが exit 0 で空配列を返した場合）とは必ず区別すること
- `gh pr checks` は失敗チェックがあると終了コードが非0になるが、これは「失敗チェックが存在する」という正常系の結果であり、認証失敗・通信障害・不正なPR番号等の実行時エラーと区別が必要。区別は終了コードではなく **出力がJSONとしてパース可能かどうか** で行う。

  ```bash
  echo "$CHECKS_JSON" | jq -e . >/dev/null 2>&1
  ```

  パースに成功した場合のみ、その内容を「失敗チェックの有無」の判定材料として使う（`CHECKS_EXIT` が非0でもJSONとしてパースできていれば正常系として扱う）。パースに失敗した場合（＝実行時エラーで意味のある出力を返せなかった場合）は、**後続のステップに進まず**、ラベル操作は一切行わずに出力内容をそのまま含めて「判定: エラー」で結果報告を行い終了する（「CI失敗なし」には倒さない。ステップ0の失敗時と同様の扱い）
  - `state` が `FAILURE` / `STARTUP_FAILURE` のチェックについてのみ、`link` から `run-id` を抽出して失敗内容を確認する。GitHub MCP の `get_job_logs`（`failed_only: true`）を優先し、利用不可なら `gh run view <run-id> --log-failed` にフォールバックする。**全Passなら追加のログ取得は行わない**
- `gh pr view` の結果は「デザインPRか（`cc-ui-design`）」「Epic PRか（`cc-epic-issue`）」「`Refs #<N>` の有無」の確認に使う。ステップ3で同じ情報を再取得せず、ここで取得したラベル一覧を使い回す
- デザインPR（`cc-ui-design`）と判定した場合のみ、差分ファイル一覧を追加で取得する（実装コードの混入・スナップショットの有無の確認用）

  ```bash
  gh pr diff $ARGUMENTS --name-only
  ```

#### 2-2. ノイズの除外

会話コメントには対応不要なノイズが混ざるため、次を判定対象から除外する。

- `is_minimized: true` のコメント（折りたたみ済み＝outdated/resolved/spam等として処理済み）
- `/gemini review` のようなボット起動コマンドや、CIステータスの自動投稿
- PR作成者自身の単なる進捗報告・補足など、対応を求めていないチャット

判断に迷う場合は「このコメントは未対応の修正要求か？」を基準にする。

#### 2-3. 各項目の二分判定

残った各コメント・各CI失敗を、下記の評価基準に照らして **「対応すべき」／「対応不要」の二値** に振り分ける。修正方針・修正手順・対象ファイルの列挙は書かない（`fix-review-point` が行う）。

**判定の基準線**: 「重要か」「軽微か」といった主観的な軽重で切らない。**不正な動作・テスト失敗・誤解を招く結果・将来の障害につながる設計上の穴を引き起こしうる指摘はすべて「対応すべき」**とし、「対応不要」に落とすのは下記「対応不要の可能性あり」に**具体的に該当するもの（純粋なスタイル/命名の好み、PR範囲外の提案、既存規約と矛盾する提案）だけ**に限る。どちらにも当てはまらない指摘は「対応すべき」に倒す（このスキルはマージのゲートであり、取りこぼした指摘は誰も直さないまま PR がマージされる）。

**「対応すべき」が1件見つかった時点で残りの項目の精査を打ち切り、ステップ3のパターンAへ進んでよい**（以降の項目をいくら精査しても付与するラベルは変わらないため）。ただしCI失敗がパターンC（差分の修正では解消不能）に該当しうる場合は、その切り分けを終えてから分岐する。

**ステップ3のパターンB（マージ可能）へ進めるのは、2-1で取得した全チェックが `SUCCESS` 等の明示的な成功状態であることを確認できた場合に限る。** `PENDING` や実行中など未完了のチェックが1件でも残っている場合は、CIが失敗しているわけではなくても「対応不要」の暗黙扱いにせず、パターンBへは進まない。

未完了チェックが残っている場合の分岐は「対応すべき」項目の有無で決まる。

- **「対応すべき」が1件以上ある場合**: CIの完了を待たずステップ3のパターンA（CI失敗が差分の修正では解消不能ならパターンC）へ進む。CI結果に関わらず修正は必要であり、待っても付与するラベルは変わらないため
- **「対応すべき」が1件もない場合**: 判定を確定させず、ステップ3に進まずに「判定: 保留（CI未完了）」として結果報告のみ行い終了する（次回ポーリングで再評価させる。ラベル操作は行わない）

#### デザインPR（`cc-ui-design` ラベル付き）の場合の評価基準

2-1で取得したラベル一覧に `cc-ui-design` が含まれる場合、そのPRは `.pen`（Pencilデザインファイル）とスナップショットPNGのみを変更するデザインPRであり、コードレビューの観点（型安全性・テスト・Lint等）は適用しても意味がない。以下の観点に差し替えて評価する。

- **差分が `.pen` とスナップショットPNGに限定されているか**（実装コードが混入していないか）。混入していれば「対応すべき」
- **スナップショットが差分に含まれ、デザイン意図がPR bodyから読み取れるか**。スナップショットが無くレビューできない場合は「対応すべき」
- **対象Issueに一致する `Refs #<N>` がPR bodyに存在するか**。`Refs #<N>` の記述が欠落している、または記載されているIssue番号が対象Issueと一致しない場合は要件突き合わせ自体が不可能なため「対応すべき」とする（`Closes`/`Fixes`等のclosing keywordはこの参照としては扱わない。下記の通り別途拒否対象）
- **Issueの要件（対象画面・要素・状態バリエーション）を満たしているか**。`Refs #<N>` で参照されているIssueの内容と突き合わせる。要件の取りこぼしがあれば「対応すべき」
- **`Closes` / `Fixes` などの closing keyword がPR bodyに含まれていないか**。含まれているとマージ時に実装Issueが閉じてしまうため「対応すべき」

`.pen` は暗号化バイナリのため `Read` / `Grep` で開かない。デザイン内容の確認はスナップショットPNGとPR bodyの記述で行う（必要なら `inspect-pencil-node` スキルを使う）。

上記以外の観点（テストカバレッジ・Lint・型安全性など）はデザインPRには適用しない。**CIが失敗している場合は、失敗の種類を問わず通常PRと同様に「対応すべき」とする**（`.pen`/スナップショットPNGの変更で直せるもの・実装コードに対する必須チェック・ベースブランチ側の障害のいずれも含む）。デザインPRであることを理由に `cc-fix-onetime` を回避しない。例外は下記パターンC（差分をどう変更しても解消しない失敗）のみで、これはデザインPRか通常PRかを問わず同じ基準で判定する。

#### 対応すべき
- **バグ・正確性の問題**: ロジックエラー、不正な動作、欠落したエッジケース
- **セキュリティ脆弱性**: SQLインジェクション、XSS、認証バイパス、データ漏洩
- **破壊的変更**: APIコントラクト違反、マイグレーションなしの後方互換性の破壊
- **型安全性の違反**: TypeScript型エラー、ランタイム障害を引き起こす可能性のある安全でないキャスト
- **テスト失敗**: 壊れたテスト、新しいロジックに対する重要なテストカバレッジの欠如
- **Lintエラー**: パイプラインをブロックする違反
- **データ整合性リスク**: レースコンディション、重要なデータに対するバリデーションの欠如
- **CIがオールグリーンになっていない**: CIが失敗している

#### 対応不要の可能性あり（**この6項目に具体的に該当する場合のみ**）
- **純粋なスタイル好み**: コードベースパターンと一貫性のあるフォーマット選択
- **主観的な命名提案**: 既存の名前が明確で規約に従っている場合
- **過剰設計の提案**: まだ必要のないコードに対する抽象化の追加
- **スコープクリープ**: PR範囲外の無関係なコードのリファクタリングや機能追加の提案
- **既存パターンとの冗長**: 確立されたコードベース規約と矛盾する提案
- **既に解消済み**: 指摘後のコミットで修正されており、現在のコードに問題が残っていないことを確認できた（`is_outdated: true` でも中身が未解消なら「対応すべき」）

「軽微そう」「クリティカルパスではなさそう」という理由だけで「対応不要」に落とさない。上のどれにも具体的に当てはめられない場合は「対応すべき」とする。

### ステップ3: 判定に基づくアクション

評価結果に基づき、以下のパターン（通常はA/Bのいずれか、CI失敗が差分の修正では解消不能な場合はC。Cは一過性の失敗を再実行で切り分けるC-1を先に通す）で判定し、**必ずいずれかのアクションを実行**する。判定のみで終了せず、コマンドの実行まで確実に行う（C-1の再実行、および「保留」で終わる場合は結果報告のみで正しい）。

#### パターンA: 修正が必要な場合

「対応すべき」と判定された項目が1つでもある場合、`cc-fix-onetime`ラベルを追加する。**ラベル付与のみで終了し、コード修正は行わない**。修正項目が明確で実装が容易に見えても、コード変更・コミット・pushを行ってはならない（実際の修正は`cc-fix-onetime`ラベルをトリガーに別スキルが担当する）。

```
gh pr edit $ARGUMENTS --add-label "cc-fix-onetime"
```

#### パターンC: CI失敗がリポジトリの変更では修正不能な場合

CI失敗の原因が、**このPRの差分をどう変更しても解消しない種類**である場合に限り、`cc-need-human-check`ラベルを追加し終了する。`cc-fix-onetime`は付与しない（修正で直らない失敗を直させ続ける triage-pr ⇔ fix-review-point の無限ループを避けるため）。デザインPR（`cc-ui-design`）か通常PRかは問わず、同じ基準で判定する。

該当する例（人手での対処や環境側の復旧が必要なもの）:

- APIの利用コスト・使用量の上限超過、クレジット枯渇、課金停止
- 外部サービスの障害・レート制限・ネットワーク到達不能
- シークレット/トークンの欠落・失効、権限不足によるジョブ失敗
- CIランナー・インフラ側の障害（キュー詰まり、イメージ取得失敗など）

該当しない例（＝パターンA）: 型チェック・ユニットテスト・Lint・ビルドの失敗、スナップショット差分、ベースブランチ由来のテスト失敗。**リポジトリ内の変更（コードでも `.pen` でも、リベースやベース追従でも）で直せる余地が1つでもあればパターンAへ倒す**。判定に迷ったらパターンA。

**このパターンはCI失敗を根拠とする場合に限る**。CI以外の理由（PR bodyに書かれた作者の人間ゲート、承認待ち、リリース判断、レビュアー不在など）を根拠に `cc-need-human-check` を付けてはならない。同ラベルはPRを `triage-pr` のポーリング対象から恒久的に外すため、CI以外の保留事由に流用すると人がラベルを外すまでPRが自動処理から消える。CI以外の理由でマージを見送る場合は、ラベルを一切付けずに「判定: 保留（理由）」として結果報告のみ行い終了する（次回ポーリングで再評価される）。

##### C-1: 先に「再実行で直るか」を切り分ける

上記の該当例のうち、**一過性の可能性がある失敗**（ネットワーク到達不能・レート制限・イメージ取得失敗・キュー詰まり・CIキャッシュ破損・同一run内の他ジョブが同じコードで成功しているのに特定ジョブだけ落ちている、など）は、再実行で解消することがある。恒久的な失敗（クレジット枯渇・課金停止・シークレット欠落/失効・権限不足）は再実行しても変わらないので、この切り分けは不要でそのまま C-2 へ進む。

一過性の可能性がある場合は、その失敗runの実行回数を確認する。GitHub MCP の `actions_get` を優先し、利用不可なら以下にフォールバックする。**この`attempt`判定は再実行ループを防ぐための必須ロジックであり、経路に関わらず必ず行うこと。**

```bash
gh run view <run-id> --json attempt -q .attempt
```

- **`attempt` が 1（初回実行）**: 失敗ジョブだけを1回再実行し、**ラベルは一切付けずに**「判定: 保留（CI再実行）」として結果報告のみ行い終了する。再実行の完了は待たない（次回ポーリングで結果を再評価する）。GitHub MCP の `actions_run_trigger` を優先し、利用不可なら以下にフォールバックする。

  ```bash
  gh run rerun <run-id> --failed
  ```

- **`attempt` が 2以上（再実行済みで同じ失敗が再現している）**: 一過性ではないと確定するので C-2 へ進む

再実行は**同一runにつき1回まで**。`attempt` を確認せずに再実行すると、直らない失敗を毎ポーリングで再実行し続けるループになる。

##### C-2: ラベル付与と理由の記録

`cc-need-human-check` を付与し、**同じコマンド内でPRへ理由コメントも投稿する**。ラベルだけを付けるとGitHub上に判断根拠が残らず、後から見た人にはPRが理由なく停止したようにしか見えない。

```bash
gh pr edit $ARGUMENTS --add-label "cc-need-human-check"
gh pr comment $ARGUMENTS --body-file - <<'EOF'
## 自動トリアージを停止しました（cc-need-human-check）

CI失敗の原因がこのPRの差分では解消できない種類のため、`cc-need-human-check` ラベルを付与しました。

- **失敗チェック**: <チェック名>
- **失敗内容**: <エラーの要点（ログの該当行を数行まで）>
- **差分では直せないと判断した根拠**: <例: 同一run内の同一ビルドが別ジョブでは成功 / 外部サービスの到達不能 / 再実行しても同じ失敗が再現（attempt N）>

環境側の復旧や設定変更で解消したら、`cc-need-human-check` ラベルを外してください（`triage-pr` が再開します）。
EOF
```

#### パターンB: マージ可能な場合

すべての項目が「対応不要」、または対象となるコメント・CI失敗が1件もない場合、マージ可能（リリース問題なし）と判定する。

**まず対象PRが Epic PR（`cc-epic-issue` ラベル付き）かどうかを、2-1で取得したラベル一覧で確認する**（再取得はしない）。

- **Epic PR の場合（ラベル一覧に `cc-epic-issue` を含む）**: このPRをマージするとデフォルトブランチへの集約反映（＝リリース）になるため、**このスキルではマージせず** `cc-release-ready` ラベルのみを付与して終了する。実際のリリース（マージ）は人間の判断に委ねるゲートとして扱う。以降のマージ手順・関連Issueクローズには進まない。

  ```bash
  gh pr edit $ARGUMENTS --add-label "cc-release-ready"
  ```

- **通常のPRの場合（`cc-epic-issue` を含まない）**: 以下の手順でマージし、**必要に応じて関連Issueを明示的にクローズする。判定だけで終了しないこと。**

1. マージ前に、PRのbaseブランチとデフォルトブランチ名を取得する。`baseRefName` はGitHub MCP の `pull_request_read`（method: `get`）を優先し、利用不可なら以下にフォールバックする。

```bash
BASE_BRANCH=$(gh pr view $ARGUMENTS --json baseRefName -q .baseRefName)
DEFAULT_BRANCH=$(bash ${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh default-branch)
```

2. **必ずマージを実行する。** GitHub MCP の `pull_request_write`（method: `merge`）を優先し、利用不可なら以下の `gh` コマンドへフォールバックする（フォールバックした場合はその旨を最終報告に1行残す）。

```bash
gh pr merge $ARGUMENTS --merge --delete-branch
```

マージが失敗した場合は、エラー内容を記録して報告し、以降の手順に進まない。

3. マージ成功後、`BASE_BRANCH` が `DEFAULT_BRANCH` と **一致しない**（`cc-epic-<N>` のような非デフォルトブランチへのマージ）場合のみ、関連Issueを明示的にクローズする。GitHubの`Closes #<issue番号>`記法による自動クローズは**デフォルトブランチへのマージ時にのみ**発動するため、EpicフローでサブIssueが閉じられずEpic PR作成が止まるのを防ぐ必要がある。一致する場合はGitHubが自動でクローズするためスキップする。

   3-1. PR本文から関連Issueの番号を抽出する（「PRクローズ時のIssue連動Close」と同じ抽出コマンドを流用）。`body` はGitHub MCP の `pull_request_read`（method: `get`）を優先し、利用不可なら以下にフォールバックする。

   ```bash
   gh pr view $ARGUMENTS --json body --jq '.body' | grep -ioE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+'
   ```

   3-2. 抽出したIssue番号それぞれに対して、完了クローズを実行する（複数ある場合は全て）。実装がEpicブランチに取り込まれた完了クローズのため、マージせずクローズする場合の`--reason "not planned"`とは異なり`--reason completed`を用いる。

   ```bash
   gh issue close <issue番号> --reason completed
   ```

   関連Issueが抽出できない場合は、その旨を報告に含めること。

## 意思決定の原則

1. **正確性はスタイルに優先**: 機能的な正確性を常に優先する
2. **レビュアーの意図を尊重**: 具体的な提案を却下する場合でも、レビュアーが達成しようとしていることを理解する
3. **コードベースの一貫性**: プロジェクトで確立されたパターンを優先する
4. **実用主義**: 各変更のコスト対効果を考慮する
5. **判断に迷う場合は対応すべきに寄せる**

## PRクローズ時のIssue連動Close

何かしらの理由で`gh pr close`によりPRをクローズする場合、必ず関連するIssueも併せてCloseすること。GitHubはPRが**マージされず**にCloseされた場合、`Closes #<issue番号>`記法で紐づいたIssueを自動Closeしないため、明示的にCloseする必要がある。

手順:

1. PRのdescriptionから関連Issueの番号を取得する。`body` はGitHub MCP の `pull_request_read`（method: `get`）を優先し、利用不可なら以下にフォールバックする。

```
gh pr view $ARGUMENTS --json body --jq '.body' | grep -ioE '(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]+#[0-9]+' | grep -oE '[0-9]+'
```

2. PRをCloseする。

```
gh pr close $ARGUMENTS --delete-branch
```

3. 取得したIssue番号それぞれに対してCloseを実行する（複数ある場合は全て）。

```
gh issue close <issue番号> --reason "not planned"
```

関連Issueが取得できない場合は、その旨を報告に含めること。

## 注意事項

- 作業は全てworktree上で行い、デフォルトブランチで作業は絶対に行わないこと
- ファイル編集などの作業を行う際は、pwdコマンドでworktree内部であることを確認してから行うこと
  - 作業ディレクトリ: !`pwd`
- `cc-triage-scope`ラベルがPRに付与されている場合、いかなる操作においても**絶対に削除しない**こと。`gh pr edit`で`--remove-label`を使用する際も`cc-triage-scope`を対象に含めない
- **このスキル本文では一切コードを変更しない**（「やること・やらないこと」参照）。コンフリクト解消も修正実行もラベル経由で別スキルに委譲する

## 出力

処理結果として以下を報告する：

- **判定**: コンフリクト検知（`cc-resolve-conflict`ラベル付与） / パターンA（修正が必要・`cc-fix-onetime`ラベル付与） / パターンB-Epic（Epic PRのリリースゲート・`cc-release-ready`ラベル付与、マージせず終了） / パターンB-通常（マージ済み。非デフォルトブランチへのマージ時は連動Closeした関連Issue番号も明記） / パターンC（CI失敗がリポジトリの変更では修正不能・`cc-need-human-check`ラベル付与＋理由コメント投稿） / 保留（CI未完了 / CI再実行 / CI以外の事由でマージ見送り・いずれもラベル操作なし） / PRクローズ（関連IssueもClose） / エラー
- **理由**: 判定の根拠（コンフリクト検知時はターゲットブランチ名、対応すべき項目の要約、マージ可能と判断した理由、Epic PRで`cc-release-ready`を付与した旨、非デフォルトブランチへのマージで`--reason completed`により連動Closeした関連Issue番号、CI未完了で保留した場合は未完了チェック名、CI再実行で保留した場合は再実行したrun-idと失敗ジョブ名、エラー時は`gh pr view`のmergeable判定不能または`gh pr checks`出力のパース失敗など発生箇所、またはクローズ理由と連動Closeした関連Issue番号）
