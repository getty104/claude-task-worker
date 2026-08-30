# claude-task-worker

GitHub Issues/PRを定期ポーリングし、Claude Codeに処理を委譲するCLIツール。

同梱の Claude Code プラグイン（`plugin/`）と組み合わせることで、Issue の実装からPRのレビュー対応、Dependabot PR の対応までを自動化する。CLI 本体（npm パッケージ）とプラグイン（Claude Code マーケットプレイス）は同じリポジトリ・同じ名前で提供される。

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
- `cc-need-human-check` が付いた Issue、未解決の blockedBy を持つ Issue は対象外
- 完了時にトリガーラベルを除去し、次のワーカーへ引き継ぐラベルを付与する
- 定期ワーカー3つ（`update-*`）はラベルではなく時刻を条件に24時間おきに1回動く。表の「間隔」は24時間経過したかを確認する頻度
- UIデザイン系3ワーカー（`create-ui-design` / `apply-ui-design` / `update-design-md`）は `uiDesign.enabled` が `true` のときだけ起動する（既定 `false`）

## セットアップ

### 前提条件

| 名前 | 用途 |
|---|---|
| [Node.js](https://nodejs.org/) >= 22.6.0 | CLI の実行ランタイム |
| [GitHub CLI (`gh`)](https://cli.github.com/) | 全 GitHub 操作（認証済みであること） |
| [Claude Code (`claude`)](https://docs.anthropic.com/en/docs/claude-code) | タスク実行エンジン |
| [Git](https://git-scm.com/) / [jq](https://jqlang.org/) | worktree 操作 / スキル内での JSON 加工 |
| [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph) | コード探索用インデックス（任意。未導入ならテキスト検索に落ちる） |
| [Pen CLI](https://docs.pen.dev/for-developers/pen-cli) | `.pen` の編集・参照。UIデザイン先行ワークフロー使用時のみ（要ログイン） |
| [Playwright](https://playwright.dev/) のブラウザ | Playwright MCP でのブラウザ確認 |
| [DESIGN.md CLI](https://github.com/google-labs-code/design.md) | `DESIGN.md` の lint。`update-design-md` 使用時のみ（未導入でも動く） |
| [herdr](https://herdr.dev) | `--project` / `mode: "herdr"` 使用時のみ（`--cloud` は herdr に依存しない） |
| [GitHub MCP](https://github.com/github/github-mcp-server) | GitHub アクセスの高速化・クラウド実行時のプロキシ制限回避（任意。Claude 側のコネクタで有効化） |

CLI 本体に npm の実行時依存はない（Node.js 標準モジュールのみで動作する）。

### インストール

```bash
npx claude-task-worker install
```

マーケットプレイス追加・プラグイン導入・CLI 本体のグローバルインストール・各種 CLI（CodeGraph / DESIGN.md / Pen）と Playwright ブラウザの取得を一括で行う。いずれかが失敗しても処理は継続する。インストール後、Claude Code のセッションを再起動するとプラグインが有効になる。

個別にやる場合:

```bash
npm install -g claude-task-worker
claude plugin marketplace add getty104/claude-task-worker
claude plugin install claude-task-worker@claude-task-worker
```

herdr は `curl -fsSL https://herdr.dev/install.sh | sh` または `brew install herdr`（[ドキュメント](https://herdr.dev/docs/install/)）。

### 更新

```bash
claude-task-worker update
```

マーケットプレイス・プラグイン・CLI 本体・各種 CLI をまとめて更新する。プラグインの反映にはセッション再起動が必要。

### 初期化

対象リポジトリで実行すると、GitHub ラベル・Issue テンプレート・GitHub Actions ワークフロー・設定ファイル（`claude-task-worker.json`）が作成され、CodeGraph のインデックスが構築される。

```bash
claude-task-worker init           # 既存ファイルは保護
claude-task-worker init --force   # 強制上書き
```

作成されるラベル:

| ラベル | 用途 |
|---|---|
| `cc-triage-scope` | トリアージ対象マーク（Issue/PR） |
| `cc-issue-created` | `create-issue` 由来の Issue マーク |
| `cc-update-issue` / `cc-answer-issue-questions` / `cc-exec-issue` | Issue の更新 / 確認事項回答 / 実行トリガー |
| `cc-fix-onetime` / `cc-resolve-conflict` | PR の修正 / コンフリクト解消トリガー |
| `cc-in-progress` | 処理中ステータス |
| `cc-need-human-check` | 人間の確認が必要（付与中はワーカーの対象外） |
| `cc-pr-created` | PR 作成完了マーク |
| `cc-epic-issue` | エピックマーク（Issue: サブ全 Close で `epic-issue` 起動 / PR: リリースゲート対象） |
| `cc-release-ready` | エピックPRがリリース可能と判定されたマーク（マージは人間が実施） |
| `cc-create-ui-design` / `cc-ui-design-pr-created` / `cc-ui-design-ready` | UIデザイン先行ワークフローの各段階 |
| `cc-ui-design` | デザインPRのマーカー |
| `cc-cloud-done` | クラウド実行タスクの完了マーク（セッションが付与し、ワーカーが検知して除去する。手動付与で張り付いたタスクを救済できる） |

## コマンド

```bash
claude-task-worker <command> [--epic <issue-number>]... [--label <label>]... [--project <name>]... [--cloud]
```

| コマンド | 内容 |
|---|---|
| 各ワーカー名 | 単一ワーカーを起動（`exec-issue` / `triage-pr` など） |
| `all` | 通常ワーカー9つ + 定期ワーカー3つ（`triage-created-issue` / `triage-pr` / `check-dependabot` を除く） |
| `yolo` | 全ワーカーを同時にポーリング |
| `init` | ラベル・テンプレート・設定ファイルの作成と CodeGraph セットアップ |
| `install` / `update` | 上記「セットアップ」を参照 |
| `cloud-setup [--force]` | クラウド VM 側の準備（下記「`--cloud`」を参照） |
| `usage` | Claude API 使用状況（5時間/7日間の利用率とリセット時刻）を表示し、Slack にも通知 |
| `version` | CLI のバージョンを表示（`--version` / `-v` も可） |

### `--epic <issue-number>`

指定したエピック Issue のサブ Issue のみを処理対象に絞る。複数指定は OR。

```bash
claude-task-worker all --epic 100 --epic 200
```

`epic-issue` ワーカーではエピック Issue 自身の番号として照合される。

### `--label <label>`

トリガーラベルに加えて指定ラベルが付いた Issue のみに絞る。複数指定は AND。`--epic` と併用可能。

```bash
claude-task-worker all --label priority-high --label needs-design
```

### `--project <name>`

指定したプロジェクト（またはグループ、`all`）へ [herdr](https://herdr.dev) 経由でコマンドをディスパッチする。CLI はワーカーを直接実行せず、プロジェクトごとに独立した herdr ワークスペースを作ってそこでコマンドを実行し、稼働状況をステータステーブルに表示する。SIGTERM/SIGINT で全セッションを一括停止する。

```bash
claude-task-worker all --project all
claude-task-worker exec-issue --project app-a --epic 100
```

プロジェクト名・グループ名は `config.json` で定義する（下記「設定ファイル」）。`all` は全プロジェクトを指す予約語。

`--project` と併用できないコマンド: `init` / `install` / `update` / `usage` / `version`

### `--cloud`

タスクを Claude Code on the web（クラウド VM）で実行する。プロセス単位のフラグで既定は無効。

```bash
claude-task-worker exec-issue --cloud
claude-task-worker all --cloud
```

**クラウドで実行されるのは `exec-issue` と `fix-review-point` の2ワーカーだけ**で、それ以外は `--cloud` を付けてもローカル実行のまま残る（`all` / `yolo` にそのまま付けられる）。どのワーカーがクラウドで走るかは起動時にログへ出る。

前提条件:

| 前提 | 備考 |
|---|---|
| `script` コマンドが使える環境（macOS / Linux） | クラウドセッションの作成には TTY が必要で、それを `script` コマンドの疑似 pty で供給する。platform が darwin/linux でない、または `script` が PATH に無い場合はタスクを1件も起動せずエラー終了する（フォールバックしない） |
| claude.ai アカウントでのサインイン | API キー認証・第三者プロバイダ（Bedrock / Vertex）構成では利用不可。`--cloud` 指定時のみ検査される |
| 対象リポジトリの GitHub App 連携 | クラウド VM から push / PR 作成を行うため |
| claude.ai の「プルリクエストを自動的に作成する」「プルリクエストの自動修正」が **OFF** | 下記 |
| VM 側のセットアップスクリプト | 下記 |
| `PEN_CLI_KEY` 環境変数 | UIデザイン先行ワークフローを使う場合のみ（下記「Pen CLI のログイン」） |

claude.ai の設定にある **「プルリクエストを自動的に作成する」「プルリクエストの自動修正」は必ず OFF にする**。どちらもタスクワーカーの制御と競合する。前者はスキルの `create-pr`（`Closes #<N>`・ベースブランチ・ラベル付与）とは別に PR を作るため PR が重複し、後者はセッションが PR 作成後に終了せずレビューを待って修正を続けるため、`cc-cloud-done` による完了検知が 4 時間のタイムアウトまで効かない。

claude.ai の環境設定（セットアップスクリプト欄）に次の2行を記載しておく。

```bash
npx claude-task-worker install
npx claude-task-worker cloud-setup
```

`cloud-setup` は VM 側の `~/.claude/settings.json` に権限モード・出力スタイル・言語を書き込み、グローバル gitignore へ `.codegraph/` を登録する。クラウドセッションは起動フラグの `--permission-mode` を反映しないため、この設定ファイルが権限モードを指定する唯一の経路になる。書き込みはキー単位のマージで既存の設定を消さない（`--force` で上書き）。

補足:

- クラウド実行のタスクは worktree を作らない（VM が自前でリポジトリを持つため）
- 完了は `cc-cloud-done` ラベルで検知する。4時間で応答がなければ打ち切り、`cc-need-human-check` を付けて失敗通知する
- `--project` と併用した場合、`--cloud` は各プロジェクトへそのまま転送される
- `--cloud` と併用できないコマンド: `init` / `install` / `update` / `usage` / `version`
- `--cloud` は `mode`（`default` / `herdr`）に依存しない。クラウドセッションの作成は `script` コマンドの疑似 pty で完結し、herdr のペインを使わないため、どちらの `mode` でも同じ経路を通る

詳細は [`docs/prd-cloud-worker-execution.md`](./docs/prd-cloud-worker-execution.md) を参照。

### Pen CLI のログイン

`.pen` を扱うスキルは Pen CLI の認証を必要とする。UIデザイン先行ワークフローを使うなら一度ログインしておく。

```bash
pencil login    # メールアドレス + パスワード、またはメールアドレス + OTP コード
pencil status   # 認証状態の確認
```

CI やクラウド VM など対話ログインできない環境では、環境変数 `PEN_CLI_KEY`（pen.dev の組織設定 > Developer Keys で発行）を使う。保存済みトークンより優先される。

## 設定ファイル

グローバル設定は `$XDG_CONFIG_HOME/claude-task-worker/config.json`（未設定なら `~/.config/claude-task-worker/config.json`）、リポジトリ設定は実行ディレクトリ直下の `claude-task-worker.json`。

### `config.json`（グローバル）

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

| キー | 既定 | 説明 |
|---|---|---|
| `projects` | - | プロジェクト名 → 絶対パス |
| `projectGroups` | `{}` | グループ名 → プロジェクト名配列 |
| `mode` | `"default"` | `"default"`: `claude -p` の子プロセスとして実行 / `"herdr"`: herdr のタブ内で TUI 起動し、実行中の様子を覗ける（`--project` はこちらが必要） |
| `advisor` | `false` | `true` で `--advisor <model>` を渡す。モデルは `claude-task-worker.json` の `advisorModel` |
| `permission` | `"bypassPermissions"` | Claude CLI の[権限モード](https://code.claude.com/docs/ja/permission-modes)（`bypassPermissions` / `dontAsk` / `auto` / `acceptEdits` / `manual` / `plan`） |

いずれもトップレベル一括で、プロジェクト単位・ワーカー単位の指定はできない。`permission` はワーカーに承認するユーザーがいないため、`bypassPermissions` / `dontAsk` 以外ではタスクが承認待ちで止まりうる。

> ℹ️ `mode: "herdr"` の完了通知音はワーカー側から止められない。無音にするには `~/.config/herdr/config.toml` に `[ui.sound] enabled = false` を書いて `herdr server reload-config` する（herdr サーバー全体に効く）。

### `claude-task-worker.json`（リポジトリ）

| キー | 型 | 既定 | 説明 |
|---|---|---|---|
| `fixReviewPointCallbackCommentMessage` | string | - | `fix-review-point` 完了時に PR へ投稿するコメント（未設定なら投稿しない） |
| `uiDesign` | object | `{ "enabled": false, "designDir": "designs", "yolo": false }` | UIデザイン先行ワークフロー（下記） |
| `workers` | object | `{}` | ワーカーごとの上書き設定（下記） |
| `lastRun` | object | `{}` | 定期ワーカーの最終実行時刻。ワーカーが自動更新するため手で編集しない |

#### ワーカーごとの設定

未指定のワーカー・フィールドは既定値にフォールバックする。

| フィールド | 説明 |
|---|---|
| `skill` | Claude CLI の `-p` に渡すスラッシュコマンド（`"<skill> <番号>"` の形で起動） |
| `model` | `--model` の値（`sonnet` / `opus` / `haiku`） |
| `advisorModel` | `--advisor` の値。空文字なら advisor なし。`config.json` の `advisor: true` のときだけ参照される |
| `effort` | `--effort` の値（`high` / `medium` / `low`） |
| `pollingIntervalSeconds` | ポーリング間隔（秒） |
| `cooldownSeconds` | タスク完了後にポーリングを止める時間（秒）。既定 `0` |
| `maxConcurrentTasks` | 同時実行できるタスクの最大数。既定 `1` |

既定値:

| ワーカー | `model` | `effort` | `pollingIntervalSeconds` |
|---|---|---|---|
| `exec-issue` / `fix-review-point` / `answer-issue-questions` / `create-issue` / `create-ui-design` / `triage-pr` | `opus` | `high` | 60 |
| `update-issue` / `triage-created-issue` / `resolve-conflict` | `sonnet` | `high` | 60 |
| `epic-issue` / `apply-ui-design` | `sonnet` | `medium` | 300 |
| `check-dependabot` | `sonnet` | `high` | 3600 |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | `opus` | `high` | 3600 |
| （未知のワーカー名） | `opus` | `high` | 60 |

`advisorModel` の既定は全ワーカー空文字（advisor なし）。

設定例:

```json
{
  "workers": {
    "exec-issue":       { "model": "opus", "cooldownSeconds": 600, "maxConcurrentTasks": 3 },
    "fix-review-point": { "model": "sonnet", "advisorModel": "opus", "maxConcurrentTasks": 2 },
    "triage-pr":        { "effort": "medium", "pollingIntervalSeconds": 120 }
  }
}
```

## ワークフロー

### Epic（親Issue）連携

親 Issue を持つサブ Issue は、デフォルトブランチではなく `cc-epic-<親Issue番号>` ブランチから worktree を作って処理される。サブ Issue ごとのPRを単一の統合ブランチへ集約するため。エピックブランチが remote に無ければ自動で派生・push される。

サブ Issue がすべて Close されると `epic-issue` ワーカーがエピックブランチからまとめてPRを作る。エピックPRは `triage-pr` がマージ可能と判定してもマージせず `cc-release-ready` を付けるだけで、実際のマージ（リリース）は人間に委ねられる。

### UIデザイン先行ワークフロー

UI実装 Issue について、実装の前に Pencil（`.pen`）でデザインを作り、独立したPRとしてマージしてから実装へ進むフロー。`uiDesign.enabled` によるオプトインで、既定（`false`）では関連ワーカーが起動しない。

| キー | 既定 | 意味 |
|---|---|---|
| `uiDesign.enabled` | `false` | 有効化 |
| `uiDesign.designDir` | `"designs"` | `.pen` とスナップショットの配置先（リポジトリルートからの相対パス） |
| `uiDesign.yolo` | `false` | `true` でデザインPRに `cc-triage-scope` を付け、既存フローで自動レビュー・自動マージへ流す |

```text
triage-created-issue（ルーティング）
  ├─ UI実装タスクでない → cc-exec-issue
  └─ UI実装タスク       → cc-create-ui-design
        → create-ui-design: .pen + snapshots を作り、デザインPR（cc-ui-design）を作成
        → yolo: true なら自動レビュー・マージ / false なら人がレビュー・マージ
        → apply-ui-design: マージ後に Issue description へ「## UIデザイン」を追記し cc-exec-issue を付与
        → exec-issue: デザインを参照元として実装
```

デザインが不要と判明した場合は `create-ui-design` が理由をコメントして実装へ復帰する。Pencil が使えない環境やデザインPRが却下された場合は `cc-need-human-check` で停止する。

## Slack通知

環境変数 `CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL` に Incoming Webhook URL を設定すると、タスクの完了時・失敗時に通知が送られる。未設定なら送信されない。

```bash
export CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
claude-task-worker all
```

通知には Claude API の使用状況も含まれる。あわせて [RunCat Neo](https://kyome.io/runcat/) 用のスナップショットを `~/.claude/runcat-usage.json`（`RUNCAT_OUT_FILE` で変更可）へ書き出す。クラウド実行のタスクは通知の先頭行にセッションURLが入る。

## プロセス管理

実行中のタスクはリアルタイムのステータステーブルで表示される（タスクID・タイトル・ステータス・開始時刻・経過時間）。SIGTERM/SIGINT で graceful shutdown し、もう一度送ると強制終了してラベル・worktree の後片付けを試みる。前回の異常終了で残った worktree はワーカー起動時に自動回収される。

ワーカーは応答するユーザーがいない状態でスキルを起動するため、処理が未完のままラベルだけ進む事故を防ぐガードを持つ（バックグラウンド実行と対話系ツールの無効化、自律実行原則のシステムプロンプト注入、PR 実在の完了検証、空出力セッションの失敗扱い、`Stop` フックによる残留プロセスの停止）。

## 開発

```bash
npm install
npm run build         # 型チェック + esbuild で dist/index.js にバンドル
npm run dev           # 型チェックの watch モード
npm test              # ユニットテスト
npm run lint          # ESLint（--fix で自動修正）
npm run format        # Prettier で整形
```

開発版をローカルから使う場合は `npm install && npm run build && npm link`。

コントリビューションを歓迎します。開発環境のセットアップ・PRの出し方は [CONTRIBUTING.md](./CONTRIBUTING.md)、バグ報告・機能要望は [Issue テンプレート](https://github.com/getty104/claude-task-worker/issues/new/choose) から。セキュリティ上の脆弱性は公開Issueではなく [SECURITY.md](./SECURITY.md) の手順で報告してください。参加にあたっては [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)（Contributor Covenant）を遵守してください。

## ライセンス

MIT License. 詳細は [LICENSE](./LICENSE) を参照してください。
