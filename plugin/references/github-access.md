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
| `gh api graphql`（`reviewThreads`） | `pull_request_read`（method: `get_review_comments`） |
| `gh pr list --head` / `--base` / `--state` | `list_pull_requests` |
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

## `gh` のまま残す操作

MCP へ移さない。理由が「クラウドでも `gh` で足りる」ではなく「**MCP では代替できない**」ものだけを挙げる。

| 操作 | 残す理由 |
| --- | --- |
| `gh pr checkout <n>` | ローカル作業ツリーへの checkout。リモート API では代替できない |
| `gh-asset download <id>` | 添付アセットをローカルへ落とす操作。MCP にファイル取得の同等ツールがない |
| `gh pr status` | カレントブランチという**ローカルの文脈**に依存する（MCP は PR 番号を要求する） |
| `gh repo view --json nameWithOwner,defaultBranchRef` | リポジトリ情報の単独取得ツールが MCP に無い。`git remote get-url origin` / `git symbolic-ref refs/remotes/origin/HEAD` でローカル導出できるため、そちらを優先してよい |
| `gh issue view --json parent` / `blockedBy`、`gh issue edit --add-blocked-by` / `--add-sub-issue` | Issue Dependencies / sub-issue の操作。MCP 側の対応が不定のため `gh` に据え置く |

## 本ドキュメントで扱わないもの

- **レビュースレッドの Resolve**（GraphQL `resolveReviewThread`、`resolve-pr-comments` スキル）。REST に該当エンドポイントが無く、フック／タスクハンドラ実行へ移す方針で別Issueの担当
- `src/gh.ts` などワーカープロセス側の `gh` 呼び出し。ワーカーはローカルで走り続けるためプロキシのゲートを受けない

## GitHub MCP の有効化

GitHub MCP は Claude 側（claude.ai / Claude Code）のコネクタとして有効化する。有効化していればセッションに GitHub MCP ツールが現れる。

本プラグインは `.mcp.json` で GitHub MCP を宣言しない（Claude 側のコネクタと二重登録になるため）。未設定の場合は上記「判定手順」のとおり `gh` へフォールバックする。

有効化の手順は README の「セットアップ」を参照。
