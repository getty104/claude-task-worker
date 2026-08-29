---
name: triage-sentry-issues
description: Sentry の Issue 一覧 URL（例 `https://<org>.sentry.io/issues/?project=<id>&environment=<env>`）を受け取り、未解決（unresolved）の Issue を列挙して1件ずつサブエージェントで並列調査する。コード上で既に解消済みと確認できたものは Sentry 側を resolved にし、未解消のものは `create-issue` スキルで GitHub Issue を作成する。「Sentryのissueをトリアージして」「Sentryの未解決エラーをチケット化して」といった依頼で使用する。
argument-hint: "[sentry-issues-url]"
---

# Triage Sentry Issues

Sentry の Issue 一覧 URL `$ARGUMENTS` を起点に、未解決 Issue を「解消済み → Sentry で resolve」「未解消 → GitHub Issue 化」へ振り分けるスキル。

**自律実行原則**: ユーザーへの確認は行わず、判断はすべて本スキル内のルールで自動決定する。中断条件に該当した場合のみ理由を出力して終了する。

**スコープ**: 本スキルは調査と振り分けのみを行う。**コードの修正・コミット・PR作成はしない**（修正は作成した GitHub Issue が `exec-issue` に回ることで行われる）。Sentry 側の操作は `resolved` への変更だけで、ignore・delete・assign はしない。

# Instructions

## GitHub アクセス

本スキルの GitHub 参照/更新は **GitHub MCP を優先し、利用不可なら `gh` コマンドへフォールバックする**。判定手順・`gh` → MCP の対応表・`gh` のまま残す操作は `${CLAUDE_PLUGIN_ROOT}/references/github-access.md` を参照する（本文中の `gh` コマンド例は、対応表に該当するものについてはフォールバック手段として読むこと）。

## ステップ0: 前提確認

1. **Sentry MCP ツールが使えること**。ツール名のプレフィックスは接続方法で変わる（`mcp__plugin_sentry_sentry__*` / `mcp__claude_ai_Sentry__*` など）ため、**末尾の名前**で判定する。必要なのは `search_issues` / `get_sentry_resource` / `update_issue` の3つ。無ければ「Sentry MCP が未接続のため実行できません」と出力して終了する。
2. `$ARGUMENTS` が Sentry の Issue 一覧 URL でなければ、期待する形式を示して終了する。
3. `gh repo view --json nameWithOwner -q .nameWithOwner` で対象リポジトリを確定する（単独取得ツールがMCPに無いため gh のまま残す）。
4. `pwd` を確認する。worktree を**新たに作成しない**（`.claude/worktrees/` 配下ならそこで、それ以外ならその場で作業する）。

**完了条件**: Sentry MCP が使え、URL が妥当で、対象リポジトリが確定していること。

---

## ステップ1: URL のパース

URL からクエリパラメータを取り出す。値は URL エンコードされている（`%3A` → `:`、`%20` → 空白、`+` → 空白）ので**デコードしてから使う**。

| 要素 | 取り出し方 | 未指定時の扱い |
|---|---|---|
| org slug | ホスト名の先頭ラベル（`igsa.sentry.io` → `igsa`）。`sentry.io/organizations/<slug>/issues/` 形式ならパスから | 取れなければ中断 |
| project | `project` クエリ（数値ID。複数指定されうる） | **全プロジェクトを対象**（`projectSlugOrId` を渡さない） |
| environment | `environment` クエリ（複数指定されうる） | **全環境を対象**（`environment:` 条件を足さない） |
| statsPeriod | `statsPeriod` クエリ。`search_issues` の `period` が許す値（`24h` / `7d` / `14d` / `30d` / `90d`）へ最も近い値に丸める | `30d` |
| 検索クエリ | `query` クエリ | `is:unresolved` |

**検索クエリの正規化**（対象は未 resolve の Issue のみなので必ず適用する）:

- `is:` 条件が無ければ先頭に `is:unresolved` を足す
- `is:resolved` / `is:ignored` が含まれていれば `is:unresolved` へ置き換える
- environment が指定されていれば `environment:<env>` を AND で足す（複数なら `environment:[<env1>,<env2>]`）

**完了条件**: org slug・プロジェクト一覧（空＝全件）・検索クエリ・period が決まっていること。

---

## ステップ2: 未解決 Issue の取得

`search_issues` を呼ぶ。

```
search_issues(organizationSlug=<org>, projectSlugOrId=<project or 省略>, query=<正規化済みクエリ>, period=<period>, sort='freq', limit=100)
```

- **プロジェクトが複数指定されている場合**、`projectSlugOrId` は1つしか渡せないためプロジェクトごとに呼び、結果を結合する
- 0件なら「対象の未解決 Issue はありません」と出力して終了する
- 各 Issue から `shortId`（例 `PROJECT-1Z43`）・タイトル・`culprit`・permalink（Issue URL）・`lastSeen`・発生件数・影響ユーザー数を控える

**完了条件**: 調査対象の未解決 Issue 一覧が手元にあること。

---

## ステップ3: 並列調査（サブエージェント）

**1 Sentry Issue = 1 サブエージェント**（`general-purpose-assistant`）で調査する。1回のメッセージに複数の Agent 呼び出しを並べて並列起動し、**同時実行は最大5件**まで（Sentry API のレート制限と、`create-issue` の同時実行数を抑えるため）。5件ずつのバッチで回す。

サブエージェントは人に質問できない。判断はすべて自力で行わせ、迷った場合は**未解消側に倒す**（誤って resolve するとエラーが埋もれるため）。

### ブリーフィングに必ず含めるもの

- Sentry Issue の shortId・タイトル・culprit・permalink・lastSeen・発生件数・環境
- 対象リポジトリ（`owner/repo`）と作業ディレクトリ
- 下記「サブエージェントの手順」と「解消済み判定の基準」を**そのまま**転記
- 出力フォーマット（下記「サブエージェントの報告」）

### サブエージェントの手順

1. `get_sentry_resource(url=<permalink>)` で Issue 詳細（スタックトレース・直近イベント・release・lastSeen）を取得する
2. スタックトレースから**アプリケーションコード側の最上位フレーム**（`file:line` と関数名）を特定する。ライブラリ内部のフレームは原因箇所ではない
3. CodeGraph（`codegraph_explore`）で該当シンボルの現在のソースと呼び出し元を読む。CodeGraph が使えなければ `Grep` / `Read` にフォールバックする
4. `git log -S '<原因コードの特徴的な文字列>' --oneline` / `git log --since='<lastSeen>' -- <該当ファイル>` で、lastSeen 以降に該当箇所へ修正が入っているかを確認する
5. 下記の基準で「解消済み」か「未解消」かを判定する
6. 判定に応じて後述の処理を行い、報告を返す

### 解消済み判定の基準

**次の (a) と (b) の両方を満たす場合のみ「解消済み」**とする。片方でも欠けたら「未解消」に倒す。

- (a) **原因箇所の現在のコードでは、このエラーが発生しない**ことをコードの実物で確認できる。例: 原因のコードパス自体が削除されている／null・undefined ガードが追加されている／呼び出している API・スキーマが変更され、エラーになる分岐が存在しない
- (b) **その変更が `lastSeen` より後に入っている**ことを `git log` で確認できる。または `lastSeen` が30日以上前で、かつ現在のコードに原因が見当たらない

「たぶん直っている」「関連しそうなリファクタがあった」は根拠にならない。スタックトレースの原因箇所を特定できなかった場合も「未解消」とする。

### 判定後の処理

**解消済みの場合**:

```
update_issue(issueUrl=<permalink>, status='resolved', reason='<根拠。修正コミットのSHAと該当ファイルを含めて1〜2行>')
```

**未解消の場合**:

1. **重複確認**: **Open/Closed の両方**を検索対象にする（Closed で放置された重複を見落とすと再作成してしまう）。GitHub MCP が使える場合は `list_issues`（`states` に `OPEN` と `CLOSED` の両方を指定）または `search_issues`（`query` に状態を絞る `is:open` / `is:closed` を付けず、両状態を対象にする）を使う。以下は MCP 利用不可時のフォールバック。
   `gh issue list --state all --search "<shortId>" --json number,title,url,state` を実行する。同じ Sentry Issue を指す GitHub Issue が既にあれば**作成せず**、そのURLを添えて `skipped-duplicate` として報告する
2. 重複が無ければ `create-issue` スキル（`claude-task-worker:create-issue`）を呼ぶ。引数には自然言語のタスク説明として次を含める:
   - エラーのタイトルと種別（例外クラス・メッセージ）
   - Sentry Issue URL と shortId、環境、発生件数・影響ユーザー数、firstSeen / lastSeen
   - 原因と推定した箇所（`file:line` と関数名）と、そう判断した根拠
   - スタックトレースの要点（アプリケーションフレームのみ。全文は貼らない）
   - 再現条件として分かっていること（リクエストパス・入力値・release など）
   - **修正方針を断定して書かない**。原因の推定までに留め、実装プランは `create-issue` に任せる

### サブエージェントの報告

次の形式で返させる（余計な説明を足させない）:

```
shortId: <PROJECT-1Z43>
判定: resolved | issue-created | skipped-duplicate | undecided
根拠: <1〜2行>
GitHub Issue: <URL or ->
```

`undecided` は Sentry API エラーなどで調査自体ができなかった場合にのみ使う。

**完了条件**: 全 Sentry Issue についてサブエージェントの報告が揃っていること。

---

## ステップ4: 最終報告

結論から書く。1文目に「対象N件 / resolve M件 / GitHub Issue 作成 K件 / 重複スキップ L件 / 判定不能 J件」を述べ、続けて一覧表を出す。

| shortId | タイトル | 判定 | GitHub Issue / 根拠 |
|---|---|---|---|

- 表以外の説明は、`undecided` があった場合の理由と次の一手のみ（1〜3行）
- 埋め草セクション・言い換えを書かない

---

## 中断条件

以下に該当する場合は、理由を出力して終了する（部分的に処理済みならそこまでの結果を報告する）。

- Sentry MCP ツールが使えない
- `$ARGUMENTS` が Sentry の Issue 一覧 URL でない、または org slug を取り出せない
- `search_issues` が認証エラー・権限エラーを返す
