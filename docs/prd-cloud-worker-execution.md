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
- クラウドセッションはローカルのプロセス寿命から独立しているため、ワーカー再起動やマシンのスリープでタスクが失われない（ただし本 PRD Phase 1 の完了検知はローカルのアタッチに依存する。→ 4.4）
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

`buildClaudeArgs()`（`src/claude-args.ts:207-255`）は `cloud` を受け取り、クラウド実行時は以下の差分を適用する。**実装が落とすのは `-p` のみ**で、`--permission-mode bypassPermissions` / `--disallowedTools` / `--append-system-prompt-file` / `--model` / `--effort` / `--advisor` はクラウドでもローカルと同一に付与される（当初想定していた「ツール制限系フラグはクラウドでは付けない」という差分は採用していない）。

実測（`docs/cloud-session-launch-flags.md`、claude 2.1.247、S-1 / T番号）により、**起動そのものが `Error:` で失敗するのは限定的な2ケースのみ**であることを確認済み（それ以外のフラグは受理される、または「起動時に拒否されるフラグは受理されない」という原則が成り立つ）。

| 引数 | ローカル | クラウド | 実装の扱い | 実測結果 |
|------|---------|---------|-----------|---------|
| `-p <prompt>` | default モードのみ付与 | **付けない** | 落とす | `-p` と `--cloud`（新規作成）の併用は `Error: --cloud cannot be combined with --print.` で拒否される（T2）。クラウドセッションの新規作成は print モード非対応 |
| `--cloud` | なし | **付与**（値なし） | 付与 | 新規クラウドセッションを作成する |
| `--ref <branch>` | なし | **付与**（Issue 系: ベースブランチ） | 付与 | **意味論・受理可否ともに未実測**（→ 10章 Phase 2）。実測環境では GitHub App 連携が未設定のため、ブランチ名の検証に到達する前に `Error: --ref <branch> cannot be honored: the GitHub App is not set up for this repository, …` で拒否される（T9） |
| `--on-branch <branch>` | なし | **付与**（PR 系） | 付与 | 同上、未実測（T10）。**PRD が想定していた「`--ref` = ベースブランチ / `--on-branch` = 既存 PR ブランチ上で作業再開」という役割分担ではない**。`--ref` と `--on-branch` は**どちらもベースブランチ指定で排他**（T8: `Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other`）。実装は起動前に `buildClaudeArgs()` が例外で両方の同時指定を弾く（外部プロセスのエラーで気づく形にしないため） |
| `--permission-mode bypassPermissions` | 付与 | **付与**（ローカルと同一） | 付与 | 受理される（T5）。PRD が旧版で記載していた `Error: a cloud session cannot bypass permissions` は2.1.247では再現しない |
| `--disallowedTools` | 付与 | **付与**（ローカルと同一） | 付与 | 受理される（T6）。PRD が旧版で記載していた `Error: a cloud session does not enforce tool restrictions yet` は2.1.247では再現しない |
| `--append-system-prompt-file` | 付与 | **付与**（ローカルと同一） | 付与 | 受理される（T7）。ただし「起動引数として拒否されない」ことのみ確認済みで、**クラウド VM 側で実際にシステムプロンプトとして反映されるかは未確認**（→ 10章 Phase 2） |
| `--model` / `--effort` / `--advisor` / `--chrome` | 付与 | **付与**（ローカルと同一） | 付与 | 受理される（T7）。同上、VM 側で実際に効くかは未確認 |

「受理されないフラグを渡すと起動そのものが失敗する（黙って無視されない）」という原則自体は維持する。ただし実際に該当するのは (a) `-p` との併用（`Error: --cloud cannot be combined with --print.`、T2）と (b) `--ref` と `--on-branch` の同時指定（`Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other`、T8）の2点のみである。

非TTY での `--cloud` 新規作成は拒否（`Error: --cloud requires an interactive terminal.`、T1）、`--cloud <session_id>` の対話アタッチは**アカウント単位で無効**（T4、`Error: Attaching to an existing cloud session is not enabled for your account.`）。既存セッションへの `-p --cloud <session_id>` の投函はTTY不要で受理される（T3）。

プロンプト（`/claude-task-worker:exec-issue 123`）は `--cloud` の説明文（引数）として渡さず、**起動後に投入する**（herdr の `agent prompt` 経由）。説明文として渡すと、herdr の `agent start` が「入力待ちになるまで」ブロックする仕様と噛み合わない（既存の herdr モードと同じ理由）。

### 4.3 実行形態の制約: クラウド実行は `mode: "herdr"` 限定（Phase 1）

**新規クラウドセッションの作成には TTY が必要**。claude CLI は stdout が TTY でない場合 print モード扱いになり、print モードの `--cloud` は「既存セッションへのメッセージ投函」しか受け付けない。ワーカーの `mode: "default"` は `spawn(..., { stdio: ["ignore", "pipe", "pipe"] })` で TTY を持たないため、**この経路ではクラウドセッションを作成できない**。

したがって Phase 1 では:

- `cloud: true` のワーカーが1つでもあり、かつ `mode` が `"herdr"` でない場合、**ワーカー起動時にエラー終了**する（`assertRunModeAvailable()` と同じ位置。サイレントにローカル実行へフォールバックしない）
- `mode: "herdr"` では既存のタスクタブ（TUI・TTY あり）がそのまま**セッションの起動場所**になる。タブラベルはクラウド実行であることが分かるよう `ctw:<project>:#<n>:cloud` とする。なお起動後もクラウドセッションにアタッチし続ける「ドライバ」（2章の用語）は成立しない（→ 4.4-2）

`mode: "default"` でのクラウド実行（pty 割り当て等）は Phase 2 とする（→ 10章）。

### 4.4 タスクのライフサイクル（クラウド実行時）

ローカル実行との差分のみ記す。ラベル遷移・通知・`onCompleted` 検証の**呼び出し順序は一切変えない**。

1. **worktree を作らない**。`createWorktreeFromBranch()` / `removeWorktree()` / `getWorktreePath()` をスキップし、cwd はリポジトリのルート（ワーカーの cwd）とする。クラウド VM は自前で clone するため、ローカルの作業ツリーは使われない
   - Issue 系の epic 対応は `ensureEpicBranch()` を**引き続き実行する**（`cc-epic-<N>` をリモートに用意する処理であり、その後 `--ref cc-epic-<N>` で参照する）
   - PR 系の `removeWorktreeByBranch()` / `deleteLocalBranch()` / `localBranchExists()` によるプリフライトは**スキップする**。ローカルの checkout 競合はクラウド実行では発生しないため（`gh pr checkout` はクラウド VM 側で走る）
2. **完了検知はドライバの接続経路が成立しない**。実測（`docs/cloud-session-launch-flags.md`、claude 2.1.247 / herdr 0.8.2、S-2 / M番号）により、**PRD が前提としていた「クラウドセッションにアタッチし続けるローカルドライバ」は2.1.247 / 実測アカウントでは存在しない**ことが確定した。`claude --cloud "<desc>"` は実TTYでも作成後に即 exit し（M-1）、対話アタッチはアカウント単位で無効（S-1 T4）。`--teleport` はセッションを引き寄せて**ローカル実行に化ける**（M-3。VM ではなくローカルマシン・ローカル worktree・ローカルブランチで実行される）。したがって herdr の agent ステータスで*クラウドセッションの*完了を検知する経路は現状無い
   - ただし **driver 契約そのもの（`working` / `idle` / `done` / `blocked` の遷移）は teleport セッション（＝ローカル TUI）に対しては完全に成立する**（M-2 / M-4）。壊れているのは「ドライブ対象がローカルになってしまう」という接続経路の側であり、`observeAgentStatus()` / `waitForHerdrTask()` のロジック自体は正しい。質問待ち（`AskUserQuestion`）は `blocked` を返し続け `idle` に誤って落ちない（M-4、受け入れ基準7に対応）
3. **最終レポートの取得経路は現状ゼロ**。既存の「transcript 優先・ペイン内容フォールバック」は**両方とも空振りする**。クラウド VM で実行されたターンは transcript にもペイン内容にも一切現れない（M-6）。クラウドセッションのローカル transcript（`~/.claude/projects/*/<sessionId>.jsonl`）は生成されない（M-6）。`findTranscriptPath()` / `readFinalReport()` の実装自体は teleport セッション（ローカルターン）に対しては無修正で機能するが、読めるのはローカルで実行した分だけである
4. **セッション終了**は既存の `stopHerdrTask()`（ctrl-c ×2 → agent 消失待ち → タブクローズ）。ドライバを閉じても**クラウドセッション自体は生き続ける**点がローカル実行と異なる（アーカイブ・削除は claude.ai 側の操作）。ドライバのローカルプロセスが死んだ場合の再接続（session ID を保持してのポーリング再開）は Phase 1 では実装せず、セッションが宙に浮いたまま失敗通知に session URL を載せて人手に委ねる（→8章リスク表、Phase 2 で解消）
   - **セッションIDを得られるのは起動コマンドの stdout（`Created cloud session: <id>` / `View: https://claude.ai/code/<id>`）だけ**である（M-9）。`agentGet()`（`src/herdr.ts`）が返す `sessionId` は**ローカル claude のセッションUUID**であってクラウドセッションID（`session_01…`）とは別物で、claude.ai の URL に入れても「このセッションは見つかりませんでした」になる（M-7）。実装は `extractCloudSessionId()`（`src/herdr-runner.ts`）が起動出力をパースしてクラウドセッションIDを取得する
5. **`cc-in-progress` / `cc-need-human-check` / `cc-pr-created`** の扱いはローカル実行と完全に同一。`onCompleted` の検証（PR 実在確認）は GitHub API 経由なので実行場所に依存しない
   - ただし `exec-issue` の検証のうち「**worktreeId を head とする PR**」の条件は成立しない（クラウドセッションは自分でブランチ名を決めるため）。**クラウドセッションの実ブランチ名を取得する手段は無い**（M-8 / M-9。CLI にクラウドセッションを列挙・照会する経路が無く、claude.ai の Web UI でしか確認できない）ため、PRD 旧版が想定していた「実ブランチ名を取得できる場合はそれを使う」分岐は成立せず、実装は代替経路のみを使う: `selectOwnedClosingPr()`（`src/workers/exec-issue.ts`）が closing 参照 PR の **base ブランチ一致 ＋ 作成時刻がタスク起動時刻以降**であることで所有権を判定する。所有権を確認できない closing-reference PR は根拠として使わず、「Issue がクローズ済み」の条件のみで `cc-pr-created` を付与する

### 4.5 前提条件チェック

`cloud: true` のワーカーがある場合、ワーカー起動時に以下を確認する。**チェック対象ごとに契約が異なる**:

- **1（サインイン）は起動時に静的検査でき、満たさなければエラー終了する（タスクを1件も起動しない）**
- **2（GitHub 連携）・3（プラグイン導入）・4（`allow_remote_sessions` 組織ポリシー）はローカルから照会する手段が無いため、エラー終了の対象にはせず、タスク実行時に失敗した場合のエラーメッセージ案内に留める**

実測の詳細（判定コマンド・構成ごとの出力・案内メッセージの文面案）は `docs/cloud-prerequisite-checks.md`（Issue #225）。これらの検査は `cloud: true` のワーカーが1件も無ければ I/O ごと行わない（既存リポジトリでの挙動を不変に保つため）。

1. **claude.ai アカウントでのサインイン**。API キー認証・第三者プロバイダ（Bedrock / Vertex 等）ではクラウドセッションを作成できない。`checkCloudAuth()` が `claude auth status --json` の `loggedIn` / `authMethod` / `apiProvider` / `apiKeySource` と `ANTHROPIC_BASE_URL` の有無で**起動時に静的検査してエラー終了する**（`ANTHROPIC_API_KEY` 設定時も `authMethod` は `"claude.ai"` を返すため、`apiKeySource` の不在を併せて見る必要がある）。`claude auth status --json` の実行・パースそのものに失敗した「判定不能」なケースは拒否根拠にせず、エラーにしない安全側の倒し方をとる
2. **GitHub 連携**（Claude GitHub App の認可、または `/web-setup` による `gh` トークンの同期）。連携状態は非公開 API（`GET /api/oauth/organizations/:orgUUID/sync/github/auth`）経由でしか取れず CLI 表層に無いため、静的検査しない（失敗時のエラーメッセージで案内）
   - 未設定でもセッション作成自体は成功し、ローカル作業ツリーがアップロードされてシードされる（PRD 4.4-1 の「クラウド VM が自前で clone する」前提は GitHub 連携済みの場合にのみ成立する）。失敗するのは `--ref` / `--on-branch` を付けた場合で、その時点で連携未設定が顕在化する
3. **プラグイン導入**。クラウド VM に本プラグインのスキルが存在しないと `/claude-task-worker:exec-issue` などのセッションが空振りする。リポジトリの `.claude/settings.json` へ宣言を書き戻せばクラウドセッションが自動的にプラグインを有効化する、という前提で `shouldRegisterPlugin()` / `mergePluginSettings()`（`src/commands/init.ts`）と `checkPluginDeclaration()` による静的検査を実装していたが、その前提が事実でなかったため撤去した（Issue #268）。代わりに claude.ai の環境設定のセットアップスクリプト欄に `npx claude-task-worker install` を記載し、VM 側にプラグイン・CLI を直接導入する。VM 側の導入状況はローカルから照会できないため静的検査は行わない
4. **`allow_remote_sessions` 組織ポリシー**。組織側でクラウドセッションの作成が無効化されているとセッション作成不可。CLI はポリシー取得結果を `policy-limits.json` にキャッシュする実装を持つが、実測環境では生成されず、不在は「未取得」と「拒否」を区別できないため静的検査しない（失敗時のエラーメッセージで案内）

### 4.6 通知

Slack 通知の本文・経路は変更しない。クラウド実行時は本文の先頭にクラウドセッションの URL（`https://claude.ai/code/<session-id>`）を1行入れる。取得できない場合は省略する（通知自体は落とさない）。

## 5. クラウド実行の制約とワーカー適合性

クラウドセッションはローカル実行と等価ではない。以下は **claude CLI / ドキュメントで確認済み**の制約で、ワーカー選定の前提になる。GitHub アクセス系（先頭5行）は実測済み（→ [cloud-graphql-proxy-limits.md](./cloud-graphql-proxy-limits.md) / [cloud-session-launch-flags.md](./cloud-session-launch-flags.md)）。

| 制約 | 影響 |
|------|------|
| **GraphQL の 403 制限**（実測済み）: GitHub プロキシは操作名単位のアローリストで判定し、`gh` から到達できる GraphQL 操作は1つも通らない。リポジトリ連携の有無とは独立（リポジトリを含まない `query{viewer{login}}` も同じ403） | `gh issue view --json` / `gh pr view --json` が**フィールドを問わず**失敗する（`--json number,title,state` でも403。`gh` に REST 経路が無い）。`gh pr list` / `gh pr checks` も同様。ワーカー起動スキル15個すべてが影響を受ける。REST（`gh api repos/{owner}/{repo}/...`）へ書き換えれば大半は回復するが、**レビュースレッドの解決（`resolveReviewThread`）だけは REST 代替が原理的に存在しない** |
| **リポジトリゲート**（実測済み）: GitHub App 連携が未設定のセッションでは `repos/{owner}/{repo}/...` が**全リポジトリで**403（無関係な公開リポジトリも含む） | 連携未設定のリポジトリではクラウド実行そのものが成立しない。REST へのフォールバックも塞がれ、`git remote` も0件のため push・PR 作成もできない |
| **パスゲート**（実測済み）: リポジトリスコープでない REST パス（`search/*` 等）は403 | `gh search` 系は使えない。`gh` で通る REST は `user` と `rate_limit` のみ |
| **クラウド VM の `gh` が古い**（実測: 2.45.0 / 2025-07-18） | `--json parent` / `blockedBy` / `subIssuesSummary` / `closingIssuesReferences` は `Unknown JSON field` でクライアント側で失敗する。プロキシ制限とは独立した交絡 |
| **GitHub App 未設定のクラウドセッションには `git remote` が無い**（実測済み） | GitHub App 連携が未設定のリポジトリでは、セッションはローカル作業ツリーのアップロードでシードされ VM 側の clone に `git remote` が0件になる（`docs/cloud-session-launch-flags.md` M-5・T11、`docs/cloud-graphql-proxy-limits.md` P-6）。push も PR 作成もできない。PR を作るワーカーはこの構成のままではクラウド化できない |
| **push は「セッションの作業ブランチ」のみ** | 別ブランチへの push・固定名ブランチへの force-push を伴う処理は成立しない。`--on-branch` で作業ブランチを PR の head に合わせる必要がある。**この制約自体は実在が未確認**（前段の GitHub App 連携チェックで止まるため制約に到達しない。claude CLI / ドキュメント由来の記載である旨を維持。Issue #227 / `docs/cloud-session-force-push.md`） |
| **bypassPermissions 不可 / ツール制限不可** | `--disallowedTools` による `AskUserQuestion` / `Monitor` 等の無効化が効かない。自律実行原則（システムプロンプト注入）だけが歯止めになる |
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
| `exec-issue` | △（実測前 ◎） | 許可 | 新規ブランチを自分で作って push・PR 作成するため push 制約には当たらない。ただし `gh issue view --json body` が403で**Issue本文を読めない**ため、スキルを REST（`gh api repos/{o}/{r}/issues/{n}`）へ書き換えるまで着手できない |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | △（実測前 ◎） | 許可 | 1日1回・長時間・成果物は新規ブランチの PR。ただし収集スクリプトが `gh api graphql` と `gh (issue\|pr) view --json` に依存し、403 で収集が0件になり空振りする |
| `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` | △（実測前 ○） | 許可 | コード変更を伴わない。`gh issue view --json` がフィールドを問わず403のため、分析の入力（本文・コメント）がゼロになる。`--json parent` は加えて VM の `gh` 2.45.0 でも失敗する |
| `epic-issue`（`create-epic-pr`） | △（実測前 ○） | 許可 | `cc-epic-<N>` を作業ブランチにできれば成立するが、`gh issue view --json` が403 |
| `fix-review-point` | ✕（実測前 △） | **許可**（推奨しない） | `reviewThreads` クエリで**レビュー指摘を1件も取得できない**。さらにスレッド解決（`resolveReviewThread`）は REST 代替が原理的に存在せず、スキルを書き換えても回復しない |
| `triage-pr` | ✕（実測前 △） | **許可**（推奨しない） | `gh pr view --json` / `gh pr checks` / `reviewThreads` / `gh pr list` がすべて403で、**マージ判断の材料がゼロ**になる。マージゲートを担うワーカーが根拠なく判断する状態は許容しない。`gh pr merge` 自体の可否は未判定（リポジトリゲートが先に効くため） |
| `check-dependabot` | ✕（実測前 △） | **許可**（推奨しない） | 依存更新の検証にプロジェクト固有のツールチェーンが要る場合がある。加えて `gh pr view --json` / `gh pr checks` が403で更新内容もCI結果も読めない |
| `resolve-conflict` | ✕（Phase 1 では非対応） | **拒否**（`CLOUD_DENIED_WORKERS`） | rebase 後の force-push の可否は**測定不能で確定**（「拒否される」のではなく「可否を確認できない」ことが根拠。GitHub App 未設定のため `--on-branch` が前段で拒否され、`--on-branch` を外しても VM に remote が無い。Issue #227 / `docs/cloud-session-force-push.md`）。`.pen` の解決に `pencil` CLI が必要。加えてコンフリクト判定の入力（`gh pr view --json mergeable`）も403 |
| `create-ui-design` / `apply-ui-design` | ✕（Phase 1 では非対応） | **拒否**（`CLOUD_DENIED_WORKERS`） | `.pen` の編集に `pencil` CLI と認証が必要 |

起動時に拒否されるのは `CLOUD_DENIED_WORKERS`（`src/config.ts`）の3ワーカー（`resolve-conflict` / `create-ui-design` / `apply-ui-design`）だけである。`fix-review-point` / `triage-pr` / `check-dependabot` は適合「✕」でも**起動時には許可される**（Phase 1 で確定済みの方針）。上表の「適合」列はクラウド実行の推奨可否の評価であって、起動時ガードの対象を意味しない。運用上は「許可はするが、GraphQL ゲートが解除されるかスキルが REST 化されるまで `cloud: true` にしない」ことを推奨する。

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
| `src/config.ts` | `WorkerRuntimeConfig.cloud`（boolean）追加。`DEFAULT_WORKER_CONFIG` / `WORKER_DEFAULTS` に `cloud: false`、`parseWorkerEntry()` にパース追加 |
| `src/claude-args.ts` | `ClaudeInvocation` に `cloud` / `baseRef` / `onBranch` を追加。`buildClaudeArgs()` にクラウド分岐（4.2 の表）。`buildClaudeEnv()` はクラウド時に print 専用の env を渡さない（herdr と同じ扱い） |
| `src/workers/issue-worker.ts` | `cloud` のとき worktree 生成・削除をスキップし、cwd をリポジトリルートに。`--ref` へ渡すベースブランチ（`cc-epic-<N>` または default）を `buildClaudeExecution()` に渡す |
| `src/workers/pr-worker.ts` | 同上。加えてローカルブランチ掃除・`localBranchExists()` プリフライトをスキップし、`--on-branch <pr.headRefName>` を渡す |
| `src/workers/scheduled-worker.ts` | `cloud` のとき worktree 生成・削除をスキップし、cwd をリポジトリルートに。`--ref` へデフォルトブランチを渡す。実行記録PR（`publishLastRunPr()`）はローカルのまま変更しない |
| `src/workers/exec-issue.ts` | `onCompleted` の PR 実在検証から「worktreeId を head とする PR」の条件をクラウド時に外す |
| `src/herdr-runner.ts` | `taskTabLabel()` にクラウド識別子を追加。それ以外は変更なし（クラウドかどうかは引数の差でしかない） |
| `src/index.ts` | `assertRunModeAvailable()` の隣に `assertCloudAvailable()`（`cloud: true` × `mode !== "herdr"` の拒否、非対応ワーカーの拒否、前提条件チェック） |
| `src/slack.ts` | 通知本文へのセッション URL 付与（取得できた場合のみ） |

### 7.2 テスト

11章の受け入れ基準（実クラウドセッション作成・TTY・ブランチ選択・worktree省略・状態検出・ラベル遷移・Slack通知・cleanup・起動拒否）は純粋関数のユニットテストだけでは検証できないため、以下の3層で構成する。

**ユニットテスト**（純粋関数、既存のローカル実行引数テストは変更しない）:

- `parseWorkerEntry()` が `cloud` を正しくパースする / 不正値で既定へ倒れる
- `buildClaudeArgs()` がクラウド時に `-p` を含まず、`--permission-mode bypassPermissions` / `--disallowedTools` はローカルと同一に含んだうえで `--cloud` と `--ref`（または `--on-branch`）を含む（4.2参照）
- `--ref` と `--on-branch` が同時に付かない
- 既存テスト（ローカル実行の引数）が**一切変わらない**こと

**CLIスタブによる command-level 統合テスト**（`claude` / `herdr` をテスト用スタブに差し替え、実バイナリを呼ばずに検証する）:

- 起動引数（`--cloud` / `--ref` / `--on-branch` の付与漏れ・排他）
- 環境変数（print 専用 env が渡らないこと）
- cwd（worktree を作らずリポジトリルートになること）
- agent ステータスの mapping（`working` → `idle` / `done` の完了判定）
- `onCompleted` コールバックの呼び出し条件（PR 実在検証の分岐）
- 失敗時の cleanup（ラベル・worktree 状態）
- Slack 通知本文（セッション URL の有無）
- `mode: "default"` × `cloud: true`、および非対応ワーカーでの起動拒否

**実クラウドセッションを使う限定的な smoke test**（CI では毎回回さず手動/定期実行に留める）:

- `--cloud` によるセッション作成 → タスク投入 → 完了検知 → PR 実在確認までの一連が実環境で通ることを確認する。4.2〜4.5 の未検証フラグ（9章の確認事項）の実測を兼ねる

## 8. リスクと緩和

| リスク | 緩和 |
|-------|------|
| クラウドセッションのスキルが空振りし、ワーカーが「完了」と誤認してラベルを進める | 既存の空出力検知（`buildTaskResult`）と `onCompleted` の成果物検証がそのまま効く。加えてクラウド VM の環境設定のセットアップスクリプト欄でプラグインを導入しておくことで空振りの主要因を潰す |
| GraphQL 403 でスキルが途中失敗し、Issue/PR が中途半端な状態で残る | 失敗は Slack 通知に出る。適合性「△」のワーカーは Phase 1 では既定 `false` のまま、実測でホワイトリスト化する |
| ドライバがクラウドセッションの完了を検知できない（実測でクラウドをドライブし続けるローカル TUI 自体が存在しないことが確定。→4.4-2 / 9-8） | Phase 2 で完了検知の代替チャネルを用意する（→10章）。Phase 1 では失敗通知に session URL を載せて人が拾えるようにする |
| クラウド実行がレート制限を食い、ローカルのワーカーが詰まる | `maxConcurrentTasks` は据え置き。クラウド化はワーカー単位のオプトインなので影響範囲が限定される |
| ツール制限（`--disallowedTools`）が効かず、`AskUserQuestion` でセッションが停止する | システムプロンプトの自律実行原則が残る。停止しても herdr 側は `blocked`/`idle` として観測され、既存の待機・通知経路に乗る |

## 9. 確認事項（実装前に実測が必要）

1. ~~**前提条件チェックの現実的な範囲**~~: **実測済み**（Issue #225 / `docs/cloud-prerequisite-checks.md`）。1（サインイン）は `claude auth status --json` で静的判定でき起動時エラーへ、2（GitHub 連携）・4（組織ポリシー）は照会手段が無く案内のみへ確定。4.5 を更新済み
2. ~~`--append-system-prompt-file` がクラウドセッションで受理されるか~~: **実測済み**（Issue #223 / `docs/cloud-session-launch-flags.md` T7）。**受理される**（起動引数としては拒否されない）。ただし「VM 側で実際にシステムプロンプトとして反映されるか」までは確認していない未実測が残る（→10章 Phase 2）
3. ~~`--model` / `--effort` / `--advisor` / `--chrome` の受理可否~~: **実測済み**（Issue #223 / `docs/cloud-session-launch-flags.md` T7）。**5フラグすべて受理される**。VM 側で実際に効くかは未実測（→10章 Phase 2）
4. ~~クラウドセッションのローカル transcript（`~/.claude/projects/*/<sessionId>.jsonl`）が生成されるか~~: **前提が成立しないことが確定**（Issue #224 / `docs/cloud-session-launch-flags.md` M-6）。クラウドセッションでは transcript は**生成されない**。クラウド VM で実行されたターンは transcript にもペイン内容にも一切現れないため、最終レポートの取得経路は現状ゼロ（フォールバック先も含めて空振り）
5. ~~**GitHub プロキシの GraphQL 403 が、実際にどのスキル操作で発生するか**~~: **実測済み**（Issue #226 / [cloud-graphql-proxy-limits.md](./cloud-graphql-proxy-limits.md)）。`gh issue view --json` / `gh pr view --json` はフィールドを問わず403、`gh pr list` / `gh pr checks` / `gh api graphql` も全滅で、ワーカー起動スキル15個すべてが影響を受ける。レビュースレッド解決だけは REST 代替が原理的に存在しない。5章の制約表・適合性表を差し替え済み。残課題は、リポジトリ連携済みセッションでの REST 代替の実行検証と、書き込み系操作（マージ・CI再実行・ラベル付与・コメント投稿）の個別可否
6. ~~クラウドセッションから PR ブランチへの **force-push** が可能か~~: **測定不能で確定**（Issue #227 / `docs/cloud-session-force-push.md`）。GitHub App 連携が未設定のため `--on-branch` がブランチ検証の前段で拒否され、PR の head ブランチ・固定名ブランチのどちらでも同一文言になる（拒否理由はブランチの実在有無に依存しない）。`--on-branch` を外した経路でも VM に `git remote` が無く push が資格情報へ到達しない。`resolve-conflict` は **Phase 1 で ✕ 据え置き**（「拒否される」ではなく「可否を確認できない」ことが根拠）。Phase 2 で再判定するには GitHub App 連携済みリポジトリでの再実測が要る
7. ~~`--ref` / `--on-branch` の正確な意味と組み合わせ~~: **一部解消**（Issue #223 / `docs/cloud-session-launch-flags.md` T8〜T10）。**どちらもベースブランチ指定で排他**であること（PRD 4.2 旧版が想定していた「`--ref`＝ベースブランチ／`--on-branch`＝既存PRブランチ上で作業再開」という役割分担ではないこと）は確定した。ただし個々の受理可否・意味論そのものは実測環境（GitHub App 連携未設定）ではブランチ名検証に到達する前に拒否されるため**未実測のまま**（→10章 Phase 2）
8. ~~herdr の agent ステータス検出が、クラウドセッションをドライブしている TUI でも `working` / `idle` / `done` を正しく返すか~~: **前提が成立しないことが確定**（Issue #224 / `docs/cloud-session-launch-flags.md` M-1〜M-4）。**クラウドセッションをドライブし続けるローカル TUI が存在しない**（`--teleport` はローカル実行に化ける）ため、この問いは成立しない。一方、driver 契約自体（`working`/`idle`/`done`/`blocked` の遷移、質問待ちの `blocked` 継続）は teleport セッション（＝ローカル TUI）に対しては正しく動作することを確認済み
9. ~~クラウドセッションの session ID をローカル側で取得する手段~~: **前提が成立しないことが確定**（Issue #224 / `docs/cloud-session-launch-flags.md` M-7〜M-9）。`agentGet()` の `sessionId` は**ローカル claude のセッションUUIDでありクラウドセッションIDとは別物**（claude.ai の URL に入れても見つからない）。クラウドセッションIDを取得できるのは起動コマンドの stdout（`Created cloud session: <id>` / `View: https://claude.ai/code/<id>`）だけで、CLI にクラウドセッションを列挙・照会する経路は無い。実装は `extractCloudSessionId()` で起動出力をパースする

## 10. 段階導入

- **Phase 1**（本 PRD の主対象）: `cloud` 設定 + 引数の組み立て + `mode: "herdr"` 限定 + 起動時ガードは `CLOUD_DENIED_WORKERS`（`resolve-conflict` / `create-ui-design` / `apply-ui-design`）のみを拒否する deny-list 方式（5章・受け入れ基準6参照）。適合性「△/✕」でも同リストに含まれないワーカー（`fix-review-point` / `triage-pr` / `check-dependabot` 等）は起動時に拒否しない。default モード・`CLOUD_DENIED_WORKERS` は起動時エラー
- **Phase 2**: 以下の残課題に取り組む
  - `mode: "default"` でのクラウド実行
  - ドライバ再接続と**完了検知の代替チャネル**。S-2 の実測で `--teleport` によるローカルドライバ接続が成立しないことが確定したため（→9-8）、herdr の agent ステータスに代わる検知手段が要る。副次的な観測（`docs/cloud-session-launch-flags.md` M-8）として、`claude agents --json` は TTY 無しで `status`（`idle` / `busy`）を返し herdr 非依存の完了検知に使えるが、**返るのはローカルセッションのみでクラウドセッションは1件も含まれない**ため、そのままではクラウド実行の完了検知には使えない
  - クラウド環境セットアップスクリプトの提供（`pencil` / `codegraph` / `designmd` の導入。Pencil はさらに認証が要る）。プラグイン・CLI 自体の導入（`npx claude-task-worker install`）は claude.ai の環境設定へ直接記載する方式として Phase 1 で実装済み（Issue #268）
  - `resolve-conflict` の force-push 可否の再測定
  - 上記すべての前提となる **GitHub App 連携済みリポジトリでの再実測**（`--ref` / `--on-branch` の意味論、REST 代替の実行検証、書き込み系操作の個別可否、push 可否がいずれもこの前提に依存する。→9-2・9-3・9-5・9-6・9-7）

## 11. 受け入れ基準

1. `claude-task-worker.json` に `cloud` を書かない既存リポジトリで、引数・挙動・テスト結果がこの変更の前後で**完全に同一**であること
2. `workers.<name>.cloud: true` かつ `mode: "herdr"` で、対象ワーカーのタスクがクラウドセッションとして起動し、claude.ai 上でセッションが確認できること
3. クラウド実行のタスクで、`cc-in-progress` の付与・除去、`cc-need-human-check` への退避、`cc-pr-created` の検証付き付与が**ローカル実行と同一の条件**で行われること
4. クラウド実行のタスクで worktree が作られず、実行後にローカルへ残骸（worktree・ローカルブランチ）が残らないこと
5. クラウド実行の完了・失敗が Slack へ通知され、失敗通知から原因（セッション URL または出力）を辿れること
6. `cloud: true` × `mode: "default"`、および `CLOUD_DENIED_WORKERS`（`resolve-conflict` / `create-ui-design` / `apply-ui-design`）への `cloud: true` が、タスクを1件も起動せずにワーカー起動時点でエラー終了すること。適合性「✕」でも `CLOUD_DENIED_WORKERS` に含まれないワーカー（`fix-review-point` / `triage-pr` / `check-dependabot`）は起動時に拒否されないこと（→ 5章の適合性表の「起動時ガード」列）
7. cloud driver の状態遷移（`working` / `idle` / `done` / `blocked`）が、実クラウドセッションまたは同等の driver contract テスト（7.2 のCLIスタブ統合テスト／smoke test）で検証されていること。質問待ち（`blocked` 相当）を `idle` として誤返却しないことを含む
