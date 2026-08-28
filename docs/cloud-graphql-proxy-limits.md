# クラウドセッションの GitHub プロキシ制限の実測結果

クラウドセッション内で `gh` の各操作がどこまで通るかを実測した記録。`docs/prd-cloud-worker-execution.md` 5章（制約表・ワーカー別適合性表）を確定させるための調査（Issue #226、PRD 9-5 に対応）。

- 実測日: 2026-08-28
- 実測バージョン: ローカル `claude --version` → `2.1.248 (Claude Code)` / クラウド VM の `gh --version` → `gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)`
- プロキシのポリシーはバージョン・アカウント設定に依存するため、いずれかがここより新しい場合は再実測すること

## 実測環境

- クラウドセッション: `session_<REDACTED-1>`（`script -q /dev/null claude --cloud "<desc>"` で作成）
- プローブ投函: `claude -p --cloud <session_id> "<prompt>"`（非TTY）。結果の回収は claude.ai/code のセッションページのみ（CLI に取得経路が無いことは `docs/cloud-session-launch-flags.md` M-5 / M-8 で既測）
- クラウド VM: Linux x86_64 / `root` / cwd `/home/user/repo`
- **このリポジトリでは claude.ai 側の GitHub App 連携が未設定**。VM の作業ツリーはローカル worktree のアップロードでシードされ、`git remote` は0件（`docs/cloud-session-launch-flags.md` T11 / M-5 と同じ状態）

## 結論

GitHub アクセスは **3つの独立したゲート**で塞がれており、`gh` から取得できるのは `user` と `rate_limit` だけだった。

| ゲート | 対象 | エラー本文（`message`） | リポジトリ連携で解けるか |
|---|---|---|---|
| **GraphQL ゲート** | `api.github.com/graphql` の全リクエスト | `This GraphQL query is not enabled for this session — only the pinned set of PR-review operations is served. Use REST via gh api repos/{owner}/{repo}/... instead.` | **解けない**（リポジトリ非依存。下記参照） |
| **リポジトリゲート** | `repos/{owner}/{repo}/...` の全パス（メソッド不問） | `GitHub access to this repository is not enabled for this session. Use add_repo to request access. …` | 解ける見込み（未実測） |
| **パスゲート** | リポジトリスコープでない REST パス（`/octocat`、`search/issues` 等） | `This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...).` | 対象外（設計上の制限） |

要点は3つ。

1. **GraphQL ゲートはリポジトリ連携と独立している**。リポジトリを一切含まない `query{viewer{login}}` が、リポジトリ指定クエリと**バイト単位で同一**の403本文（`Content-Length: 263`）を返した。リポジトリをアタッチしても解けない性質のゲートである。
2. **PRD 5章の想定より影響範囲が広い**。PRD は「`gh issue view --json parent,blockedBy`、レビュースレッド解決、Projects v2」を挙げていたが、実際には `gh issue view --json` / `gh pr view --json` は**フィールドを問わず**（`number,title,state,labels` でも）GraphQL 経由なので全滅する。`gh pr list` / `gh pr checks` も同様。REST でしか取れないフィールドを指定しても `gh` 側に REST 経路が無い。
3. **3つのエラーメッセージが循環している**。GraphQL の403は「REST の `repos/{owner}/{repo}/...` を使え」と案内し、リポジトリゲートはまさにそのパスを拒否し、パスゲートは「リポジトリスコープのエンドポイントを使え」と案内してリポジトリゲートへ戻る。本セッション構成では、どの経路でもリポジトリのデータに到達できない。

なお403の応答ヘッダは3行（`Content-Length` / `Content-Type` のみ、`Server` も `X-GitHub-Request-Id` も無い）で、200を返した `gh api user` は完全な GitHub ヘッダ群を伴っていた。**拒否はコンテナ内で合成されており、GitHub には到達していない**。

### 交絡: クラウド VM の `gh` が古い

クラウド VM の `gh` は **2.45.0（2025-07-18 の Ubuntu パッケージ）**で、`parent` / `blockedBy` / `subIssuesSummary` / `closingIssuesReferences` の各 `--json` フィールドを**そもそも知らない**（`Unknown JSON field` でネットワークに出る前に失敗する）。この4つはプロキシ制限とは無関係に失敗するため、403の集計から切り離して読むこと。ワーカー本体（`src/gh.ts`）が使う `hasOpenBlockers` / `getIssueSubIssuesSummary` / `listIssuesByLabel`(`--json parent`) は、クラウド実行時にこの CLI バージョン差にも当たる。

## `gh` コマンド表（PRD 5章 制約表の差し替え用）

`使用箇所` は本リポジトリでの実体。`src/gh.ts` の関数はワーカープロセス（＝ローカル実行）、スキルはタスクセッション（＝クラウド実行）で走る。**クラウド実行で影響を受けるのはスキル側だけ**である点に注意（→「影響範囲の切り分け」）。

| ID | コマンド | 使用箇所 | GraphQL 経由 | 結果 | エラー |
|---|---|---|---|---|---|
| A2 | `gh auth status` | — | — | OK（警告付き） | `X Failed to log in to github.com using token (GH_TOKEN)`（それでも A3 は成功する） |
| A3 | `gh api user` | `getCurrentUser()`（`src/gh.ts`）/ 多数のスキル | 否 | **OK (200)** | — |
| — | `gh api rate_limit` | — | 否 | **OK (200)** | — |
| B1 | `gh api graphql -f query='query{viewer{login}}'` | — | 是 | **403** | GraphQL ゲート |
| B2 | `gh api graphql`（`closedByPullRequestsReferences`） | `findPrNumberClosingIssue()` | 是 | **403** | GraphQL ゲート |
| B3 | `gh api graphql`（`reviewThreads`） | `fetch-unresolved-comments.sh` / `resolve-pr-comments.sh` | 是 | **403** | GraphQL ゲート |
| B4 | `gh api graphql`（`resolveReviewThread` mutation） | `resolve-pr-comments.sh` | 是 | **403** | GraphQL ゲート（GitHub に到達せず） |
| C1 | `gh issue view <n> --json parent` | `listIssuesByLabel()` / `listIssuesByNumbers()` / `triage-created-issue` 他 | 是 | **失敗（CLI）** | `Unknown JSON field: "parent"`（gh 2.45.0） |
| C2 | `gh issue view <n> --json blockedBy` | `hasOpenBlockers()` | 是 | **失敗（CLI）** | `Unknown JSON field: "blockedBy"` |
| C3 | `gh issue view <n> --json subIssuesSummary` | `getIssueSubIssuesSummary()` | 是 | **失敗（CLI）** | `Unknown JSON field: "subIssuesSummary"` |
| C4 | `gh pr view <n> --json mergeable` | `getPrMergeable()` | 是 | **403** | GraphQL ゲート |
| C5 | `gh pr view <n> --json reviews` | `create-review-fix-plan` / `triage-pr` | 是 | **403** | GraphQL ゲート |
| C6 | `gh pr view <n> --json closingIssuesReferences` | — | 是 | **失敗（CLI）** | `Unknown JSON field` |
| C7 | `gh issue view <n> --json number,title,state,labels` | ワーカー起動スキル全15個 | 是 | **403** | GraphQL ゲート。**REST で表現できるフィールドでも `gh` は GraphQL で取りに行く** |
| D1 | `gh pr checks <n>` | `triage-pr` / `check-dependabot` | 是 | **403** | GraphQL ゲート |
| D2 | `gh pr list` | `exec-issue` フェーズ7 の PR 実在検証 他 | 是 | **403** | `This GraphQL query (PullRequestList, sent by gh pr list) is not enabled…`（操作名が埋め込まれる） |
| D3 | `gh run list` | `triage-pr` | 否 | **403** | リポジトリゲート |
| D4 | `gh api -X PUT repos/…/pulls/{n}/merge` | `mergePr()` / `triage-pr` | 否 | **403（リポジトリゲート）** | ゲートが先に効くため、マージ自体の可否は**未判定** |
| D5 | `gh api -X POST repos/…/actions/runs/{id}/rerun-failed-jobs` | `triage-pr` C-1 | 否 | **403（リポジトリゲート）** | 同上・**未判定** |
| D6 | `gh api -X POST repos/…/issues/{n}/labels` | `addLabel()` 他 | 否 | **403（リポジトリゲート）** | 同上・**未判定** |
| D7 | `gh api -X POST repos/…/issues/{n}/comments` | `postIssueComment()` 他 | 否 | **403（リポジトリゲート）** | 同上・**未判定** |
| E1–E7 | `gh api repos/…`（REST 代替の実行） | — | 否 | **403（リポジトリゲート）** | 連携未設定のため代替経路も塞がれる |

D4–D7 は「存在しないオブジェクトID宛て」で投げた副作用のないプローブで、403 はリポジトリゲート由来である。**メソッド／パス単位のポリシーに到達する前に落ちているため、マージ・CI再実行・ラベル操作・コメント投稿が個別に許可されるかどうかは本実測では判定できていない**（→「未実測項目」）。

## GraphQL 依存操作の REST 代替

エンドポイントの実在は GitHub REST ドキュメントで確認済み。ただし**本セッションではリポジトリゲートにより実行検証ができていない**（実行時は `-H "X-GitHub-Api-Version: 2022-11-28"` を添える）。

| 必要な情報 | GraphQL 側 | REST 代替 | 代替コマンド |
|---|---|---|---|
| Issue の parent | `--json parent` | **あり** | `gh api repos/{o}/{r}/issues/{n}/parent --jq '{number,title,state}'` |
| Issue の blockedBy | `--json blockedBy` | **あり** | `gh api repos/{o}/{r}/issues/{n}/dependencies/blocked_by --jq '[.[] \| select(.state=="open")] \| length'` |
| サブIssueの進捗 | `--json subIssuesSummary` | **あり** | `gh api repos/{o}/{r}/issues/{n} --jq '.sub_issues_summary'` / `gh api repos/{o}/{r}/issues/{n}/sub_issues` |
| PR の mergeable | `--json mergeable` | **あり** | `gh api repos/{o}/{r}/pulls/{n} --jq '{mergeable,mergeable_state,merged}'`。**`mergeable` は算出中 `null` を返す**ため、`null` を `CONFLICTING` と解釈せずポーリングする（GraphQL の `UNKNOWN` と同じ扱い） |
| PR のレビュー一覧 | `--json reviews` | **あり** | `gh api repos/{o}/{r}/pulls/{n}/reviews` |
| PR のレビューコメント | `reviewThreads` | **部分的** | `gh api repos/{o}/{r}/pulls/{n}/comments`。コメント個々は取れるが**スレッドの解決状態は取れない**（REST にスレッドという資源が無い） |
| レビュースレッドの解決 | `resolveReviewThread` mutation | **なし** | REST に該当エンドポイントが存在しない。`pulls/comments` 系7エンドポイントのいずれも解決操作を持たず、レスポンススキーマに解決状態のフィールドも無い。解決はスレッド単位の操作だが REST はスレッドを資源として公開していないため、原理的に代替が作れない |
| PR が閉じる Issue | `--json closingIssuesReferences` | **なし** | 完全な代替は無い。PR body の closing keyword を自前で解析するか（`create-pr` が書く形式なので本ワーカー製PRには有効、手書きの表記ゆれは取りこぼす）、`gh api repos/{o}/{r}/issues/{n}/timeline` の `cross-referenced` を辿る |
| CI チェック状態 | `gh pr checks` | **あり**（2本必要） | `sha=$(gh api repos/{o}/{r}/pulls/{n} --jq .head.sha) && gh api "repos/{o}/{r}/commits/$sha/check-runs"` と `gh api "repos/{o}/{r}/commits/$sha/status"`（前者が Actions / Checks API、後者が旧 Status API） |

コマンド置換で SHA を取る形は、内側の呼び出しが403になるとエラーJSONがそのままURLパスへ流れ込む（実測で `accepts 1 arg(s), received 44` になった）。`&&` で連結し置換失敗が伝播するようにすること。

## 影響範囲の切り分け（ワーカー本体 vs スキル）

`src/gh.ts` の GraphQL 依存関数（`findPrNumberClosingIssue` / `hasOpenBlockers` / `getIssueSubIssuesSummary` / `getPrMergeable` / `listIssuesByLabel` / `listIssuesByNumbers`）は**ワーカープロセスが呼ぶ**。ワーカー自体はクラウドへ移らずローカルで走り続けるため、`cloud: true` にしてもこれらは影響を受けない。

クラウドで走るのは**タスクセッション（スキル）だけ**であり、そこで問題になるのは各スキル本文の `gh` 呼び出しである。調査時点で `gh issue view --json` / `gh pr view --json` を使うワーカー起動スキルは以下のとおりで、**15個すべてが該当する**。C7 が示すとおりフィールドの内容に関わらず403になるため、GraphQL ゲートが有効な限り**どのワーカーもクラウドでは Issue/PR 本文を読めない**。

| スキル | `gh (issue\|pr) view --json` の出現数 | `gh api graphql` | `gh pr list` / `gh pr checks` |
|---|---|---|---|
| `exec-issue` | 2 | — | 1 |
| `fix-review-point` | 6 | — | 1 |
| `triage-pr` | 5 | — | 3 |
| `triage-created-issue` | 5 | — | — |
| `create-issue-from-issue-number` | 4 | — | 1 |
| `update-issue` | 7 | — | 1 |
| `answer-issue-questions` | 4 | — | 1 |
| `check-dependabot` | 1 | — | 1 |
| `create-epic-pr` | 1 | — | — |
| `resolve-pr-conflict` | 3 | — | — |
| `create-ui-design` | 3 | — | 1 |
| `apply-ui-design` | 7 | — | 1 |
| `update-coding-guidelines` | 2 | あり | 1 |
| `update-requirement-rules` | 3 | あり | — |
| `update-design-md` | 2 | あり | 1 |

補助スキル・スクリプトでは `resolve-pr-comments.sh`（`reviewThreads` + `resolveReviewThread`）と `create-review-fix-plan`（`reviewThreads`）が GraphQL に直接依存する。`create-pr` / `commit-push` は `--json` も `graphql` も使わない。

## ワーカー別適合性（PRD 5章 適合性表の差し替え用）

判定は「Phase 1 でクラウド実行を推奨してよいか」。**本実測の結果は、GitHub App 連携が未設定のリポジトリでは全ワーカーが成立しないことを示している**（そもそも `git remote` が無く push も PR 作成もできない。`docs/cloud-session-launch-flags.md` M-5 で既測）。以下は「連携を設定してリポジトリゲートを解いた場合に、**GraphQL ゲートだけが残る**」という前提での判定である。この前提の根拠である「GraphQL ゲートはリポジトリ連携と独立している」という結論（B1）は、**GitHub App 連携が未設定のセッションでの実測**（リポジトリを含まないクエリと含むクエリが同一の403を返した）にとどまり、連携済みセッションでの挙動は未検証である。

| ワーカー | 判定 | GraphQL 403 で劣化する操作 | ラベル遷移・成果物検証への影響 |
|---|---|---|---|
| `exec-issue` | △（PRD の ◎ から格下げ） | `gh issue view --json body`（Issue本文の読み取り）、フェーズ7の `gh pr list --head` によるPR実在検証 | Issue本文が読めなければ実装に着手できない。REST（`gh api repos/{o}/{r}/issues/{n} --jq .body`）への書き換えが前提条件。ラベル遷移はワーカー側（ローカル）が行うため影響なし |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | △（PRD の ◎ から格下げ） | 収集スクリプトの `gh api graphql` と `gh (issue\|pr) view --json` | 収集が0件になり、空振りのまま成果物なしで終了する。実行記録PRはローカルのワーカーが出すため記録自体は残るが、内容が伴わない |
| `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` | △（PRD の ○ から格下げ） | `gh issue view --json body,comments,labels`（フィールドを問わず403） | Issue本文・コメントが読めず、分析系スキルの入力がゼロになる。`--json parent` は加えて gh 2.45.0 でも失敗する |
| `epic-issue`（`create-epic-pr`） | △（PRD の ○ から格下げ） | `gh issue view --json` | 同上。PR本文の生成材料（コミットログ）は `git log` で取れるが、Issue情報が欠ける |
| `fix-review-point` | ✕（PRD の △ から格下げ） | `reviewThreads` クエリ（未解決コメント取得）、`resolveReviewThread`（スレッド解決）、`gh pr view --json` | **レビュー指摘を1件も取得できない**。加えてスレッド解決は REST 代替が原理的に存在しないため、書き換えでも回復しない。Phase 1 では許可方針が確定済みだが、実質的に何もできないまま完了扱いになる点を明記する |
| `triage-pr` | ✕（PRD の △ から格下げ） | `gh pr view --json`、`gh pr checks`、`reviewThreads`、`gh pr list` | CI状態もレビュー指摘も取れないため、**マージ判断の材料がゼロ**。マージゲートを担うワーカーが根拠なく判断する状態になる。`gh pr merge` 自体の可否は未判定 |
| `check-dependabot` | ✕（PRD の △ から格下げ） | `gh pr view --json`、`gh pr checks` | 依存更新の内容もCI結果も読めない |
| `resolve-conflict` | ✕（PRD どおり） | `gh pr view --json` | PRD の理由（force-push 未検証・`pencil` CLI 不在）に加え、コンフリクト判定の入力も取れない |
| `create-ui-design` / `apply-ui-design` | ✕（PRD どおり） | `gh issue view --json` | PRD の理由（`pencil` CLI と認証）は変わらず |

「△」の3ワーカー（`fix-review-point` / `triage-pr` / `check-dependabot`）を Phase 1 で起動時に拒否せず許可する方針は確定済みのため、**本実測は判定の運用（拒否するかどうか）を覆さない**。ただし上表のとおり、これらは GraphQL ゲート下では成果物を出せないため、許可したままクラウド実行するとタスクが空振りする。運用上は「許可はするが、GraphQL ゲートが解除されるかスキルが REST 化されるまで `cloud: true` にしない」ことを推奨する。

## 測定ログ（verbatim）

### P-1: GraphQL ゲートの403（`gh api graphql -f query='query{viewer{login}}' -i`）

```
HTTP/1.1 403 Forbidden
Content-Length: 263
Content-Type: application/json; charset=utf-8

{"message":"This GraphQL query is not enabled for this session — only the pinned set of PR-review operations is served. Use REST via gh api repos/{owner}/{repo}/... instead.","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}
```

リポジトリを指定したクエリ（`repository(owner:"getty104", name:"claude-task-worker"){…}`）でも**同一本文・同一 `Content-Length: 263`**。`gh pr list` のみ操作名が埋め込まれた変種を返した:

```
This GraphQL query (PullRequestList, sent by gh pr list) is not enabled for this session…
```

操作名が埋まることから、ゲートはクエリをパースして**操作名単位のアローリスト**で判定している。ただし本実測で通った GraphQL 操作は1つも無く、アローリストに載っている操作を特定できていない。

### P-2: リポジトリゲートの403（`gh api repos/getty104/claude-task-worker/issues/226 -i`）

```
HTTP/1.1 403 Forbidden
Content-Length: 378
Content-Type: application/json; charset=utf-8

{"message":"GitHub access to this repository is not enabled for this session. Use add_repo to request access. If add_repo answers that read access is already available and you need GitHub API or write access, call add_repo again with access:"push" to attach the repository with credentials.","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}
```

**無関係な公開リポジトリでも同一本文**（`gh api repos/cli/cli --jq .full_name` → exit 1、同じ378バイト）。特定リポジトリが未アタッチなのではなく、**1件もアタッチされていない**状態である。

### P-3: パスゲートの403（`gh api /octocat` / `gh api search/issues?q=...`）

```
{"message":"This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...).","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}
```

### P-4: 通過する REST（`gh api user -i` / `gh api rate_limit`）

`gh api user` は 200 を返し、`Server: github.com` / `X-Github-Request-Id: 1046:369991:702C9AD:17C1A3C7:6A90D2A2` / `X-Github-Api-Version-Selected: 2022-11-28` を含む完全な GitHub ヘッダ群を伴った（＝実際に GitHub へ到達している）。`gh auth status` は `X Failed to log in to github.com using token (GH_TOKEN)` と警告するが `gh api user` は `<local-user>` を返す。**環境変数のトークンはプレースホルダで、実際の資格情報はプロキシが注入している**。

```
gh api rate_limit --jq .rate
{"limit":5000,"remaining":4851,"reset":1787878698,"used":149}
```

403 の2本（P-1 / P-2）はヘッダが3行のみで `Server` も `X-GitHub-Request-Id` も無く、**コンテナ内で合成されて GitHub へ出ていない**ことが分かる。

### P-5: プロキシの構成

```
CCR_AGENT_PROXY_ENABLED=1
CCR_UPSTREAM_PROXY_ENABLED=1
CCR_TEST_GITPROXY=1
CLAUDE_CODE_PROXY_RESOLVES_HOSTS=true
https_proxy=http://127.0.0.1:43957
HTTPS_PROXY=http://127.0.0.1:43957
GH_TOKEN=<redacted>
GITHUB_TOKEN=<redacted>
```

`curl http://127.0.0.1:43957/__agentproxy/status`:

```
{ "enabled": true, "port": 43957, "caBundlePath": "/root/.ccr/ca-bundle.crt",
  "installedProxyPreconfiguredClis": [ "gh" ],
  "gitConfigInjection": true, "gitSshRewrite": true,
  "recentRelayFailures": [ ... ] }
```

`recentRelayFailures` に GitHub の拒否は1件も記録されていない。**403 を出しているのは CONNECT リレーそのものではなく、その上位の GitHub 対応レイヤ**である。

### P-6: `gh` のバージョンと git の状態

```
gh version 2.45.0 (2025-07-18 Ubuntu 2.45.0-1ubuntu0.3)
/usr/bin/gh
-rwxr-xr-x 1 root root 45201664 Jul 18  2025 /usr/bin/gh
```

ラッパースクリプトではなく実バイナリ。`--json parent` / `blockedBy` / `subIssuesSummary` / `closingIssuesReferences` は**このバージョンが未対応**で、403 以前に `Unknown JSON field` で失敗する。

```
git -C /home/user/repo remote -v      → (出力なし。remote 0件)
git -C /home/user/repo rev-parse --abbrev-ref HEAD  → deft-river-0856
git -C /home/user/repo push --dry-run → fatal: No configured push destination.  (exit 128)
```

push はネットワークにも資格情報にも到達せず失敗している。**この結果は push の可否を測っていない**（push 先が存在しないだけ）。

### P-7: `add_repo` はこのセッション種別に存在しない

P-2 の403本文が案内する `add_repo` を実行してリポジトリゲートを解こうとしたが、**当該ツールがクラウドセッションのツール一覧に存在しなかった**（`ToolSearch` で `select:add_repo` および関連語検索がいずれも0件）。したがってアタッチは試行されておらず、アカウントレベルの設定変更・GitHub App の認可も一切発生していない。

## PRD からの差分

1. **5章「GraphQL の 403 制限」の影響範囲が過小**。PRD は `--json parent,blockedBy` とレビュースレッド解決を挙げていたが、実際は `gh issue view --json` / `gh pr view --json` / `gh pr list` / `gh pr checks` が**フィールドを問わず**全滅する。ワーカー起動スキル15個すべてが影響を受ける
2. **「REST へのフォールバックが必要」は正しいが、レビュースレッド解決だけは REST 代替が原理的に存在しない**。`fix-review-point` / `resolve-pr-comments.sh` はスキル・スクリプトを書き換えても回復しない
3. **適合性表を全面的に格下げする必要がある**。`exec-issue` の ◎ を含め、Issue/PR の内容を `gh` で読む全ワーカーが GraphQL ゲートの影響下にある（上表参照）
4. **制約表に「リポジトリゲート」と「パスゲート」を追加すべき**。GitHub App 連携が未設定のセッションでは `repos/*` が全リポジトリで403になり、GraphQL 以前に何も読めない
5. **クラウド VM の `gh` が 2.45.0 で古い**。プロキシ制限とは独立に、sub-issue / issue-dependencies 系の `--json` フィールドが使えない。PRD にはこの前提が無い

## 未実測項目

1. **リポジトリ連携済みセッションでの REST 代替の実行検証**
   - 理由: `add_repo` がこのセッション種別に存在せず（P-7）、リポジトリゲートを解く手段が無かった。「REST 代替表」のエンドポイントはドキュメント上の実在確認に留まり、プロキシが個々の REST パスを通すかは未確認
   - 再現手順: claude.ai で対象リポジトリの GitHub 連携を設定したうえでクラウドセッションを作り直し、本メモの「REST 代替」表の各コマンドを実行する
2. **書き込み系操作（マージ・CI再実行・ラベル付与・コメント投稿）の個別可否**
   - 理由: D4–D7 はリポジトリゲートで先に落ちており、メソッド／パス単位のポリシーに到達していない
   - 再現手順: 1 の環境で D4–D7 を同じ「存在しないID宛て」の形で再実行し、403（プロキシ）と 404/422（GitHub 到達）を区別する
3. **GraphQL アローリストに載っている操作の特定**
   - 理由: エラー本文が「pinned set of PR-review operations」の存在を示すが、本実測で通った GraphQL 操作は1件も無い
   - 再現手順: 1 の環境で `gh pr view --json reviews` 等の PR レビュー系操作を再実行し、リポジトリ連携でアローリストが変化するかを確認する
4. **クラウドセッションからの push 可否**
   - 理由: 作業ツリーに remote が0件のため、push が資格情報に到達する前に失敗する（P-6）。remote の追加はリポジトリの変更にあたるため実施していない
   - 再現手順: 1 の環境（clone 由来で remote があるセッション）で `git push --dry-run` を実行する

## 実測の副作用

本実測により以下1件のクラウドセッションが作成された:

- `session_<REDACTED-1>`（P-1〜P-7。すべて読み取り専用のプローブで、`add_repo`・書き込み系 API・push・commit・ファイル編集はいずれも実行していない）

不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。GitHub 側への副作用は無い（すべての書き込みプローブは存在しないオブジェクトID宛てで、かつリポジトリゲートで拒否されている）。
