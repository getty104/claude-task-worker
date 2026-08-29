# PRD: ワーカータスクのクラウド実行（Claude on the Web）

- ステータス: Draft
- 作成日: 2026-08-27
- 対象リポジトリ: getty104/claude-task-worker
- 関連 PRD: [prd-herdr-mode.md](./prd-herdr-mode.md)（`mode` によるタスク実行形態の切り替え）

> **フラグ名について**: 依頼文では `--claude` を渡すとあったが、claude CLI にそのフラグは存在しない。Claude on the Web（クラウドセッション）を起動するのは **`--cloud`** で、`--remote` はその非推奨エイリアス。本 PRD では `--cloud` として扱う。

## 1. 背景・目的

現在、ワーカーが起動するタスクセッションはすべてローカルマシンで走る（`mode: "default"` は `claude -p` の子プロセス、`mode: "herdr"` は herdr タブ内の TUI）。このため:

1. **並列度がローカルマシンの資源に縛られる**。`maxConcurrentTasks` を上げると CPU・メモリ・ネットワークがローカルで競合し、`--project all` で複数リポジトリを回すとさらに悪化する
2. **マシンを閉じられない**。ワーカープロセスが死ぬと実行中タスクも死ぬ（ラベルと worktree が中途半端に残る）
3. **ローカル環境の状態がタスクに漏れる**。worktree の残骸、掴まれたブランチ、常駐プロセス、`docker compose` の後片付け（`stop-servers.mjs`）といった問題は、すべて「タスクがローカルで走る」ことに由来する

Claude Code on the Web（クラウドセッション）はタスクごとに使い捨ての VM を割り当て、リポジトリを GitHub から clone して実行する。ワーカーのタスクを**ワーカーごとに**クラウドへ逃がせるようにすることで、上記3点を該当ワーカー分だけ解消する。

### 解決する課題

- 重いワーカー（`exec-issue` 等）だけをクラウドへ逃がし、ローカルは軽いワーカーとディスパッチに専念させられる
- クラウドセッションはローカルのプロセス寿命から独立しているため、ワーカー再起動やマシンのスリープでタスクが失われない（ただし完了検知の待機はワーカープロセス内に持つため、ワーカーを再起動すると待機は失われる。セッション自体は生き続ける。→ 4.4）
- タスク実行環境が使い捨て VM になり、worktree・残留プロセス・ローカルブランチ競合の後片付けが不要になる

### 非目標

- 全ワーカーを一律クラウドへ移すこと（既定は `false`、オプトイン）
- ローカル実行の廃止・置き換え

## 2. 用語

| 用語 | 意味 |
|------|------|
| クラウドセッション | `claude --cloud` で作成される、Anthropic 管理 VM 上の Claude Code セッション（claude.ai/code） |
| クラウド実行 | `workers.<name>.cloud: true` のワーカーが、タスクをクラウドセッションとして起動すること |
| ローカル実行 | 現行の実行形態（`mode: "default"` / `"herdr"` のいずれも、claude 本体がローカルで走る） |
| ドライバ | クラウドセッションを作成し、アタッチし続けるローカル側の `claude` プロセス。ワーカーから見た「タスクのプロセス」はこれになる |
| GitHub プロキシ | クラウドセッションの GitHub 通信を仲介する Anthropic 側のプロキシ。実際の GitHub 資格情報を VM の外に置く |

## 3. ユーザーストーリー

1. 開発者として、`claude-task-worker.json` に `"cloud": true` と書くだけで、そのワーカーのタスクをクラウドで実行したい。
2. 開発者として、`cloud` を書かない従来の設定では、これまでとまったく同じ挙動であってほしい（既定 `false`）。
3. 開発者として、クラウド実行でもラベル遷移（`cc-in-progress` の付け外し、`cc-need-human-check` への退避、`cc-pr-created` の検証付き付与）がローカル実行と同一であってほしい。
4. 開発者として、クラウド実行のタスクが失敗したら、ローカル実行と同じように Slack の失敗通知を受け取りたい。
5. 開発者として、クラウド実行を有効にしたが前提条件（認証）が整っていない場合は、タスクを起動する前にワーカー起動時点で気づきたい。

## 4. 機能要件

### 4.1 `workers.<name>.cloud`

リポジトリ直下 `claude-task-worker.json` の各ワーカー設定に `cloud`（boolean、既定 `false`）を追加する。

```json
{
  "workers": {
    "exec-issue": { "cloud": true },
    "triage-pr": { "cloud": false }
  }
}
```

- 追加先は `WorkerRuntimeConfig`（`src/config.ts`）。`DEFAULT_WORKER_CONFIG` と `WORKER_DEFAULTS` の全エントリで `cloud: false`
- パースは `parseWorkerEntry()` の他フィールドと同じく「不正値は警告して既定値」
- ワーカー単位で切り替えられる点が `mode` / `advisor` / `permission`（`config.json` のトップレベル一括）と異なる。クラウド適合性がワーカーごとに大きく違う（→ 5章）ため

### 4.2 起動引数の差分

クラウド実行の起動引数は**作成コマンド1つ**で組み立てる。`buildClaudeArgs()`（`src/claude-args.ts`）が組み立てるフラグ列（以下「共通フラグ」）だけを使う。**実装が落とすのは `-p` のみ**で、`--permission-mode bypassPermissions` / `--disallowedTools` / `--append-system-prompt-file` / `--model` / `--effort` / `--advisor` はクラウドでもローカルと同一に付与される（当初想定していた「ツール制限系フラグはクラウドでは付けない」という差分は採用していない）。`--ref` / `--on-branch` は cloud のときのみ、どちらか一方が共通フラグへ足される（同時指定は `buildClaudeArgs()` が例外を投げる）。

共通フラグはそのまま実行に使われるわけではなく、以下の関数が argv を組み立てる:

- `buildCloudCreateArgs(commonArgs, description)` → `["--cloud", description, ...commonArgs]`。**作成コマンド**（新規クラウドセッションの作成。TTY 必須）。実測（claude 2.1.250）により `--cloud <description>` の `description` は表示名ではなく**初期プロンプトとして即実行される**ことが判明したため、`description` には herdr のタスクタブラベルではなく `appendCloudDoneInstruction()` 適用後のプロンプトそのものを渡す（herdr のタスクタブラベルは引き続き `taskTabLabel()` の値を `tabCreate` へ渡すが、これは `description` とは別の値）。旧版にあった `buildCloudDispatchArgs()`（投函コマンド）は撤去した — description が即実行されるため、作成 → 投函の2コマンド方式は同じ作業を2回実行させてしまう（Issue #302: 1タスクで PR が2件作られる不具合の原因）

実測（`docs/cloud-session-launch-flags.md`、claude 2.1.247、S-1 / T番号）により、**起動そのものが `Error:` で失敗するのは限定的な2ケースのみ**であることを確認済み（それ以外のフラグは受理される、または「起動時に拒否されるフラグは受理されない」という原則が成り立つ）。

| 引数 | ローカル | クラウド | 実装の扱い | 実測結果 |
|------|---------|---------|-----------|---------|
| `-p <prompt>` | default モードのみ付与 | **付けない** | 共通フラグからは落とす。クラウドセッションの新規作成に `-p` を付けられないため、プロンプトは代わりに `--cloud` の値として渡す | `-p` と `--cloud`（新規作成）の併用は `Error: --cloud cannot be combined with --print.` で拒否される（T2）。クラウドセッションの新規作成は print モード非対応。一方、既存セッションへの `-p --cloud <session_id>` の投函はTTY不要で受理される（T3。現行実装では使わない。次段落参照） |
| `--cloud` | なし | 作成コマンド: `--cloud <description>`（= プロンプト） | `buildCloudCreateArgs()` が付与（共通フラグには含まれない） | `--cloud` 直後の値が初期プロンプトとして即実行される（claude 2.1.250 実測） |
| `--ref <branch>` | なし | 共通フラグへ**付与**（Issue 系: ベースブランチ。作成コマンドにのみ実質的な意味を持つ） | 付与 | 実測環境では Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)、2026-08-29時点 OPEN）による誤判定でブランチ名の検証に到達する前に `Error: --ref <branch> cannot be honored: the GitHub App is not set up for this repository, …` で拒否されていた（T9）。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`（`buildClaudeEnv(mode, cloud)`）の適用でセッション作成には成功することを smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で確認済み。**ブランチ名検証以降の意味論も実測済み**: 指定ブランチを起点に `claude/<description 由来>-<6文字>` 形式の作業ブランチが新規に作られる。作業ブランチ名は `--cloud` に渡した description に依存するため、**ローカル側から事前に名前を決められない／予測できないという結論は維持される**（→ 4.4-5） |
| `--on-branch <branch>` | なし | 共通フラグへ**付与**（PR 系） | 付与 | 同上（T10）。回避策適用後、セッション作成に成功することを smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で確認済み。**クラウドセッションは指定した PR の head ブランチ上で直接作業し、push するとその PR がそのまま更新される（新しいブランチは作られない）ことを確認**。`--ref` と `--on-branch` は**どちらもベースブランチ指定で排他**（T8: `Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other`）。実装は起動前に `buildClaudeArgs()` が例外で両方の同時指定を弾く（外部プロセスのエラーで気づく形にしないため） |
| `--permission-mode bypassPermissions` | 付与 | **付与**（ローカルと同一） | 付与 | 受理される（T5）。PRD が旧版で記載していた `Error: a cloud session cannot bypass permissions` は2.1.247では再現しない |
| `--disallowedTools` | 付与 | **付与**（ローカルと同一） | 付与。ただし VM 側でツール制限として効かないため、**ツール制限の指示は cloud 実行時のみ初期プロンプト本文（`--cloud <prompt>` の値）へ付加して担保する** | 受理される（T6）。PRD が旧版で記載していた `Error: a cloud session does not enforce tool restrictions yet` は2.1.247では再現しない。ただし**受理されるだけで VM 側ではツール制限として効かない**ことを smoke test（claude 2.1.250、2026-08-29）で確定 |
| `--append-system-prompt-file` | 付与 | **付与**（ローカルと同一） | 付与。ただし VM 側に反映されないため、**自律実行原則（`systemPromptFor()`）は cloud 実行時のみ初期プロンプト本文へ付加して担保する** | 受理される（T7）が、**VM 側にはシステムプロンプトとして反映されない**ことを smoke test（claude 2.1.250、2026-08-29）で確定（システムプロンプトに仕込んだ合言葉をセッションが「無し」と回答） |
| `--model` / `--effort` / `--advisor` / `--chrome` | 付与 | **付与**（ローカルと同一） | 付与 | 受理される（T7）。「起動引数として拒否されない」ことのみ確認済みで、**VM 側で実際に効くかは引き続き未確認**（→ 10章 Phase 2。今回の smoke test の対象外） |

「受理されないフラグを渡すと起動そのものが失敗する（黙って無視されない）」という原則自体は維持する。ただし実際に該当するのは (a) `-p` との併用（`Error: --cloud cannot be combined with --print.`、T2）と (b) `--ref` と `--on-branch` の同時指定（`Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other`、T8）の2点のみである。

非TTY での `--cloud` 新規作成は拒否（`Error: --cloud requires an interactive terminal.`、T1）、`--cloud <session_id>` の対話アタッチは**アカウント単位で無効**（T4、`Error: Attaching to an existing cloud session is not enabled for your account.`）。

プロンプト（`/claude-task-worker:exec-issue 123`）は**作成コマンドの description として渡す**（`buildCloudCreateArgs(commonArgs, description)` の第2引数）。herdr の `agent prompt` は使わない（ローカル herdr 実行のプロンプト投入とは別経路。「4.3」以降参照）。プロンプトの末尾には `appendCloudDoneInstruction()` が完了報告用の指示を追記する（→ 4.4-3）。

### 4.3 実行形態の制約: クラウド実行は `mode: "herdr"` 限定（Phase 1）

**作成コマンドには TTY が必要**。claude CLI は stdout が TTY でない場合 print モード扱いになり、print モードの `--cloud` は「既存セッションへのメッセージ追記」しか受け付けない（新規作成は不可）。ワーカーの `mode: "default"` は `spawn(..., { stdio: ["ignore", "pipe", "pipe"] })` で TTY を持たないため、**この経路では作成コマンドを実行できない**。

したがって Phase 1 では:

- `cloud: true` のワーカーが1つでもあり、かつ `mode` が `"herdr"` でない場合、**ワーカー起動時にエラー終了**する（`assertRunModeAvailable()` と同じ位置。サイレントにローカル実行へフォールバックしない）
- `mode: "herdr"` の既存のタスクタブ（TUI・TTY あり）が**作成コマンドの実行場所**になる。タブラベルはローカル実行と同じ `taskTabLabel()` の `ctw:<project>:#<n>`（`:cloud` サフィックスは付かない）。作成コマンドがクラウドセッションIDを返した時点で（取得に失敗した場合も）タスクタブは**即座に `tabClose` される**（→ 4.4-1）。したがってタスクタブは「セッションの起動場所」であって「セッションの起動場所として維持され続けるもの」ではない。起動後もクラウドセッションにアタッチし続けるローカルプロセス（2章「ドライバ」の用語が想定していたもの）は成立しない（→ 4.4-2）

`mode: "default"` でのクラウド実行（pty 割り当て等）は Phase 2 とする（→ 10章）。

### 4.4 タスクのライフサイクル（クラウド実行時）

ローカル実行との差分のみ記す。ラベル遷移・通知・`onCompleted` 検証の**呼び出し順序は一切変えない**。

1. **worktree を作らない**。`createWorktreeFromBranch()` / `removeWorktree()` / `getWorktreePath()` をスキップし、cwd はリポジトリのルート（ワーカーの cwd）とする。クラウド VM は自前で clone するため、ローカルの作業ツリーは使われない
   - Issue 系の epic 対応は `ensureEpicBranch()` を**引き続き実行する**（`cc-epic-<N>` をリモートに用意する処理であり、その後 `--ref cc-epic-<N>` で参照する）
   - PR 系の `removeWorktreeByBranch()` / `deleteLocalBranch()` / `localBranchExists()` によるプリフライトは**スキップする**。ローカルの checkout 競合はクラウド実行では発生しないため（`gh pr checkout` はクラウド VM 側で走る）
   - タスクタブ（herdr）は `tabCreate` → `waitForPaneReady` → 作成コマンド送信 → `paneRead` によるクラウドセッションID抽出（`extractCloudSessionId()`、上限 `CLOUD_SESSION_TIMEOUT_MS = 120秒`・間隔 `CLOUD_SESSION_POLL_INTERVAL_MS = 1秒`）を経て、**ID取得の成否に関わらず `finally` で即座に `tabClose` される**（→ 4.3）。クラウドセッションはローカルに常駐しないため、タスクタブを「セッションの起動場所」として維持し続ける必要が無い
2. **完了検知は `cc-cloud-done` ラベルのポーリングで行う**。実測（`docs/cloud-session-launch-flags.md`、claude 2.1.247 / herdr 0.8.2、S-2 / M番号）により、**PRD が前提としていた「クラウドセッションにアタッチし続けるローカルドライバ」は2.1.247 / 実測アカウントでは存在しない**ことが確定している。`claude --cloud "<desc>"` は実TTYでも作成後に即 exit し（M-1）、対話アタッチはアカウント単位で無効（S-1 T4）、`--teleport` はセッションを引き寄せて**ローカル実行に化ける**（M-3。VM ではなくローカルマシン・ローカル worktree・ローカルブランチで実行される）ため、herdr の agent ステータスで*クラウドセッションの*完了を検知する経路は成立しない。この実測を根拠に、**セッション自身が最後の操作として対象 Issue/PR へ `cc-cloud-done` ラベルを付ける**方式へ切り替えた: 作成コマンド（プロンプト込み）成功後、`waitForCloudTask(id, type)` が完了検知ポーラー（下記）の通知を待つ。作成コマンドの非0終了、またはセッションID抽出の失敗は `status: "failed"` で確定する — ただし後者は**セッション自体は既に作業を開始している可能性がある**（孤立セッション。ID を取得できないだけでプロンプトは投入済みのため）ことを失敗メッセージに明記する
   - **完了検知ポーラー**: `CLOUD_POLL_INTERVAL_MS = 30秒` / `CLOUD_TASK_TIMEOUT_MS = 4時間`。`cloudWaiters` Map（キーは `${type}:${number}`。Issue #N と PR #N の番号衝突を避ける）と `ensureCloudPollLoop()` / `pollCloudWaiters()` による**共有ポーラー**が、実行中のクラウドタスク全体を type ごとに1クエリで判定する（`listNumbersWithLabel(type, CLOUD_DONE_LABEL)`、`src/gh.ts`）。個別番号の `gh issue view` ポーリングにするとタスク数に比例して API を叩くことになるため。`--state all` にしているのは `exec-issue` の「コード変更なし」経路が Issue をクローズしてからラベルを付けるため
   - シャットダウン応答性のため 30 秒を丸ごと眠らず 1 秒刻みで `herdrAbortSignal` を確認する。シャットダウンで待機を抜けた場合は `status: "failed"`（アボート）として確定する
   - タイムアウトに落ちる典型は `AskUserQuestion` で停止したセッション・VM 側クラッシュ・プラグイン未導入による空振り・ラベル付与自体の失敗
   - 人が手動で `cc-cloud-done` を付けても同じ経路で完了扱いになる（張り付いたタスクの救済手段）
   - 起動前に対象から `cc-cloud-done` を除去する（`issue-worker.ts` / `pr-worker.ts`）。前回実行の残骸で即座に完了と誤判定するのを防ぐ
   - **待機中も台帳エントリ（`herdrTasks`）は `running` のまま維持し、`finishTask()` はラベル検知の後に呼ぶ**。これにより `isRunning()` が完了検知まで真を返し続け、トリガーラベルが再装填されるワーカー（`triage-pr` / `cc-fix-repeat`）で毎ポーリングごとにクラウドセッションが量産されるのを防ぐ（→ 8章リスク表）
   - `CLOUD_TASK_TIMEOUT_MS` 超過で打ち切る場合は `cc-need-human-check` を付けて `failed` にする。**この付与は `runViaCloud()` 側で行う**。ワーカーの `onComplete` の失敗経路は同ラベルを付けないため、そこに任せると打ち切られたタスクが誰にも拾われないまま残る
   - **driver 契約そのもの（`working` / `idle` / `done` / `blocked` の遷移）は teleport セッション（＝ローカル TUI）に対しては完全に成立する**ことも確認済み（M-2 / M-4）。壊れているのは「ドライブ対象がローカルになってしまう」という接続経路の側であり、`observeAgentStatus()` / `waitForHerdrTask()` のロジック自体は正しい。ただし Phase 1 のクラウド完了検知はこの driver 契約を使わず、上記のラベルポーリングに一本化している
3. **最終レポートは Issue/PR コメント経由で回収する**（Issue #285）。既存の「transcript 優先・ペイン内容フォールバック」は**両方とも空振りする**。クラウド VM で実行されたターンは transcript にもペイン内容にも一切現れない（M-6）。クラウドセッションのローカル transcript（`~/.claude/projects/*/<sessionId>.jsonl`）は生成されない（M-6）。`findTranscriptPath()` / `readFinalReport()` の実装自体は teleport セッション（ローカルターン）に対しては無修正で機能するが、読めるのはローカルで実行した分だけである。そこで `appendCloudDoneInstruction()`（`src/claude-args.ts`）は `cc-cloud-done` ラベルを付ける**直前**に、対象へ固定見出し `CLOUD_REPORT_HEADING`（`## claude-task-worker 実行結果`）を持つコメントを1件投稿させる。ワーカーは `cc-cloud-done` 検知後に `removeLabel(cc-cloud-done)` してから1回だけ `findCommentSince()`（`src/gh.ts`、タスク起動時刻以降のコメントから見出し一致の最新1件を取得）でその本文を回収し `TaskResult.output` にする。取得できない/例外の場合は従来どおりの定型文（セッション URL のみ）で通知を落とさない
4. **セッション終了は `tabClose` のみで、`stopHerdrTask()` は使わない**。`runViaCloud()` はセッションID取得直後（成否に関わらず）にタスクタブを閉じるため（上記1）、完了待ち・レポート回収の時点でタスクタブは既に存在しない。ctrl-c ×2 送信・agent 消失待ちといった `stopHerdrTask()` の手順（ローカル実行の claude プロセスを止めるためのもの）はクラウド実行には対応物が無い。ドライバを閉じても**クラウドセッション自体は生き続ける**点がローカル実行と異なる（アーカイブ・削除は claude.ai 側の操作）。**ワーカーが再起動されると `cloudWaiters` の待機は失われる**（プロセス内 Map のため）。失われた待機は再起動後のポーリングで自然に再開する経路を Phase 1 では持たず、ラベルは GitHub 側に残り続けるため人手（または偶発的な再起動後の別ポーリング）で拾われる可能性はあるが、これを保証する仕組みはまだ無い（→8章リスク表、Phase 2 で検討）
   - **孤立セッション（ローカル側で失敗を確定したがクラウドセッションは生き残っている可能性がある状態）は `cc-need-human-check` ＋対象 Issue/PR へのコメントで可視化する**。該当するのはセッションID抽出失敗（catch 経路。プロンプトは投入済みの可能性がある）と `aborted`（ワーカーのシャットダウン。作成コマンド自体は投入済み）の2経路で、`runViaCloud()` 内でラベル付与・コメント投稿まで行う（ワーカーの `onComplete` の失敗経路は同ラベルを付けないため、そこへ任せると誰にも拾われない）。コメントにはセッションURL（取得できた場合）または「セッションURL不明（ID抽出に失敗）」を残す。`cc-in-progress` を残す案は採らない — ワーカーの `finally` が無条件に外すため残すには共通コールバックへ分岐を追加する必要があり、かつ「実行中に見えるが実行していない」状態を作ってしまう。`cc-need-human-check` はどちらのワーカーでも共通除外ラベルなので、再ポーリングによる2本目のクラウドセッション量産も同時に止まる。`aborted` は catch 経路と違いタスクの失敗そのものではないが「孤立セッションが残りうる」点は同じなので、区別はラベルではなくコメント・通知の文面で行う
   - ワーカー再起動後に `cc-cloud-done` が付いた Issue/PR を拾い直す経路は Phase 1 では実装しない。所有ワーカーの対応付けがプロセス内の `cloudWaiters` にしか無く、復元にはタスク台帳の永続化が要るため。代わりに上記の孤立セッション可視化（`cc-need-human-check` ＋コメント）を緩和策とする
   - **セッションIDを得られるのは起動コマンドの stdout（`Created cloud session: <id>` / `View: https://claude.ai/code/<id>`）だけ**である（M-9）。`agentGet()`（`src/herdr.ts`）が返す `sessionId` は**ローカル claude のセッションUUID**であってクラウドセッションID（`session_01…`）とは別物で、claude.ai の URL に入れても「このセッションは見つかりませんでした」になる（M-7）。実装は `extractCloudSessionId()`（`src/herdr-runner.ts`）が起動出力をパースしてクラウドセッションIDを取得する
5. **`cc-in-progress` / `cc-need-human-check` / `cc-pr-created`** の扱いはローカル実行と完全に同一。`onCompleted` の検証（PR 実在確認）は GitHub API 経由なので実行場所に依存しない
   - ただし `exec-issue` の検証のうち「**worktreeId を head とする PR**」の条件は成立しない（クラウドセッションは自分でブランチ名を決めるため）。**クラウドセッションの実ブランチ名を取得する手段は無い**（M-8 / M-9。CLI にクラウドセッションを列挙・照会する経路が無く、claude.ai の Web UI でしか確認できない）ため、PRD 旧版が想定していた「実ブランチ名を取得できる場合はそれを使う」分岐は成立せず、実装は代替経路のみを使う: `selectOwnedClosingPr()`（`src/workers/exec-issue.ts`）が closing 参照 PR の **base ブランチ一致 ＋ 作成時刻がタスク起動時刻以降**であることで所有権を判定する。所有権を確認できない closing-reference PR は根拠として使わず、「Issue がクローズ済み」の条件のみで `cc-pr-created` を付与する。**`--ref` から作られる作業ブランチの命名形式（`claude/<description 由来>-<6文字>`）は smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で判明したが**、6文字サフィックスは description からローカル側で予測できないため、「ローカルからは作業ブランチ名を取得できない」という上記の結論・代替経路自体は変わらない（→ 4.2）

### 4.5 前提条件チェック

`cloud: true` のワーカーがある場合、ワーカー起動時に以下を確認する。**チェック対象ごとに契約が異なる**:

- **1（サインイン）は起動時に静的検査でき、満たさなければエラー終了する（タスクを1件も起動しない）**
- **2（GitHub 連携）・3（プラグイン導入）・4（`allow_remote_sessions` 組織ポリシー）はローカルから照会する手段が無いため、エラー終了の対象にはせず、タスク実行時に失敗した場合のエラーメッセージ案内に留める**

実測の詳細（判定コマンド・構成ごとの出力・案内メッセージの文面案）は `docs/cloud-prerequisite-checks.md`（Issue #225）。これらの検査は `cloud: true` のワーカーが1件も無ければ I/O ごと行わない（既存リポジトリでの挙動を不変に保つため）。

1. **claude.ai アカウントでのサインイン**。API キー認証・第三者プロバイダ（Bedrock / Vertex 等）ではクラウドセッションを作成できない。`checkCloudAuth()` が `claude auth status --json` の `loggedIn` / `authMethod` / `apiProvider` / `apiKeySource` と `ANTHROPIC_BASE_URL` の有無で**起動時に静的検査してエラー終了する**（`ANTHROPIC_API_KEY` 設定時も `authMethod` は `"claude.ai"` を返すため、`apiKeySource` の不在を併せて見る必要がある）。`claude auth status --json` の実行・パースそのものに失敗した「判定不能」なケースは拒否根拠にせず、エラーにしない安全側の倒し方をとる
2. **GitHub 連携**（Claude GitHub App の認可、または `/web-setup` による `gh` トークンの同期）。連携状態は非公開 API（`GET /api/oauth/organizations/:orgUUID/sync/github/auth`）経由でしか取れず CLI 表層に無いため、静的検査しない（失敗時のエラーメッセージで案内）
   - 未設定でもセッション作成自体は成功し、ローカル作業ツリーがアップロードされてシードされる（PRD 4.4-1 の「クラウド VM が自前で clone する」前提が成立する条件は未確認）。`--ref` / `--on-branch` を付けた場合に「GitHub App is not set up」の文言で失敗することがあるが、これは実際の連携未設定だけでなく Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)）による誤判定でも起こる。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` の適用でセッション作成には成功することを smoke test で確認済み（詳細は `docs/cloud-session-launch-flags.md` / `docs/cloud-prerequisite-checks.md`）
3. **プラグイン導入**。クラウド VM に本プラグインのスキルが存在しないと `/claude-task-worker:exec-issue` などのセッションが空振りする。リポジトリの `.claude/settings.json` へ宣言を書き戻せばクラウドセッションが自動的にプラグインを有効化する、という前提で `shouldRegisterPlugin()` / `mergePluginSettings()`（`src/commands/init.ts`）と `checkPluginDeclaration()` による静的検査を実装していたが、その前提が事実でなかったため撤去した（Issue #268）。代わりに claude.ai の環境設定のセットアップスクリプト欄に `npx claude-task-worker install` を記載し、VM 側にプラグイン・CLI を直接導入する。VM 側の導入状況はローカルから照会できないため静的検査は行わない
4. **`allow_remote_sessions` 組織ポリシー**。組織側でクラウドセッションの作成が無効化されているとセッション作成不可。CLI はポリシー取得結果を `policy-limits.json` にキャッシュする実装を持つが、実測環境では生成されず、不在は「未取得」と「拒否」を区別できないため静的検査しない（失敗時のエラーメッセージで案内）

### 4.6 通知

Slack 通知の本文・経路は変更しない。クラウド実行時は本文の先頭にクラウドセッションの URL（`https://claude.ai/code/<session-id>`）を1行入れる。取得できない場合は省略する（通知自体は落とさない）。

## 5. クラウド実行の制約とワーカー適合性

クラウドセッションはローカル実行と等価ではない。以下は **claude CLI / ドキュメントで確認済み**の制約で、ワーカー選定の前提になる。GitHub アクセス系（先頭5行）は実測済み（→ [cloud-graphql-proxy-limits.md](./cloud-graphql-proxy-limits.md) / [cloud-session-launch-flags.md](./cloud-session-launch-flags.md)）。

| 制約 | 影響 |
|------|------|
| **GraphQL の 403 制限**（実測済み）: GitHub プロキシは操作名単位のアローリストで判定し、`gh` から到達できる GraphQL 操作は1つも通らない。リポジトリ連携の有無とは独立（リポジトリを含まない `query{viewer{login}}` も同じ403） | `gh issue view --json` / `gh pr view --json` が**フィールドを問わず**失敗する（`--json number,title,state` でも403。`gh` に REST 経路が無い）。`gh pr list` / `gh pr checks` も同様。ワーカー起動スキル15個すべてが影響を受ける。REST（`gh api repos/{owner}/{repo}/...`）へ書き換えれば大半は回復するが、**レビュースレッドの解決（`resolveReviewThread`）だけは REST 代替が原理的に存在しない**。GraphQL ゲート自体は smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）後も**健在**（`gh … --json` は引き続き403、`gh api repos/...` の REST は成功） |
| **GitHub MCP はプロキシを経由しない**（smoke test で実測、claude 2.1.250 / herdr 0.8.2、2026-08-29）: クラウド VM 上に `mcp__github__*` ツールが**55個**存在することを確認。そのうち実際に動作を確認できたのは `issue_read` / `add_issue_comment` / `issue_write` / `create_pull_request` の**4つ**のみ（残り51ツールは今回未実行のため動作未確認） | 確認済み4ツールで代替できる操作（Issue本文の読み取り・Issueへのコメント・Issue編集・PR作成）は GraphQL ゲートを回避できる。CI状態取得（`gh pr checks`）・PR一覧（`gh pr list`）・レビュースレッド解決（`resolveReviewThread`）など確認済み4ツールに含まれない操作は今回検証しておらず、この行の実測は一般化しない（→ 下記ワーカー別適合性の `exec-issue` 行） |
| **リポジトリゲート**（実測済み）: 実測当時 GitHub App 連携が未設定と判断していたセッションでは `repos/{owner}/{repo}/...` が**全リポジトリで**403（無関係な公開リポジトリも含む）。この判断が Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)）による誤判定だった可能性があり、実際の連携状態を反映した観測かどうかは再実測が必要 | 未確認。連携済み環境（かつ回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 適用後）での再実測ができるまでは、クラウド実行が成立しない可能性がある前提を維持する |
| **パスゲート**（実測済み）: リポジトリスコープでない REST パス（`search/*` 等）は403 | `gh search` 系は使えない。`gh` で通る REST は `user` と `rate_limit` のみ |
| **クラウド VM の `gh` が古い**（実測: 2.45.0 / 2025-07-18） | `--json parent` / `blockedBy` / `subIssuesSummary` / `closingIssuesReferences` は `Unknown JSON field` でクライアント側で失敗する。プロキシ制限とは独立した交絡 |
| **クラウドセッションに `git remote` が無い観測**（実測済み。当時は GitHub App 未設定が理由と解釈） | セッションはローカル作業ツリーのアップロードでシードされ VM 側の clone に `git remote` が0件になる（`docs/cloud-session-launch-flags.md` M-5・T11、`docs/cloud-graphql-proxy-limits.md` P-6）。この観測が Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)）による誤判定の影響下にあるかは未確認。再実測が済むまで、push も PR 作成もできない前提のままとする |
| **push は「セッションの作業ブランチ」のみ** | 別ブランチへの push・固定名ブランチへの force-push を伴う処理は成立しない。`--on-branch` で作業ブランチを PR の head に合わせる必要がある。**この制約自体は実在が未確認**（前段のチェックで止まるため制約に到達しない。当時は GitHub App 連携未設定が理由と解釈していたが、実際には #81776 のバグによる誤判定だった。claude CLI / ドキュメント由来の記載である旨を維持。Issue #227 / `docs/cloud-session-force-push.md`） |
| **bypassPermissions 不可 / ツール制限不可** | `--disallowedTools` による `AskUserQuestion` / `Monitor` 等の無効化が効かない。`--append-system-prompt-file` による自律実行原則の注入も VM 側に反映されないため、原則とツール制限は初期プロンプト本文（`--cloud <prompt>` の値）へ移して担保する（smoke test、claude 2.1.250、2026-08-29 で確定。Issue #307） |
| **`!` インラインコマンド不可** | SKILL.md のプリアンブル `!` が実行されない。現状の該当は `triage-pr` / `check-dependabot` の `git fetch`（いずれも失敗しても継続する設計）のみ |
| **MCP はデバイスリンク経由** | CodeGraph / Pencil の MCP サーバーはローカルのドライバ経由でしか届かない。プラグイン同梱の `.mcp.json` はクラウド VM 側でも起動されるが、`codegraph` CLI もインデックスも VM に存在しないためテキスト検索へフォールバックする |
| **ローカル CLI が入っていない** | `pencil` / `codegraph` / `designmd` は未インストール。必要ならクラウド環境のセットアップスクリプトで導入する（Pencil はさらに認証が要る） |
| **レート制限を共有** | クラウド実行はアカウントのレート制限を消費する（VM の追加課金はない）。並列度を上げるとローカル実行と同じ枠を食い合う |
| **利用できない構成** | ZDR 有効な組織、IP アローリスト有効な組織、第三者プロバイダ構成では使えない |

### ワーカー別の適合性（Issue #226 の実測反映後）

判定は「Phase 1 でクラウド実行を推奨してよいか」。**GitHub App 連携を設定してリポジトリゲートを解いた状態で、GraphQL ゲートだけが残る**ことを前提にした評価である（連携未設定では全ワーカーが成立しない）。根拠の詳細は [cloud-graphql-proxy-limits.md](./cloud-graphql-proxy-limits.md)。

**「適合」は Phase 1 でクラウド実行を推奨してよいかの評価、「起動時ガード」は `cloud: true` を指定したときワーカー起動時に実際に拒否されるかを表す。この2列は独立**で、「✕」でも起動時には拒否されないワーカーがある（下記参照）。

| ワーカー | 適合 | 起動時ガード | 根拠 / 前提 |
|---------|------|------------|------------|
| `exec-issue` | ○（2026-08-29 smoke test で `issue_read` / `create_pull_request` の動作を確認、△ から格上げ。ただし PR一覧検証は未実測のため ◎ ではない） | 許可 | 新規ブランチを自分で作って push・PR 作成するため push 制約には当たらない。Issue本文の読み取り（`issue_read`）と PR作成（`create_pull_request`）が GitHub MCP 経由で成立することを smoke test（claude 2.1.250 / herdr 0.8.2）の `exec-issue` エンドツーエンド実行（2行のファイル追加、所要9分03秒）で確認済み。フェーズ7の `gh pr list --head` によるPR実在検証ステップは今回未確認のまま残る（ラベル遷移自体はワーカー側＝ローカルが行うため影響なし） |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | △（実測前 ◎） | **拒否**（`CLOUD_DENIED_WORKERS`） | 1日1回・長時間・成果物は新規ブランチの PR。加えて収集スクリプトが `gh api graphql` と `gh (issue\|pr) view --json` に依存し、403 で収集が0件になり空振りする。起動時ガード対象なのは適合性とは別の理由: 定期ワーカーは対象 Issue/PR を持たないため `cc-cloud-done` を置く先が無く、Phase 1 の完了検知（ラベルポーリング）が原理的に成立しない |
| `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` | △（実測前 ○） | 許可 | コード変更を伴わない。`gh issue view --json` がフィールドを問わず403のため、分析の入力（本文・コメント）がゼロになる。`--json parent` は加えて VM の `gh` 2.45.0 でも失敗する |
| `epic-issue`（`create-epic-pr`） | △（実測前 ○） | 許可 | `cc-epic-<N>` を作業ブランチにできれば成立するが、`gh issue view --json` が403 |
| `fix-review-point` | ✕（実測前 △） | **許可**（推奨しない） | `reviewThreads` クエリで**レビュー指摘を1件も取得できない**。さらにスレッド解決（`resolveReviewThread`）は REST 代替が原理的に存在せず、スキルを書き換えても回復しない |
| `triage-pr` | ✕（実測前 △） | **許可**（推奨しない） | `gh pr view --json` / `gh pr checks` / `reviewThreads` / `gh pr list` がすべて403で、**マージ判断の材料がゼロ**になる。マージゲートを担うワーカーが根拠なく判断する状態は許容しない。`gh pr merge` 自体の可否は未判定（リポジトリゲートが先に効くため） |
| `check-dependabot` | ✕（実測前 △） | **許可**（推奨しない） | 依存更新の検証にプロジェクト固有のツールチェーンが要る場合がある。加えて `gh pr view --json` / `gh pr checks` が403で更新内容もCI結果も読めない |
| `resolve-conflict` | ✕（Phase 1 では非対応） | **拒否**（`CLOUD_DENIED_WORKERS`） | rebase 後の force-push の可否は**引き続き未測定**（可否そのものは断定しない）。ただし smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で `--on-branch <PR head>` が指定した PR の head ブランチ上で直接作業し push するとその PR が更新されることを確認したため、force-push 可否の**前提条件が整い、再判定可能になった**（実測当時は GitHub App 未設定のため `--on-branch` が前段で拒否されると解釈していたが、実際には Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)）による誤判定だった。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 適用でセッション作成・`--on-branch` 到達までは確認済みだが、force-push そのものの実測はまだ行っていない。Issue #227 / `docs/cloud-session-force-push.md` → 10章 Phase 2）。`.pen` の解決に `pencil` CLI が必要。加えてコンフリクト判定の入力（`gh pr view --json mergeable`）も403（GitHub MCP の未実測51ツールにこの操作の代替が含まれるかは確認していない） |
| `create-ui-design` / `apply-ui-design` | ✕（Phase 1 では非対応） | **拒否**（`CLOUD_DENIED_WORKERS`） | `.pen` の編集に `pencil` CLI と認証が必要 |

起動時に拒否されるのは `CLOUD_DENIED_WORKERS`（`src/config.ts`）の**6ワーカー**（`resolve-conflict` / `create-ui-design` / `apply-ui-design` ＋ 定期ワーカー3件 `update-coding-guidelines` / `update-requirement-rules` / `update-design-md`）である。前者3件は `.pen` 編集・force-push 可否といったクラウド実行そのものの成立性が理由、定期ワーカー3件は「`cc-cloud-done` を置く対象 Issue/PR が無く完了検知できない」ことが理由で、根拠のカテゴリが異なる点に注意。`fix-review-point` / `triage-pr` / `check-dependabot` は適合「✕」でも**起動時には許可される**（Phase 1 で確定済みの方針）。上表の「適合」列はクラウド実行の推奨可否の評価であって、起動時ガードの対象を意味しない。運用上は「許可はするが、GraphQL ゲートが解除されるかスキルが REST 化されるまで `cloud: true` にしない」ことを推奨する。

## 6. スコープ外

- クラウドセッションの自動アーカイブ・削除
- クラウド環境（cloud environment）の作成・設定の自動化。ユーザーが claude.ai 側で用意した既定環境を使う
- 自己ホスト環境（`--environment ccpool_...`）への対応
- クラウドセッションの Auto-fix PR 機能との連携（`triage-pr` / `fix-review-point` と役割が重複するため、統合するなら別 PRD）
- ローカル実行時の挙動変更

## 7. 実装方針

### 7.1 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/claude-args.ts` | `ClaudeInvocation` に `cloud` / `baseRef` / `onBranch` を追加。`buildClaudeArgs()` にクラウド分岐（4.2 の表、共通フラグの組み立て）。`buildCloudCreateArgs()`（作成コマンド1本の argv 組み立て。description にプロンプトを直接埋め込む）。`appendCloudDoneInstruction()` / `CLOUD_REPORT_HEADING`（プロンプトへの完了報告・ラベル付与指示の追記。`buildCloudCreateArgs()` へ渡す前に適用する）。`shellQuote()`（作成コマンドを herdr の `pane send-text` へ1トークンで渡すためのクォート）。`buildClaudeEnv()` はクラウド時に print 専用の env を渡さない（herdr と同じ扱い） |
| `src/workers/issue-worker.ts` | `cloud` のとき worktree 生成・削除をスキップし、cwd をリポジトリルートに。`--ref` へ渡すベースブランチ（`cc-epic-<N>` または default）を `buildClaudeExecution()` に渡す。起動前に対象から `cc-cloud-done` を除去する |
| `src/workers/pr-worker.ts` | 同上。加えてローカルブランチ掃除・`localBranchExists()` プリフライトをスキップし、`--on-branch <pr.headRefName>` を渡す |
| `src/workers/scheduled-worker.ts` | `cloud` のとき worktree 生成・削除をスキップし、cwd をリポジトリルートに。`--ref` へデフォルトブランチを渡す。実行記録PR（`publishLastRunPr()`）はローカルのまま変更しない。ただし `CLOUD_DENIED_WORKERS` に含まれるため `cloud: true` はワーカー起動時に拒否される |
| `src/workers/exec-issue.ts` | `onCompleted` の PR 実在検証から「worktreeId を head とする PR」の条件をクラウド時に外し、`selectOwnedClosingPr()`（base ブランチ一致＋作成時刻）へ切り替える |
| `src/herdr-runner.ts` | `extractCloudSessionId()` を追加（起動コマンドの stdout から `Created cloud session: <id>` / `View: https://claude.ai/code/<id>` をパースしてクラウドセッションIDを取得） |
| `src/process-manager.ts` | `runViaCloud()`（作成コマンド（プロンプト込み）送信 → セッションID抽出 → `tabClose` → `waitForCloudTask()`）、`waitForCloudTask()` / `cloudWaiters` / `ensureCloudPollLoop()` / `pollCloudWaiters()`（`cc-cloud-done` ラベルの共有ポーラー）を追加。`CLOUD_SESSION_TIMEOUT_MS`（120秒）/ `CLOUD_SESSION_POLL_INTERVAL_MS`（1秒）/ `CLOUD_POLL_INTERVAL_MS`（30秒）/ `CLOUD_TASK_TIMEOUT_MS`（4時間）の各定数を定義 |
| `src/gh.ts` | `findCommentSince()`（タスク起動時刻以降のコメントから見出し一致の最新1件を取得）、`listNumbersWithLabel()`（type ごとに `cc-cloud-done` 付き番号を1クエリで取得）を追加 |
| `src/config.ts` | `WorkerRuntimeConfig.cloud`（boolean）追加。`DEFAULT_WORKER_CONFIG` / `WORKER_DEFAULTS` に `cloud: false`、`parseWorkerEntry()` にパース追加。`CLOUD_DONE_LABEL`（`"cc-cloud-done"`）/ `CLOUD_DENIED_WORKERS`（`resolve-conflict` / `create-ui-design` / `apply-ui-design` ＋ 定期ワーカー3件）を定義。`checkCloudConfig()` / `checkCloudAuth()` を追加 |
| `src/index.ts` | `assertRunModeAvailable()` の隣に `assertCloudAvailable()`（`checkCloudConfig()` / `checkCloudAuth()` を呼び、`cloud: true` × `mode !== "herdr"` の拒否、`CLOUD_DENIED_WORKERS` の拒否、サインイン前提条件チェックを行う） |
| `src/slack.ts` | 通知本文へのセッション URL 付与（取得できた場合のみ、1行目に配置） |

### 7.2 テスト

11章の受け入れ基準（実クラウドセッション作成・TTY・ブランチ選択・worktree省略・ラベル駆動の完了検知・ラベル遷移・Slack通知・cleanup・起動拒否）は純粋関数のユニットテストだけでは検証できないため、以下の3層で構成する。実装済みのテストは次の通り。

**ユニットテスト**（純粋関数、既存のローカル実行引数テストは変更しない）:

- `src/claude-args.test.ts`: `buildClaudeArgs` のクラウド分岐（`-p` と `--cloud` 自体を共通フラグに含まない／作成コマンドの共通フラグのみ／`--ref`・`--on-branch` 排他で throw／両方未指定なら両方省く／他フラグ不変／`cloud` 未指定・`false` で不変）、`buildCloudCreateArgs` の argv、`appendCloudDoneInstruction` 3件（原文保持＋ラベル指示付加／見出しを含む／issue と pr で文言が切り替わる）
- `src/config.test.ts`: `parseWorkerEntry` の `cloud` パース4件、`checkCloudConfig` 5件、`checkCloudAuth` 各種、`scheduled workers are all in CLOUD_DENIED_WORKERS (no Issue/PR to hold cc-cloud-done)`（定期ワーカー3件が拒否対象であることの固定）
- `src/herdr-runner.test.ts`: `extractCloudSessionId` 4件（`View:` URL からクエリを落として抽出／`Created cloud session:` 行から抽出／どちらも無ければ undefined／description 自身をIDとして掴まない）
- `src/gh.test.ts`: `findCommentSince` 4件（gh api のパス／一致コメントの body／複数一致なら最新／不一致なら null）
- `src/process-manager.test.ts`: `waitForCloudTask: cc-cloud-done が付かないまま期限を過ぎると timeout で解決する`
- `src/slack.test.ts`: `cloudSessionId` の有無による通知本文（付与なしは従来どおり／付与ありは1行目にセッション URL／空文字・空白のみでは付けない）6件
- `src/workers/exec-issue.test.ts`: `selectOwnedClosingPr (cloud)` 4件（base 一致＋createdAt 範囲内なら採用／base 不一致は棄却／タスク起動前の作成は棄却／検証時刻より後の作成は棄却）、`verifyPrCreated (cloud)`（`gh pr list` を呼ばず base + createdAt の所有権判定で採用）
- 既存テスト（ローカル実行の引数）が**一切変わらない**こと

**CLIスタブによる command-level 統合テスト**（`src/cloud-execution.integration.test.ts`。`claude` / `herdr` / `gh` をスタブへ差し替え、実バイナリを呼ばずに検証する）:

- A: `exec-issue` のクラウド実行が `--cloud`/`--ref` を付け worktree を作らない
- B: `triage-pr` が `--on-branch` を付け `--ref` を付けない
- C: 定期ワーカーに `cloud: true` があると起動せず終了コード1
- D: 作成コマンドの非0終了でも `cc-in-progress` を除去し PR ラベルを付けない
- E1: `mode: default` × `cloud: true` で起動せず終了コード1
- E2: `mode: herdr` × `CLOUD_DENIED_WORKERS` で起動せず終了コード1
- F: ローカル実行は `--cloud`/`--ref`/`-p` の扱いが従来どおりで worktree を作る

**実クラウドセッションを使う限定的な smoke test**（CI では毎回回さず手動/定期実行に留める）:

- `--cloud` によるセッション作成 → タスク投入 → `cc-cloud-done` ラベル検知 → PR 実在確認までの一連が実環境で通ることを確認する。4.2〜4.5 の未検証フラグ（9章の確認事項）の実測を兼ねる

## 8. リスクと緩和

| リスク | 緩和 |
|-------|------|
| クラウドセッションのスキルが空振りし、ワーカーが「完了」と誤認してラベルを進める | 既存の空出力検知（`buildTaskResult`）と `onCompleted` の成果物検証がそのまま効く。加えてクラウド VM の環境設定のセットアップスクリプト欄でプラグインを導入しておくことで空振りの主要因を潰す |
| GraphQL 403 でスキルが途中失敗し、Issue/PR が中途半端な状態で残る | 失敗は Slack 通知に出る。適合性「△」のワーカーは Phase 1 では既定 `false` のまま、実測でホワイトリスト化する |
| ~~ドライバがクラウドセッションの完了を検知できない~~（**解消済み**。実測でクラウドをドライブし続けるローカル TUI 自体が存在しないことが確定したため、`cc-cloud-done` ラベルによる完了検知へ切り替えた。→4.4-2） | `CLOUD_TASK_TIMEOUT_MS`（4時間）で打ち切り、`cc-need-human-check` を付けて `failed` にする。残るリスクは「セッションがラベルを付けずに終わるとタイムアウトまで完了扱いにならない」こと（`AskUserQuestion` での停止・VM クラッシュ・プラグイン未導入の空振りが典型） |
| **セッション量産ループ**: トリガーラベルが再装填されるワーカー（`triage-pr` / `cc-fix-repeat`）で、作成成功を即座に完了扱いにすると毎ポーリングごとにクラウドセッションが作られる | 待機中も台帳エントリ（`herdrTasks`）を `running` のまま維持して `isRunning()` を効かせ、完了検知（`cc-cloud-done`）までは同一 Issue/PR への再起動を防ぐ |
| クラウド実行がレート制限を食い、ローカルのワーカーが詰まる | `maxConcurrentTasks` は据え置き。クラウド化はワーカー単位のオプトインなので影響範囲が限定される |
| ツール制限（`--disallowedTools`）が効かず、`AskUserQuestion` でセッションが停止する | 原則とツール制限をプロンプト本文（`--cloud <prompt>` の値）へ付加して担保する（smoke test、claude 2.1.250、2026-08-29。Issue #307）。それでも停止した場合は `cc-cloud-done` が付かないまま `CLOUD_TASK_TIMEOUT_MS` まで待機し、タイムアウト後に `cc-need-human-check` 付きの失敗通知で拾われる |
| **孤立セッション**: セッションID抽出失敗（catch 経路）や `aborted`（ワーカーのシャットダウン）でローカル側の失敗を確定させても、クラウドセッション自体は生き続け、後から PR 作成や `cc-cloud-done` 付与を行いうる。一方ワーカーはトリガーラベルと `cc-in-progress` を無条件に外すため、ラベル上「未着手」に見える Issue/PR へ後から成果物が届く | `runViaCloud()` が両経路で `cc-need-human-check` を付与し、対象 Issue/PR へ孤立セッションである旨とセッションURL（不明なら「セッションURL不明（ID抽出に失敗）」）をコメントする（→4.4-4） |

## 9. 確認事項（実装前に実測が必要）

1. ~~**前提条件チェックの現実的な範囲**~~: **実測済み**（Issue #225 / `docs/cloud-prerequisite-checks.md`）。1（サインイン）は `claude auth status --json` で静的判定でき起動時エラーへ、2（GitHub 連携）・4（組織ポリシー）は照会手段が無く案内のみへ確定。4.5 を更新済み
2. ~~`--append-system-prompt-file` がクラウドセッションで受理されるか~~: **実測済み**（Issue #223 / `docs/cloud-session-launch-flags.md` T7）。**受理はされるが VM 側には反映されない**ことを smoke test（claude 2.1.250、2026-08-29）で確定（システムプロンプトに仕込んだ合言葉をセッションが答えられなかった）。自律実行原則はプロンプト本文へ移した（Issue #307）
3. ~~`--model` / `--effort` / `--advisor` / `--chrome` の受理可否~~: **実測済み**（Issue #223 / `docs/cloud-session-launch-flags.md` T7）。**5フラグすべて受理される**。VM 側で実際に効くかは引き続き未実測のまま（→10章 Phase 2）
4. ~~クラウドセッションのローカル transcript（`~/.claude/projects/*/<sessionId>.jsonl`）が生成されるか~~: **前提が成立しないことが確定**（Issue #224 / `docs/cloud-session-launch-flags.md` M-6）。クラウドセッションでは transcript は**生成されない**。クラウド VM で実行されたターンは transcript にもペイン内容にも一切現れないため、`findTranscriptPath()` / `readFinalReport()` 経由の最終レポート取得はクラウド実行では常に空振りする（→ 4.4-3）。代わりに Issue/PR コメント経由の回収（`appendCloudDoneInstruction()` / `findCommentSince()`）を実装済み
5. ~~**GitHub プロキシの GraphQL 403 が、実際にどのスキル操作で発生するか**~~: **実測済み**（Issue #226 / [cloud-graphql-proxy-limits.md](./cloud-graphql-proxy-limits.md)）。`gh issue view --json` / `gh pr view --json` はフィールドを問わず403、`gh pr list` / `gh pr checks` / `gh api graphql` も全滅で、ワーカー起動スキル15個すべてが影響を受ける。レビュースレッド解決だけは REST 代替が原理的に存在しない。5章の制約表・適合性表を差し替え済み。残課題は、リポジトリ連携済みセッションでの REST 代替の実行検証と、書き込み系操作（マージ・CI再実行・ラベル付与・コメント投稿）の個別可否
6. ~~クラウドセッションから PR ブランチへの **force-push** が可能か~~: **前提条件が整い再判定可能になったが、可否自体は引き続き未測定**（Issue #227 / `docs/cloud-session-force-push.md`）。実測当時は GitHub App 連携が未設定のため `--on-branch` がブランチ検証の前段で拒否されると解釈していたが、実際には Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)）による誤判定だった。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 適用後の smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で `--on-branch <PR head>` が指定 PR の head ブランチ上で直接作業し push するとその PR が更新されることを確認したため、force-push（既存コミットの書き換えを伴う push）を試す前提自体は整った。ただし今回試したのは通常の push を伴う操作までで、**force-push そのものはまだ実測していない**。`resolve-conflict` は **Phase 1 で ✕ 据え置き**（可否を断定しないため）。Phase 2 で force-push 自体の再実測が要る
7. ~~`--ref` / `--on-branch` の正確な意味と組み合わせ~~: **解消**（Issue #223 / `docs/cloud-session-launch-flags.md` T8〜T10、および 2026-08-29 smoke test）。**どちらもベースブランチ指定で排他**であること（T8）に加え、**個々の意味論も実測済み**: `--ref <branch>` は指定ブランチを起点に `claude/<description 由来>-<6文字>` 形式の作業ブランチを新規に作る（ブランチ名は description 依存でローカルからは予測不能）、`--on-branch <PR head>` は指定した PR の head ブランチ上で直接作業し push するとその PR がそのまま更新される（PRD 4.2 旧版が想定していた「`--ref`＝ベースブランチ／`--on-branch`＝既存PRブランチ上で作業再開」という役割分担どおりの挙動）。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` の適用が前提（→ 4.2・4.4-5）
8. ~~herdr の agent ステータス検出が、クラウドセッションをドライブしている TUI でも `working` / `idle` / `done` を正しく返すか~~: **前提が成立しないことが確定**（Issue #224 / `docs/cloud-session-launch-flags.md` M-1〜M-4）。**クラウドセッションをドライブし続けるローカル TUI が存在しない**（`--teleport` はローカル実行に化ける）ため、この問いは成立しない。Phase 1 の完了検知は herdr の agent ステータスを使わず `cc-cloud-done` ラベルのポーリングへ一本化した（→ 4.4-2）。driver 契約自体（`working`/`idle`/`done`/`blocked` の遷移、質問待ちの `blocked` 継続）は teleport セッション（＝ローカル TUI）に対しては正しく動作することを確認済みだが、クラウド実行のタスクタブは作成コマンド完了直後に閉じるため、この契約はクラウド実行の完了検知には使われない
9. ~~クラウドセッションの session ID をローカル側で取得する手段~~: **前提が成立しないことが確定**（Issue #224 / `docs/cloud-session-launch-flags.md` M-7〜M-9）。`agentGet()` の `sessionId` は**ローカル claude のセッションUUIDでありクラウドセッションIDとは別物**（claude.ai の URL に入れても見つからない）。クラウドセッションIDを取得できるのは起動コマンドの stdout（`Created cloud session: <id>` / `View: https://claude.ai/code/<id>`）だけで、CLI にクラウドセッションを列挙・照会する経路は無い。実装は `extractCloudSessionId()` で起動出力をパースする

## 10. 段階導入

- **Phase 1**（本 PRD の主対象、実装済み）: `cloud` 設定 + 作成コマンド1本（description にプロンプトを直接渡す）による引数の組み立て + `mode: "herdr"` 限定 + `cc-cloud-done` ラベルポーリングによる完了検知 + Issue/PR コメント経由のレポート回収 + 起動時ガードは `CLOUD_DENIED_WORKERS`（`resolve-conflict` / `create-ui-design` / `apply-ui-design` ＋ 定期ワーカー3件 `update-coding-guidelines` / `update-requirement-rules` / `update-design-md`、計6ワーカー）のみを拒否する deny-list 方式（5章・受け入れ基準6参照）。適合性「△/✕」でも同リストに含まれないワーカー（`fix-review-point` / `triage-pr` / `check-dependabot` 等）は起動時に拒否しない。default モード・`CLOUD_DENIED_WORKERS` は起動時エラー
- **Phase 2**: 以下の残課題に取り組む
  - `mode: "default"` でのクラウド実行。作成コマンドは TTY を要求するため、`script -q /dev/null claude --cloud ...` のような pty 割り当てで実行できる見込みがある（**未検証**。実測していない）
  - 定期ワーカー3件のクラウド化の解禁。現状は「`cc-cloud-done` を置く対象 Issue/PR が無い」ことが理由で `CLOUD_DENIED_WORKERS` に含めているが、実行記録PR（`publishLastRunPr()`）が作る PR をラベルの置き先にできれば解禁できる可能性がある（案の段階で未実装）
  - クラウド環境セットアップスクリプトの提供（`pencil` / `codegraph` / `designmd` の導入。Pencil はさらに認証が要る）。プラグイン・CLI 自体の導入（`npx claude-task-worker install`）は claude.ai の環境設定へ直接記載する方式として Phase 1 で実装済み（Issue #268）
  - `resolve-conflict` の force-push 可否の再測定。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 適用済みで `--on-branch <PR head>` が PR の head ブランチ上で直接作業できることは smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で確認済みのため、前提条件は整っている。残るのは force-push（既存コミットの書き換えを伴う push）そのものの実測のみ（→9-6）
  - GitHub MCP の未実測ツール（`mcp__github__*` 55個中、動作確認済みは `issue_read` / `add_issue_comment` / `issue_write` / `create_pull_request` の4つのみ）の検証。特に `fix-review-point` のレビュースレッド解決・`triage-pr` の CI状態取得（`gh pr checks`）・PR一覧取得（`gh pr list`）に相当する MCP 操作が動作するかは未確認で、動けば5章の適合性表を追加で見直せる可能性がある
  - 上記すべての前提となる**回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 適用後の再実測**（REST 代替の実行検証、書き込み系操作の個別可否がこの前提に依存する。→9-5・9-6）。従来「GitHub App 連携済みリポジトリでの再実測」としていたが、拒否の原因は連携未設定ではなく Claude Code 側のバグ（[#81776](https://github.com/anthropics/claude-code/issues/81776)）であったため、必要な前提を回避策の適用へ差し替えた。`--ref` / `--on-branch` の意味論は smoke test（2026-08-29）で解消済み（→9-7）

## 11. 受け入れ基準

1. `claude-task-worker.json` に `cloud` を書かない既存リポジトリで、引数・挙動・テスト結果がこの変更の前後で**完全に同一**であること
2. `workers.<name>.cloud: true` かつ `mode: "herdr"` で、対象ワーカーのタスクがクラウドセッションとして起動し、claude.ai 上でセッションが確認できること
3. クラウド実行のタスクで、`cc-in-progress` の付与・除去、`cc-need-human-check` への退避、`cc-pr-created` の検証付き付与が**ローカル実行と同一の条件**で行われること。**検証済み**: smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）の `exec-issue` エンドツーエンド実行（2行のファイル追加、所要9分03秒）で、プロンプト投函 → 最終報告コメント投稿 → `cc-cloud-done` 付与 → ワーカーが検知して除去 → `cc-pr-created` 付与、の完了検知の連鎖が成立することを確認した
4. クラウド実行のタスクで worktree が作られず、実行後にローカルへ残骸（worktree・ローカルブランチ）が残らないこと。**検証済み**: 上記 smoke test の `exec-issue` エンドツーエンド実行で確認した
5. クラウド実行の完了・失敗が Slack へ通知され、失敗通知から原因（セッション URL または出力）を辿れること
6. `cloud: true` × `mode: "default"`、および `CLOUD_DENIED_WORKERS`（`resolve-conflict` / `create-ui-design` / `apply-ui-design` ＋ 定期ワーカー3件 `update-coding-guidelines` / `update-requirement-rules` / `update-design-md`、計6ワーカー）への `cloud: true` が、タスクを1件も起動せずにワーカー起動時点でエラー終了すること。適合性「✕」でも `CLOUD_DENIED_WORKERS` に含まれないワーカー（`fix-review-point` / `triage-pr` / `check-dependabot`）は起動時に拒否されないこと（→ 5章の適合性表の「起動時ガード」列）
7. `cc-cloud-done` ラベルの検知とタイムアウト打ち切りが検証されていること。具体的には: (a) 対象 Issue/PR に `cc-cloud-done` ラベルが付与されると `waitForCloudTask()` が `completed` へ遷移すること、(b) `CLOUD_TASK_TIMEOUT_MS`（4時間）を超過すると `cc-need-human-check` を付けて `failed` になること、(c) 完了検知の待機中は `isRunning()` が真を返し、同一 Issue/PR に対するトリガーラベル再装填でも二重起動が起きないこと。以上を 7.2 のCLIスタブ統合テスト／実クラウドセッションの smoke test で検証する。**(a) は検証済み**: smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）の `exec-issue` エンドツーエンド実行（2行のファイル追加、所要9分03秒）で `cc-cloud-done` の付与検知と `waitForCloudTask()` の完了遷移を確認した。**(b)・(c) はタイムアウト再現に長時間を要するため今回の smoke test では検証していない**
