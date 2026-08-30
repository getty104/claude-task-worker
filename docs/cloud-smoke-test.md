# クラウド実行の smoke test 手順書

`--cloud` フラグによるクラウド実行（Claude on the Web）を、実クラウドセッションで確認するための手順書。`docs/prd-cloud-worker-execution.md` 7.2 が定めるテスト3層（ユニットテスト／CLIスタブ統合テスト／**実クラウドセッションを使う限定的な smoke test**）のうち3層目に対応する（Issue #242）。

- **CI の通常ジョブでは実行しない**。実際に claude.ai 上にクラウドセッションを作成する副作用を伴うため、手動または定期実行に留める
- 2026-08-29 に実測を実施済み（claude 2.1.250 / herdr 0.8.2、使い捨ての private リポジトリ）。詳細は末尾の「実測記録」の該当エントリを参照。以降も実測のたびに「結果記録テンプレート」を埋めて「実測記録」へ追記していく運用を想定している

## スタブ層でカバー済みの範囲（本手順書では扱わない）

`src/cloud-execution.integration.test.ts` が CLI スタブで検証済みの項目（起動引数の付与・排他、print 専用環境変数が渡らないこと、worktree を作らないこと、`onCompleted` の呼び出し条件、mode/対応ワーカーの起動拒否）は再実装しない。本手順書が担うのは、**スタブでは代替できない実環境の挙動**（claude.ai 上の実セッション、`cc-cloud-done` ラベルによる実際の完了検知、Slack 通知からの実URL到達性）だけ。

同統合テストは `claude auth status --json` をスタブ化し、ワーカー子プロセスへ渡すホスト env（`ANTHROPIC_BASE_URL` 等）も固定するため、実行するホストの claude.ai サインイン状態に依存しない。未サインイン時の起動拒否（E3）もスタブ層で検証済みのため、本手順書でホストのサインイン状態を切り替えて確認する必要はない。

## 事前条件

| # | 項目 | 確認方法 |
|---|------|---------|
| 1 | `mode: "herdr"` | `~/.config/claude-task-worker/config.json` の `mode` |
| 2 | 対象ワーカーが `CLOUD_DENIED_WORKERS` に含まれず `--cloud` でクラウド実行される | 起動コマンドに `--cloud` を付ける（`claude-task-worker exec-issue --cloud` 等）。`claude-task-worker.json` の `workers.<name>.cloud` 設定は廃止済み |
| 3 | claude.ai サインイン | `claude auth status --json`（判定式は `docs/cloud-prerequisite-checks.md` 参照） |
| 4 | herdr の疎通 | `herdr --version` が応答すること |

**注記（Issue #374）**: 上記1・4は `scripts/cloud-smoke-test.sh preflight` が要求し続ける項目であり、同スクリプトは本Issueのスコープ外のため未更新のままである。一方 CLI 本体の起動ゲート（`checkCloudConfig()`、`src/config.ts`）は既に `mode` を判定条件に持たず、`script(1)` の可用性（`resolveScriptAvailable()`、`src/index.ts`）のみを見る（`docs/prd-cloud-worker-execution.md` 4.3）。herdr のタスクタブ経由でセッションを作成する経路自体が撤去されているため、herdr の疎通（項目4）は CLI 本体の起動には不要になっているが、preflight は要求し続ける。つまり**このスクリプトの preflight を通すことは CLI 本体の起動ゲートより厳しい**（herdr 未導入でも起動ゲート自体は通る）。ただし `run()` の実行経路振り分けが `mode: "herdr"` 条件のまま未追随（`docs/prd-cloud-worker-execution.md` 4.3）なので、**smoke test を実際に成立させるには項目1・4がいずれも必要**である。表自体はスクリプトの実際の要求どおりであり、変更していない。

クラウド VM 側の事前セットアップとして、claude.ai の環境設定のセットアップスクリプト欄に `npx claude-task-worker install` を記載し、プラグイン・CLI を導入しておくこと。リポジトリの `.claude/settings.json` へ宣言を書き戻す方式は前提が事実でなかったため撤去した（Issue #268）。

**GitHub App 連携（claude.ai 側）が未設定のリポジトリでは `--ref` / `--on-branch` が拒否される**（`docs/cloud-session-launch-flags.md` 実測）。事前に対象リポジトリで https://claude.ai/code の GitHub 連携を済ませておくこと。連携未設定のまま進めると、後述の「セッション作成」段で `Error: --ref <branch> cannot be honored: ...` を受け取って停止する。

**`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を設定すること**。GitHub App 連携が済んでいても、Claude Code 側のバグ（[anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776)）により `--ref` / `--on-branch` が「連携未設定」と誤判定されて拒否されることがある。本 CLI 経由の実行では `buildClaudeEnv()` が既に実装済みだが、本手順書の手動プローブ（`claude --cloud ...` を直接叩く手順）ではこの環境変数を自分で設定する必要がある。

**使い捨ての private リポジトリで実施すること**。実測に使ったIssue/PR番号・ブランチ名等が本リポジトリ（public）に残らないようにするため。

`scripts/cloud-smoke-test.sh preflight` が上記1〜4と herdr/gh/jq の存在をまとめて確認する。

## 手順

各段に、満たす受け入れ基準（PRD 11章）を対応付ける。基準1（既存挙動の不変性）と6（起動拒否）はユニット／スタブ層の担当のため対象外。

**推奨する実施段階**: いきなりワーカー経由のエンドツーエンドを回すのではなく、まず「手動プローブ」（`claude --cloud` を直接叩き、`--ref` / GitHub MCP の疎通 / ラベル付与 / `--on-branch` を個別に確認する）で個々の挙動を切り分けてから、「ワーカー経由のエンドツーエンド」（`cc-exec-issue` 等のトリガーラベルを実際に付けて一連の連鎖を通しで確認する）へ進む。個別の失敗をエンドツーエンドの結果と混同しないため。

### 1. 事前条件

```bash
scripts/cloud-smoke-test.sh preflight <worker-name>
```

事前条件1〜4がOK/NGで出る。NGがあれば解消してから進む。

### 2. セッション作成・タスク投入 — 基準2・7

対象の `cc-exec-issue`（または対象ワーカーのトリガーラベル）をテスト用Issueに付け、ワーカーを起動する。

- **確認**: 作成コマンド `claude --cloud <description> <共通フラグ...>` は herdr のタスクタブではなく、`script(1)` の疑似 pty 経由でワーカープロセスの子として `spawn` される（`createCloudSession()`、`src/process-manager.ts`）。`description` にワーカーのプロンプト（`appendCloudDoneInstruction()` 適用後）がそのまま渡っていることを確認したい場合、コマンドライン自体を目視する実測手段は確立していないため、代わりに claude.ai/code 上でセッションが実際にそのタスクのプロンプトどおりに動作していること（次項目）で間接的に確認する（基準2・7）。作成コマンド1本でセッション作成とプロンプト投入を同時に行う設計のため、投函コマンドは存在しない
- **目視**: claude.ai/code でクラウドセッションが作成され、対象タスクの内容で走っていることを確認する（基準2）
- **確認**: 作成コマンドの stdout からクラウドセッションID（`Created cloud session:` / `View: https://claude.ai/code/<id>`）が `CLOUD_SESSION_TIMEOUT_MS`（120秒）以内に読み取れること（`createCloudSession()`）。作成コマンドの spawn プロセス自体は ID 取得後すぐに終了する短命プロセスであり、herdr のタブは介在しないため「タブが閉じられること」の確認は不要
- **目視**: 作業が二重実行されていないこと（手順4で確認する PR が1件だけ作られること）を確認する。旧・作成→投函の2コマンド方式では description が初期プロンプトとして即実行されたうえ投函コマンドが同じ作業を再実行し、1タスクでPRが2件作られる不具合があった（Issue #302）

投入前に `scripts/cloud-smoke-test.sh snapshot before` を実行し、worktree・ローカルブランチの状態を記録しておく（後片付け確認・基準4で使う）。

### 3. 完了検知 — 基準7

タスク完了まで待つ。ローカルにクラウドをドライブし続ける TUI は存在しない（手順2の作成コマンドは既に終了している）ため、完了検知は `cc-cloud-done` ラベルのポーリングで行う。

- 完了検知は `cc-cloud-done` ラベルのポーリング方式（`waitForCloudTask()`、`src/process-manager.ts`）。herdr の agent ステータスはクラウド側の完了を反映しないため使わない（実測 `docs/cloud-session-launch-flags.md` M-1）
- **目視**: 台帳エントリ（ステータステーブル）が待機中も `running` のまま維持され、同一 Issue/PR の二重起動が `isRunning()` で防がれることを確認する
- **目視 → 自動の順で確認する**:
  1. クラウドセッションが最後の操作として、投入したプロンプトの指示（`appendCloudDoneInstruction()`、`src/claude-args.ts`）どおりに固定見出し `## claude-task-worker 実行結果`（`CLOUD_REPORT_HEADING`）を持つコメントを対象 Issue/PR へ投稿し、その直後に `cc-cloud-done` ラベルを付与することを **目視**で確認する
  2. ワーカーが `cc-cloud-done` の付与をポーリング検知し（`CLOUD_POLL_INTERVAL_MS` = 30秒間隔）、ラベルを除去することを手順4の `check-labels` で確認する（`cc-cloud-done` が残っていないこと）
  3. ワーカーが上記コメント（`findCommentSince()` で回収）を Slack 通知の本文に載せることを手順5で確認する
- **タイムアウト（`CLOUD_TASK_TIMEOUT_MS` = 4時間）で打ち切られた場合**: `cc-need-human-check` が付いて failed 扱いになり、セッション URL 付きの Slack 失敗通知が届くことを確認する。典型原因は `AskUserQuestion` でのセッション停止・クラウドVMのクラッシュ・プラグイン未導入・ラベル付与自体の失敗
- **手動救済の確認**: `cc-cloud-done` を人が手動で付与しても同じ経路で完了扱いになること（張り付いたクラウドタスクの救済手段）を、テスト用Issue/PRで確認する
- ここが本 smoke test の核心。「S-1/S-2 の前提の再確認」セクションの5番（クラウドをドライブし続ける TUI の有無）に直結する
- クラウド側の完了を確認する期待結果は次の2つ: (1) **目視**: claude.ai/code のセッションURLを開き、実際にタスクが完了していることを確認する、(2) **目視**: 手順5のSlack通知が届くこと

### 4. PR実在確認 — 基準3

```bash
scripts/cloud-smoke-test.sh check-labels <issue-number>
scripts/cloud-smoke-test.sh check-pr <issue-number> <base-branch> <task-started-epoch-ms>
```

- `check-labels` で `cc-in-progress` の除去、`cc-pr-created` または `cc-need-human-check` の付与を確認する
- `check-pr` は `selectOwnedClosingPr()`（`src/workers/exec-issue.ts`）と同じ判定材料（Issueをclosing参照、baseRefNameが対象ベースブランチと一致、createdAtがタスク起動時刻以降・現在時刻以前）で候補PRを列挙する。ローカル実行と異なりクラウドはブランチ名を自分で決めるため、head ref 一致ではなくこの基準で見る

### 5. 完了・失敗通知 — 基準5

- **目視**: Slack にタスク完了（または失敗）通知が届き、本文冒頭の `https://claude.ai/code/<id>` からセッションを開けることを確認する

### 6. 後片付け

```bash
scripts/cloud-smoke-test.sh snapshot after
```

- クラウドセッション: claude.ai/code の一覧から手動で削除する
- テスト用Issue/PR: 使い捨てのテスト用Issueで検証する方針とする（既存Issueを流用すると `cc-in-progress` 等の実運用ラベルが混ざり判定が汚れるため）。検証後にIssue/PRをクローズする
- ラベル: `check-labels` の結果を見て、テスト目的で付与されたラベルを外す
- worktree・ローカルブランチ: `snapshot after` の差分が `snapshot before` と一致すること（クラウド実行はworktreeを作らないため差分ゼロが正しい。基準4）

## S-1 / S-2 の前提の再確認

`docs/cloud-session-launch-flags.md` で実測済みの前提を、実装後・バージョン更新後も成立しているか確かめる項目。S-1（起動引数の受理可否）と S-2（完了検知・セッションID・transcript）は同一ファイルにまとまっている。事前条件の判定手段は `docs/cloud-prerequisite-checks.md` が正。

- 実測日: `claude --version` 2.1.247 / `herdr --version` 0.8.2（2026-08-27時点）
- **失効注記**: `claude --version` / `herdr --version` が上記より新しい場合は、下記5点を再実測すること

1. **引数の受理可否**（S-1）: `-p` と `--cloud` の併用が拒否される／非TTYの `--cloud` が拒否される／`--ref` と `--on-branch` の併用が拒否される／`--permission-mode` `--disallowedTools` `--append-system-prompt-file` `--model` `--effort` `--advisor` `--chrome` は受理される（`--advisor` は `buildClaudeArgs()`（`src/claude-args.ts`）が `advisorModel` 指定時のみ付与する。`--chrome` は本ツールからは付与されないが、claude CLI 側が受理することは `docs/cloud-session-launch-flags.md` T7 で確認済みのため確認対象に含める）
2. **セッション作成・完了検知の状態遷移**（S-2 / M-2・M-4）: 作成コマンド（`claude --cloud <description>`。description はプロンプトそのもの）の stdout からセッションIDが `CLOUD_SESSION_TIMEOUT_MS`（120秒）以内に取得できること。完了検知はローカル driver の agent ステータスではなく `cc-cloud-done` ラベルのポーリング方式のため、クラウドセッションがプロンプトの指示どおりに最終報告コメント投稿 → ラベル付与まで完遂することを確認する
3. **`agent_session` の値がクラウドセッションIDと一致しない**（S-2 / PRD 9-9）: `agentGet()` の `agent_session.value` はローカル claude のセッションUUID形式で、クラウドセッションID（`session_01…`形式）とは別物であること
4. **クラウドターンのローカル transcript が生成されない**（S-2 / PRD 9-4）: `~/.claude/projects/*/<sessionId>.jsonl` がクラウドセッションのターンでは生成されないこと
5. **クラウドをドライブし続けるローカル TUI の不在**（S-2 の最大の前提）: 2.1.247 時点では `claude --cloud "<desc>"` は作成後すぐ exit し、`claude --cloud <session_id>` の対話アタッチも無効で、herdr の agent ステータスで*クラウド側*の完了を検知する経路が無い。この前提を踏まえ、実装は herdr の agent ステータスに頼らず `cc-cloud-done` ラベルのポーリングで完了検知する方式に倒してある（手順3参照）。**本項目は、この前提（ローカル driver 経由でクラウド側の完了を検知できない）が新バージョンでも変わらず成立しているかを再確認する位置づけ**。もし新バージョンでクラウドをドライブし続ける TUI が現れていた場合は、ラベル駆動方式より確実な検知手段になりうるため、結果記録テンプレートにその旨と挙動の変化を記録すること

## 人の目視が必要な項目 / スクリプトで自動照会できる項目

| 項目 | 種別 |
|------|------|
| claude.ai/code 上のセッション表示 | 目視 |
| セッションID取得後に作成コマンドの spawn プロセスが終了すること | 目視 |
| クラウドセッションが最終報告コメント（`## claude-task-worker 実行結果`）を投稿し `cc-cloud-done` を付与・ワーカーが検知して除去する | 目視 |
| Slack 通知本文とセッションURLの到達性 | 目視 |
| 事前条件1〜4（mode / `--cloud`指定 / サインイン / herdr疎通） | `scripts/cloud-smoke-test.sh preflight` |
| Issueラベルの遷移（`cc-cloud-done` の除去含む） | `scripts/cloud-smoke-test.sh check-labels` |
| closing参照PRの候補列挙 | `scripts/cloud-smoke-test.sh check-pr` |
| worktree・ローカルブランチの残骸有無 | `scripts/cloud-smoke-test.sh snapshot` |

---

## 結果記録テンプレート

以下をコピーして実測のたびに埋める。

```markdown
### 実測 YYYY-MM-DD

- claude --version:
- herdr --version:
- 対象ワーカー / リポジトリ（プロジェクト名は伏せる）:

#### 受け入れ基準

| 基準 | 内容 | 結果（OK/NG/未実測） | 備考 |
|------|------|------|------|
| 2 | claude.ai上でセッション確認 | | |
| 3 | ラベル遷移がローカル同一条件 | | |
| 4 | worktree/ブランチ残骸なし | | |
| 5 | Slack通知からセッションURLに到達 | | |
| 7 | セッション作成（プロンプト込み）・`cc-cloud-done`付与→検知・除去→Slack通知の状態遷移が正しく連鎖する | | |

#### S-1 / S-2 再確認

| # | 項目 | 結果（OK/NG/未実測） | 備考 |
|---|------|------|------|
| 1 | 引数の受理可否 | | |
| 2 | セッション作成（プロンプト込み）・cc-cloud-done完了検知の状態遷移 | | |
| 3 | agent_session ≠ クラウドセッションID | | |
| 4 | クラウドターンのtranscript不在 | | |
| 5 | クラウドドライブ用ローカルTUIの不在 | | |

#### GitHub MCP（クラウドVM側）の追加確認

-
-
-

#### 副作用と後片付け

- 作成したクラウドセッション（削除済み/未削除）:
- テスト用Issue/PR番号（クローズ済み/未クローズ）:
- 付与されたラベルの後片付け:
```

## 実測記録

実測のたびに、上記テンプレートを埋めたエントリをここへ追記する（新しい実測を上に追加）。

### 実測 2026-08-29

- claude --version: 2.1.250
- herdr --version: 0.8.2
- 対象ワーカー / リポジトリ（プロジェクト名は伏せる）: `exec-issue`（手動プローブ2セッション＋ワーカー経由のエンドツーエンド1件）、使い捨てのprivateリポジトリ

#### 受け入れ基準

| 基準 | 内容 | 結果（OK/NG/未実測） | 備考 |
|------|------|------|------|
| 2 | claude.ai上でセッション確認 | OK | 手動プローブ2セッション（`--ref main`相当のベースブランチ指定、`--on-branch <PR head>`指定）とも作成・実行を確認 |
| 3 | ラベル遷移がローカル同一条件 | OK | `cc-cloud-done`の検知・除去 → `cc-pr-created`付与の連鎖を確認 |
| 4 | worktree/ブランチ残骸なし | OK | クラウド実行はworktreeを作らない設計どおり、snapshot差分ゼロ |
| 5 | Slack通知からセッションURLに到達 | OK | 完了通知本文冒頭のセッションURLから到達を確認 |
| 7 | セッション作成（プロンプト込み）・`cc-cloud-done`付与→検知・除去→Slack通知の状態遷移が正しく連鎖する | OK | `exec-issue`の所要時間は9分03秒（2行のファイル追加という小規模タスク） |

#### S-1 / S-2 再確認

| # | 項目 | 結果（OK/NG/未実測） | 備考 |
|---|------|------|------|
| 1 | 引数の受理可否 | OK | `--on-branch <PR head>`は指定PRのheadブランチ上で直接作業し、pushするとそのPRが更新される（新規ブランチは切られない）。`--ref <branch>`は指定ブランチを起点に`claude/<description由来>-<6文字>`形式の作業ブランチが新規に作られる（ブランチ名はdescription依存） |
| 2 | セッション作成（プロンプト込み）・cc-cloud-done完了検知の状態遷移 | OK | 上記「受け入れ基準」7参照 |
| 3 | agent_session ≠ クラウドセッションID | 未実測 | 本回の確認対象に含めていない |
| 4 | クラウドターンのtranscript不在 | 未実測 | 本回の確認対象に含めていない |
| 5 | クラウドドライブ用ローカルTUIの不在 | 未実測 | 本回の確認対象に含めていない |

#### GitHub MCP（クラウドVM側）の追加確認

- `mcp__github__*`ツールが55個存在することを確認
- 動作を確認できたのは4ツール: `issue_read` / `add_issue_comment` / `issue_write` / `create_pull_request`
- `gh … --json`（GraphQL経由）は引き続き403（GraphQLゲート健在）。`gh api repos/...`（REST）は成功

#### 副作用と後片付け

- 作成したクラウドセッション（削除済み/未削除）: 削除済み
- テスト用Issue/PR番号（クローズ済み/未クローズ）: クローズ済み（使い捨てリポジトリのため番号は本ドキュメントに記載しない）
- 付与されたラベルの後片付け: 完了（`cc-cloud-done`はワーカーが検知・除去、テスト用ラベルも後片付け済み）
- herdrタスクタブの後片付け: 完了（セッションID取得後にクローズ済み）
