# 5. クラウド実行

`--cloud` を付けると、ワーカーが起動するタスクを手元のマシンではなく Claude Code on the web（クラウド VM）で実行する。手元のマシンの CPU・メモリを使わずに並列度を上げたいときに使う。

```bash
claude-task-worker exec-issue --cloud
claude-task-worker all --cloud
```

ワーカー（ポーリング・ラベル操作）は手元で動き続け、スキルの実行だけがクラウドへ移る。`--cloud` を付けたプロセスが起動するワーカーはすべてクラウドで実行される。

## 前提条件

| 前提 | 確認方法 |
|---|---|
| macOS または Linux で `script` コマンドが使える | 満たさなければ起動時にエラー終了する |
| claude.ai アカウントでサインインしている（API キー・Bedrock・Vertex・`ANTHROPIC_BASE_URL` では不可） | 満たさなければ起動時にエラー終了する |
| 対象リポジトリが claude.ai の GitHub 連携済み | ローカルからは確認できない。https://claude.ai/code で連携する（GitHub App の認可、または `/web-setup`） |
| 組織ポリシーでクラウドセッションが許可されている（`allow_remote_sessions`） | ローカルからは確認できない。拒否されている場合は組織の管理者に有効化を依頼する |
| claude.ai の「プルリクエストを自動的に作成する」「プルリクエストの自動修正」が OFF | 下記 |
| VM 側のセットアップスクリプト | 下記 |

サインインの直し方:

- 未サインイン: `claude auth login`
- API キー認証（`ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`）: 環境変数を解除して `claude auth login`
- 第三者プロバイダ: `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` を解除する
- `ANTHROPIC_BASE_URL` を設定している: 解除する

## セットアップ

### 1. claude.ai の設定

「プルリクエストを自動的に作成する」「プルリクエストの自動修正」を **OFF** にする。ON のままだと、前者はスキルとは別に PR を作って重複させ、後者はセッションが終わらず完了検知が 4 時間のタイムアウトまで効かなくなる。

### 2. 環境のセットアップスクリプト

claude.ai の環境設定のセットアップスクリプト欄に記載する。

```bash
npx claude-task-worker install
npx claude-task-worker cloud-setup
```

`install` は VM にプラグインと CLI を入れ、`cloud-setup` は VM の `~/.claude/settings.json` に権限モード（`auto`）・必要な `gh` / `git` の許可・出力スタイル・言語を書き込む。クラウドセッションは起動フラグの権限モードを反映しないため、この設定ファイルが唯一の指定経路になる。

[4章](./config-package.md) のパックのようにほかのプラグインのスキルを使う場合は、その `claude plugin marketplace add` / `claude plugin install` もここへ追記する。

UI デザイン先行ワークフローを使う場合は、環境変数 `PEN_CLI_KEY` も設定する。

### 3. 環境の指定（任意）

使うクラウド環境を固定したい場合は、`claude-task-worker.local.json` に環境 ID を書く（人ごとに違う値なのでコミットしない）。

```json
{ "remoteEnvId": "env_xxxxxxxx" }
```

指定しない場合は claude CLI の既定（`~/.claude/settings.json` の `remote.defaultEnvironmentId` → アカウントの最初のクラウド環境）が使われる。

## 動作

- タスクごとにクラウドセッションが1つ作られる。Slack 通知の先頭行にセッション URL が入る
- 手元に worktree は作らない（VM が自前でリポジトリを持つ）
- Issue 系ワーカーはベースブランチから新しい作業ブランチを切り、PR 系ワーカーは PR のブランチ上で直接作業する
- 完了はセッションが最後に付ける `cc-cloud-done` ラベルで検知する。ワーカーが検知してラベルを外し、以降はローカル実行と同じラベル遷移になる
- 4 時間で `cc-cloud-done` が付かなければ打ち切り、`cc-need-human-check` を付けて失敗通知する。セッションが実は終わっている場合は、手で `cc-cloud-done` を付ければ完了扱いにできる

## ワーカーごとの向き不向き

クラウドではスキルから `gh ... --json` などの一部の GitHub 操作が使えず、GitHub MCP 経由に切り替わる。

| ワーカー | 目安 |
|---|---|
| `exec-issue` / `fix-review-point` | 向いている（動作確認済み） |
| Issue 分析系（`create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue`）、`epic-issue`、`triage-pr`、`check-dependabot`、`resolve-conflict`、定期ワーカー | 動く想定だが運用実績が少ない |
| `create-ui-design` / `apply-ui-design` | VM に Pen CLI と `PEN_CLI_KEY` が必要 |

プロセス単位のフラグなので、向いているワーカーだけクラウドで動かすなら別プロセスに分ける。

```bash
claude-task-worker exec-issue --cloud &
claude-task-worker fix-review-point --cloud &
claude-task-worker triage-pr
```

## 失敗したとき

| 症状 | 対処 |
|---|---|
| 起動時に `--cloud` のエラーで終了する | 上記「前提条件」のサインインと `script` コマンドを確認する |
| `the GitHub App is not set up for this repository` | 連携済みでも Claude Code 側の不具合で出ることがある。ワーカーは回避策（`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`）を自動で付けているので、それでも出る場合は https://claude.ai/code で連携をやり直す |
| `Couldn't verify your organization's policy` | ポリシーの取得に失敗している。ネットワークを確認する |
| セッションが作られない・すぐ失敗する | 組織ポリシー（`allow_remote_sessions`）で拒否されている可能性がある。管理者に確認する |
| タイムアウトで `cc-need-human-check` が付いた | 通知のセッション URL を開いて状態を確認する。質問待ちで止まっている・セットアップスクリプト未設定でプラグインが無い、が典型 |

最終報告を Issue/PR に残して調べたいときは `--debug` を併用する。
