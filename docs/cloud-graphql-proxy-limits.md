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

> 2026-08-30 の `G-*` 実測で、リポジトリ連携済みのセッションには**4つ目のゲート（書き込みパスゲート）**があることが判明した。`repos/{o}/{r}/git/refs` への書き込みだけが `Write access to this GitHub API path is not permitted through this proxy.` で拒否される（`issues/*` / `pulls/*` への書き込みは通る）。詳細は「GitHub MCP ツールのクラウド実測」を参照。

要点は3つ。

1. **GraphQL ゲートはリポジトリ連携と独立している**。リポジトリを一切含まない `query{viewer{login}}` が、リポジトリ指定クエリと**バイト単位で同一**の403本文（`Content-Length: 263`）を返した。リポジトリをアタッチしても解けない性質のゲートである。
2. **PRD 5章の想定より影響範囲が広い**。PRD は「`gh issue view --json parent,blockedBy`、レビュースレッド解決、Projects v2」を挙げていたが、実際には `gh issue view --json` / `gh pr view --json` は**フィールドを問わず**（`number,title,state,labels` でも）GraphQL 経由なので全滅する。`gh pr list` / `gh pr checks` も同様。REST でしか取れないフィールドを指定しても `gh` 側に REST 経路が無い。
3. **3つのエラーメッセージが循環している**。GraphQL の403は「REST の `repos/{owner}/{repo}/...` を使え」と案内し、リポジトリゲートはまさにそのパスを拒否し、パスゲートは「リポジトリスコープのエンドポイントを使え」と案内してリポジトリゲートへ戻る。本セッション構成では、どの経路でもリポジトリのデータに到達できない。

なお403の応答ヘッダは3行（`Content-Length` / `Content-Type` のみ、`Server` も `X-GitHub-Request-Id` も無い）で、200を返した `gh api user` は完全な GitHub ヘッダ群を伴っていた。**拒否はコンテナ内で合成されており、GitHub には到達していない**。

### 交絡: クラウド VM の `gh` が古い（2026-08-29 に解消。ただし結論は変わらない）

実測当時のクラウド VM の `gh` は **2.45.0（2025-07-18 の Ubuntu パッケージ）**で、`parent` / `blockedBy` / `subIssuesSummary` / `closingIssuesReferences` の各 `--json` フィールドを**そもそも知らなかった**（`Unknown JSON field` でネットワークに出る前に失敗する）。この4つはプロキシ制限とは無関係に失敗するため、403の集計から切り離して読むこと。

**2026-08-29 時点でクラウド VM の `gh` は 2.98.0 へ上がり、この交絡は解消した**（C1 / C2 / C3 / C6 の「失敗（CLI）」はもう起きない）。ただし**403 になる事実は変わらない**。同日 gh 2.98.0（ローカル）で `GH_DEBUG=api` を取り、以下がいずれも `https://api.github.com/graphql` を叩くことを確認した:

| コマンド | 転送経路（gh 2.98.0 実測） |
|---|---|
| `gh issue view <n> --json parent` / `blockedBy` | GraphQL |
| `gh issue edit <n> --add-blocked-by` / `--add-blocking` / `--add-sub-issue` | GraphQL |
| `gh issue create`（`--blocked-by` 等の有無に関わらず） | GraphQL（`createIssue` mutation） |
| `gh pr view <n> --json mergeable` | GraphQL（`PullRequestByNumber`） |

つまりフィールド・フラグの有無ではなく**転送経路**の問題であり、**gh を新しくしても GraphQL ゲートは越えられない**。REST（`gh api repos/{o}/{r}/...`）へ寄せる以外に手が無く、その実装が `plugin/scripts/gh-compat.sh` である。

あわせて `gh issue create --blocked-by` の順序も確認した。**Issue の作成（`createIssue`）が先に完了し、relationship の解決はその後**に走るため、`--blocked-by` に不正な番号を渡すとコマンドは非0で終わるが Issue は作成済みで残る。`post-scope-issue-body` に書かれていた「relationship が貼れないなら Issue も作られない」という fail-fast の記述は、現行 gh では成立しない（同スキルの記述を訂正済み）。

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

`src/gh.ts` の GraphQL 依存関数（`findPrNumberClosingIssue` / `hasOpenBlockers` / `getIssueSubIssuesSummary` / `getPrMergeable` / `listIssuesByLabel` / `listIssuesByNumbers`）は**ワーカープロセスが呼ぶ**。ワーカー自体はクラウドへ移らずローカルで走り続けるため、`--cloud` を付けてもこれらは影響を受けない。

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

2026-08-29 の smoke test（claude 2.1.250 / herdr 0.8.2、後述「GitHub MCP 移行との関係」参照）で、クラウド VM の GitHub MCP のうち `issue_read` / `add_issue_comment` / `issue_write` / `create_pull_request` の4ツールが動作することを確認した。以下の表はこの4ツールで直接代替できる操作に限って判定を見直したもので、それ以外（`gh pr checks` によるCI状態取得、`gh pr list` によるPR一覧、レビュースレッドの `reviewThreads`/`resolveReviewThread` など）は今回動作確認していないため判定を据え置いてある。

| ワーカー | 判定 | GraphQL 403 で劣化する操作 | ラベル遷移・成果物検証への影響 |
|---|---|---|---|
| `exec-issue` | ○（2026-08-29 smoke test で `issue_read`/`create_pull_request` の動作を確認、△ から格上げ。ただし PR一覧検証は未実測のため ◎ ではない） | ~~`gh issue view --json body`（Issue本文の読み取り）~~ → `issue_read` で代替確認済み。~~PR作成~~ → `create_pull_request` で代替確認済み（同 smoke test の `exec-issue` エンドツーエンド実行で実際に成立、所要9分03秒）。フェーズ7の `gh pr list --head` によるPR実在検証は今回未確認のまま残る | Issue本文の読み取りとPR作成はMCP経由で成立することを確認した。PR一覧を使う検証ステップの成否は未確認。ラベル遷移はワーカー側（ローカル）が行うため影響なし |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | △（`--cloud` 指定時はクラウド実行される。GraphQL 依存は解消済みだが E2E 未実測） | 解消済み。3スクリプト（`fetch-recent-review-comments.sh` / `fetch-recent-requirement-issues.sh` / `fetch-recent-ui-design-prs.sh`）は `plugin/scripts/gh-compat.sh` 経由の REST へ移行済みで、`gh api graphql` / `gh (issue\|pr) view --json` への依存は残っていない | 「収集が403で全滅する」という前提は成立しなくなったが、**クラウドでの収集成功は実測していない**（成功と断定しない）。加えて完了検知を行わない（セッション作成＝完了）ため、収集が失敗しても `lastRun` が進んで次の24時間まで再実行されず、Slack 通知にもセッション URL と定型文しか載らない。実行記録PRはローカルのワーカーが出すため記録自体は従来どおり残る |
| `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` | △（PRD の ○ から格下げ） | `gh issue view --json body,comments,labels`（フィールドを問わず403） | Issue本文・コメントが読めず、分析系スキルの入力がゼロになる。`--json parent` は加えて gh 2.45.0 でも失敗する |
| `epic-issue`（`create-epic-pr`） | △（PRD の ○ から格下げ） | `gh issue view --json` | 同上。PR本文の生成材料（コミットログ）は `git log` で取れるが、Issue情報が欠ける |
| `fix-review-point` | ✕（PRD の △ から格下げ。据え置き） | `reviewThreads` クエリ（未解決コメント取得）、`resolveReviewThread`（スレッド解決）、`gh pr view --json` | **レビュー指摘を1件も取得できない**。加えてスレッド解決は REST 代替が原理的に存在せず、2026-08-29 の smoke test でも `resolveReviewThread` 代替は確認していない（確認済みの4ツールに該当なし）ため、書き換えでも回復しない。Phase 1 では許可方針が確定済みだが、実質的に何もできないまま完了扱いになる点を明記する |
| `triage-pr` | ✕（PRD の △ から格下げ。据え置き） | `gh pr view --json`、`gh pr checks`、`reviewThreads`、`gh pr list` | CI状態（`gh pr checks`）もレビュー指摘（`reviewThreads`）も PR一覧（`gh pr list`）も今回動作確認していないため、**マージ判断の材料がゼロ**のまま。マージゲートを担うワーカーが根拠なく判断する状態になる。`gh pr merge` 自体の可否は未判定 |
| `check-dependabot` | ✕（PRD の △ から格下げ。据え置き） | `gh pr view --json`、`gh pr checks` | 依存更新の内容もCI結果も読めない。`gh pr checks` 相当の代替は今回動作確認していない |
| `resolve-conflict` | ✕（PRD どおり） | `gh pr view --json` | PRD の理由（force-push 未検証・`pencil` CLI 不在）に加え、コンフリクト判定の入力も取れない |
| `create-ui-design` / `apply-ui-design` | ✕（PRD どおり） | `gh issue view --json` | PRD の理由（`pencil` CLI と認証）は変わらず |

「△」の3ワーカー（`fix-review-point` / `triage-pr` / `check-dependabot`）を Phase 1 で起動時に拒否せず許可する方針は確定済みのため、**本実測は判定の運用（拒否するかどうか）を覆さない**。ただし上表のとおり、これらは GraphQL ゲート下では成果物を出せないため、許可したままクラウド実行するとタスクが空振りする。運用上は「許可はするが、GraphQL ゲートが解除されるかスキルが REST 化されるまで、これらのワーカーを `--cloud` 付きで起動しない」ことを推奨する。

## GitHub MCP 移行との関係

Issue #270 で `plugin/` 配下スキルの GitHub アクセスを GitHub MCP 優先（利用不可なら `gh` へフォールバック）へ切り替えた。GitHub MCP は本ドキュメントが実測した `gh` 経由のプロキシ（GraphQL ゲート／リポジトリゲート／パスゲート）を経由しない。対応表は `plugin/references/github-access.md` に集約してある。

**2026-08-29 に smoke test でクラウド VM 上の GitHub MCP の起動・動作を実測した**（実測バージョン: claude 2.1.250 / herdr 0.8.2、使い捨ての private リポジトリ、手動プローブ2セッション＋`exec-issue` ワーカーのエンドツーエンド実行1件）。結果は以下のとおり。

- クラウド VM 上で `mcp__github__*` ツールが **55個**存在することを確認した。そのうち実際に動作を確認できたのは **`issue_read` / `add_issue_comment` / `issue_write` / `create_pull_request` の4つ**。残り51ツールは今回実行していないため動作は未確認。
- 一方、`gh … --json`（GraphQL 経由）は今回も**403のまま**だった。**GraphQL ゲートはこの移行によって解消されたわけではなく、GitHub MCP はそれとは別経路でゲートを迂回するにすぎない**（ゲート自体は健在）。
- `gh api repos/…`（REST）は成功した。
- 上記4ツールを使う完了検知の連鎖（プロンプト投函 → 最終報告コメント投稿 → `cc-cloud-done` ラベル付与 → ワーカー側での検知・除去 → `cc-pr-created` 付与）が成立し、`exec-issue` の1タスク（2行のファイル追加）がエンドツーエンドで完了した。所要時間は9分03秒。

この実測をもとに、上表「ワーカー別適合性」は確認済みの4ツールで直接代替できる操作に限って判定を見直した（`exec-issue` の格上げ、詳細は同表の直前の注記を参照）。CI状態取得（`gh pr checks`）・PR一覧（`gh pr list`）・レビュースレッドの解決（`resolveReviewThread`）など、確認済み4ツールに含まれない操作に依存する判定は据え置いてある。`mcp__github__*` の残り51ツールについても、今回動作を確認していない以上、それらに依存する判定を動かす根拠にはしていない。

レビュースレッドの Resolve（`resolveReviewThread`）は本移行のスコープ外（別Issue担当）で、今回も動作確認しておらず、`fix-review-point` の判定に変更はない。

## GitHub MCP ツールのクラウド実測（`G-*`）

2026-08-29 の smoke test で未実測のまま残っていた GitHub MCP ツール（読み取り系・書き込み系）を、クラウドセッション内から実際に呼んで確認した記録（Issue #330）。

- 実測日: 2026-08-30
- 実測バージョン: クラウド VM の `claude --version` → `2.1.251 (Claude Code)` / `gh version 2.98.0 (2026-08-20)` / `node v22.22.2`
- 実測環境: **`exec-issue` ワーカーが `--cloud` で起動した本 Issue のタスクセッション自身**（`docs/cloud-smoke-test.md` の手動プローブではなく、実運用と同じ経路）。`git remote` は `origin` 1件（`https://github.com/getty104/claude-task-worker`）で、**GitHub App 連携済み**のセッションである
- **2026-08-28 の実測（P-1〜P-7）との最大の違いは、リポジトリゲートが解けていること**。当時は `repos/{o}/{r}/...` が全リポジトリで403だったため書き込み系の可否が「未判定」で残っていたが（D4–D7）、本実測ではその手前のゲートが無い状態で個々の操作に到達できている
- **プローブ対象は本リポジトリ自身**（使い捨ての private リポジトリではない）。本セッションの GitHub アクセスは `getty104/claude-task-worker` にスコープされており、別リポジトリを作成・使用できないため。書き込み系は `ctw-probe-330-base` ← `ctw-probe-330-head` という使い捨てブランチ間の PR #341 に閉じて実施し、**デフォルトブランチと既存 PR には一切触れていない**（→「実測の副作用」）

### 結論

**GitHub MCP は読み取り系・書き込み系ともにクラウドで動作する**。MCP ツールのプローブ30件（G-1〜G-30）は**すべて期待どおりの結果を返し、プロキシ由来の拒否は1件も無かった**（唯一の失敗 G-29 は GitHub 由来の「再実行対象が無い」エラーで、ゲートではない）。あわせて `gh` 側の REST についても、リポジトリゲートが解けた状態では **Issue/PR への書き込みが GitHub に到達する**ことを確認した（2026-08-28 に「未判定」として残していた D4–D7 の解消）。

一方、**`gh` 経路（G-31〜G-42）では新たに3つの制限**が判明した。

1. **`gh api` の REST には「書き込みパス」単位のゲートがある**。`repos/{o}/{r}/git/refs` への `POST` / `DELETE` は、リポジトリ連携済みでも `{"message":"Write access to this GitHub API path is not permitted through this proxy.","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}` の403で拒否される（`documentation_url` が `docs.anthropic.com` ＝**プロキシが合成した拒否**）。対照的に `issues/*` / `pulls/*` への `POST` / `PATCH` / `PUT` は GitHub に到達する（存在しない番号宛てで `404 Not Found` ＋ `documentation_url` が `docs.github.com`）。**メソッド単位ではなくパス単位の制限**であり、ブランチ／タグの作成・削除だけが塞がれている
2. **CI 再実行は `gh` 経路と MCP 経路で結果が分かれる**。`POST repos/{o}/{r}/actions/runs/{id}/rerun` は GitHub 由来の403（`Resource not accessible by integration`）＝**プロキシが注入するトークンに `actions: write` が無い**。同じ操作を MCP の `actions_run_trigger` で行うと **201 Created で成功する**（`run_attempt` が 1 → 2 へ上がることを確認）。`triage-pr` の C-1（失敗ジョブの再実行）は **MCP 経由でのみ成立する**
3. **`gh-compat.sh default-branch` がクラウドで必ず失敗する**（G-42）。クラウド VM の作業ツリーに `refs/remotes/origin/HEAD` が無いため git 導出が成立せず、`gh` フォールバックは GraphQL ゲートで403になる。`exec-issue` のフェーズ0はデフォルトブランチを解決できないと fail-safe で中断するため、**クラウドタスクが着手前に止まりうる**

GraphQL ゲートは**リポジトリ連携済みのセッションでも健在**で、`gh api graphql -f query='query{viewer{login}}'` は 2026-08-28 と同一本文の403を返した。これで「GraphQL ゲートはリポジトリ連携と独立している」という B1 の結論が、連携済みセッションでも成り立つことを確認できた（従来は未連携セッションでの実測にとどまっていた）。

### 実測表（読み取り系）

| ID | ツール | method / 引数 | 成否 | 備考 |
|---|---|---|---|---|
| G-1 | `list_pull_requests` | `state: all` / `head` / `base` / `fields` | **成功** | `fields` で返却フィールドを絞れる。**`merged` はマージ済み PR でも `false` を返す**（REST の PR 一覧が同フィールドを埋めないため）。マージ済みかどうかは `pull_request_read`（`get`）で判定する |
| G-2 | `pull_request_read` | `get` | **成功** | `merged` / `mergeable_state` / `labels` / `head` / `base` / `merged_at` を返す。`gh pr view --json` の代替として成立 |
| G-3 | `pull_request_read` | `get_files` | **成功** | `patch` 込み。`perPage` が効く |
| G-4 | `pull_request_read` | `get_diff` | **成功** | 生の unified diff |
| G-5 | `pull_request_read` | `get_status` | **成功** | **旧 Status API の combined status のみ**。GitHub Actions のチェックは含まれないため、CI 判定に使うなら G-6 と併用する |
| G-6 | `pull_request_read` | `get_check_runs` | **成功** | Actions のチェックラン（`name` / `status` / `conclusion` / `html_url`）。`gh pr checks` 相当はこちら |
| G-7 | `pull_request_read` | `get_review_comments` | **成功** | スレッドの node ID（`PRRT_...`）と解決状態を返す。**返却キーは `is_resolved` / `is_outdated` / `is_collapsed` の snake_case**（`isResolved` ではない）。`pageInfo.endCursor` によるカーソルページング |
| G-8 | `pull_request_read` | `get_reviews` | **成功** | レビューが無い PR では空配列 |
| G-9 | `pull_request_read` | `get_commits` | **成功** | — |
| G-10 | `pull_request_read` | `get_comments` | **成功** | 会話コメント（レビュースレッドではない）。bot コメントも含む |
| G-11 | `search_pull_requests` | `query` / `fields` | **成功** | `repo:` 修飾子付きのクエリが通る |
| G-12 | `actions_list` | `list_workflow_runs` | **成功** | **`per_page` が効かない**（`3` を指定して30件返却）。`workflow_runs_filter.branch` / `.status` は効くので、絞り込みはこちらで行う。無指定で呼ぶと応答が数万トークン規模になる |
| G-13 | `actions_get` | `get_workflow_run` | **成功** | `run_attempt` / `conclusion` を返す |
| G-14 | `get_job_logs` | `job_id` + `return_content` + `tail_lines` | **成功** | 本文が返る |
| G-15 | `get_job_logs` | `run_id` + `failed_only: true` | **成功** | 失敗ジョブのみを `failed_jobs` 件数付きで返す |
| G-16 | `get_me` | — | **成功** | — |

### 実測表（書き込み系）

すべて使い捨てブランチ間の PR #341 に対して実行した。

| ID | ツール | method / 操作 | 成否 | 備考 |
|---|---|---|---|---|
| G-17 | `create_branch` | `from_branch` 指定 | **成功** | 2本作成 |
| G-18 | `create_or_update_file` | 新規ファイル作成 | **成功** | 2件。`gh api git/refs` が塞がれている一方、MCP のファイル書き込みは通る |
| G-19 | `create_pull_request` | — | **成功** | 2026-08-29 に確認済みだが、使い捨てブランチをベースにしても成立することを再確認 |
| G-20 | `update_pull_request` | `title` / `body` | **成功** | 変更後に G-2 で読み直して反映を確認。**`pull_request_write`（method: `update`）は存在しない** |
| G-21 | `pull_request_review_write` | `create`（`event` 省略＝ pending） | **成功** | — |
| G-22 | `add_comment_to_pending_review` | `subjectType: LINE` | **成功** | — |
| G-23 | `pull_request_review_write` | `submit_pending`（`event: COMMENT`） | **成功** | 自分の PR でも `COMMENT` は通る |
| G-24 | `pull_request_review_write` | `resolve_thread` | **成功** | G-7 で `is_resolved: true` を確認。**2回目の呼び出しも成功**（冪等な no-op であることを実測） |
| G-25 | `pull_request_review_write` | `unresolve_thread` | **成功** | — |
| G-26 | `resolve_review_thread`（単独ツール） | `owner` / `repo` / `threadId` | **成功** | G-24 と同じ結果。`pull_request_review_write` と並存しており、どちらを使ってもよい |
| G-27 | `actions_run_trigger` | `rerun_workflow_run` | **成功** | 201 Created。G-13 で `run_attempt` が 1 → 2 になることを確認 |
| G-28 | `actions_run_trigger` | `rerun_failed_jobs`（失敗ランに対して） | **成功** | 201 Created |
| G-29 | `actions_run_trigger` | `rerun_failed_jobs`（**成功**ランに対して） | **失敗（GitHub 由来）** | `403 This workflow run cannot be retried`。**プロキシの403と紛らわしいので注意** — 本文に `documentation_url` が無く GitHub 由来である。再実行対象が無いだけで、ゲートではない |
| G-30 | `merge_pull_request` | `merge_method: squash` | **成功** | `{"merged":true}`。マージ後に head ブランチがリポジトリ設定で自動削除された |

### 実測表（`gh` の REST 書き込み — 2026-08-28 の D4–D7 の再測）

リポジトリゲートが解けた状態で、2026-08-28 に「未判定」として残していた書き込み系を同じ「存在しないID宛て」の形で再実行した。**404 は GitHub に到達した証拠**（`documentation_url` が `docs.github.com`）、**403 かつ `documentation_url` が `docs.anthropic.com` はプロキシによる拒否**として読む。

| ID | コマンド | 結果 | 判定 |
|---|---|---|---|
| G-31 | `gh api repos/{o}/{r}` / `.../issues/{n}`（GET） | **200** | リポジトリゲートは解けている |
| G-32 | `gh api -X POST .../issues/999999/comments` | 404（GitHub） | **プロキシは通す**（D7 の解消） |
| G-33 | `gh api -X POST .../issues/999999/labels` | 404（GitHub） | **プロキシは通す**（D6 の解消） |
| G-34 | `gh api -X PATCH .../issues/999999` | 404（GitHub） | プロキシは通す |
| G-35 | `gh api -X PUT .../pulls/999999/merge` | 404（GitHub） | **プロキシは通す**（D4 の解消） |
| G-36 | `gh api -X PATCH .../pulls/999999` | 404（GitHub） | プロキシは通す |
| G-37 | `gh api -X POST .../actions/runs/{id}/rerun` | 403（GitHub: `Resource not accessible by integration`） | **トークンに `actions: write` が無い**。プロキシではなく権限（D5 は「プロキシは通すが権限で落ちる」が正解）。MCP の `actions_run_trigger` なら成功する（G-27 / G-28） |
| G-38 | `gh api -X POST .../git/refs` | 403（プロキシ: `Write access to this GitHub API path is not permitted through this proxy.`） | **書き込みパスゲート**（新規発見） |
| G-39 | `gh api -X DELETE .../git/refs/heads/<branch>` | 403（プロキシ、同上） | 同上。**クラウドからはブランチを削除できない** |
| G-40 | `git push origin :refs/heads/<branch>`（削除 push） | `send-pack: unexpected disconnect` → `Everything up-to-date`（ref は残る） | G-39 と同じ制限が git の smart HTTP 経路にも現れる。**エラーで終わらず「最新です」と表示されるため、成功と誤認しやすい** |
| G-41 | `gh api graphql -f query='query{viewer{login}}'` | 403（プロキシ、GraphQL ゲート） | 連携済みセッションでも**GraphQL ゲートは健在**（B1 の結論を追認） |
| G-42 | `gh-compat.sh default-branch` | **失敗**（`failed to resolve the default branch`） | 次項を参照 |

**G-42 の詳細（クラウド実行の実害）**: クラウド VM の作業ツリーには `refs/remotes/origin/HEAD` が設定されておらず（`git symbolic-ref --short refs/remotes/origin/HEAD` が `fatal: ref refs/remotes/origin/HEAD is not a symbolic ref` で exit 128）、`gh-compat.sh default-branch` の第一手段が成立しない。フォールバックの `gh repo view --json defaultBranchRef` は GraphQL ゲートで403になるため、サブコマンド全体が失敗する。`exec-issue` のフェーズ0はデフォルトブランチ名を取得できない場合に fail-safe で**中断**する仕様であり、この経路を通るとクラウド実行のタスクが着手前に止まりうる。**REST（`gh api repos/{o}/{r} --jq .default_branch`）は200を返す**（G-31）ので代替手段は存在する。本 Issue はコードを変更しないスコープのため修正は行っていない。



### 未実測項目（本実測で埋まらなかったもの）

1. **`actions_run_trigger` の `run_workflow`（`workflow_dispatch`）**
   - 理由: 本セッションがアクセスできる唯一のリポジトリで `workflow_dispatch` を持つワークフローは `publish.yml`（npm への公開）だけで、実行すると不可逆な外部副作用（リリース）が発生する。安全側に倒して実行していない
   - 再現手順: 副作用の無い `workflow_dispatch` ワークフローを持つリポジトリで `actions_run_trigger`（`run_workflow`、`workflow_id` + `ref`）を呼ぶ
2. **`actions_run_trigger` の `cancel_workflow_run` / `delete_workflow_run_logs`**
   - 理由: 同一ツール・同一エンドポイント群の書き込み経路は G-27 / G-28 で成立を確認済みのため、追加の CI 実行を焼いてまで個別に確認していない
3. **`pull_request_review_write` の `delete_pending`、および `create` に `event` を渡して即 submit する経路**
   - 理由: pending の作成・コメント追加・submit（G-21〜G-23）で必要な経路は確認できたため
4. **`actions_get` の `get_workflow` / `get_workflow_job` / `get_workflow_run_usage` / `get_workflow_run_logs_url` / `download_workflow_run_artifact`、`actions_list` の `list_workflows` / `list_workflow_jobs` / `list_workflow_run_artifacts`**
   - 理由: 同ツールの代表 method（G-12 / G-13）で経路の成立を確認したため。個別の可否は未確認
5. **`mcp__github__*` の残り（本セッションで確認できたのは55ツール中20ツール）**
   - 理由: 3ワーカーが依存する操作に絞ってプローブしたため

通常の `git push`（新規コミットの push）は、当初この一覧に挙げる予定だったが、**本タスク自身の push が成功したため未実測ではない**（後述の「未実測項目」4 の注記を参照）。

### 実測の副作用

- 使い捨てブランチ `ctw-probe-330-base` / `ctw-probe-330-head` と PR #341（両ブランチ間、**ベースはデフォルトブランチではない**）を作成し、`update_pull_request` / レビュー投稿 / Resolve / CI 再実行 / squash マージを実行した。既存の PR・Issue・デフォルトブランチには書き込んでいない
- `ctw-probe-330-head` はマージ時にリポジトリ設定で自動削除された。**`ctw-probe-330-base` は残っている** — G-38〜G-40 のとおり、クラウドセッションからはブランチを削除する手段が無い（MCP にブランチ削除ツールが無く、REST も git 経路もプロキシに塞がれる）。**手動での削除が必要**
- PR #341 に対して CI（`ci.yml`）が3回（初回 + `rerun_workflow_run` + `rerun_failed_jobs`）、レビュー系ワークフロー（`ocr-review.yml` / CodeRabbit）が2回走った。`publish.yml` は実行していない
- G-32〜G-36 / G-38 / G-39 は存在しないID宛て、または使い捨てブランチ宛てのプローブで、GitHub 側の状態を変えていない

## ワーカー E2E（スキル本文）のクラウド実測（`W-*`）

適合性表で「クラウド実行されるが推奨しない」と判定していた3ワーカー（`triage-pr` / `fix-review-point` / `check-dependabot`）を、実際にクラウドセッション内で走らせた記録（Issue #337）。`G-*` が「MCP ツール単体が動くか」を測ったのに対し、本節は「**スキル本文がクラウド環境で最後まで通るか**」を測っている。

- 実測日: 2026-08-30
- 実測バージョン: クラウド VM の `claude --version` → `2.1.251 (Claude Code)` / `gh version 2.98.0 (2026-08-20)` / `node v22.22.2` / `claude-task-worker` 0.97.0
- 実測環境: `exec-issue` ワーカーが `--cloud` で起動した本 Issue のタスクセッション自身。cwd は `/home/user/<repo>`、`git remote` は `origin` 1件、GitHub App 連携済み

### 方法と、その限界（先に読むこと）

**ローカルの herdr ワーカーから `mode: "herdr"` ＋ `--cloud` で3ワーカーを起動する経路は再現していない。** クラウド VM には herdr も `~/.config/claude-task-worker/config.json` も存在せず、クラウドセッションの中からワーカーを起動できないため。代わりに、**同じクラウドセッションの中で3スキルを `Skill` ツールで直接起動**して観測した。ワーカーが `--on-branch` で与える「PR の head ブランチ上でセッションが始まる」状態は、スキル起動前に該当ブランチを checkout することで再現している。

したがって本節が測ったのは E2E の**スキル側の半分**である。

| 区間 | 本節での扱い |
| --- | --- |
| ワーカー起動 → herdr タスクタブ → `claude --cloud` によるセッション作成 | **未実測**（クラウドセッションからは再現できない） |
| クラウドセッション内でのスキル本文の実行 | **本節の実測対象** |
| `cc-cloud-done` 付与 → ワーカーのポーリング検知 → ラベル遷移 | **未実測**（ワーカー側がローカルにいないため）。ただし `exec-issue` については 2026-08-29 に成立を確認済み（`docs/cloud-smoke-test.md` の実測記録） |

### 結論

3ワーカーで結果が分かれた。

1. **`triage-pr` は成立した**。PR詳細・CI状態・未解決レビューコメントの取得から二分判定・ラベル付与まで全ステップを通り、**`gh` へのフォールバックは1回も発生しなかった**（すべて GitHub MCP で完結）
2. **`fix-review-point` はフェーズ0で中断し、成果物ゼロだった**。原因は GitHub アクセスではなく、**スキル本文の安全ガード2つがクラウドでは原理的に成立しない**こと（W-10 / W-11）
3. **`check-dependabot` は CHANGELOG 取得で詰まった**。**セッションの GitHub アクセスは `gh` も MCP も「設定済みリポジトリ」だけにスコープされており、依存元リポジトリ（例: DefinitelyTyped）を読めない**（W-22 / W-23）。外部 HTTPS（`WebFetch`）は通るため代替経路は存在する

最も重要な発見は2点。

- **`.claude/worktrees/` 配下チェックはクラウド実行では常に偽になる**（W-10）。クラウド実行は設計上 worktree を作らず（`isCloudWorker()` 分岐、`src/workers/pr-worker.ts` ほか）、cwd はリポジトリルートである。このチェックを中断条件として持つ `fix-review-point` と `exec-issue` は、**書かれたとおりに判定するとクラウドでは必ず着手前に止まる**。2026-08-29 の `exec-issue` E2E が成立したのは、この中断条件がコードではなくスキル本文の自然言語であり、機械的に強制されていないためと考えられる（＝挙動がモデルの判断に依存し非決定的になる）
- **リポジトリゲートは「解けた」のではなく「セッションの設定リポジトリに限って開いている」**（W-22 / W-23）。`G-31` の「リポジトリゲートは解けている」という結論は自リポジトリについてのみ成り立ち、第三者リポジトリでは 2026-08-28 と同一本文の403が返る。**GitHub MCP もこのスコープを迂回しない**（`gh` とは別の文言で拒否する）

### プローブ構成

使い捨てブランチ `ctw-probe-337-base`（`cc-epic-328` 由来）をベースに、3本の使い捨て PR を作成した。**デフォルトブランチと既存の PR には一切触れていない**。

| PR | head | 付与ラベル | 仕込んだ状態 |
| --- | --- | --- | --- |
| #350 | `ctw-probe-337-triage` | `cc-triage-scope` | 未解決レビュースレッド1件（要修正の指摘） |
| #351 | `ctw-probe-337-fix` | `cc-fix-onetime` | 未解決レビュースレッド1件（要修正の指摘） |
| #352 | `ctw-probe-337-dep` | `dependencies` | `@types/node` を 22.0.0 → 22.20.1 に上げた Dependabot 模擬差分（`package.json` + `package-lock.json`） |

CI は3本とも `build` / `preflight` / `code-review` がすべて success だった。

### 実測表: `triage-pr`（PR #350）— **完遂**

| ID | ステップ / 操作 | 手段 | 結果 | 備考 |
| --- | --- | --- | --- | --- |
| W-1 | ステップ0 `gh pr checkout` | — | **省略（正しい判定）** | 現在ブランチが `head.ref` と一致したためスキル本文の指示どおり省略。クラウドでの fail-safe が意図どおり働いた |
| W-2 | ステップ1 コンフリクト検知 | MCP `pull_request_read`（`get`） | **成功（ただし読み替えが必要）** | スキル本文は `mergeable` の3値（`MERGEABLE` / `CONFLICTING` / `UNKNOWN`）を前提にしているが、**MCP が返すのは `mergeable_state`**（今回は `clean`）。本文どおりのマッピングをそのまま適用できない |
| W-3 | ステップ2 未解決レビューコメント取得 | MCP `pull_request_read`（`get_review_comments`） | **成功** | 1件、`hasNextPage: false` |
| W-4 | ステップ2 会話コメント取得 | MCP `issue_read`（`get_comments`） | **成功** | 2件（いずれも bot） |
| W-5 | ステップ2 CI状態取得 | MCP `pull_request_read`（`get_check_runs`） | **成功** | 3件すべて `conclusion: success` |
| W-6 | 補助スクリプト `fetch-unresolved-comments.sh` | — | **未使用** | MCP が成功したためフォールバック条件に該当せず |
| W-7 | ステップ3 パターンA ラベル付与 | MCP `issue_write`（`update`） | **成功** | `cc-fix-onetime` 付与を `pull_request_read`（`get`）で事後確認（`labels: ["cc-fix-onetime","cc-triage-scope"]`） |
| W-8 | `plugin/references/github-access.md` が指す `pull_request_write` | — | **ツールが存在しない** | セッションのツール一覧に無い（`ToolSearch` が0件）。`update_pull_request` は存在するが **`labels` パラメータを持たない**。PR のラベル操作は `issue_write`（`update`）で行う必要がある |
| W-9 | 素の `gh pr view --json baseRefName`（スキル本文 L291） | `gh`（GraphQL） | **未到達／単独では403** | パターンA で終了したためスキル実行中には到達せず。単独で実行すると `HTTP 403: This GraphQL query is not enabled for this session — only the pinned set of PR-review operations is served. Use REST via `gh api repos/{owner}/{repo}/...` instead. (https://api.github.com/graphql)`。**マージへ進むパターンB ではここで落ちる** |

`gh` へのフォールバックは1回も発生しなかった。

**W-19（補足）**: 本 Issue の PR 作成時（`create-pr` スキル）にも同じ問題が現れた。`create_pull_request` / `update_pull_request` のどちらも assignee・label のパラメータを持たないため `gh pr edit` へフォールバックしたところ **403（GraphQL ゲート）** になり、REST（`gh api repos/{o}/{r}/issues/{n}/assignees` / 同 `/labels`）へ切り替えて成立した。**PR への assignee・label 付与は、MCP にも `gh` の高レベルコマンドにも成立する経路が無く、`issue_write`（W-7）か REST 直叩きのいずれかを使う必要がある。**

### 実測表: `fix-review-point`（PR #351）— **フェーズ0で中断・成果物ゼロ**

| ID | ステップ / 操作 | 手段 | 結果 | 備考 |
| --- | --- | --- | --- | --- |
| W-10 | フェーズ0 `.claude/worktrees/` 配下チェック | `pwd` | **中断条件に該当** | `pwd` = `/home/user/<repo>`。クラウド実行は worktree を作らない設計のため、**この条件はクラウドでは常に成立しない** |
| W-11 | フェーズ0 デフォルトブランチ取得（fail-safe） | `gh-compat.sh default-branch` | **失敗 → 中断条件に該当** | 出力 verbatim: `gh-compat: failed to resolve the default branch`（exit 1）。G-42 の再現。代替手段は2つあり、どちらも実測で成立する（W-17 / W-18） |
| W-17 | 同上・REST による代替 | `gh api repos/{o}/{r} --jq .default_branch` | **成功（200）** | `main` を返す |
| W-18 | 同上・git 側の修復 | `git remote set-head origin -a` | **成功** | 欠けていた `refs/remotes/origin/HEAD` が `origin/main` に設定され、**以降 `gh-compat.sh default-branch` がそのまま `main` を返すようになる**。クラウド VM でもリモートへの照会は通るため、`gh-compat.sh` の第一手段（git ローカル導出）が成立しない原因は「参照が未設定であること」だけだと分かる |
| W-12 | フェーズ0 PR状態取得 | MCP `pull_request_read`（`get`） | **成功** | `state: open` / `head.ref: ctw-probe-337-fix` / `labels: ["cc-fix-onetime"]` |
| W-13 | フェーズ0 `gh pr checkout` | — | **省略（正しい判定）** | 現在ブランチが `headRefName` と一致 |
| W-14 | フェーズ1 `create-review-fix-plan` | — | **未起動** | フェーズ0中断のため |
| W-15 | フェーズ5 `commit-push` | — | **未起動** | 同上 |
| W-16 | フェーズ6 `resolve-pr-comments`（`resolve_thread`） | — | **未起動** | 同上。**`resolveReviewThread` の MCP 代替（G-24 / G-26）が動くかどうか以前に、そこへ到達しない** |

事後確認: PR #351 のレビュースレッドは `is_resolved: false` のまま、ラベル・コミット数にも変化なし（**GitHub 側への書き込みは1件も発生していない**）。

### 実測表: `check-dependabot`（PR #352）— **CHANGELOG 取得で停滞・判定に至らず**

| ID | ステップ / 操作 | 手段 | 結果 | 備考 |
| --- | --- | --- | --- | --- |
| W-20 | PR本文・差分の取得 | MCP `pull_request_read`（`get` / `get_diff`） | **成功** | G-2 / G-4 と同じ経路 |
| W-21 | CI状態の取得 | MCP `pull_request_read`（`get_check_runs`） | **成功** | 3件すべて success |
| W-22 | 依存元リポジトリの参照（`gh`） | `gh api repos/DefinitelyTyped/DefinitelyTyped` / 同 `/releases` | **403（プロキシ）** | 本文 verbatim: `{"message":"GitHub access to this repository is not enabled for this session. Use add_repo to request access. If add_repo answers that read access is already available and you need GitHub API or write access, call add_repo again with access:\"push\" to attach the repository with credentials.","documentation_url":"https://docs.anthropic.com/en/docs/claude-code/github-actions"}`。`documentation_url` が `docs.anthropic.com` ＝ **プロキシ合成の拒否**。2026-08-28 のリポジトリゲートと同一 |
| W-23 | 依存元リポジトリの参照（MCP） | MCP `list_releases`（`DefinitelyTyped/DefinitelyTyped`） | **拒否** | 本文 verbatim: `Access denied: repository "definitelytyped/definitelytyped" is not configured for this session. Allowed repositories: getty104/claude-task-worker`。**GitHub MCP はリポジトリスコープを迂回しない**（GraphQL ゲートは迂回するが、こちらは別の制限） |
| W-24 | 外部 HTTPS の到達性 | `curl https://registry.npmjs.org/@types/node` | **200** | プロキシ経由で外部へ出られる |
| W-25 | CHANGELOG 相当の取得（`WebFetch`・npm レジストリ） | `WebFetch` | **成功** | `https://registry.npmjs.org/@types/node/22.20.1` から依存（`undici-types ~6.21.0`）と `typeScriptVersion: 5.6` を取得できた |
| W-26 | CHANGELOG 相当の取得（`WebFetch`・GitHub の HTML ページ） | `WebFetch` | **成功** | `https://github.com/DefinitelyTyped/DefinitelyTyped/commits/master/types/node` のコミット一覧を取得できた。**API は塞がれていても HTML は読める** |
| W-27 | context7 での型定義パッケージの解決 | MCP `resolve-library-id`（`@types/node`） | **該当なし** | 返ってきたのは `utility-types` / `mime-types` 等の無関係な候補のみ。DefinitelyTyped の型定義パッケージは context7 の索引対象外とみられる |
| W-28 | 最終判定とマージ／修正 push | — | **未到達** | W-22 でスキルが停滞し、約40分後に打ち切った。PR #352 への書き込みは1件も発生していない |

### この実測で判明した、コード／ドキュメント側の要修正点

いずれも本 Issue のスコープ外（コードを変更しない）のため、別 Issue として起票した。

1. **`fix-review-point` / `exec-issue` のフェーズ0 worktree ガードがクラウド実行と構造的に矛盾する**（W-10）
2. **`gh-compat.sh default-branch` がクラウドで必ず失敗する**（W-11 / G-42）。REST を手段に加える（W-17）か、`git remote set-head origin -a` で `refs/remotes/origin/HEAD` を補う（W-18）ことで解決する
3. **`plugin/references/github-access.md` の PR ラベル操作の対応表が実在しないツール（`pull_request_write`）を指している**（W-8）。あわせて `triage-pr` の `mergeable` 3値前提（W-2）と、`issue_read`（`get_labels`）に PR 番号を渡すと `Failed to get issue labels: Could not resolve to an Issue with the number of 350.` で失敗する点も同じ箇所の問題
4. **`check-dependabot` の CHANGELOG 取得が第三者リポジトリのスコープ制限に阻まれる**（W-22 / W-23）。`WebFetch`（W-25 / W-26）へ寄せれば代替できる

### 未実測項目（本実測で埋まらなかったもの）

1. **ワーカー起動 → クラウドセッション作成 → `cc-cloud-done` 検知 → ラベル遷移の、ワーカー側の半分**
   - 理由: クラウドセッションの中に herdr も CLI の設定ファイルも無く、ワーカーを起動できない（上記「方法と、その限界」）
   - 再現手順: ローカルの herdr 環境から `claude-task-worker triage-pr --cloud` 等を、本節と同じ構成のプローブ PR に対して実行する
2. **`triage-pr` のパターンB（マージ）経路**
   - 理由: 仕込んだ未解決レビューコメントによりパターンA（`cc-fix-onetime` 付与）で確定したため。マージ自体は G-30 で成立を確認済みだが、**その直後に走る素の `gh pr view --json baseRefName`（W-9）は403になる**ため、マージ後の関連 Issue 連動 Close は失敗する見込み
3. **`fix-review-point` のフェーズ1以降すべて**
   - 理由: フェーズ0で中断したため（W-10 / W-11）。中断条件を解消しない限り測れない
4. **`check-dependabot` の判定・マージ／修正 push**
   - 理由: CHANGELOG 取得（W-22）で停滞し打ち切ったため
5. **`triage-pr` のパターンC（CI失敗時の `cc-need-human-check`）と CI 再実行**
   - 理由: プローブ PR の CI がすべて success だったため。CI 再実行が MCP 経由でのみ成立することは G-27 / G-28 / G-37 で確認済み

### 実測の副作用

- 使い捨てブランチ `ctw-probe-337-base` / `ctw-probe-337-triage` / `ctw-probe-337-fix` / `ctw-probe-337-dep` と、そのブランチ間の PR #350 / #351 / #352（**ベースはデフォルトブランチではない**）を作成した。既存の PR・Issue・デフォルトブランチには書き込んでいない
- PR #350 に `cc-fix-onetime` ラベルが付与された（`triage-pr` の判定結果そのもの）。#351 / #352 への書き込みは無い
- 3本の PR に対して CI（`ci.yml` / `ocr-review.yml` / CodeRabbit）が各1回走った
- **プローブブランチ4本は残っている** — G-38〜G-40 のとおりクラウドセッションからはブランチを削除できないため、**手動での削除が必要**。PR #350 / #351 / #352 も手動クローズが必要

## 測定ログ（要旨）

- **P-1** GraphQL ゲートの403: `gh api graphql -f query='query{viewer{login}}' -i` → `HTTP/1.1 403`（`Content-Length: 263`）、本文 `{"message":"This GraphQL query is not enabled for this session — only the pinned set of PR-review operations is served. Use REST via gh api repos/{owner}/{repo}/... instead.", ...}`。リポジトリを指定したクエリでも**バイト単位で同一本文**。`gh pr list` のみ操作名入りの変種（`This GraphQL query (PullRequestList, sent by gh pr list) is not enabled for this session…`）を返し、ゲートが**操作名単位のアローリスト**でクエリをパース判定していることを示す（ただし本実測で通った操作は1件も無くアローリストの中身は特定できず）
- **P-2** リポジトリゲートの403: `gh api repos/getty104/claude-task-worker/issues/226 -i` → `HTTP/1.1 403`（`Content-Length: 378`）、本文 `{"message":"GitHub access to this repository is not enabled for this session. Use add_repo to request access. ...", ...}`。**無関係な公開リポジトリ**（`gh api repos/cli/cli`）でも同一378バイト本文 → 特定リポジトリ未アタッチではなく**1件もアタッチされていない**状態
- **P-3** パスゲートの403: `gh api /octocat` / `gh api search/issues?q=...` → `{"message":"This GitHub API path is not available: sessions are bound to their configured repositories. Use repository-scoped endpoints (repos/{owner}/{repo}/...).", ...}`
- **P-4** 通過するREST: `gh api user` は200で完全な GitHub ヘッダ群（`Server: github.com` 等）を伴い実際に到達。`gh auth status` はトークンログインに失敗警告を出すが `gh api user` は成功（**環境変数のトークンはプレースホルダで、実資格情報はプロキシが注入**）。`gh api rate_limit --jq .rate` も200。対照的にP-1/P-2の403応答ヘッダは3行のみで `Server`/`X-GitHub-Request-Id` を欠き、**コンテナ内で合成されGitHubへ出ていない**
- **P-5** プロキシ構成: `CCR_AGENT_PROXY_ENABLED=1` 等のプロキシ関連env、`https_proxy=http://127.0.0.1:43957`。`curl .../__agentproxy/status` は `{"enabled":true,"port":43957,"installedProxyPreconfiguredClis":["gh"],"gitConfigInjection":true,...}` を返し、`recentRelayFailures` にGitHub拒否の記録は無い → **403はCONNECTリレーではなくその上位のGitHub対応レイヤが出している**
- **P-6** `gh version 2.45.0`（実バイナリ、ラッパーではない）。`--json parent`/`blockedBy`/`subIssuesSummary`/`closingIssuesReferences` は**このバージョンが未対応**で403以前に `Unknown JSON field` で失敗。`git remote -v` は出力なし（0件）、`git push --dry-run` は `fatal: No configured push destination.`（exit 128、push先が無いだけで**push可否は測れていない**）
- **P-7** `add_repo` はこのセッション種別に存在しない: P-2の403本文が案内する `add_repo` ツールがクラウドセッションのツール一覧に無く（`ToolSearch` 検索0件）、リポジトリゲートを解く試行自体ができなかった。アカウントレベルの設定変更・GitHub App 認可も発生していない

## PRD からの差分

1. **5章「GraphQL の 403 制限」の影響範囲が過小**。PRD は `--json parent,blockedBy` とレビュースレッド解決を挙げていたが、実際は `gh issue view --json` / `gh pr view --json` / `gh pr list` / `gh pr checks` が**フィールドを問わず**全滅する。ワーカー起動スキル15個すべてが影響を受ける
2. **「REST へのフォールバックが必要」は正しいが、レビュースレッド解決だけは REST 代替が原理的に存在しない**。ただし**GitHub MCP には代替がある**: `pull_request_review_write`（method: `resolve_thread`、`threadId` は `pull_request_read` の `get_review_comments` が返す `PRRT_...` node ID）。MCP はプロキシを経由しないため、`resolve-pr-comments` スキルを MCP 優先へ書き換えればクラウドでも Resolve は成立する（`gh api graphql` を使う `resolve-pr-comments.sh` は引き続きクラウドでは403で、ローカル向けフォールバックとして残る）。**未実測**（本メモの smoke test で動作確認した4ツールに含まれない）
3. **適合性表を全面的に格下げする必要がある**。`exec-issue` の ◎ を含め、Issue/PR の内容を `gh` で読む全ワーカーが GraphQL ゲートの影響下にある（上表参照）
4. **制約表に「リポジトリゲート」と「パスゲート」を追加すべき**。GitHub App 連携が未設定のセッションでは `repos/*` が全リポジトリで403になり、GraphQL 以前に何も読めない
5. **クラウド VM の `gh` が 2.45.0 で古い**。プロキシ制限とは独立に、sub-issue / issue-dependencies 系の `--json` フィールドが使えない。PRD にはこの前提が無い

## 未実測項目

> 以下は 2026-08-28 時点の未実測項目。**1 / 2 / 4 は 2026-08-30 の `G-*` 実測（上記「GitHub MCP ツールのクラウド実測」）で解消または部分解消している**（各項目の末尾を参照）。3 は未解消のまま。

1. **リポジトリ連携済みセッションでの REST 代替の実行検証**
   - 理由: `add_repo` がこのセッション種別に存在せず（P-7）、リポジトリゲートを解く手段が無かった。「REST 代替表」のエンドポイントはドキュメント上の実在確認に留まり、プロキシが個々の REST パスを通すかは未確認
   - 再現手順: claude.ai で対象リポジトリの GitHub 連携を設定したうえでクラウドセッションを作り直し、本メモの「REST 代替」表の各コマンドを実行する
   - **2026-08-30: 解消**。連携済みセッションで `repos/{o}/{r}/...` の GET が200を返すことを確認した（G-31）
2. **書き込み系操作（マージ・CI再実行・ラベル付与・コメント投稿）の個別可否**
   - 理由: D4–D7 はリポジトリゲートで先に落ちており、メソッド／パス単位のポリシーに到達していない
   - 再現手順: 1 の環境で D4–D7 を同じ「存在しないID宛て」の形で再実行し、403（プロキシ）と 404/422（GitHub 到達）を区別する
   - **2026-08-30: 解消**（G-32〜G-39）。マージ・ラベル付与・コメント投稿はプロキシを通って GitHub に到達する。CI再実行は `gh` 経路ではトークン権限（`actions: write` 欠如）で落ち、MCP 経由でのみ成立する。あわせて `git/refs` への書き込みだけを塞ぐ**書き込みパスゲート**を新たに発見した
3. **GraphQL アローリストに載っている操作の特定**
   - 理由: エラー本文が「pinned set of PR-review operations」の存在を示すが、本実測で通った GraphQL 操作は1件も無い
   - 再現手順: 1 の環境で `gh pr view --json reviews` 等の PR レビュー系操作を再実行し、リポジトリ連携でアローリストが変化するかを確認する
   - **2026-08-30: 未解消**。連携済みセッションでも GraphQL ゲートは同一本文の403を返した（G-41）。アローリストの中身は依然として特定できていない
4. **クラウドセッションからの push 可否**
   - 理由: 作業ツリーに remote が0件のため、push が資格情報に到達する前に失敗する（P-6）。remote の追加はリポジトリの変更にあたるため実施していない
   - 再現手順: 1 の環境（clone 由来で remote があるセッション）で `git push --dry-run` を実行する
   - **2026-08-30: 解消**。`git fetch` と**通常の push（新規コミットの push / `--force-with-lease` を含む）は成功する**。失敗するのは**削除 push（`git push origin :refs/heads/<branch>`）だけ**で、しかもエラーではなく `Everything up-to-date` と表示されて ref が残る（G-40）

## 実測の副作用

本実測により1件のクラウドセッション（`session_<REDACTED-1>`、P-1〜P-7）が作成された。`add_repo`・push・commit・ファイル編集は実行していない。一方、書き込み系APIは D4–D7（マージ・CI再実行・ラベル付与・コメント投稿）として実際に呼び出しており、いずれも存在しないオブジェクトID宛てのプローブで、リポジトリゲートの403（コンテナ内で合成されGitHubへ出ていない）に拒否されている。そのためGitHub側への副作用は無い。セッション自体は不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。
