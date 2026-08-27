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
5. 開発者として、クラウド実行を有効にしたが前提条件（認証・プラグイン宣言）が整っていない場合は、タスクを起動する前にワーカー起動時点で気づきたい。

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

`buildClaudeArgs()`（`src/claude-args.ts`）は `cloud` を受け取り、クラウド実行時は以下の差分を適用する。クラウドセッションが**受理しないフラグを渡すと起動そのものが `Error:` で失敗する**（黙って無視されない）ため、差分は削除側が中心になる。

| 引数 | ローカル | クラウド | 理由 |
|------|---------|---------|------|
| `-p <prompt>` | default モードのみ付与 | **付けない** | クラウドセッションの**新規作成は print モード非対応**（`-p` + `--cloud` は既存セッションへの追記専用） |
| `--cloud` | なし | **付与**（値なし） | 新規クラウドセッションを作成する |
| `--ref <branch>` | なし | **付与**（Issue 系: ベースブランチ） | クラウド VM はリモートを clone するため、ローカル worktree ではなくブランチ名でベースを指定する |
| `--on-branch <branch>` | なし | **付与**（PR 系: PR の head ブランチ） | 既存 PR ブランチ上で作業を再開させる。`--ref` とは排他。未検証（→9-7）。未対応と判明した場合は起動前バリデーションでエラー終了する |
| `--permission-mode bypassPermissions` | 付与 | **付けない** | クラウドセッションは bypassPermissions を拒否する（`Error: a cloud session cannot bypass permissions`）。クラウド VM は隔離済みで、セッション既定の権限モードに委ねる |
| `--disallowedTools` | 付与 | **付けない** | クラウドセッションはツール制限を強制できず、渡すと拒否される（`Error: a cloud session does not enforce tool restrictions yet`） |
| `--append-system-prompt-file` | 付与 | **要検証**（→ 9-2） | 受理されないと判明した場合は起動前バリデーションでエラー終了する。**プロンプト本文への前置に降格しない**（本文には Issue/PR 由来の外部テキストが後続で入るため、自律実行原則を本文へ落とすとプロンプトインジェクションで上書きされうる） |
| `--model` / `--effort` / `--advisor` / `--chrome` | 付与 | **要検証**（→ 9-3） | 拒否される場合は個別に落とす |

プロンプト（`/claude-task-worker:exec-issue 123`）は `--cloud` の説明文（引数）として渡さず、**起動後に投入する**（herdr の `agent prompt` 経由）。説明文として渡すと、herdr の `agent start` が「入力待ちになるまで」ブロックする仕様と噛み合わない（既存の herdr モードと同じ理由）。

### 4.3 実行形態の制約: クラウド実行は `mode: "herdr"` 限定（Phase 1）

**新規クラウドセッションの作成には TTY が必要**。claude CLI は stdout が TTY でない場合 print モード扱いになり、print モードの `--cloud` は「既存セッションへのメッセージ投函」しか受け付けない。ワーカーの `mode: "default"` は `spawn(..., { stdio: ["ignore", "pipe", "pipe"] })` で TTY を持たないため、**この経路ではクラウドセッションを作成できない**。

したがって Phase 1 では:

- `cloud: true` のワーカーが1つでもあり、かつ `mode` が `"herdr"` でない場合、**ワーカー起動時にエラー終了**する（`assertRunModeAvailable()` と同じ位置。サイレントにローカル実行へフォールバックしない）
- `mode: "herdr"` では既存のタスクタブ（TUI・TTY あり）がそのままドライバになる。タブラベルはクラウド実行であることが分かるよう `ctw:<project>:#<n>:cloud` とする

`mode: "default"` でのクラウド実行（pty 割り当て等）は Phase 2 とする（→ 10章）。

### 4.4 タスクのライフサイクル（クラウド実行時）

ローカル実行との差分のみ記す。ラベル遷移・通知・`onCompleted` 検証の**呼び出し順序は一切変えない**。

1. **worktree を作らない**。`createWorktreeFromBranch()` / `removeWorktree()` / `getWorktreePath()` をスキップし、cwd はリポジトリのルート（ワーカーの cwd）とする。クラウド VM は自前で clone するため、ローカルの作業ツリーは使われない
   - Issue 系の epic 対応は `ensureEpicBranch()` を**引き続き実行する**（`cc-epic-<N>` をリモートに用意する処理であり、その後 `--ref cc-epic-<N>` で参照する）
   - PR 系の `removeWorktreeByBranch()` / `deleteLocalBranch()` / `localBranchExists()` によるプリフライトは**スキップする**。ローカルの checkout 競合はクラウド実行では発生しないため（`gh pr checkout` はクラウド VM 側で走る）
2. **完了検知**は herdr の agent ステータス（`working` → `idle` / `done`）をそのまま使う。ドライバ（アタッチ中のローカル claude）がクラウドセッションの状態を TUI に反映するため、既存の `waitForHerdrTask()` が流用できる想定（→ 9-8）
3. **最終レポート**は既存の「transcript 優先・ペイン内容フォールバック」をそのまま使う。クラウドセッションのローカル transcript が存在しない可能性があるため（→ 9-4）、フォールバック経路が実質の本命になる
4. **セッション終了**は既存の `stopHerdrTask()`（ctrl-c ×2 → agent 消失待ち → タブクローズ）。ドライバを閉じても**クラウドセッション自体は生き続ける**点がローカル実行と異なる（アーカイブ・削除は claude.ai 側の操作）。ドライバのローカルプロセスが死んだ場合の再接続（session ID を保持してのポーリング再開）は Phase 1 では実装せず、セッションが宙に浮いたまま失敗通知に session URL を載せて人手に委ねる（→8章リスク表、Phase 2 で解消）
5. **`cc-in-progress` / `cc-need-human-check` / `cc-pr-created`** の扱いはローカル実行と完全に同一。`onCompleted` の検証（PR 実在確認）は GitHub API 経由なので実行場所に依存しない
   - ただし `exec-issue` の検証のうち「**worktreeId を head とする PR**」の条件は成立しない（クラウドセッションは自分でブランチ名を決めるため）。クラウドセッションの実ブランチ名を取得できる場合はそれを `headRefName` 一致の代替として渡し、「Issue を closing 参照する PR」の候補が本当にこのタスクの成果物かを検証する。実ブランチ名を取得できない場合は代替の所有権検証（closing-reference PR の base ブランチが `--ref`/`--on-branch` で指定したブランチと一致すること、かつ PR の作成時刻がタスク起動時刻に近接していること）で判定する。いずれの経路でも所有権を確認できない closing-reference PR は根拠として使わず、「Issue がクローズ済み」の条件のみで `cc-pr-created` を付与する

### 4.5 前提条件チェック

`cloud: true` のワーカーがある場合、ワーカー起動時に以下を確認する。**チェック対象ごとに契約が異なる**:

- **1（サインイン）・3（プラグイン宣言）は起動時に静的検査でき、満たさなければエラー終了する（タスクを1件も起動しない）**
- **2（GitHub 連携）・4（`allow_remote_sessions` 組織ポリシー）はローカルから照会する手段が無いため、エラー終了の対象にはせず、タスク実行時に失敗した場合のエラーメッセージ案内に留める**

実測の詳細（判定コマンド・構成ごとの出力・案内メッセージの文面案）は `docs/cloud-prerequisite-checks.md`（Issue #225）。

1. **claude.ai アカウントでのサインイン**。API キー認証・第三者プロバイダ（Bedrock / Vertex 等）ではクラウドセッションを作成できない。`claude auth status --json` の `loggedIn` / `authMethod` / `apiProvider` / `apiKeySource` と `ANTHROPIC_BASE_URL` の有無で**起動時に静的検査してエラー終了する**（`ANTHROPIC_API_KEY` 設定時も `authMethod` は `"claude.ai"` を返すため、`apiKeySource` の不在を併せて見る必要がある）
2. **GitHub 連携**（Claude GitHub App の認可、または `/web-setup` による `gh` トークンの同期）。連携状態は非公開 API（`GET /api/oauth/organizations/:orgUUID/sync/github/auth`）経由でしか取れず CLI 表層に無いため、静的検査しない（失敗時のエラーメッセージで案内）
   - 未設定でもセッション作成自体は成功し、ローカル作業ツリーがアップロードされてシードされる（PRD 4.4-1 の「クラウド VM が自前で clone する」前提は GitHub 連携済みの場合にのみ成立する）。失敗するのは `--ref` / `--on-branch` を付けた場合で、その時点で連携未設定が顕在化する
3. **リポジトリ `.claude/settings.json` へのプラグイン宣言**。クラウドセッションが読み込むのは**リポジトリの**設定で、ローカルの `~/.claude/settings.json`（`claude plugin install` の書き込み先）は届かない。`extraKnownMarketplaces` + `enabledPlugins` に本プラグインが宣言されていないと、`/claude-task-worker:exec-issue` などのスキルがクラウド VM に存在せず、セッションが空振りする（起動時に静的検査してエラー終了）
   - この登録処理（`registerPluginInSettings()` / `mergePluginSettings()`）は `ce46d5d` で `init` から撤去済み。**クラウド実行の前提として復活が必要**（`claude-task-worker init --cloud` 等、明示的なオプトインで書き込む形が望ましい）
4. **`allow_remote_sessions` 組織ポリシー**。組織側でクラウドセッションの作成が無効化されているとセッション作成不可。CLI はポリシー取得結果を `policy-limits.json` にキャッシュする実装を持つが、実測環境では生成されず、不在は「未取得」と「拒否」を区別できないため静的検査しない（失敗時のエラーメッセージで案内）

### 4.6 通知

Slack 通知の本文・経路は変更しない。クラウド実行時は本文の先頭にクラウドセッションの URL（`https://claude.ai/code/<session-id>`）を1行入れる。取得できない場合は省略する（通知自体は落とさない）。

## 5. クラウド実行の制約とワーカー適合性

クラウドセッションはローカル実行と等価ではない。以下は **claude CLI / ドキュメントで確認済み**の制約で、ワーカー選定の前提になる。

| 制約 | 影響 |
|------|------|
| **GraphQL の 403 制限**: GitHub プロキシは PR ワークフロー向けの限定セットしか通さない。`GH_TOKEN` を自前で設定しても同じ | `gh issue view --json parent,blockedBy`、レビュースレッドの解決（`resolve-pr-comments`）、Projects v2 など GraphQL 依存の操作が失敗しうる。REST（`gh api repos/{owner}/{repo}/...`）へのフォールバックが必要 |
| **push は「セッションの作業ブランチ」のみ** | 別ブランチへの push・固定名ブランチへの force-push を伴う処理は成立しない。`--on-branch` で作業ブランチを PR の head に合わせる必要がある |
| **bypassPermissions 不可 / ツール制限不可** | `--disallowedTools` による `AskUserQuestion` / `Monitor` 等の無効化が効かない。自律実行原則（システムプロンプト注入）だけが歯止めになる |
| **`!` インラインコマンド不可** | SKILL.md のプリアンブル `!` が実行されない。現状の該当は `triage-pr` / `check-dependabot` の `git fetch`（いずれも失敗しても継続する設計）のみ |
| **MCP はデバイスリンク経由** | CodeGraph / Pencil の MCP サーバーはローカルのドライバ経由でしか届かない。プラグイン同梱の `.mcp.json` はクラウド VM 側でも起動されるが、`codegraph` CLI もインデックスも VM に存在しないためテキスト検索へフォールバックする |
| **ローカル CLI が入っていない** | `pencil` / `codegraph` / `designmd` は未インストール。必要ならクラウド環境のセットアップスクリプトで導入する（Pencil はさらに認証が要る） |
| **レート制限を共有** | クラウド実行はアカウントのレート制限を消費する（VM の追加課金はない）。並列度を上げるとローカル実行と同じ枠を食い合う |
| **利用できない構成** | ZDR 有効な組織、IP アローリスト有効な組織、第三者プロバイダ構成では使えない |

### ワーカー別の適合性（初期評価）

| ワーカー | 適合 | 根拠 / 前提 |
|---------|------|------------|
| `exec-issue` | ◎ | 新規ブランチを自分で作って push・PR 作成。クラウドの push 制約に当たらない。最も重いワーカーで効果が大きい |
| `update-coding-guidelines` / `update-requirement-rules` / `update-design-md` | ◎ | 1日1回・長時間・成果物は新規ブランチの PR。実行記録 PR はローカルのワーカーが出すため影響なし |
| `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` | ○（GraphQL 要検証） | コード変更を伴わない。`parent` / `blockedBy` の取得が GraphQL 依存のため 403 の影響を受けうる |
| `epic-issue`（`create-epic-pr`） | ○ | `cc-epic-<N>` を作業ブランチにできれば成立 |
| `fix-review-point` | △ | PR head への push が必要（`--on-branch`）。レビューコメント取得・スレッド解決が GraphQL 依存 |
| `triage-pr` | △ | マージ判断・`gh pr merge`・CI 再実行が GraphQL/REST 混在。`gh pr checkout` はクラウド VM 側で実行されるため、ローカルの checkout 競合ガードは無効化する |
| `resolve-conflict` | ✕（Phase 1 では非対応） | rebase 後の force-push が push 制約に抵触するか未検証。`.pen` の解決に `pencil` CLI が必要 |
| `create-ui-design` / `apply-ui-design` | ✕（Phase 1 では非対応） | `.pen` の編集に `pencil` CLI と認証が必要 |
| `check-dependabot` | △ | 依存更新の検証にプロジェクト固有のツールチェーンが要る場合がある |

「✕」のワーカーで `cloud: true` が指定された場合は、**警告のうえローカル実行へフォールバックせず、起動時にエラー終了する**（サイレントな挙動差を作らない）。

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
| `src/workers/exec-issue.ts` | `onCompleted` の PR 実在検証から「worktreeId を head とする PR」の条件をクラウド時に外す |
| `src/herdr-runner.ts` | `taskTabLabel()` にクラウド識別子を追加。それ以外は変更なし（クラウドかどうかは引数の差でしかない） |
| `src/index.ts` | `assertRunModeAvailable()` の隣に `assertCloudAvailable()`（`cloud: true` × `mode !== "herdr"` の拒否、非対応ワーカーの拒否、前提条件チェック） |
| `src/commands/init.ts` | `.claude/settings.json` へのプラグイン登録を復活（クラウド実行のオプトイン時のみ） |
| `src/slack.ts` | 通知本文へのセッション URL 付与（取得できた場合のみ） |

### 7.2 テスト

11章の受け入れ基準（実クラウドセッション作成・TTY・ブランチ選択・worktree省略・状態検出・ラベル遷移・Slack通知・cleanup・起動拒否）は純粋関数のユニットテストだけでは検証できないため、以下の3層で構成する。

**ユニットテスト**（純粋関数、既存のローカル実行引数テストは変更しない）:

- `parseWorkerEntry()` が `cloud` を正しくパースする / 不正値で既定へ倒れる
- `buildClaudeArgs()` がクラウド時に `-p` / `--permission-mode bypassPermissions` / `--disallowedTools` を含まず、`--cloud` と `--ref`（または `--on-branch`）を含む
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
| クラウドセッションのスキルが空振りし、ワーカーが「完了」と誤認してラベルを進める | 既存の空出力検知（`buildTaskResult`）と `onCompleted` の成果物検証がそのまま効く。加えて 4.5 のプラグイン宣言チェックで空振りの主要因を潰す |
| GraphQL 403 でスキルが途中失敗し、Issue/PR が中途半端な状態で残る | 失敗は Slack 通知に出る。適合性「△」のワーカーは Phase 1 では既定 `false` のまま、実測でホワイトリスト化する |
| ドライバのローカルプロセスが死ぬとクラウドセッションが宙に浮く（セッションは生きているがワーカーは失敗扱い） | Phase 2 でセッション ID を保持し、再起動後にステータスを引き直す。Phase 1 では失敗通知に session URL を載せて人が拾えるようにする |
| クラウド実行がレート制限を食い、ローカルのワーカーが詰まる | `maxConcurrentTasks` は据え置き。クラウド化はワーカー単位のオプトインなので影響範囲が限定される |
| ツール制限（`--disallowedTools`）が効かず、`AskUserQuestion` でセッションが停止する | システムプロンプトの自律実行原則が残る。停止しても herdr 側は `blocked`/`idle` として観測され、既存の待機・通知経路に乗る |

## 9. 確認事項（実装前に実測が必要）

1. ~~**前提条件チェックの現実的な範囲**~~: **実測済み**（Issue #225 / `docs/cloud-prerequisite-checks.md`）。1（サインイン）は `claude auth status --json` で静的判定でき起動時エラーへ、2（GitHub 連携）・4（組織ポリシー）は照会手段が無く案内のみへ確定。4.5 を更新済み
2. `--append-system-prompt-file` がクラウドセッションで受理されるか。**拒否される場合はクラウド実行を起動時エラーとする**（プロンプト本文への前置は、外部テキストによる上書きを許すためセキュリティ上採用しない）。残課題は、同等の system-level control（本文とは別チャネルでシステムプロンプトを注入する手段）がクラウドセッションに存在するかの実測
3. `--model` / `--effort` / `--advisor` / `--chrome` の受理可否（クラウドでは `/model` で切り替える旨の記述があり、起動引数として受理されるかは未確認）
4. クラウドセッションのローカル transcript（`~/.claude/projects/*/<sessionId>.jsonl`）が生成されるか。されない場合、最終レポートはペイン内容フォールバックのみになる
5. GitHub プロキシの GraphQL 403 が、実際にどのスキル操作で発生するか（`gh issue view --json parent,blockedBy`、`gh pr view --json reviews`、レビュースレッド解決）
6. クラウドセッションから PR ブランチへの **force-push** が可能か（`resolve-conflict` の可否を決める）
7. `--ref` / `--on-branch` の正確な意味と組み合わせ（ヘルプ非掲載のフラグ。CLI 内の検証メッセージからは「新規セッションのベースブランチ指定」「ブランチ上での作業再開」と読める）
8. herdr の agent ステータス検出が、クラウドセッションをドライブしている TUI でも `working` / `idle` / `done` を正しく返すか（返らない場合は完了検知を別手段に切り替える必要がある）
9. クラウドセッションの session ID をローカル側で取得する手段（Slack 通知へのリンク付与と Phase 2 の再接続に必要）

## 10. 段階導入

- **Phase 1**（本 PRD の主対象）: `cloud` 設定 + 引数の組み立て + `mode: "herdr"` 限定 + 適合性「◎/○」のワーカーのみ許可。default モード・非対応ワーカーは起動時エラー
- **Phase 2**: `mode: "default"` でのクラウド実行（pty 割り当て、または完了検知をセッション ID ポーリングへ移行）、ドライバ再接続、クラウド環境セットアップスクリプトの提供（`pencil` / `codegraph` 導入）

## 11. 受け入れ基準

1. `claude-task-worker.json` に `cloud` を書かない既存リポジトリで、引数・挙動・テスト結果がこの変更の前後で**完全に同一**であること
2. `workers.<name>.cloud: true` かつ `mode: "herdr"` で、対象ワーカーのタスクがクラウドセッションとして起動し、claude.ai 上でセッションが確認できること
3. クラウド実行のタスクで、`cc-in-progress` の付与・除去、`cc-need-human-check` への退避、`cc-pr-created` の検証付き付与が**ローカル実行と同一の条件**で行われること
4. クラウド実行のタスクで worktree が作られず、実行後にローカルへ残骸（worktree・ローカルブランチ）が残らないこと
5. クラウド実行の完了・失敗が Slack へ通知され、失敗通知から原因（セッション URL または出力）を辿れること
6. `cloud: true` × `mode: "default"`、および適合性「✕」のワーカーへの `cloud: true` が、タスクを1件も起動せずにワーカー起動時点でエラー終了すること
7. cloud driver の状態遷移（`working` / `idle` / `done` / `blocked`）が、実クラウドセッションまたは同等の driver contract テスト（7.2 のCLIスタブ統合テスト／smoke test）で検証されていること。質問待ち（`blocked` 相当）を `idle` として誤返却しないことを含む
