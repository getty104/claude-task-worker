# GitHub アクセス方針（GitHub MCP 優先 / `gh` フォールバック）

本プラグインのスキルが GitHub の Issue・PR・Actions を参照/更新するときの共通ルール。**スキル本文に `gh` コマンドの例が書かれている箇所も、本ドキュメントの対応表に該当するものは MCP ツールを優先して呼ぶ**。

## なぜ MCP を優先するか

クラウドセッション（`claude --cloud` / Claude Code on the web）の GitHub プロキシは操作名単位のアローリストで、`gh issue view --json` / `gh pr view --json` が**フィールドを問わず 403** になる（実測は `docs/cloud-graphql-proxy-limits.md`）。この状態ではタスクセッションが Issue/PR 本文を1文字も読めない。GitHub MCP はこのプロキシを経由しないため、クラウド実行でも読み書きが成立する。

ローカル実行では `gh` も MCP も動くため、どちらでも成果物は変わらない。

## 判定手順（1操作につき1回）

1. 対応表に載っている操作で、GitHub MCP のツールが利用可能なら**必ず MCP を使う**
2. 利用不可なら**同等の `gh` コマンドへ即フォールバック**する。利用不可とみなすのは次のいずれか
   - GitHub MCP のツールがセッションに存在しない（未設定・サーバー未起動）
   - 認証エラー（401 / 403 / 未認証を示すエラー）が返る
   - ツール呼び出しが失敗する
3. **MCP で失敗した同じ操作を MCP で再試行しない**（認証・設定の問題は再試行で直らず、待ち時間だけ増える）
4. フォールバックした場合は、その事実を最終報告に1行残す（例: 「GitHub MCP 未認証のため `gh` へフォールバックした」）

MCP 未設定・未認証の環境でもスキルは従来どおり動作する。GitHub MCP は**前提条件ではなく最適化**であり、導入していないリポジトリの挙動を変えない。

## `gh` 失敗の扱い（収集系スクリプト）

クラウドセッションでは MCP が使えない操作の `gh` フォールバックも 403 で失敗しうる。この失敗を `|| true` 等で握りつぶすと、「該当0件」と「取得に失敗した」を呼び出し元が区別できなくなる（収集対象0件と誤認してその期間の収集がスキップされる）。

- 収集スクリプト（`fetch-recent-*.sh` 等）は `gh` コマンドの失敗を**正常系として扱わない**。失敗時は握りつぶさず終了コード非0でエラー終了し、原因を stderr へ出す
- 「本当に0件だった」（`gh` が成功して結果が空）と「取得に失敗した」（`gh` がエラーで終了）は常に区別できる形で返す

## 書き込み系操作のフォールバック方針（二重実行の防止）

MCP でのコメント投稿・ラベル更新・マージ等の書き込みが失敗したとき、応答が失われただけで実際には書き込みが成立している場合がある。無条件に `gh` へ再実行すると二重投稿・二重マージの恐れがあるため、失敗の種類で扱いを分ける。

- **未実行が確定している場合**（認証拒否・権限エラー・ツール未検出など、リクエストがサーバーに到達していないと分かるエラー）は、即座に `gh` の同等コマンドへフォールバックしてよい
- **実行有無が不明な場合**（タイムアウト・接続断・応答喪失など）は、`gh` で直接再実行せず、まず対象（Issue/PRのコメント一覧・ラベル・マージ状態など）を読み直して**既に反映されていないかを確認**する。反映済みなら再実行しない。未反映と確認できた場合にのみ `gh` へフォールバックする
- **例外**: `pull_request_review_write`（method: `resolve_thread` / `unresolve_thread`）は冪等な no-op なので二重実行の害が無い。失敗の種類を問わず即フォールバックしてよい

## 対応表

ツール名は上流（[github/github-mcp-server](https://github.com/github/github-mcp-server)）で統廃合が進んでおり（`list_workflow_runs` → `actions_list` など）、リネームされることがある。**名前が食い違ったらセッションで利用可能なツール一覧を正とし、本表を直す**。

### Issue

| `gh` | GitHub MCP |
| --- | --- |
| `gh issue view <n> --json <fields>` | `issue_read`（method: `get`） |
| `gh issue view <n> --json comments` | `issue_read`（method: `get_comments`） |
| `gh issue view <n> --json subIssuesSummary` | `issue_read`（method: `get_sub_issues`） |
| `gh issue list --search ...` | `list_issues` / `search_issues` |
| `gh issue create` | `issue_write`（method: `create`） |
| `gh issue edit --add-label` / `--remove-label` / `--body` | `issue_write`（method: `update`） |
| `gh issue close [--reason]` | `issue_write`（method: `update`、state を closed へ） |
| `gh issue comment` | `add_issue_comment` |

### Pull Request

| `gh` | GitHub MCP |
| --- | --- |
| `gh pr view <n> --json <fields>` | `pull_request_read`（method: `get`） |
| `gh pr view --json files` / `gh pr diff --name-only` | `pull_request_read`（method: `get_files`） |
| `gh pr diff` | `pull_request_read`（method: `get_diff`） |
| `gh pr checks` | `pull_request_read`（method: `get_status` / `get_check_runs`） |
| `gh api graphql`（`reviewThreads`） | `pull_request_read`（method: `get_review_comments`）。スレッドの node ID（`PRRT_...`）と `isResolved` を返す。カーソル方式（`perPage` 最大100 / `after` に前ページの `endCursor`）でページングを取得しきる |
| `gh api graphql`（`resolveReviewThread` mutation） | `pull_request_review_write`（method: `resolve_thread`、`threadId: <node ID>`）。既に解決済みのスレッドへの呼び出しは **no-op**（冪等） |
| `gh pr list --head` / `--base` / `--state` | `list_pull_requests`（MCP 不可時の REST は `gh api "repos/{o}/{r}/pulls?state=open&head={owner}:{branch}"`。`gh pr list` は GraphQL 経由で 403 になる） |
| `gh pr list --search ...` | `search_pull_requests` |
| `gh pr create` | `create_pull_request` |
| `gh pr edit` | `pull_request_write`（method: `update`） |
| `gh pr merge` | `pull_request_write`（method: `merge`） |
| `gh pr comment` | `add_issue_comment`（PR は Issue 番号空間を共有する） |

### Actions

| `gh` | GitHub MCP |
| --- | --- |
| `gh run view <id> --log-failed` | `get_job_logs`（`failed_only: true`） |
| `gh run view <id> --json ...` / `gh workflow view` | `actions_get` |
| `gh run list` | `actions_list` |
| `gh run rerun --failed` | `actions_run_trigger` |

### その他

| `gh` | GitHub MCP |
| --- | --- |
| `gh api user --jq .login` | `get_me` |

## `gh-compat.sh`（MCP に無く、`gh` ではクラウドで落ちる操作）

MCP に同等ツールが無く、かつ `gh` の経路が GraphQL ゲートで 403 になる操作は、`${CLAUDE_PLUGIN_ROOT}/scripts/gh-compat.sh` に寄せてある。**REST / git のローカル導出を第一手段にし、失敗時のみ従来の `gh` へフォールバックする**ので、ローカル実行の挙動は変わらない。スキル本文からは `gh` を直接呼ばず、必ずこのヘルパーを経由する。

| サブコマンド | 置き換えた `gh` | 第一手段 |
| --- | --- | --- |
| `default-branch` | `gh repo view --json defaultBranchRef` | `git symbolic-ref refs/remotes/origin/HEAD` |
| `owner-repo` | `gh repo view --json nameWithOwner` | `git remote get-url origin` |
| `issue-parent <n>` | `gh issue view --json parent` | `GET repos/{o}/{r}/issues/{n}/parent` |
| `issue-deps <n>` | `gh issue view --json blockedBy,blocking` | `GET repos/{o}/{r}/issues/{n}/dependencies/{blocked_by,blocking}` |
| `add-blocked-by <n> <num>...` | `gh issue edit --add-blocked-by` | `POST .../dependencies/blocked_by`（body は番号ではなく `issue_id`） |
| `add-blocking <n> <num>...` | `gh issue edit --add-blocking` | 同上を**相手側から**貼る（REST に `blocking` の POST が無いため） |
| `add-sub-issue <parent> <child>...` | `gh issue edit --add-sub-issue` | `POST .../sub_issues`（body は `sub_issue_id`） |
| `pr-mergeable <n>` | `gh pr view --json mergeable` / `gh pr status` | `GET repos/{o}/{r}/pulls/{n}` の `mergeable`（`null` は `UNKNOWN` へ写す） |
| `pr-for-branch [branch]` | `gh pr view --json number`（カレントブランチのPR導出） | `GET repos/{o}/{r}/pulls?state=open&head={owner}:{branch}` |

`gh issue view --json parent` / `blockedBy` は GraphQL ゲートに加え、クラウド VM の gh 2.45.0 が**フィールド自体を知らない**（`Unknown JSON field`）。`gh issue edit --add-blocked-by` / `--add-sub-issue` も同 gh はフラグを知らない。ゲートが解けても `gh` 経路は直らないため、REST が唯一の道になる。

## `gh` のまま残す操作

| 操作 | 残す理由 |
| --- | --- |
| `gh pr checkout <n>` | ローカル作業ツリーへの checkout。リモート API では代替できない。**クラウドでは実行しない** — PR 系ワーカーがセッション作成時に `--on-branch <PR の head ブランチ>` を渡しており、クラウド VM は最初から PR のブランチ上で始まる（`src/claude-args.ts` の `buildCloudCheckoutInstruction()` が起動プロンプトでその旨を伝える） |
| `gh run view` / `gh run list` / `gh run rerun` | REST 経由なので GraphQL ゲートを受けない（MCP の `actions_*` を優先し、これはフォールバック） |

## 画像・添付ファイル

**画像は Issue へ直接添付せず、Google Drive 等へ上げたうえでリンクを貼る運用を前提とする。** GitHub の添付ファイル（`user-images.githubusercontent.com` / `github.com/user-attachments/...`）は認証付きの実体取得が必要で、クラウドセッションからは取得手段が無い（かつて使っていた `gh-asset` はサードパーティ拡張で、クラウド VM に導入されていない）。

- description・コメントに貼られた**リンクは読む**。一般URLは `WebFetch`、Google Drive はドライブ用の MCP、Figma は Figma MCP、GitHub の URL は上記対応表の MCP ツール
- 直接添付されていて読めない場合は、推測で補わず「添付 `<URL>` は取得不可（Issue への直接添付のため）」と報告・根拠に明記し、確認できた範囲で処理を続行する

## 本ドキュメントで扱わないもの

- `src/gh.ts` などワーカープロセス側の `gh` 呼び出し。ワーカーはローカルで走り続けるためプロキシのゲートを受けない

## GitHub MCP の有効化

GitHub MCP は Claude 側（claude.ai / Claude Code）のコネクタとして有効化する。有効化していればセッションに GitHub MCP ツールが現れる。

本プラグインは `.mcp.json` で GitHub MCP を宣言しない（Claude 側のコネクタと二重登録になるため）。未設定の場合は上記「判定手順」のとおり `gh` へフォールバックする。

有効化の手順は README の「セットアップ」を参照。
