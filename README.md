# claude-task-worker

GitHub Issues/PRを定期ポーリングし、Claude Codeに処理を委譲するCLIツール。

同梱の `claude-task-worker` Claude Code プラグイン（`plugin/`）と組み合わせることで、Issue の実装からPRのレビュー対応、Dependabot PR の対応までを自動化する。CLI 本体（npm パッケージ）とプラグイン（Claude Code マーケットプレイス）は同じリポジトリ・同じ名前で提供される。

## アーキテクチャ

CLI が GitHub ラベルを検知してタスクを起動し、プラグインのスキルが実際の処理を担う。

```
   GitHub (Issue / PR + ラベル)
              │ poll
              ▼
     claude-task-worker
              │ invoke
              ▼
       Claude Code CLI
   + claude-task-worker plugin
```

### Worker とスキルの対応

| Worker | トリガー | 呼び出すスキル | 間隔 |
|---|---|---|---|
| `exec-issue` | `cc-exec-issue` (Issue) | `/claude-task-worker:exec-issue` | 1分 |
| `create-issue` | `cc-triage-scope` (Issue) | `/claude-task-worker:create-issue-from-issue-number` | 1分 |
| `update-issue` | `cc-update-issue` | `/claude-task-worker:update-issue` | 1分 |
| `answer-issue-questions` | `cc-answer-issue-questions` | `/claude-task-worker:answer-issue-questions` | 1分 |
| `triage-created-issue` | `cc-issue-created` + `cc-triage-scope` (Issue) | `/claude-task-worker:triage-created-issue` | 1分 |
| `epic-issue` | `cc-epic-issue` (Issue, sub-issues が全て Close) | `/claude-task-worker:create-epic-pr` | 5分 |
| `create-ui-design` | `cc-create-ui-design` (Issue) | `/claude-task-worker:create-ui-design` | 1分 |
| `apply-ui-design` | `cc-ui-design-pr-created` (Issue) | `/claude-task-worker:apply-ui-design` | 5分 |
| `fix-review-point` | `cc-fix-onetime` (PR) | `/claude-task-worker:fix-review-point` | 1分 |
| `triage-pr` | `cc-triage-scope` (PR) | `/claude-task-worker:triage-pr` | 1分 |
| `resolve-conflict` | `cc-resolve-conflict` (PR) | `/claude-task-worker:resolve-pr-conflict` | 1分 |
| `check-dependabot` | `dependencies` (PR) | `/claude-task-worker:check-dependabot` | 1時間 |
| `update-coding-guidelines` | 24時間経過 | `/claude-task-worker:update-coding-guidelines` | 1時間 |
| `update-requirement-rules` | 24時間経過 | `/claude-task-worker:update-requirement-rules` | 1時間 |
| `update-design-md` | 24時間経過 | `/claude-task-worker:update-design-md` | 1時間 |

共通の挙動:

- 処理中は `cc-in-progress` を付与し、同一 Issue/PR の重複実行を防ぐ
- `cc-need-human-check` が付いた Issue は全ワーカーの対象外
- Issue 系ワーカーは `-is:blocked` 検索 qualifier で絞り込むため、未解決の blockedBy を持つ Issue は対象外
- 完了時にトリガーラベルを除去し、次のワーカーへ引き継ぐラベルを付与する
- `create-ui-design` / `apply-ui-design` は `uiDesign.enabled` が `true` のときだけ起動する（既定 `false`）
- 定期ワーカー3つ（`update-coding-guidelines` / `update-requirement-rules` / `update-design-md`）はラベルではなく時刻を条件に24時間おきに1回動く。表の「間隔」は24時間経過したかを確認する頻度
- `update-design-md` は `uiDesign.enabled` が `true` のときだけ起動する

### プラグインの構成

| ディレクトリ | 内容 |
|---|---|
| `plugin/skills/` | ワーカーが呼ぶスキル群と、対話セッション用の補助スキル（`commit-push` / `create-pr` / `breakdown-issues` / `edit-pencil-design` など） |
| `plugin/agents/` | サブエージェント定義（`explore-agent` / `frontend-implementer` / `general-purpose-assistant` / `lightweight-assistant` / `pencil-design-updater` / `requirement-todo-organizer`） |
| `plugin/hooks/` | `SessionStart`（worktree セットアップ / `git fetch --prune`）と `UserPromptSubmit`（`codegraph prompt-hook`）のフック定義 |
| `plugin/scripts/` | フックから呼ばれるスクリプト（`setup-worktree.sh` / `stop-servers.mjs` / `resolve-pr-comments.sh` — `fix-review-point` の `Stop` フックでレビュースレッドを一括 Resolve） |
| `plugin/references/` | 複数スキルが共有する参照ドキュメント（GitHub アクセス方針など） |
| `plugin/.mcp.json` | MCP サーバー定義（`codegraph` / `context7` / `next-devtools` / `shadcn` / `playwright`） |

## セットアップ

### 前提条件

| 名前 | 用途 |
|---|---|
| [Node.js](https://nodejs.org/) >= 22.6.0 | CLI の実行ランタイム |
| [GitHub CLI (`gh`)](https://cli.github.com/) | 全 GitHub 操作（認証済みであること） |
| [Claude Code (`claude`)](https://docs.anthropic.com/en/docs/claude-code) | タスク実行エンジン |
| [Git](https://git-scm.com/) | worktree の作成・ブランチ操作 |
| [jq](https://jqlang.org/) | プラグインスキル内での JSON 加工 |
| [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) | コード探索用インデックス。任意（未導入でも探索がテキスト検索に落ちるだけ） |
| [Pen CLI](https://docs.pen.dev/for-developers/pen-cli) | `.pen` デザインファイルの編集・参照。UIデザイン先行ワークフロー使用時のみ（要ログイン。呼び出しは `pencil` 経由） |
| [Playwright](https://playwright.dev/) のブラウザ（chromium） | Playwright MCP でのブラウザ確認。`install` / `update` が取得する（バイナリのみ。CLI のグローバル導入はしない）。Linux ではシステムライブラリ（`install-deps`）も併せて導入する（非 root では `sudo` 経由なのでパスワードを求められることがある） |
| [DESIGN.md CLI](https://github.com/google-labs-code/design.md) | `DESIGN.md` の lint。`update-design-md` 使用時のみ（呼び出しは `designmd` 経由。未導入でもスキルは動く） |
| [herdr](https://herdr.dev) | `--project` / `mode: "herdr"` 使用時のみ |
| [GitHub MCP](https://github.com/github/github-mcp-server) | GitHub アクセスの高速化・クラウド実行時のプロキシ制限回避。Claude 側のコネクタで有効化する（任意。未設定でも `gh` へフォールバックする） |

CLI 本体に npm の実行時依存はない（esbuild で `dist/index.js` に単一バンドルされ、Node.js 標準モジュールのみで動作する）。

### インストール

```bash
npx claude-task-worker install
```

マーケットプレイスの追加・プラグインのインストール・CLI 本体のグローバルインストール・CodeGraph CLI / DESIGN.md CLI / Pen CLI のインストール・Playwright ブラウザ（chromium）の取得を一括で行う。いずれかが失敗しても処理は継続し、`[install]` プレフィックス付きでログ出力される（失敗時の終了コードは 1）。インストール後、Claude Code のセッションを再起動するとプラグインが有効になる。

個別にやる場合:

```bash
npm install -g claude-task-worker
claude plugin marketplace add getty104/claude-task-worker
claude plugin install claude-task-worker@claude-task-worker
```

herdr が必要な場合は `curl -fsSL https://herdr.dev/install.sh | sh` または `brew install herdr`（[ドキュメント](https://herdr.dev/docs/install/)）。

クラウド実行（`workers.<名前>.cloud: true`）を使う場合は、クラウド VM（Claude Code on the web）側にもプラグイン・CLI が必要になる。claude.ai の環境設定（Environment setup script / セットアップスクリプト欄）に `npx claude-task-worker install` を直接記載しておく。あわせて、クラウドセッションが push / PR 作成を行うには対象リポジトリの GitHub App 連携が必要。

UIデザイン先行ワークフローを使う場合は、同じ claude.ai の環境設定の環境変数欄に `PEN_CLI_KEY` も設定する。`.pen` を扱うスキル（`edit-pencil-design` / `inspect-pencil-node` / `resolve-pencil-conflict`）の Pen CLI 認証に使うもので、クラウド VM では対話ログインができないため。キーの発行元と値の形式は後述の「[Pen CLI のログイン](#pen-cli-のログイン)」を参照。

詳細は後述の「[`cloud`（クラウド実行）](#cloudクラウド実行)」を参照。

### GitHub コネクタの有効化

GitHub MCP は Claude 側のコネクタとして有効化する（本プラグインは `.mcp.json` で宣言しない）。claude.ai の設定 > コネクタ、または Claude Code の `/mcp` から GitHub コネクタを有効化する。

任意の設定であり、未設定でもスキルは `gh` へフォールバックして動作する。対応表は [`plugin/references/github-access.md`](./plugin/references/github-access.md) を参照。

### Pen CLI のログイン

`.pen` を扱うスキル（`edit-pencil-design` / `inspect-pencil-node` / `resolve-pencil-conflict`）は Pen CLI の認証を必要とする。未ログインだと `.pen` の読み書きが失敗するため、UIデザイン先行ワークフローを使うなら**インストール後に一度ログインしておく**。

```bash
pencil login    # メールアドレス + パスワード、またはメールアドレス + OTP コード
pencil status   # 認証状態の確認
```

セッショントークンは `~/.pencil/session-cli.json` に保存され、以降のコマンドで再利用される。

CI やワーカーを実行するマシンなど対話ログインできない環境では、環境変数 `PEN_CLI_KEY`（pen.dev の組織設定 > Developer Keys で発行）を使う。保存済みトークンより優先される。

```bash
export PEN_CLI_KEY=pencil_cli_...
```

詳細は [Pen CLI のドキュメント](https://docs.pen.dev/for-developers/pen-cli)を参照。

### 更新

```bash
claude-task-worker update
```

マーケットプレイス・プラグイン・CLI 本体・CodeGraph CLI / DESIGN.md CLI / Pen CLI をまとめて更新する。プラグインの反映にはセッション再起動が必要。

### 初期化

対象リポジトリで実行すると、GitHub ラベル・Issue テンプレート・GitHub Actions ワークフロー・設定ファイルが作成され、CodeGraph のインデックスが構築される。

```bash
claude-task-worker init           # 既存ファイルは保護
claude-task-worker init --force   # 強制上書き
```

作成されるラベル:

| ラベル | 用途 |
|---|---|
| `cc-triage-scope` | トリアージ対象マーク（Issue/PR） |
| `cc-issue-created` | `create-issue` 由来の Issue マーク（`triage-created-issue` のトリガー） |
| `cc-update-issue` | Issue 更新トリガー |
| `cc-answer-issue-questions` | Issue 確認事項への回答トリガー |
| `cc-exec-issue` | Issue 実行トリガー |
| `cc-fix-onetime` | PR 修正トリガー（1回） |
| `cc-resolve-conflict` | PR コンフリクト解消トリガー |
| `cc-in-progress` | 処理中ステータス |
| `cc-need-human-check` | 人間の確認が必要（付与中は Issue ワーカーの対象外） |
| `cc-pr-created` | PR 作成完了マーク |
| `cc-epic-issue` | エピックマーク（Issue: サブ全 Close で `epic-issue` 起動 / PR: リリースゲート対象） |
| `cc-release-ready` | エピックPRがリリース可能と判定されたマーク（実際のマージは人間が実施） |
| `cc-create-ui-design` | UIデザイン作成トリガー |
| `cc-ui-design-pr-created` | デザインPR作成済み・マージ待ちマーク |
| `cc-ui-design-ready` | デザイン反映済みマーク（再デザイン抑止） |
| `cc-ui-design` | デザインPRのマーカー（`triage-pr` のレビュー観点切り替え用） |
| `cc-cloud-done` | クラウド実行タスクの完了マーク（セッションが最後に付与し、ワーカーが検知して除去する。人が手動で付与しても同じ経路で完了扱いになるため、張り付いたクラウドタスクの救済手段としても使える） |

作成されるファイル:

- `.github/ISSUE_TEMPLATE/cc-triage-scope.yml` — `cc-triage-scope` 付き Issue 作成用テンプレート
- `.github/workflows/assign-creator-on-cc-triage-scope.yml` — Issue 作成者の自動アサイン
- `claude-task-worker.json` — 設定ファイル。**ワーカーごとの既定値は書き出さない**（写経するとプラグイン更新で既定が変わっても古い値に固定されるため）。上書きしたいワーカーだけ手で追記する

CodeGraph のセットアップとして、グローバル gitignore（`~/.config/git/ignore`）へ `.codegraph/` を冪等に追記し、`codegraph init` を実行する。CodeGraph 未インストールでも `init` 全体は失敗しない。

## コマンド

```bash
claude-task-worker <command> [--epic <issue-number>]... [--label <label>]... [--project <name>]...
```

| コマンド | 内容 |
|---|---|
| 各ワーカー名 | 単一ワーカーを起動（`exec-issue` / `triage-pr` など。上記 Worker 表を参照） |
| `all` | 通常ワーカー9つ + 定期ワーカー3つの計12ワーカーを同時にポーリング（`triage-created-issue` / `triage-pr` / `check-dependabot` を除く） |
| `yolo` | 全ワーカーを同時にポーリング（`all` + `triage-created-issue` + `triage-pr` + `check-dependabot`） |
| `init` | ラベル・テンプレート・設定ファイルの作成と CodeGraph セットアップ |
| `install` / `update` | 上記「セットアップ」を参照 |
| `usage` | Claude API 使用状況（5時間/7日間の利用率とリセット時刻）を表示し、Slack にも通知 |
| `version` | CLI のバージョンを表示（`--version` / `-v` も可） |

### `--epic <issue-number>`

指定したエピック Issue のサブ Issue のみを処理対象に絞る。`all` / `yolo` と Issue 系ワーカーで有効。複数指定するといずれかのエピックを親に持つサブ Issue が対象になる（OR）。

```bash
claude-task-worker all --epic 100 --epic 200
```

`epic-issue` ワーカーだけはエピック Issue 自体が処理対象なので、指定番号は「エピック Issue 自身の番号」として照合される。

### `--label <label>`

トリガーラベルに加えて指定ラベルが付いた Issue のみに絞る。複数指定すると全ラベルの AND。`--epic` と併用可能。ユーザーのスコープ指定なので、タスク完了時にワーカーが除去することはない。

```bash
claude-task-worker all --label priority-high --label needs-design
```

### `--project <name>`

指定したプロジェクト（またはグループ、`all`）へ [herdr](https://herdr.dev) 経由でコマンドをディスパッチする。指定するとCLIはワーカーを直接実行せず、対象プロジェクトごとに独立した herdr ワークスペースを作ってそこでコマンドを実行する。

```bash
claude-task-worker all --project all
claude-task-worker all --project frontend
claude-task-worker exec-issue --project app-a --epic 100 --label priority-high
```

プロジェクト名・グループ名は `$XDG_CONFIG_HOME/claude-task-worker/config.json`（未設定なら `~/.config/claude-task-worker/config.json`）で定義する。`all` は全プロジェクトを指す予約語。

```json
{
  "mode": "default",
  "advisor": false,
  "permission": "bypassPermissions",
  "projects": {
    "app-a": "/Users/me/repos/app-a",
    "app-b": "/Users/me/repos/app-b"
  },
  "projectGroups": {
    "frontend": ["app-a", "app-b"]
  }
}
```

ディスパッチャーの機能:

- **一斉起動**: プロジェクトごとに `ctw:<プロジェクト名>` ラベルのワークスペースを作り、そこで（`--project` を除いた）同じコマンドを実行する。ワーカーが実際に起動したかを確認し、起動しなければ再送・失敗判定する
- **稼働一覧**: プロジェクト名・ワークスペースID・ペインID・ステータス・稼働時間をステータステーブルに描画する
- **一括停止**: SIGTERM/SIGINT で全セッションへ ctrl-c を送り、終了を待ってワークスペースを閉じる。もう一度送ると強制終了

`--project` と併用できないコマンド: `init` / `install` / `update` / `usage` / `version`

## 設定ファイル

グローバル設定は `config.json`（上記）、リポジトリ設定は実行ディレクトリ直下の `claude-task-worker.json`。

### `config.json`（グローバル）

| キー | 既定 | 説明 |
|---|---|---|
| `projects` | - | プロジェクト名 → 絶対パス |
| `projectGroups` | `{}` | グループ名 → プロジェクト名配列 |
| `mode` | `"default"` | タスクの実行形態（下記） |
| `advisor` | `false` | `--advisor` を渡すか（下記） |
| `permission` | `"bypassPermissions"` | Claude CLI の権限モード（下記） |

#### `mode`（タスクの実行形態）

全ワーカー・全プロジェクトに一括適用される（個別指定は不可）。

| `mode` | 挙動 |
|---|---|
| `"default"` | タスクを `claude -p`（非対話 print モード）の子プロセスとして実行 |
| `"herdr"` | タスクを herdr のタブ内で TUI セッションとして実行。実行中の様子を herdr で覗ける |

`"herdr"` では、worktree 作成後に `ctw:<プロジェクト名>:#<番号>` ラベルのタブを作り、そのルートペインで claude を TUI 起動する。agent ステータスを監視して完了を検知し、セッション transcript から最終レポートを回収して通知に使う。`blocked`（claude が入力待ち）になっても自動失敗にせず待機し、ステータステーブルに `running:blocked` と表示するので herdr のタブを開いて直接対応できる。herdr が未インストール・未起動なら起動時にエラー終了する（`"default"` へフォールバックしない）。

> ℹ️ タスク完了時の通知音はワーカー側から止められない（音を鳴らすのは herdr サーバープロセスで、`HERDR_DISABLE_SOUND` もそのプロセスの環境変数として読まれるため）。無音にするには `~/.config/herdr/config.toml` に `[ui.sound] enabled = false` を書いて `herdr server reload-config` する。ただし herdr サーバー全体に効くため、対話セッションの完了音も鳴らなくなる。

#### `advisor`（アドバイザーモデル）

`true` にすると、タスク起動時に Claude CLI へ `--advisor <model>` を渡す。渡すモデルは `claude-task-worker.json` の `workers.<名前>.advisorModel`。`mode` と同じくトップレベル一括で、プロジェクト単位・ワーカー単位のオン/オフはできない。空文字が指定されたワーカーには渡さない。

advisor は main モデル以上の能力が必要（Claude CLI の制約）。`model` が `opus` のワーカーに `opus` advisor を付けても意味がなく、既定で `sonnet` のワーカーも `opus` advisor を付けると下げたぶんのコスト削減を打ち消すため、`advisorModel` の既定値は全ワーカー空文字（advisor なし）。`sonnet` のワーカーの品質が落ちた場合の調整弁として `advisorModel: "opus"` を指定できる。

#### `permission`（権限モード）

タスク起動時に Claude CLI へ渡す[権限モード](https://code.claude.com/docs/ja/permission-modes)。`mode` / `advisor` と同じくトップレベル一括で、プロジェクト単位・ワーカー単位の指定はできない。

| `permission` | 挙動 |
|---|---|
| `"bypassPermissions"`（既定） | 全許可。承認するユーザーが常駐しない自律実行のため既定 |
| `"dontAsk"` | 許可されていない操作は確認せずスキップする |
| `"auto"` | 安全な操作は自動承認、危険な操作のみ確認 |
| `"acceptEdits"` | ファイル編集は自動承認、それ以外は都度確認 |
| `"manual"` | 標準の権限確認 |
| `"plan"` | 読み取りのみ。変更は行わない |

値は Claude CLI の `--permission-mode` にそのまま渡される（choices と同じ綴り）。ワーカーには承認するユーザーがいないため、`bypassPermissions` / `dontAsk` 以外ではタスクが承認待ちで止まりうる（`mode: "herdr"` なら herdr のタブを開いて手動で承認できる）。

### `claude-task-worker.json`（リポジトリ）

| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `fixReviewPointCallbackCommentMessage` | string | - | `fix-review-point` 完了時に PR へ投稿するコメント（未設定なら投稿しない） |
| `uiDesign` | object | `{ "enabled": false, "designDir": "designs", "yolo": false }` | UIデザイン先行ワークフロー（下記） |
| `workers` | object | `{}` | ワーカーごとの上書き設定（下記） |
| `lastRun` | object | `{}` | 定期ワーカーの最終実行時刻（ワーカー名 → ISO8601）。ワーカーが自動更新するため手で編集しない |

#### ワーカーごとの設定

未指定のワーカー・フィールドは既定値にフォールバックする。

| フィールド | 型 | 説明 |
|---|---|---|
| `skill` | string | Claude CLI の `-p` に渡すスラッシュコマンド。`"<skill> <番号>"` の形で起動される |
| `model` | string | `--model` の値（`sonnet` / `opus` / `haiku`） |
| `advisorModel` | string | `--advisor` の値。空文字なら advisor なし。`config.json` の `advisor: true` のときだけ参照される |
| `effort` | string | `--effort` の値（`high` / `medium` / `low`） |
| `pollingIntervalSeconds` | number | ポーリング間隔（秒） |
| `cooldownSeconds` | number | タスク完了後にポーリングを止める時間（秒）。`0` でなし |
| `maxConcurrentTasks` | number | 同時実行できるタスクの最大数 |
| `cloud` | boolean | タスクをクラウド（Claude Code on the web）で実行するか。既定 `false`（下記「[`cloud`（クラウド実行）](#cloudクラウド実行)」） |

既定値（`skill` は「[Worker とスキルの対応](#worker-とスキルの対応)」を参照。`cooldownSeconds` は `0`、`maxConcurrentTasks` は `1`、`cloud` は `false`）:

| ワーカー | `model` | `effort` | `advisorModel` | `pollingIntervalSeconds` |
|---|---|---|---|---|
| `exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue` / `create-ui-design` / `triage-pr` | `opus` | `high` | `""`（なし） | 60 |
| `update-issue` / `triage-created-issue` / `resolve-conflict` | `sonnet` | `high` | `""`（なし） | 60 |
| `check-dependabot` | `sonnet` | `high` | `""`（なし） | 3600 |
| `epic-issue` / `apply-ui-design` | `sonnet` | `medium` | `""`（なし） | 300 |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | `opus` | `high` | `""`（なし） | 3600 |
| （未知のワーカー名） | `opus` | `high` | `""`（なし） | 60 |

設定例:

```json
{
  "workers": {
    "exec-issue":       { "model": "opus", "cooldownSeconds": 600, "maxConcurrentTasks": 3 },
    "fix-review-point": { "model": "sonnet", "advisorModel": "opus", "maxConcurrentTasks": 2 },
    "triage-pr":        { "effort": "medium", "pollingIntervalSeconds": 120 },
    "check-dependabot": { "model": "haiku", "pollingIntervalSeconds": 7200 }
  }
}
```

#### `cloud`（クラウド実行）

`workers.<名前>.cloud: true` で、そのワーカーのタスクを Claude Code on the web（クラウド VM）で実行する。ワーカー単位のオプトインで既定は `false`（`mode` / `advisor` / `permission` と違い、ワーカーごとに切り替えられる）。

前提条件:

- `config.json` の `mode` が `"herdr"` であること。新しいクラウドセッションの作成には TTY が必要で、`"default"` の子プロセス実行では作れない。`cloud: true` のワーカーがあるのに `mode` が `"herdr"` でない場合は**ワーカー起動時にエラー終了する**（`"default"` へフォールバックしない）
- claude.ai アカウントでのサインインが必須。API キー認証（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）・第三者プロバイダ（Bedrock / Vertex）・カスタムエンドポイント構成では利用できない。`cloud: true` のワーカーがある場合、これはワーカー起動時に静的検査される
- 対象リポジトリの GitHub App 連携（クラウド VM から push / PR 作成を行うため）
- claude.ai の環境設定のセットアップスクリプト欄に `npx claude-task-worker install` を記載してプラグイン・CLI を導入しておくこと（手順は「[インストール](#インストール)」参照）
- UIデザイン先行ワークフローを使う場合のみ、claude.ai の環境設定の環境変数欄に `PEN_CLI_KEY`（pen.dev の組織設定 > Developer Keys で発行）を設定しておくこと。`.pen` を扱う3スキルの Pen CLI 認証に使う（「[Pen CLI のログイン](#pen-cli-のログイン)」参照）

上記のうち静的検査されるのは1〜2番目だけで、GitHub App 連携・クラウド VM 側の導入状況・環境変数の設定はローカルから確認できないため検査されない。

クラウド実行を拒否するワーカーが3つある: `resolve-conflict` / `create-ui-design` / `apply-ui-design`。これらに `cloud: true` を指定すると起動時にエラー終了する。

運用上は次の3ワーカーへの `cloud: true` を推奨しない: `fix-review-point` / `triage-pr` / `check-dependabot`。起動自体は許可されるが、クラウドセッションの GitHub プロキシ制限でレビューコメント・CI ステータスなど判断材料を取得できず、タスクが空振りする。

クラウド実行のタスクは worktree を作らない（クラウド VM が自前でリポジトリを持つため）。

設定例:

```json
// config.json
{ "mode": "herdr" }
```

```json
// claude-task-worker.json
{ "workers": { "exec-issue": { "cloud": true } } }
```

詳細は [`docs/prd-cloud-worker-execution.md`](./docs/prd-cloud-worker-execution.md) を参照。

## ワークフロー

### Epic（親Issue）連携

親 Issue（Issue Dependencies の Parent）を持つサブ Issue を処理する場合、ワーカーはデフォルトブランチではなく `cc-epic-<親Issue番号>` ブランチから worktree を作成する。エピック単位でブランチをまとめることで、サブ Issue ごとのPRを単一の統合ブランチへ集約できる。エピックブランチが remote に無ければデフォルトブランチから自動派生して push される。

サブ Issue がすべて Close されると `epic-issue` ワーカーが `/claude-task-worker:create-epic-pr` を起動し、エピックブランチからまとめてPRを作る。エピックPRは `triage-pr` がマージ可能と判定してもマージせず `cc-release-ready` を付けるだけで、実際のマージ（リリース）は人間に委ねられる。

### UIデザイン先行ワークフロー

UI実装 Issue について、実装の前に Pencil（`.pen`）でデザインを作り、独立したPRとしてマージしてから実装へ進むフロー。デザインを実装PRとは別に単体でレビュー・合意でき、合意済みデザインがリポジトリに永続化される。

`uiDesign.enabled` によるオプトインで、既定（`false`）では2つのワーカーが起動しないため、Pencil を使っていないリポジトリの挙動は本機能の追加前と完全に一致する。

| キー | 既定 | 意味 |
|---|---|---|
| `uiDesign.enabled` | `false` | 有効化。`false` の間は `triage-created-issue` がUI判定を行わず、2つのワーカーも起動しない |
| `uiDesign.designDir` | `"designs"` | `.pen` とスナップショットの配置先（リポジトリルートからの相対パス） |
| `uiDesign.yolo` | `false` | デザインPRを自動レビュー・自動マージへ流すか。`true` のときだけデザインPRに `cc-triage-scope` を付ける |

```text
cc-issue-created + triage-created-issue（ルーティング）
  ├─ UI実装タスクでない → cc-exec-issue（従来どおり）
  └─ UI実装タスク       → cc-create-ui-design
        → create-ui-design ワーカー
           ・.pen を作成/更新 + snapshots/ に PNG 出力
           ・ブランチ cc-ui-design-<N> を push しデザインPRを作成（Refs #N。closing keyword は使わない）
           ・PR に cc-ui-design、Issue に cc-ui-design-pr-created を付与
        → yolo: true  → triage-pr / fix-review-point / resolve-conflict（既存フローでレビュー・マージ）
           yolo: false → 人がデザインPRをレビュー・マージ
        → apply-ui-design ワーカー
           ・デザインPRが MERGED になるまで skip
           ・Issue description に「## UIデザイン」セクションを追記
           ・cc-ui-design-ready + cc-exec-issue を付与
        → exec-issue（デザインを参照元として実装）
```

`triage-pr` は `cc-ui-design` 付きPRをコードレビューではなくデザイン向けの観点（差分が `.pen` とPNGに限定されているか、スナップショットからデザイン意図が読み取れるか、Issue 要件を満たしているか）で評価する。

デザインが不要と判明した場合は `create-ui-design` が理由をコメントして `cc-ui-design-ready` + `cc-exec-issue` を付与し、人手を介さず実装へ復帰する。Pencil が使えない環境やデザインPRが却下された場合は `cc-need-human-check` で停止する。

## Slack通知

環境変数 `CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL` に Slack Incoming Webhook URL を設定すると、各ワーカーのタスク完了時・失敗時に通知が送られる。未設定なら送信されない。

```bash
export CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
claude-task-worker all
```

通知には Claude API の使用状況（5時間/7日間の利用率とリセット時刻）も含まれる。使用状況の取得は macOS では `security`（Keychain）、それ以外では `~/.claude/.credentials.json` を使う。あわせて [RunCat Neo](https://kyome.io/runcat/) 用のスナップショットを `~/.claude/runcat-usage.json`（`RUNCAT_OUT_FILE` で変更可）へ原子的に書き出す（Webhook 未設定でも更新される）。取得結果は360秒キャッシュされるため、値は最大6分古くなりうる。

クラウド実行（`cloud: true`）のタスクは、通知の先頭行にクラウドセッションのURL（`https://claude.ai/code/<id>`）が入る。Slack で本文が折りたたまれても先頭行は見えるため。

## プロセス管理

実行中のタスクはリアルタイムのステータステーブルで表示される。

- タスクID・タイトル・ステータス（running/completed/failed）・開始時刻・経過時間を表示
- `mode: "herdr"` では実行中の行に agent ステータスが併記される（`running:working` / `running:blocked`）
- 同一 Issue/PR の重複実行を自動防止
- SIGTERM/SIGINT で全子プロセスを graceful shutdown（もう一度送ると強制終了し、ラベル・worktree の後片付けを試みる）
- 前回の異常終了で残った worktree はワーカー起動時に自動回収される（実行中タスク・対話セッションが掴んでいるものは保護される）

### タスク実行のガード

ワーカーは応答するユーザーがいない状態でスキルを起動するため、処理が未完のままセッションが終了してラベルだけ進む事故を防ぐガードを持つ。

- **バックグラウンド実行の無効化**: `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` を全タスクへ注入し、Bash の `run_in_background` やサブエージェントの自動バックグラウンド化を止める
- **ツールの無効化**: `--disallowedTools` で `Monitor` / `ScheduleWakeup` / `AskUserQuestion` / `EnterPlanMode` / `Cron*` / `RemoteTrigger` / `EnterWorktree` を無効化する
- **自律実行原則の注入**: `--append-system-prompt` で「ユーザーに質問しない・全ステップを完遂してから終了する・曖昧なら安全側を選ぶ・サブエージェントの完了報告を検証する」および CodeGraph 優先のコード探索方針を注入する
- **完了検証**: `exec-issue` / `epic-issue` は PR の実在（または Issue のクローズ）を確認できるまで `cc-pr-created` を付けず、確認できなければ `cc-need-human-check` を付けて Issue にコメントを残す
- **空振り検知**: 正常終了しても出力が空のセッションは失敗として分類し、失敗通知（stderr の末尾を含む）を送る
- **起動プロセスの後片付け**: スキル終了時に `Stop` フックが `docker compose down` と、worktree を作業ディレクトリに持つ残留プロセスの `SIGTERM` をベストエフォートで実行する（worktree はスキル完了直後に削除されるため、残留プロセスが削除の妨げになるのを防ぐ）

## 開発

```bash
npm install
npm run build         # 型チェック（tsc --noEmit）+ esbuild で dist/index.js にバンドル
npm run dev           # 型チェックの watch モード
npm test              # ユニットテスト（node --experimental-strip-types --test）
npm run lint          # ESLint（--fix で自動修正）
npm run format        # Prettier で整形（format:check でチェックのみ）
```

開発版をローカルから使う場合は `npm install && npm run build && npm link`。

コントリビューションを歓迎します。開発環境のセットアップ・PRの出し方は [CONTRIBUTING.md](./CONTRIBUTING.md)、バグ報告・機能要望は [Issue テンプレート](https://github.com/getty104/claude-task-worker/issues/new/choose) から。セキュリティ上の脆弱性は公開Issueではなく [SECURITY.md](./SECURITY.md) の手順で報告してください。参加にあたっては [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)（Contributor Covenant）を遵守してください。

## ライセンス

MIT License. 詳細は [LICENSE](./LICENSE) を参照してください。
