# claude-task-worker

GitHub Issues/PRを定期ポーリングし、Claude Codeに処理を委譲するCLIツール。

本リポジトリに同梱されている `claude-task-worker` Claude Code プラグイン（`plugin/` ディレクトリ）と組み合わせることで、GitHub Issue の実装からPRのレビュー対応、Dependabot PRの対応までを自動化する。CLI 本体（npm パッケージ）とプラグイン（Claude Code マーケットプレイス）は同じリポジトリ・同じ名前で提供される。

## アーキテクチャ

`claude-task-worker` CLI がGitHubラベルを検知してタスクを起動し、`claude-task-worker` プラグインのスキルが実際の処理を担う。

```
┌────────────────────────────────────────────────────────┐
│                         GitHub                         │
│                                                        │
│  Issue (cc-exec-issue)                            ──┐  │
│  Issue (cc-triage-scope, blockedBy all closed)    ──┤  │
│  Issue (cc-update-issue)                          ──┤  │
│  Issue (cc-answer-issue-questions)                ──┤  │
│  Issue (cc-issue-created + cc-triage-scope)       ──┤  │
│  Issue (cc-epic-issue, all sub-issues closed)     ──┤  │
│  PR    (cc-fix-onetime)                           ──┤  │
│  PR    (cc-triage-scope)                          ──┤  │
│  PR    (cc-resolve-conflict)                      ──┤  │
│  PR    (dependencies, Dependabot)                 ──┤  │
└─────────────────────────────────────────────────────┼──┘
                                                      │
                                                      ▼
                                       ┌────────────────────────┐
                                       │   claude-task-worker   │
                                       └───────────┬────────────┘
                                                   │ invoke
                                                   ▼
                                       ┌────────────────────────┐
                                       │    Claude Code CLI     │
                                       │  + claude-task-worker  │
                                       │       plugin           │
                                       └────────────────────────┘
```

### Worker と claude-task-worker プラグインのスキル対応

| Worker | トリガーラベル | 呼び出されるスキル | デフォルト間隔 |
|---|---|---|---|
| `exec-issue` | `cc-exec-issue` | `/claude-task-worker:exec-issue` | 1分 |
| `create-issue` | `cc-triage-scope` (Issue, blockedBy が全て Close) | `/claude-task-worker:create-issue-from-issue-number` | 1分 |
| `update-issue` | `cc-update-issue` | `/claude-task-worker:update-issue` | 1分 |
| `answer-issue-questions` | `cc-answer-issue-questions` | `/claude-task-worker:answer-issue-questions` | 1分 |
| `fix-review-point` | `cc-fix-onetime` | `/claude-task-worker:fix-review-point` | 1分 |
| `triage-created-issue` | `cc-issue-created` + `cc-triage-scope` (Issue) | `/claude-task-worker:triage-created-issue` | 1分 |
| `triage-pr` | `cc-triage-scope` (PR) | `/claude-task-worker:triage-pr` | 1分 |
| `resolve-conflict` | `cc-resolve-conflict` (PR) | `/claude-task-worker:resolve-pr-conflict` | 1分 |
| `check-dependabot` | `dependencies` (PR) | `/claude-task-worker:check-dependabot` | 1時間 |
| `epic-issue` | `cc-epic-issue` (Issue, sub-issues が全て Close) | `/claude-task-worker:create-epic-pr` | 5分 |

> ℹ️ Issue 系ワーカーはすべて GitHub Issue Dependencies の `-is:blocked` 検索 qualifier でサーバ側絞り込みを行うため、未解決の blockedBy Issue を持つ Issue は対象外となる。

### Epic（親Issue）連携

親Issue (Issue Dependencies の Parent) を持つサブIssueを処理する場合、ワーカーはデフォルトブランチではなく `cc-epic-<親Issue番号>` ブランチから worktree を作成する。エピック単位でブランチをまとめることで、サブIssueごとのPRを単一の統合ブランチに集約しやすくなる。エピックブランチが remote に無い場合はデフォルトブランチから自動派生して push される。

`epic-issue` ワーカーは、`cc-epic-issue` ラベル付きの親Issueに紐づくサブIssueがすべて Close されたタイミングで `/claude-task-worker:create-epic-pr` を起動し、エピックブランチからまとめてPRを作成する。

### `--project` 指定時（ディスパッチャーモード）

`--project` オプションを指定した場合、CLIは自身でワーカーを起動する代わりに [herdr](https://herdr.dev) 経由のディスパッチャーとして動作する。指定したプロジェクトごとにherdrのタブ（ペイン）を作成し、そのプロジェクトのディレクトリで（`--project` を除いた）同じコマンドを非同期実行させ、稼働状況をステータステーブルで監視する。詳細は「[`--project <name>` オプション](#--project-name-オプション)」を参照。

## 必要なライブラリ

### 実行時に必要なもの

CLI 本体に npm の実行時依存パッケージはない（ビルド時に esbuild で単一ファイル `dist/index.js` にバンドルされ、Node.js 標準モジュールのみで動作する）。代わりに以下の外部ツールが必要。

| 名前 | バージョン | 用途 |
|---|---|---|
| [Node.js](https://nodejs.org/) | >= 22.6.0 | CLI の実行ランタイム（`--experimental-strip-types` を使用するテスト実行に必要） |
| [GitHub CLI (`gh`)](https://cli.github.com/) | - | Issue/PR の取得・ラベル操作など全GitHub操作（認証済みであること） |
| [Claude Code (`claude`)](https://docs.anthropic.com/en/docs/claude-code) | - | タスク実行エンジン。各ワーカーが Claude CLI プロセスとして起動する |
| [Git (`git`)](https://git-scm.com/) | - | worktree の作成・ブランチ操作 |
| [jq](https://jqlang.org/) | - | プラグインスキル内でのJSON加工（`check-dependabot` / `edit-pencil-design` スキルなどで使用） |
| [Pencil CLI (`pencil`)](https://docs.pencil.dev/for-developers/pencil-cli) | - | `.pen` デザインファイルの編集・参照・コンフリクト解消（`edit-pencil-design` / `inspect-pencil-node` / `resolve-pencil-conflict` スキルで使用） |
| [herdr](https://herdr.dev) | - | `--project` 使用時にのみ必要（通常ワーカー実行には不要）。複数プロジェクトへのディスパッチ・セッション監視・一括停止に使用 |
| `claude-task-worker` プラグイン | - | 各ワーカーが呼び出すスキル群（本リポジトリの `plugin/`） |

Slack通知（任意）を使う場合は Slack Incoming Webhook URL が必要。Claude API使用状況の取得には、macOSでは `security` コマンド（Keychain）を使用し、それ以外の環境では `~/.claude/.credentials.json` にフォールバックする。

### 開発時に必要なライブラリ（devDependencies）

| パッケージ | バージョン | 用途 |
|---|---|---|
| `typescript` | ^5.7.0 | 型チェック（`tsc --noEmit`） |
| `esbuild` | ^0.27.4 | `dist/index.js` へのバンドル |
| `@types/node` | ^22.0.0 | Node.js の型定義 |
| `eslint` | ^10.3.0 | Lint |
| `@eslint/js` | ^10.0.1 | ESLint 推奨設定 |
| `typescript-eslint` | ^8.59.1 | TypeScript 対応の ESLint ルール |
| `eslint-config-prettier` | ^10.1.8 | ESLint と Prettier の競合ルール無効化 |
| `prettier` | ^3.8.3 | コードフォーマッタ |

### プラグインが利用する MCP サーバー

`claude-task-worker` プラグイン（`plugin/.mcp.json`）は以下の MCP サーバーを定義しており、プラグイン有効化時に Claude Code から自動的に利用される。

| サーバー | 接続方法 | 用途 |
|---|---|---|
| `context7` | HTTP（`https://mcp.context7.com/mcp`） | ライブラリの最新ドキュメント取得 |
| `next-devtools` | `npx -y next-devtools-mcp@latest` | Next.js 開発支援 |
| `shadcn` | `npx shadcn@latest mcp` | shadcn/ui コンポーネント情報の取得 |

## セットアップ

### 前提条件

- [Node.js](https://nodejs.org/) v22.6 以上がインストール済みであること
- [GitHub CLI (`gh`)](https://cli.github.com/) がインストール・認証済みであること
- [Claude Code (`claude`)](https://docs.anthropic.com/en/docs/claude-code) がインストール済みであること
- `claude-task-worker` プラグインがインストール済みであること（下記インストール手順を参照）
- `--project` オプションを使う場合のみ、[herdr](https://herdr.dev) がインストール済みであること（通常のワーカー実行には不要）

詳細は上記「[必要なライブラリ](#必要なライブラリ)」を参照。

### インストール

#### 推奨手順（一発セットアップ）

以下のコマンド一発で、Claude Code マーケットプレイスの追加・プラグインのインストール・CLI本体のグローバルインストールをまとめて行える。

```bash
npx claude-task-worker install
```

- `claude plugin marketplace add getty104/claude-task-worker` — マーケットプレイスの追加（追加済みの場合のエラーはログのみで無視して続行）
- `claude plugin install claude-task-worker@claude-task-worker` — プラグインのインストール
- `npm install -g claude-task-worker@latest` — CLI 本体のグローバルインストール（`npx` 実行時でも `claude-task-worker` コマンドを常設化する）

インストール後、Claude Code のセッションを再起動するとプラグインが有効化される。

#### 手動手順（代替）

個別にインストールしたい場合は以下の手順でも良い。

CLI（npm パッケージ）:

```bash
npm install -g claude-task-worker
```

開発版をローカルから使う場合:

```bash
npm install
npm run build
npm link
```

Claude Code プラグイン（このリポジトリを Claude Code マーケットプレイスとして追加し、プラグインをインストールする）:

```bash
claude plugin marketplace add getty104/claude-task-worker
claude plugin install claude-task-worker@claude-task-worker
```

インストール後、Claude Code のセッションを再起動するとプラグインが有効化される。

herdr（`--project` オプションを使う場合のみ必要。通常ワーカー実行には不要）:

```bash
curl -fsSL https://herdr.dev/install.sh | sh
# または
brew install herdr
```

詳細は [herdr インストールドキュメント](https://herdr.dev/docs/install/) を参照。

#### 更新

CLI とプラグイン（マーケットプレイス）をまとめて更新する。

```bash
claude-task-worker update
```

- `claude plugin marketplace update claude-task-worker` — マーケットプレイスの更新
- `claude plugin update claude-task-worker@claude-task-worker` — プラグインの更新（反映にはセッション再起動が必要）
- `npm install -g claude-task-worker@latest` — CLI 本体の更新

### 初期化

対象リポジトリで実行すると、必要なGitHubラベル・Issueテンプレート・GitHub Actionsワークフロー・設定ファイルが作成される。既存ファイルは保護され、`--force` を指定すると上書きされる。

```bash
claude-task-worker init           # 既存ファイルは保護
claude-task-worker init --force   # 既存ファイルを強制上書き
```

作成されるラベル:

| ラベル名 | 用途 |
|---------|------|
| `cc-update-issue` | Issue更新トリガー |
| `cc-answer-issue-questions` | Issue確認事項への回答トリガー |
| `cc-exec-issue` | Issue実行トリガー |
| `cc-fix-onetime` | PR修正トリガー（1回） |
| `cc-triage-scope` | トリアージ対象マーク（Issue/PR） |
| `cc-resolve-conflict` | PRコンフリクト解消トリガー |
| `cc-in-progress` | 処理中ステータス |
| `cc-need-human-check` | 人間の確認が必要なマーク（付与中はIssueワーカーの処理対象から除外される） |
| `cc-issue-created` | `/claude-task-worker:create-issue` 由来のIssueマーク（triage-created-issue のトリガー条件） |
| `cc-pr-created` | PR作成完了マーク |
| `cc-epic-issue` | エピックマーク（Issueではサブ全Closeで `epic-issue` ワーカー起動、PRではリリースゲート対象を示すマーク） |
| `cc-release-ready` | エピックPRがリリース可能（マージ問題なし）と判定されたマーク。実際のマージ（リリース）は人間が実施 |

作成されるファイル:

- `.github/ISSUE_TEMPLATE/cc-triage-scope.yml` — `cc-triage-scope` ラベル付きIssue作成用テンプレート
- `.github/workflows/assign-creator-on-cc-triage-scope.yml` — Issue作成者を自動アサインするワークフロー
- `claude-task-worker.json` — 設定ファイル（コマンド実行ディレクトリ直下。全ワーカーのデフォルト設定が書き込まれた状態で作成される）

## コマンド

```bash
claude-task-worker <command> [--epic <issue-number>]... [--label <label-name>]...
```

### `--epic <issue-number>` オプション

`all` / `yolo` および Issue 系の各ワーカー（`exec-issue` / `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` / `epic-issue`）で、指定したエピックIssueのサブIssueのみを処理対象に絞り込む。エピック単位でロールアウトしたいときに使用する。

複数指定可能で、複数指定した場合はいずれかのエピックを親に持つサブIssueが対象になる（OR）。

> ℹ️ `epic-issue` ワーカーはエピックIssue自体を処理対象とするため、`--epic` で指定した番号は「サブIssueの親」ではなく「エピックIssue自身の番号」として照合される。`--epic 100` を指定した場合、Epic PR が作成されるのは #100 のみになる。

```bash
claude-task-worker all --epic 100
claude-task-worker all --epic 100 --epic 200    # #100 または #200 の sub-issue
```

### `--label <label-name>` オプション

`all` / `yolo` および Issue 系の各ワーカーで、トリガーラベルに加えて指定したラベルが付いているIssueのみを処理対象に絞り込む。優先度・スプリント・スコープ等で対象を限定したいときに使用する。

複数指定可能で、複数指定した場合は指定したすべてのラベルが付いているIssueが対象になる（AND）。`--epic` と併用すれば両条件のANDで絞り込まれる。

```bash
claude-task-worker all --label priority-high
claude-task-worker all --label priority-high --label needs-design   # 両方付いている Issue のみ
claude-task-worker yolo --epic 100 --epic 200 --label priority-high
```

> ℹ️ `--label` で指定したラベルはユーザーのスコープ指定なので、タスク完了時にワーカー側で除去されることはない（トリガーラベルだけが除去される）。

### `--project <name>` オプション

指定したプロジェクト（またはプロジェクトグループ、`all`）に対して、[herdr](https://herdr.dev) 経由でコマンドをディスパッチする。指定すると、CLIはワーカーをその場で実行する代わりにディスパッチャーとして動作し、対象プロジェクトごとに独立したherdrワークスペースを作ってコマンドを実行する。

プロジェクト名・グループ名・`all` のいずれかを指定できる。

- プロジェクト名: `config.json` の `projects` に登録された個別プロジェクト名
- グループ名: `config.json` の `projectGroups` に登録された、複数プロジェクト名をまとめたグループ名
- `all`: `config.json` の `projects` に登録された全プロジェクトが対象になる予約語（`projects` / `projectGroups` のキーとして使用不可）

`config.json` は `$XDG_CONFIG_HOME/claude-task-worker/config.json`（`XDG_CONFIG_HOME` 未設定の場合は `~/.config/claude-task-worker/config.json`）に配置する。`projects` にプロジェクト名から絶対パスへのマッピングを、`projectGroups` にグループ名からプロジェクト名配列へのマッピングを記述する（`projectGroups` は省略可）。

```json
{
  "mode": "default",
  "projects": {
    "app-a": "/Users/me/repos/app-a",
    "app-b": "/Users/me/repos/app-b",
    "app-c": "/Users/me/repos/app-c"
  },
  "projectGroups": {
    "frontend": ["app-a", "app-b"]
  }
}
```

`mode` については [`mode`（タスクの実行形態）](#modeタスクの実行形態) を参照。

`--project` は繰り返し指定可能で、複数指定した場合は解決後のプロジェクト集合の和集合が対象になる（重複は一意化される）。`--epic` / `--label` と併用でき、ディスパッチ先の各プロジェクトで実行されるコマンドにそのまま引き継がれる。

以下のコマンドは `--project` と併用できない: `init` / `install` / `update` / `usage` / `version`

ディスパッチャーは以下の3つの機能を持つ。

- **一斉起動**: 対象プロジェクトごとに `ctw:<プロジェクト名>` ラベルのherdrワークスペースを作成し、そのプロジェクトのディレクトリで（`--project` を除いた）同じコマンドを非同期実行する
- **稼働一覧**: 各セッションのプロジェクト名・ワークスペースID・ペインID・ステータス・稼働時間をステータステーブルとして定期的に画面へ描画し、対象プロセスが終了したセッションは自動的に一覧から除去する
- **一括停止**: SIGTERM/SIGINTを受けると、稼働中の全セッションへ ctrl-c を送信して各プロジェクトのコマンドを終了させ、終了を待ってからherdrワークスペースを閉じる（`mode: "herdr"` でワーカーが作ったタスクタブもワークスペースごと片付く）

```bash
claude-task-worker all --project all
claude-task-worker all --project app-a
claude-task-worker all --project frontend
claude-task-worker all --project app-a --project app-c    # app-a と app-c の和集合
claude-task-worker exec-issue --project app-a --epic 100 --label priority-high
```

### `mode`（タスクの実行形態）

`config.json` のトップレベルに `mode` を書くと、ワーカーが各タスク（Issue/PR ごとの claude 実行）をどう起動するかを切り替えられる。プロジェクト単位の指定はできず、全ワーカー・全プロジェクトに一括で適用される。

| `mode` | 挙動 |
|--------|------|
| `"default"`（既定） | タスクを `claude -p`（非対話 print モード）の子プロセスとして実行する |
| `"herdr"` | タスクを herdr のタブ内で TUI セッションとして実行する。実行中の様子をherdrで覗ける |

```json
{
  "mode": "herdr",
  "projects": { "app-a": "/Users/me/repos/app-a" }
}
```

`mode: "herdr"` のときの1タスクの流れ:

1. worktree を作成し、`ctw:<プロジェクト名>:#<Issue/PR番号>` ラベルのタブで claude を TUI 起動する
2. herdr が持つ agent ステータスを監視し、`working` → `idle` の遷移をタスク完了とみなす
3. 完了したらペインの内容を回収して通知に使い、タブを閉じてラベル・worktree を後片付けする

補足:

- タブは `--project` で起動した場合そのプロジェクトのワークスペース内に作られる（herdrが各ペインへ注入する `HERDR_WORKSPACE_ID` を利用する）
- `blocked`（claudeが入力待ち）になってもタスクは自動失敗にせず待機し続ける。ステータステーブルに `running:blocked` と表示されるので、herdrのタブを開いて直接対応できる
- `mode: "herdr"` でherdrが未インストール・未起動の場合、ワーカーは起動時にエラー終了する（`"default"` へ勝手にフォールバックしない）
- **タスク完了時の通知音はワーカー側から止められない**。herdr のエージェント状態遷移音を再生するのは herdr サーバープロセスで、`HERDR_DISABLE_SOUND` もそのプロセスの環境変数として読まれるため、タスクペインへ渡しても効かない（socket API にもペイン単位のミュートは無い）。無音にしたい場合は herdr 側の設定で行う:

  ```toml
  # ~/.config/herdr/config.toml
  [ui.sound]
  enabled = false
  ```

  適用は `herdr server reload-config`。この設定は herdr サーバー全体に効くため、ワーカー以外の対話セッションの完了音も鳴らなくなる（`[ui.sound.agents] claude = "off"` でも実質同じ範囲）。ワーカーだけを無音にしたい場合は、`HERDR_DISABLE_SOUND=1 herdr --session <name>` で別セッションを起動し、その中でディスパッチャーを動かす

### exec-issue

`cc-exec-issue` ラベルが付いた自分にアサインされたIssueを定期取得し、Claude Codeで処理を実行する。（デフォルト1分間隔）

- `cc-in-progress` ラベルを付与
- `/claude-task-worker:exec-issue <issue番号>` を非同期で実行
- 親Issueがある場合は `cc-epic-<親Issue番号>` ブランチから worktree を切って実行
- 完了後、`cc-exec-issue` ラベルを除去し、`cc-pr-created` ラベルを付与

### fix-review-point

`cc-fix-onetime` ラベルが付いたPRを定期取得し、Claude Codeで修正を実行する。（1分間隔）

- CI完了済みで `cc-in-progress` がないPRが対象
- 完了後、`cc-fix-onetime` ラベルを除去
- 完了後、設定ファイルに `fixReviewPointCallbackCommentMessage` が設定されていればPRにコメント投稿

### create-issue

`cc-triage-scope` ラベルが付いており、かつ Open な blockedBy Issue を持たないIssueを定期取得し、Claude CodeでIssue作成を実行する。（1分間隔）

`init` コマンドで作成されるIssueテンプレートを使えば、`cc-triage-scope` ラベル付与と作成者アサインが自動で行われる。ブロック中の依存 Issue が残っている間はワーカーが拾わず、依存がすべて Close された時点で処理が開始される。

- 除外ラベル: `cc-issue-created` / `cc-pr-created` / `cc-update-issue` / `cc-answer-issue-questions` / `cc-exec-issue` のいずれかが付いている Issue は対象外
- 完了後、`cc-issue-created` ラベルを付与して triage-created-issue ワーカーに引き継ぎ

### update-issue

`cc-update-issue` ラベルが付いたIssueを定期取得し、最新コメントの依頼内容に基づいてClaude CodeでIssue更新を実行する。（1分間隔）

### answer-issue-questions

`cc-answer-issue-questions` ラベルが付いたIssueを定期取得し、Issueに記載された確認事項への回答をClaude Codeで生成する。（1分間隔）

- 完了後、`cc-update-issue` ラベルを付与して update-issue ワーカーに引き継ぎ

### triage-created-issue

`cc-issue-created` と `cc-triage-scope` の両方のラベルが付いたIssueを定期取得し、Claude Codeでトリアージを実行する。（1分間隔）

- `cc-pr-created` / `cc-update-issue` / `cc-answer-issue-questions` / `cc-exec-issue` のいずれかが付いているIssueは除外
- 確認事項の有無に応じて `cc-answer-issue-questions` または `cc-exec-issue` ラベルを付与（または不要ならクローズ）

### triage-pr

`cc-triage-scope` ラベルが付いたPRを定期取得し、Claude Codeでトリアージを実行する。（1分間隔）

- `cc-fix-onetime` が付いているPRは除外
- `cc-resolve-conflict` が付いているPRは除外
- `cc-release-ready` が付いているPRは除外（リリースゲート判定済みのため再トリアージしない）
- マージ可能と判定した際、`cc-epic-issue` が付いたエピックPRはマージせず `cc-release-ready` ラベルを付与する（リリースのためのマージは人間の判断に委ねる）。通常PRは従来どおりマージする

### resolve-conflict

`cc-resolve-conflict` ラベルが付いたPRを定期取得し、`/claude-task-worker:resolve-pr-conflict` を実行してコンフリクト解消を行う。（1分間隔）

- 完了後、`cc-resolve-conflict` ラベルを除去

### check-dependabot

`dependencies` ラベルが付いたDependabot PRを定期取得し、依存ライブラリのバージョンアップ内容を確認する。（1時間間隔）

- `cc-triage-scope` が付いているPRは除外
- 完了後、`cc-triage-scope` ラベルを付与して triage-pr ワーカーに引き継ぎ

### epic-issue

`cc-epic-issue` ラベルが付いた親Issueを定期取得し、紐づくサブIssueがすべて Close されたタイミングで `/claude-task-worker:create-epic-pr` を起動してエピックPRを作成する。（デフォルト5分間隔）

- `cc-pr-created` が付いているIssueは除外
- サブIssueが存在しない、または1つでも未Closeのものがあればスキップ
- 完了後、親Issueに `cc-pr-created` ラベルを付与
- 完了後、作成されたエピックPR（`cc-epic-<親Issue番号>` ブランチ）に `cc-epic-issue` と `cc-triage-scope` ラベルを付与し、triage-pr のリリースゲート判定に引き継ぐ

### all

通常ワーカー7つ（exec-issue, fix-review-point, create-issue, update-issue, answer-issue-questions, resolve-conflict, epic-issue）を同時にポーリングする。`--epic` / `--label` オプションでIssue系ワーカーの処理対象を絞り込み可能（どちらも複数指定可）。

### yolo

すべてのワーカー（`all` + triage-created-issue + triage-pr + check-dependabot）を同時にポーリングする。`--epic` / `--label` オプションでIssue系ワーカーの処理対象を絞り込み可能（どちらも複数指定可）。

### usage

現在のClaude API使用状況（5時間/7日間の利用率とリセット時刻）を標準出力に表示し、Slack Webhookが設定されていればSlackにも通知する。

### install

`claude-task-worker` マーケットプレイスの追加・プラグインのインストール・CLI本体のグローバルインストールを一括で行う。

```bash
npx claude-task-worker install
```

- `claude plugin marketplace add getty104/claude-task-worker` — マーケットプレイスの追加（追加済みの場合のエラーはログのみで無視して続行）
- `claude plugin install claude-task-worker@claude-task-worker` — プラグインのインストール
- `npm install -g claude-task-worker@latest` — CLI 本体のグローバルインストール

いずれかのステップが失敗しても処理は継続し、`[install]` プレフィックス付きでエラー内容がログ出力される。

### update

`claude-task-worker` プラグイン/マーケットプレイスとCLI本体を更新する。

```bash
claude-task-worker update
```

- `claude plugin marketplace update claude-task-worker` — マーケットプレイスの更新
- `claude plugin update claude-task-worker@claude-task-worker` — プラグインの更新（反映にはセッション再起動が必要）
- `npm install -g claude-task-worker@latest` — CLI 本体の更新

いずれかのステップが失敗しても処理は継続し、`[update]` プレフィックス付きでエラー内容がログ出力される。

### version

インストールされている `claude-task-worker` CLI のバージョンを表示する。

```bash
claude-task-worker version
claude-task-worker --version
claude-task-worker -v
```

`package.json` の `version` を出力する（例: `0.6.0`）。

## 設定ファイル

コマンドを実行したディレクトリ直下の `claude-task-worker.json` を読み込む。

| キー | 型 | デフォルト | 説明 |
|---|---|---|---|
| `fixReviewPointCallbackCommentMessage` | string | - | fix-review-point 完了時にPRへ投稿するコメント（未設定の場合は投稿しない） |
| `workers` | object | `{}` | ワーカーごとに Claude CLI に渡すスキル、`--model` / `--effort`、ポーリング間隔、クールダウン時間、最大同時実行数を上書きする設定（詳細は下記） |

### ワーカーごとの設定

`workers` キーにワーカー名ごとの設定オブジェクトを指定することで、Claude CLI の `-p` に渡すスキル（スラッシュコマンド）、`--model` / `--effort`、ポーリング間隔、タスク完了後のクールダウン時間、最大同時実行数を個別に上書きできる。未指定のワーカー・フィールドは下記のワーカー別デフォルト値が使用される。

| ワーカー名 | デフォルト `skill` | デフォルト `model` | デフォルト `effort` | デフォルト `pollingIntervalSeconds` | デフォルト `cooldownSeconds` | デフォルト `maxConcurrentTasks` |
|---|---|---|---|---|---|---|
| `answer-issue-questions` | `/claude-task-worker:answer-issue-questions` | `opus` | `xhigh` | 60 | 0 | 1 |
| `create-issue` | `/claude-task-worker:create-issue-from-issue-number` | `sonnet` | `xhigh` | 60 | 0 | 1 |
| `update-issue` | `/claude-task-worker:update-issue` | `sonnet` | `high` | 60 | 0 | 1 |
| `exec-issue` | `/claude-task-worker:exec-issue` | `sonnet` | `high` | 60 | 0 | 1 |
| `fix-review-point` | `/claude-task-worker:fix-review-point` | `sonnet` | `high` | 60 | 0 | 1 |
| `triage-created-issue` | `/claude-task-worker:triage-created-issue` | `sonnet` | `high` | 60 | 0 | 1 |
| `triage-pr` | `/claude-task-worker:triage-pr` | `sonnet` | `high` | 60 | 0 | 1 |
| `resolve-conflict` | `/claude-task-worker:resolve-pr-conflict` | `sonnet` | `high` | 60 | 0 | 1 |
| `check-dependabot` | `/claude-task-worker:check-dependabot` | `sonnet` | `high` | 3600 | 0 | 1 |
| `epic-issue` | `/claude-task-worker:create-epic-pr` | `sonnet` | `high` | 300 | 0 | 1 |

各フィールドの値:

| フィールド | 型 | 説明 |
|---|---|---|
| `skill` | string | Claude CLI の `-p` に渡すスラッシュコマンド（例: `/claude-task-worker:exec-issue`, `/my-plugin:my-skill`）。ワーカーは `"<skill> <issue-or-pr-number>"` の形で Claude を起動する |
| `model` | string | Claude CLI の `--model` に渡す値（例: `sonnet`, `opus`, `haiku`） |
| `effort` | string | Claude CLI の `--effort` に渡す値（例: `high`, `medium`, `low`） |
| `pollingIntervalSeconds` | number | GitHub をポーリングする間隔（秒）。正の数を指定する |
| `cooldownSeconds` | number | タスク完了後に次のポーリングを停止する時間（秒）。`0` でクールダウンなし |
| `maxConcurrentTasks` | number | そのワーカーが同時に実行できるタスクの最大数。正の整数を指定する |

設定例:

```json
{
  "workers": {
    "exec-issue":        { "skill": "/my-plugin:exec-issue", "model": "opus", "effort": "high", "pollingIntervalSeconds": 60, "cooldownSeconds": 600, "maxConcurrentTasks": 3 },
    "fix-review-point":  { "skill": "/claude-task-worker:fix-review-point", "model": "sonnet", "effort": "high", "maxConcurrentTasks": 2 },
    "triage-pr":         { "effort": "medium", "pollingIntervalSeconds": 120 },
    "check-dependabot":  { "model": "haiku", "pollingIntervalSeconds": 7200 }
  }
}
```

## Slack通知

環境変数 `CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL` にSlack Incoming Webhook URLを設定すると、各ワーカーのタスク完了時・失敗時にSlackへ通知が送信される。

```bash
export CLAUDE_TASK_WORKER_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
claude-task-worker all
```

通知にはClaude APIの使用状況（5時間/7日間の利用率とリセット時刻）も含まれる。未設定の場合、通知は送信されない。

## プロセス管理

実行中のタスクはリアルタイムのステータステーブルで表示される。

- タスクID・タイトル・ステータス（running/completed/failed）・開始時刻・経過時間を表示
- 同一Issue/PRの重複実行を自動防止
- SIGTERM/SIGINTで全子プロセスをgraceful shutdown

## 開発

```bash
npm install
npm run build         # 型チェック（tsc --noEmit）+ esbuild で dist/index.js にバンドル
npm run dev           # 型チェックの watch モード
npm run lint          # ESLint
npm run lint:fix      # ESLint（自動修正）
npm run format        # Prettier で整形
npm run format:check  # Prettier のチェックのみ
```

コントリビューションを歓迎します。開発環境のセットアップ・PRの出し方は [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。バグ報告・機能要望は [Issue テンプレート](https://github.com/getty104/claude-task-worker/issues/new/choose) から作成してください。

セキュリティ上の脆弱性は公開Issueではなく [SECURITY.md](./SECURITY.md) の手順で報告してください。

本プロジェクトへの参加にあたっては [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)（Contributor Covenant）を遵守してください。

## ライセンス

MIT License. 詳細は [LICENSE](./LICENSE) を参照してください。
