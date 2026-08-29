# クラウド実行の smoke test 手順書

`workers.<name>.cloud: true` によるクラウド実行（Claude on the Web）を、実クラウドセッションで確認するための手順書。`docs/prd-cloud-worker-execution.md` 7.2 が定めるテスト3層（ユニットテスト／CLIスタブ統合テスト／**実クラウドセッションを使う限定的な smoke test**）のうち3層目に対応する（Issue #242）。

- **CI の通常ジョブでは実行しない**。実際に claude.ai 上にクラウドセッションを作成する副作用を伴うため、手動または定期実行に留める
- 実測記録はまだ無い。末尾の「結果記録テンプレート」に実測のたびに追記していく運用を想定している

## スタブ層でカバー済みの範囲（本手順書では扱わない）

`src/cloud-execution.integration.test.ts` が CLI スタブで検証済みの項目（起動引数の付与・排他、print 専用環境変数が渡らないこと、worktree を作らないこと、`onCompleted` の呼び出し条件、mode/対応ワーカーの起動拒否）は再実装しない。本手順書が担うのは、**スタブでは代替できない実環境の挙動**（claude.ai 上の実セッション、`cc-cloud-done` ラベルによる実際の完了検知、Slack 通知からの実URL到達性）だけ。

同統合テストは `claude auth status --json` をスタブ化し、ワーカー子プロセスへ渡すホスト env（`ANTHROPIC_BASE_URL` 等）も固定するため、実行するホストの claude.ai サインイン状態に依存しない。未サインイン時の起動拒否（E3）もスタブ層で検証済みのため、本手順書でホストのサインイン状態を切り替えて確認する必要はない。

## 事前条件

| # | 項目 | 確認方法 |
|---|------|---------|
| 1 | `mode: "herdr"` | `~/.config/claude-task-worker/config.json` の `mode` |
| 2 | 対象ワーカーの `cloud: true` | リポジトリ直下 `claude-task-worker.json` の `workers.<name>.cloud` |
| 3 | claude.ai サインイン | `claude auth status --json`（判定式は `docs/cloud-prerequisite-checks.md` 参照） |
| 4 | herdr の疎通 | `herdr --version` が応答すること |

クラウド VM 側の事前セットアップとして、claude.ai の環境設定のセットアップスクリプト欄に `npx claude-task-worker install` を記載し、プラグイン・CLI を導入しておくこと。リポジトリの `.claude/settings.json` へ宣言を書き戻す方式は前提が事実でなかったため撤去した（Issue #268）。

**GitHub App 連携（claude.ai 側）が未設定のリポジトリでは `--ref` / `--on-branch` が拒否される**（`docs/cloud-session-launch-flags.md` 実測）。事前に対象リポジトリで https://claude.ai/code の GitHub 連携を済ませておくこと。連携未設定のまま進めると、後述の「セッション作成」段で `Error: --ref <branch> cannot be honored: ...` を受け取って停止する。

`scripts/cloud-smoke-test.sh preflight` が上記1〜4と herdr/gh/jq の存在をまとめて確認する。

## 手順

各段に、満たす受け入れ基準（PRD 11章）を対応付ける。基準1（既存挙動の不変性）と6（起動拒否）はユニット／スタブ層の担当のため対象外。

### 1. 事前条件

```bash
scripts/cloud-smoke-test.sh preflight <worker-name>
```

事前条件1〜4がOK/NGで出る。NGがあれば解消してから進む。

### 2. セッション作成・タスク投入 — 基準2・7

対象の `cc-exec-issue`（または対象ワーカーのトリガーラベル）をテスト用Issueに付け、ワーカーを起動する。

- **目視**: herdr のタスクタブ（TTY を持つペイン）で作成コマンド `claude --cloud <description> <共通フラグ...>` が実行され、`description` にワーカーのプロンプト（`appendCloudDoneInstruction()` 適用後）がそのまま渡っていることを確認する（基準2・7）。作成コマンド1本でセッション作成とプロンプト投入を同時に行う設計のため、投函コマンドは存在しない
- **目視**: claude.ai/code でクラウドセッションが作成され、対象タスクの内容で走っていることを確認する（基準2）
- **目視**: ペイン出力からクラウドセッションID（`Created cloud session:` / `View: https://claude.ai/code/<id>`）が読み取れたら、（完了を待たずに）タブが閉じられることを確認する（クラウドセッションはローカルに常駐しないため。タブが残っていれば異常）
- **目視**: 作業が二重実行されていないこと（手順4で確認する PR が1件だけ作られること）を確認する。旧・作成→投函の2コマンド方式では description が初期プロンプトとして即実行されたうえ投函コマンドが同じ作業を再実行し、1タスクでPRが2件作られる不具合があった（Issue #302）

投入前に `scripts/cloud-smoke-test.sh snapshot before` を実行し、worktree・ローカルブランチの状態を記録しておく（後片付け確認・基準4で使う）。

### 3. 完了検知 — 基準7

タスク完了まで待つ。ローカルにクラウドをドライブし続ける TUI は存在しない（手順2でタブは既に閉じている）ため、完了検知は `cc-cloud-done` ラベルのポーリングで行う。

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
- herdr のタスクタブ: `ctw:<project>:#<n>`（ローカル実行と同一書式。`:cloud` サフィックスは付かない）ラベルのタブが残っていれば閉じる（通常は手順2でセッションID取得後にすぐ閉じられている）
- worktree・ローカルブランチ: `snapshot after` の差分が `snapshot before` と一致すること（クラウド実行はworktreeを作らないため差分ゼロが正しい。基準4）

## S-1 / S-2 の前提の再確認

`docs/cloud-session-launch-flags.md` で実測済みの前提を、実装後・バージョン更新後も成立しているか確かめる項目。S-1（起動引数の受理可否）と S-2（完了検知・セッションID・transcript）は同一ファイルにまとまっている。事前条件の判定手段は `docs/cloud-prerequisite-checks.md` が正。

- 実測日: `claude --version` 2.1.247 / `herdr --version` 0.8.2（2026-08-27時点）
- **失効注記**: `claude --version` / `herdr --version` が上記より新しい場合は、下記5点を再実測すること

1. **引数の受理可否**（S-1）: `-p` と `--cloud` の併用が拒否される／非TTYの `--cloud` が拒否される／`--ref` と `--on-branch` の併用が拒否される／`--permission-mode` `--disallowedTools` `--append-system-prompt-file` `--model` `--effort` `--advisor` `--chrome` は受理される（`--advisor` は `buildClaudeArgs()`（`src/claude-args.ts`）が `advisorModel` 指定時のみ付与する。`--chrome` は本ツールからは付与されないが、claude CLI 側が受理することは `docs/cloud-session-launch-flags.md` T7 で確認済みのため確認対象に含める）
2. **セッション作成・完了検知の状態遷移**（S-2 / M-2・M-4）: 作成コマンド（`claude --cloud <description>`。description はプロンプトそのもの）のペイン出力からセッションIDが `CLOUD_SESSION_TIMEOUT_MS`（120秒）以内に取得できること。完了検知はローカル driver の agent ステータスではなく `cc-cloud-done` ラベルのポーリング方式のため、クラウドセッションがプロンプトの指示どおりに最終報告コメント投稿 → ラベル付与まで完遂することを確認する
3. **`agent_session` の値がクラウドセッションIDと一致しない**（S-2 / PRD 9-9）: `agentGet()` の `agent_session.value` はローカル claude のセッションUUID形式で、クラウドセッションID（`session_01…`形式）とは別物であること
4. **クラウドターンのローカル transcript が生成されない**（S-2 / PRD 9-4）: `~/.claude/projects/*/<sessionId>.jsonl` がクラウドセッションのターンでは生成されないこと
5. **クラウドをドライブし続けるローカル TUI の不在**（S-2 の最大の前提）: 2.1.247 時点では `claude --cloud "<desc>"` は作成後すぐ exit し、`claude --cloud <session_id>` の対話アタッチも無効で、herdr の agent ステータスで*クラウド側*の完了を検知する経路が無い。この前提を踏まえ、実装は herdr の agent ステータスに頼らず `cc-cloud-done` ラベルのポーリングで完了検知する方式に倒してある（手順3参照）。**本項目は、この前提（ローカル driver 経由でクラウド側の完了を検知できない）が新バージョンでも変わらず成立しているかを再確認する位置づけ**。もし新バージョンでクラウドをドライブし続ける TUI が現れていた場合は、ラベル駆動方式より確実な検知手段になりうるため、結果記録テンプレートにその旨と挙動の変化を記録すること

## 人の目視が必要な項目 / スクリプトで自動照会できる項目

| 項目 | 種別 |
|------|------|
| claude.ai/code 上のセッション表示 | 目視 |
| セッションID取得・タブクローズの状態遷移 | 目視 |
| クラウドセッションが最終報告コメント（`## claude-task-worker 実行結果`）を投稿し `cc-cloud-done` を付与・ワーカーが検知して除去する | 目視 |
| Slack 通知本文とセッションURLの到達性 | 目視 |
| 事前条件1〜4（mode / cloud設定 / サインイン / herdr疎通） | `scripts/cloud-smoke-test.sh preflight` |
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

#### 副作用と後片付け

- 作成したクラウドセッション（削除済み/未削除）:
- テスト用Issue/PR番号（クローズ済み/未クローズ）:
- 付与されたラベルの後片付け:
- herdrタスクタブの後片付け:
```
