# PRD: herdr モード（TUI 実行）とワークスペース分離ディスパッチ

- ステータス: Draft
- 作成日: 2026-07-19
- 対象リポジトリ: getty104/claude-task-worker
- 関連 PRD: [prd-multi-project-dispatch.md](./prd-multi-project-dispatch.md)（`--project` ディスパッチ機能）

## 1. 背景・目的

`--project` ディスパッチ（PRD: マルチプロジェクトディスパッチ）により、複数リポジトリのワーカーを1コマンドで一斉起動できるようになった。現状の構成には次の2つの制約がある。

1. **ディスパッチ先がタブ単位**: プロジェクト数分のタブが単一ワークスペースに並ぶため、プロジェクトが増えるとタブバーが混雑し、どのタブがどのプロジェクトかを一目で切り分けにくい。またワーカーが今後タスクごとにタブを作る場合（後述の herdr モード）、プロジェクトのタブとタスクのタブが同じ階層に混在してしまう。
2. **タスク実行が `claude -p` 固定**: ワーカーは各タスクを非対話 print モードで spawn するため、実行中の様子を人が覗けない。途中経過の確認・介入（承認、追加指示、Ctrl-C での中断）ができず、失敗時は完了後の stdout をまとめて読むしかない。

本アップデートでは、

- ディスパッチ先を **herdr ワークスペース単位** に分離してプロジェクトごとの作業空間を独立させる
- 設定ファイルを `projects.json` から **`config.json`** に改名し、実行形態を切り替える **`mode` プロパティ**を追加する
- `mode: "herdr"` では、タスクを `claude -p` ではなく **herdr タブ内の TUI セッション**として実行し、進捗を herdr 上で可視化・監視できるようにする

### 解決する課題

- プロジェクトごとの作業空間（ワークスペース）が独立し、タスクのタブがプロジェクトのワークスペース内に閉じる
- 実行中のタスクを herdr 上でリアルタイムに覗ける（TUI のため出力・思考過程・ツール実行がその場で見える）
- タスクが詰まっている／おかしな方向に進んでいる場合、そのペインに直接介入できる
- 設定ファイル名が `projects.json`（プロジェクト定義専用）から `config.json`（CLI 全体の設定）へ変わり、`mode` のようなプロジェクト定義以外の設定を素直に追加できる

## 2. 用語

| 用語 | 意味 |
|------|------|
| ディスパッチャー | `--project` 付きで起動された claude-task-worker プロセス。ワーカーは実行せず、herdr 経由で各プロジェクトへコマンドを配送・監視する |
| ワーカーセッション | ディスパッチャーが各プロジェクトのワークスペース内で起動した `claude-task-worker <command>` プロセス |
| タスクセッション | ワーカーが Issue/PR ごとに起動する claude プロセス。`mode: "default"` では `claude -p` の子プロセス、`mode: "herdr"` では herdr タブ内の TUI セッション |
| config.json | `$XDG_CONFIG_HOME/claude-task-worker/config.json`。プロジェクト定義と `mode` を持つユーザーレベルの設定ファイル（旧 `projects.json`） |
| claude-task-worker.json | 各リポジトリ直下に置くワーカー個別設定（`src/config.ts`）。本 PRD では変更しない |

## 3. ユーザーストーリー

1. 開発者として、`--project all` で起動したとき、プロジェクトごとに独立した herdr ワークスペースが作られ、ワークスペースを切り替えるだけでプロジェクトを行き来したい。
2. 開発者として、`config.json` に `"mode": "herdr"` と書くだけで、全ワーカーのタスク実行を TUI モードに切り替えたい。
3. 開発者として、herdr モードで走っているタスクのタブを開き、claude が今何をしているかをリアルタイムに見たい。
4. 開発者として、タスクが完了したらそのタブが自動的に閉じ、タブが溜まらないようにしてほしい。
5. 開発者として、タスクのタブ名から「どのプロジェクトの何番の Issue/PR か」が即座に分かるようにしてほしい（`ctw:my-app:#123`）。
6. 開発者として、herdr モードでも通知音が鳴らないようにしてほしい（多数のタスクが並列で走るため）。
7. 開発者として、`mode` を書かない／`config.json` を置かない従来の使い方では、これまでとまったく同じ挙動であってほしい。

## 4. 機能要件

### 4.1 設定ファイルの改名: `projects.json` → `config.json`

- 新パス: `$XDG_CONFIG_HOME/claude-task-worker/config.json`（`XDG_CONFIG_HOME` 未設定時は `~/.config/claude-task-worker/config.json`）
- 形式（`mode` を追加した以外は従来と同一）:

```json
{
  "mode": "herdr",
  "projects": {
    "my-app": "/absolute/path/to/my-app",
    "time-card": "/absolute/path/to/time-card"
  },
  "projectGroups": {
    "igsa": ["time-card"],
    "all-mine": ["my-app", "time-card"]
  }
}
```

**移行**

旧ファイル名 `projects.json` のサポートは行わない（決定事項、→ 確認事項 8-4）。単一ユーザー運用で移行対象が1ファイルのみのため、フォールバックを持たずに `config.json` へリネームする。

- `config.json` が存在すればそれを読む
- 存在しない場合の扱いは従来どおり:
  - `--project` 指定時 → エラー終了（メッセージ中のパスは `config.json` を案内する）
  - `--project` 未指定時 → 設定ファイルなしで従来動作（`mode` は `"default"` 扱い）

**バリデーション（`projects` / `projectGroups`）**

既存の projects.json のバリデーション（絶対パス・ディレクトリ実在チェック、`projectGroups` の未定義参照スキップ、`projects`/`projectGroups` のキー名前空間の一意性、予約語 `all` の禁止、`__proto__` 禁止）はすべてそのまま維持する。

### 4.2 `mode` プロパティ

| 値 | 挙動 |
|----|------|
| `"default"`（既定） | 現行と完全に同一。ワーカーはタスクを `claude -p` の子プロセスとして spawn する |
| `"herdr"` | ワーカーはタスクごとに herdr タブを作り、その中で claude を TUI モードで起動する |

- トップレベルの単一プロパティとし、プロジェクトごとの上書きは本リリースのスコープ外とする（→ 確認事項 8-2）
- 未指定・不正値の場合は `"default"` にフォールバックし、不正値のときは警告を出す（`[config] invalid mode: "xxx", using "default"`）
- **`mode` はワーカープロセス自身が読む**。`--project` 経由で起動された場合も、各リポジトリで直接起動された場合も、同じ `config.json` を読むため挙動は一致する。ディスパッチャーが転送コマンドに `--mode` 等を付与する必要はない
- `mode: "herdr"` でワーカーを起動したとき、起動時に herdr の疎通確認（`checkHerdrAvailable()`）を行い、未インストール・サーバー未起動ならエラー終了する（`"default"` へのサイレントフォールバックはしない。ユーザーが明示的に選んだ実行形態を勝手に変えないため）

### 4.3 `--project` ディスパッチのワークスペース分離

現行のタブ単位ディスパッチを、ワークスペース単位に置き換える。

**起動時（`runDispatcher()`）**

1. herdr 疎通確認（変更なし）
2. 既存ワークスペースの重複チェック: `herdr workspace list` のラベルに `ctw:<projectName>` があるプロジェクトはスキップし警告（現行のタブラベル重複チェックの置き換え）
3. プロジェクトごとに `herdr workspace create --label ctw:<projectName> --cwd <リポジトリパス> --env CTW_PROJECT_NAME=<projectName> --no-focus`
   - レスポンスから `result.workspace.workspace_id` / `result.root_pane.pane_id` / `result.root_pane.tab_id` を保持する
4. root pane に対して現行と同じ手順でワーカーコマンドを送信する（`waitForPaneReady()` → `paneSendText` + `paneSendKeys enter` → `waitForWorkerStartup()` → 未起動なら再送）。シェル初期化レースのガードはそのまま維持する
5. root タブのラベルは herdr が自動採番する（`"1"`）ため、`herdr tab rename <tabId> ctw:<projectName>` でワーカー本体のタブと分かるようにリネームする

**ワークスペース ID のワーカーへの伝達**

herdr モードのワーカーは「自分のプロジェクトのワークスペース内」にタスクタブを作る必要があるため、ワークスペース ID を知らなければならない。

**herdr は各ペインの環境に `HERDR_WORKSPACE_ID` / `HERDR_TAB_ID` / `HERDR_PANE_ID` / `HERDR_ENV=1` を自動で注入している**（2026-07-19 実測）。したがって claude-task-worker 側で独自の環境変数を渡す必要はなく、ワーカーは `process.env.HERDR_WORKSPACE_ID` を読むだけでよい:

- ディスパッチャー経由の起動: ディスパッチャーが作ったワークスペースの root pane で動くため、そのワークスペース ID が入っている
- ユーザーが herdr のペイン内で直接起動した場合: そのペインのワークスペース ID が入っている
- herdr の外（通常のターミナル）で `mode: "herdr"` のワーカーを起動した場合: 未設定。ワークスペース指定なしでタスクタブを作る（herdr のアクティブワークスペースに作られる）

タスクタブのラベルに使う**プロジェクト名**は次の優先順で解決する:

1. 環境変数 `CTW_PROJECT_NAME`（ディスパッチャーが `workspace create --env CTW_PROJECT_NAME=<name>` で注入する。ワークスペース作成時点でプロジェクト名は既知のため `--env` で渡せる）
2. `config.json` の `projects` を cwd で逆引き
3. リポジトリ名（`gh repo view` で取得済みの `name`）にフォールバック

**監視（`monitorSessions()` / `pollOnce()`）**

- 生存判定は現行どおり root pane の `herdr pane process-info` に `claude-task-worker` プロセスがいるかで行う（変更なし）
- ステータステーブルの `Tab` 列を `Workspace` 列に置き換える

**終了・シャットダウン（`shutdownDispatcher()`）**

- 現行の「ctrl+c 送信 → 終了待ち → `tab close`」を「ctrl+c 送信 → 終了待ち → **`workspace close`**」に置き換える
- ワークスペースごと閉じることで、herdr モードでワーカーが作った残存タスクタブも同時に片付く
- ワーカーが自然終了した場合（`pollOnce` での検知）も同様にワークスペースを閉じる
- ユーザーがワークスペースを手動で閉じていた場合（`pane_not_found` 等）はクローズをスキップして一覧から削除するのみ（現行と同じ扱い）

### 4.4 herdr モードのタスク実行

`mode: "herdr"` のとき、ワーカーは `src/process-manager.ts` の `run()`（`spawn("claude", ["-p", ...])`）の代わりに、herdr 経由の TUI 実行を行う。

**起動手順（1タスクあたり）**

1. worktree を作成する（現行と同一。`.claude/worktrees/<adj-noun-NNNN>`）
2. `herdr agent start claude --workspace <workspaceId> --cwd <worktreePath> --env HERDR_DISABLE_SOUND=1 --env CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 --no-focus -- claude <TUI 引数...>`
   - `herdr agent start` は argv を直接実行するため、`pane send-text` のようなシェル初期化レース・シェル設定依存が発生しない
   - レスポンスの `result.agent.pane_id` / `result.agent.tab_id` を保持する
3. `herdr pane move <paneId> --new-tab --workspace <workspaceId> --label ctw:<projectName>:#<number> --no-focus`
   - `agent start` は指定ワークスペース（またはタブ）の既存タブに split で入るため、そのままでは1タブに複数タスクが同居する。`pane move --new-tab` でタスク専用タブへ切り出す
   - レスポンスの `result.move_result.created_tab.tab_id` をタスクのタブ ID として保持する

**TUI 引数**

`claude -p` 版との差分は「`-p` を外す」ことだけとし、他は現行と揃える:

```
claude "<skill> <number>"
  --dangerously-skip-permissions
  --chrome
  --disallowedTools <DISALLOWED_TOOLS_ARG>
  --append-system-prompt <SYSTEM_PROMPT>
  --model <model>
  --effort <effort>
```

- `--disallowedTools` は TUI でも維持する。ワーカーが自律実行する前提は変わらず、`AskUserQuestion` / `EnterPlanMode` に応答する人が常駐しているわけではないため
- **`--append-subagent-system-prompt` は廃止し、`SUBAGENT_SYSTEM_PROMPT` の内容を `SYSTEM_PROMPT` に統合する**（決定事項、→ 確認事項 8-1）。統合後の `SYSTEM_PROMPT` は、メインエージェント自身の自律実行原則に加えて「サブエージェントへ作業を委譲する際は、同じ原則を委譲プロンプトに明記して伝えること」「子サブエージェントの完了報告は鵜呑みにせず成果物を検証すること」を含める
  - 統合は **両モード共通**とし、`mode` による引数の分岐を最小化する（差分は `-p` の有無と print 専用環境変数のみに閉じる）
  - トレードオフ: `mode: "default"` では現在 CLI がネスト含む全サブエージェントへ強制注入しているが、統合後はメインエージェントが委譲時に伝達する形になり、注入の確実性は下がる。実行形態によって自律実行原則の届き方が変わる状態を避けること、および TUI で使えないフラグに依存しないことを優先する
- `SYSTEM_PROMPT` は文面の「`claude -p`（非対話 print モード）で自動起動されている」という記述が herdr モードの実態と食い違うため、実行形態に依存しない表現へ改める（自律実行原則そのものは維持する）
- `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` は print モード専用のため herdr モードでは渡さない
- `HERDR_DISABLE_SOUND=1` を `--env` で注入する（多数のタスクが並列で走るため通知音を止める）

**タブ名**

`ctw:<プロジェクト名>:#<Issue/PR 番号>`（例: `ctw:my-app:#123`）

- ディスパッチャーが作るワークスペースのラベル `ctw:<プロジェクト名>` とプレフィックスを共有し、claude-task-worker 由来のものだと判別できる
- 同一番号の Issue と PR を別ワーカーが同時に扱うと同名タブが並ぶことがあるが、herdr はタブを ID で管理するため機能上の問題はない（表示上の重複のみ）

### 4.5 herdr モードの監視・完了判定

`claude -p` では「プロセスの exit」がタスク完了シグナルだったが、TUI セッションはタスク完了後もプロンプト待ちで生き続けるため、完了判定を agent ステータスに置き換える。

- herdr は claude の状態を `agent_status`（`working` / `idle` / `blocked` / `unknown`）として保持しており、`herdr agent get <target>` / `herdr agent list` / `herdr wait agent-status <paneId> --status <state> --timeout <ms>` で取得・待機できる
- 完了判定: **一度 `working` を観測した後に `idle` になった時点**をタスク完了とみなす。起動直後は `unknown` / `idle` になりうるため、`working` の観測を前提条件に置く
- `blocked`（入力待ち）を観測した場合は、警告ログを出しつつ待機を継続する。**人がそのペインを開いて確認・解除する前提**とし、タイムアウトによる自動失敗扱いはしない（決定事項、→ 確認事項 8-6）。ステータステーブルにも `blocked` として表示し、人が気づけるようにする
- ペインが消えた場合（`pane_not_found`）は、claude が異常終了した／ユーザーがタブを閉じたケースとして**失敗扱い**にする
- タスク実行時間の上限は設けない（現行方針を踏襲。`herdr wait agent-status` のタイムアウトはループで再待機する）
- ステータステーブル（`process-manager.ts` の `renderTable()`）は herdr モードでも同じ枠組みで表示し、`Status` 列に agent ステータス由来の状態を表示する

**出力の回収**

Slack 通知（`notifyTaskCompleted` / `notifyTaskFailed`）と空振り検知には `claude -p` の stdout を使っていた。herdr モードでは完了検知時に `herdr pane read <paneId> --source recent --lines <N>` でペインの内容を取得し、同じ用途に流用する。

- `claude -p` の最終レポートと比べると整形が崩れる（TUI の枠線・スピナー等が混ざる）ため、通知本文は末尾 N 行に限定する
- `src/task-result.ts` の空出力検知（exit 0 かつ stdout 空 → 失敗）は herdr モードでは「ペイン内容が空 → 失敗」に相当する形で読み替える

**既存の同期実行ガードとの関係**

| ガード | herdr モードでの扱い |
|--------|---------------------|
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | `--env` で注入して維持 |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0` | print 専用のため渡さない |
| `--disallowedTools` | 維持 |
| `--append-system-prompt` | 維持（文面を実行形態非依存に改訂し、`SUBAGENT_SYSTEM_PROMPT` を統合） |
| `--append-subagent-system-prompt` | **廃止**（両モード共通）。内容は `--append-system-prompt` へ統合 |
| ワーカーレベルの完了検証（`onCompleted`） | 維持。TUI でも「ターンが終わったが成果物がない」ことは起こりうるため、最後の砦として引き続き必要 |
| Stop フック（`plugin/scripts/stop-servers.mjs`） | 維持。TUI でもターン終了時に発火するため、起動プロセスの後片付けは同様に効く |
| プリアンブル失敗の空振り検知 | ペイン内容が空のまま `idle` になるケースとして検知する |

### 4.6 タスク終了後のクリーンアップ

タスク完了（または失敗）を検知したら、次の順序で片付ける。

1. `herdr pane read` で出力を回収する（タブを閉じるとペイン内容が失われるため必ず先に行う）
2. `herdr pane send-keys <paneId> ctrl+c ctrl+c` で TUI セッションを終了させる
3. ペインが消える（＝claude が終了した）まで待つ。`CLAUDE_EXIT_TIMEOUT_MS`（15秒）以内に消えなければ警告する
4. `herdr tab close <tabId>` でタブを閉じる。グレースフルに終了した場合はタブごと自動で消えているため、`tab_not_found` は正常系として扱う
5. 既存の完了コールバック（ラベル遷移・Slack 通知・`onCompleted` 検証・worktree 削除）を現行と同じ順序で実行する

**ctrl-c は1コマンドで連続2回送る必要がある**（2026-07-19 実測）:

| 送り方 | 結果 |
|--------|------|
| `send-keys <pane> ctrl+c` を1回 | 終了しない（1回目は入力キャンセル） |
| `send-keys <pane> ctrl+c` を2秒間隔で2回 | 終了しない（終了カウントがリセットされる） |
| `send-keys <pane> ctrl+c ctrl+c`（1コマンド） | **終了する**（ペインもタブも消える） |

セッション終了を完了コールバックより先に行うのは、claude が worktree を掴んだままだと `removeWorktree()` が失敗しうるため。また ctrl-c で終了させずに `tab close` だけに頼ると、claude は後片付けの機会を得られないまま強制終了される（`tab close` 自体はペイン内のプロセスを確実に終了させることを実測済み）。

ワーカー自身が SIGINT/SIGTERM で停止する場合は、実行中の全タスクタブに対して同じ手順（ctrl+c → tab close）を実行してから終了する（`process-manager.ts` の `shutdown()` に相当する herdr 版）。

### 4.7 `mode: "default"` の挙動

現行と完全に同一。`claude -p` の spawn、stdout 収集、exit code による判定、`CLAUDE_SPAWN_ENV` の注入、ステータステーブル表示のいずれも変更しない。

## 5. 非機能要件

- herdr の各 CLI 呼び出しは JSON レスポンスをパースして成否判定し、失敗時は既存のログ規約（`[worker-name]` / `[dispatcher]` プレフィックス）でログ出力する
- 1タスクの起動失敗が他タスク・ワーカー全体を停止させない（既存の「エラーは try-catch でログ出力し、クラッシュせず継続」規約に準拠）
- herdr 由来の失敗（ワークスペース消失、タブ作成失敗等）は、ラベル・worktree を中途半端な状態に残さないよう、既存の setup エラー経路（`cc-in-progress` 除去・worktree 削除・Slack 通知）に合流させる
- ポーリング間隔・待機タイムアウトは定数として切り出す

## 6. 実装方針（案）

| ファイル | 変更内容 |
|----------|----------|
| `src/projects-config.ts` → `src/user-config.ts`（リネーム案、→ 確認事項 8-3） | 参照先を `config.json` に変更し、`projects.json` フォールバックを追加。`mode` のパース・バリデーションを追加。型名を `ProjectsConfig` → `UserConfig` に改名 |
| `src/herdr.ts` | `workspaceCreate` / `workspaceList` / `workspaceClose` / `tabRename` / `agentStart` / `paneMoveToNewTab` / `agentStatus`（`agent get`）/ `waitAgentStatus` / `paneCurrent` を追加 |
| `src/dispatcher.ts` | タブ単位 → ワークスペース単位に変更（`runDispatcher` / `removeSession` / `shutdownDispatcher` / `renderSessionTable`）。`CTW_WORKSPACE_ID` / `CTW_PROJECT_NAME` を送信コマンドに注入 |
| `src/herdr-runner.ts`（新規） | herdr モードのタスク実行。`process-manager.ts` の `run()` と同じシグネチャで、agent start → pane move → agent_status 監視 → pane read → ctrl+c → tab close を担う |
| `src/process-manager.ts` | `run()` を「mode に応じて `spawn` 版と herdr 版へ振り分ける」薄いディスパッチにする。タスク台帳（`tasks` / `isRunning` / `isWorkerAtCapacity`）とテーブル描画は両モードで共有する |
| `src/workers/issue-worker.ts` / `pr-worker.ts` | `run()` 呼び出しは維持（振り分けは `process-manager.ts` 側に閉じる）。TUI 用引数の組み立てを `src/claude-args.ts` のヘルパーに集約する |
| `src/claude-args.ts` | `buildClaudeArgs({ mode, command, number, model, effort })` を追加し、`-p` の有無と `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` の要否を吸収。`SUBAGENT_SYSTEM_PROMPT` を `SYSTEM_PROMPT` へ統合し（`--append-subagent-system-prompt` は両モードで廃止）、文面を実行形態非依存に改訂 |
| `src/commands/init.ts` | 生成する設定ファイル名・案内文を `config.json` に更新（`projects.json` を生成している場合） |
| `CLAUDE.md` / `README.md` | `config.json`・`mode`・ワークスペース分離・herdr モードの記述を追加 |

**herdr モードの処理フロー**

```
worker tick（Issue/PR 検出）
   │
   ├─ ラベル遷移（cc-in-progress 付与）
   ├─ worktree 作成
   │
   ├─ herdr agent start claude --workspace <ws> --cwd <worktree>
   │      --env HERDR_DISABLE_SOUND=1 --no-focus -- claude "<skill> <n>" ...
   │        → pane_id
   ├─ herdr pane move <pane_id> --new-tab --label ctw:<project>:#<n>
   │        → tab_id
   │
   ├─ 監視ループ（herdr wait agent-status <pane_id>）
   │      unknown → working → idle  ⇒ 完了
   │      pane_not_found            ⇒ 失敗
   │      blocked                   ⇒ 警告して待機継続
   │
   ├─ herdr pane read <pane_id> --source recent   （出力回収）
   ├─ 完了コールバック（ラベル遷移・onCompleted 検証・Slack 通知・worktree 削除）
   └─ ctrl+c 送信 → herdr tab close <tab_id>
```

**herdr の実インターフェース（2026-07-19 時点で動作確認済み）**

```
herdr workspace create [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--no-focus]
herdr workspace list | close <workspace_id> | rename <workspace_id> <label>
herdr tab create [--workspace <workspace_id>] [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--no-focus]
herdr tab rename <tab_id> <label> | close <tab_id>
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down] [--env KEY=VALUE] [--no-focus] -- <argv...>
herdr agent list | get <target> | wait <target> --status <idle|working|blocked|unknown> [--timeout MS]
herdr pane move <pane_id> --new-tab [--workspace ID] [--label TEXT] [--no-focus]
herdr pane read <pane_id> [--source visible|recent|recent-unwrapped] [--lines N]
herdr pane send-keys <pane_id> <key> [key ...]
herdr wait agent-status <pane_id> --status <idle|working|blocked|done|unknown> [--timeout MS]
```

レスポンス例（抜粋）:

```json
// workspace create
{"result":{"root_pane":{"pane_id":"wD:p1","tab_id":"wD:t1","workspace_id":"wD"},
           "tab":{"tab_id":"wD:t1","label":"1"},
           "workspace":{"workspace_id":"wD","label":"ctw-probe"},"type":"workspace_created"}}

// agent start
{"result":{"agent":{"name":"probe","pane_id":"wD:p3","tab_id":"wD:t1","workspace_id":"wD"},
           "argv":["sh","-c","sleep 45"],"type":"agent_started"}}

// pane move --new-tab
{"result":{"move_result":{"created_tab":{"tab_id":"wD:t3","label":"ctw:probe:#456"},
           "pane":{"pane_id":"wD:p4","tab_id":"wD:t3"}}}}

// agent list（agent_status を保持している）
{"result":{"agents":[{"agent":"claude","agent_status":"working","pane_id":"w7:p2",
           "tab_id":"w7:t1","workspace_id":"w7","cwd":"..."}]}}
```

確認できた挙動:

- `agent start` で起動したプロセスが終了するとペインは自動的に消える（以後 `pane get` は `pane_not_found`）
- `agent start` は `--workspace` / `--tab` 指定先の**既存タブに split で入る**ため、専用タブが欲しい場合は `pane move --new-tab` が必要
- `workspace close` はワークスペース内の全タブごと閉じる

## 7. スコープ外

- herdr 以外のターミナルマルチプレクサ（tmux 等）での TUI 実行
- プロジェクトごと・ワーカーごとの `mode` 上書き（本リリースはトップレベル一括のみ）
- herdr モードでのタスク実行時間の上限設定（現行方針どおり上限なし）
- TUI セッションのログをファイルへ永続化する仕組み（タブを閉じると出力は失われる。通知に含める末尾 N 行のみ保持）
- `config.json` の CRUD コマンド（`claude-task-worker config set` 等）— 引き続き手動編集
- 実行中タスクへの人からの介入（追加指示の送信）を CLI 側から支援する機能（herdr のペインで直接行う）

## 8. 確認事項

1. **`--append-subagent-system-prompt` の TUI での有効性**: このフラグは Claude Code v2.1.205+ の `-p` 非対話モード限定とされている（手元の v2.1.215 の `claude --help` にも記載がない）。TUI 起動時に無視される場合、herdr モードではサブエージェントへの自律実行原則の注入手段が失われる。
   → **決定: `--append-subagent-system-prompt` を廃止し、`SUBAGENT_SYSTEM_PROMPT` の内容を `--append-system-prompt`（`SYSTEM_PROMPT`）へ統合する。両モード共通とし、mode による引数分岐を `-p` の有無と print 専用環境変数だけに閉じる**（§4.4）。サブエージェントへの伝達はメインエージェントの委譲プロンプト経由になるため、`mode: "default"` では注入の確実性がやや下がるトレードオフを受け入れる。
2. **`mode` の粒度**: 「プロジェクト A だけ herdr モード」のような使い分けの需要があるか。ある場合は `projects` の値をオブジェクト形式（`{"path": "...", "mode": "herdr"}`）へ拡張する必要があり、既存の文字列形式との共存が必要になる。
   → **決定: トップレベル一括のみとする。プロジェクト別上書きは実装しない**（§4.2、§7 スコープ外）。
3. **モジュール名**: `src/projects-config.ts` を `src/user-config.ts` へリネームするか、ファイル名は据え置いて中身だけ `config.json` 対応にするか。リポジトリローカルの `src/config.ts`（`claude-task-worker.json`）と紛らわしいため、本 PRD はリネームを推奨としている。
4. **`projects.json` フォールバックの寿命**: 何バージョン残すか。
   → **決定: フォールバックは実装しない**。単一ユーザー運用で移行対象が1ファイルのみのため、`config.json` へリネームして完了とする（§4.1）。
5. **タスクタブの並び順・数の上限**: `maxConcurrentTasks` × ワーカー種別の数だけタブが同時に開きうる（`yolo` では最大10ワーカー）。タブが増えすぎる場合、ワーカー種別ごとにタブをまとめる（1タブ内で split する）案も考えられる。
6. **`blocked` の扱い**: 無人運用では永久に詰まる可能性がある。一定時間 `blocked` が続いたら失敗扱いにしてタブを閉じる方が良いか。
   → **決定: 人が確認する前提とし、待機を継続する（自動失敗にはしない）**。herdr モードはそもそも人が覗いて介入できることが利点であり、`blocked` はその介入ポイントとして扱う。ステータステーブルに `blocked` を表示して気づけるようにする（§4.5）。
7. **出力回収の行数**: `pane read --source recent --lines N` の N をいくつにするか（Slack 通知の可読性と情報量のバランス）。

## 9. 受け入れ基準

**設定ファイル**

- [ ] `~/.config/claude-task-worker/config.json` が読み込まれ、`--project` ディスパッチが従来どおり動作する
- [ ] `config.json` が存在しない状態で `--project` を指定するとエラー終了する
- [ ] `mode` 未指定・不正値の場合は `"default"` にフォールバックする（不正値では警告が出る）

**ワークスペース分離**

- [ ] `--project all` で、プロジェクトごとに `ctw:<プロジェクト名>` ラベルの herdr ワークスペースが作られる
- [ ] 各ワークスペースの root pane でワーカーが起動し、起動確認・再送のガードが従来どおり機能する
- [ ] 同名ラベルのワークスペースが既に存在するプロジェクトはスキップされ、警告が出る
- [ ] ワーカーが自然終了すると、対応するワークスペースが閉じられ一覧から消える
- [ ] Ctrl-C で全ワーカーが graceful shutdown され、作成された全ワークスペースが閉じられる

**herdr モード**

- [ ] `"mode": "herdr"` のとき、タスクが `claude -p` ではなく herdr タブ内の TUI セッションとして起動される
- [ ] タスクのタブ名が `ctw:<プロジェクト名>:#<番号>` になる
- [ ] タスクのタブが、そのプロジェクトのワークスペース内に作られる（`--project` 経由で起動した場合）
- [ ] タスクのペインで `HERDR_DISABLE_SOUND=1` が設定されている
- [ ] タスク完了（`working` → `idle`）が検知され、ラベル遷移・`onCompleted` 検証・Slack 通知・worktree 削除が `mode: "default"` と同一の順序で実行される
- [ ] 完了後にタスクのタブが自動的に閉じられる
- [ ] ペイン消失（`pane_not_found`）が失敗として扱われ、失敗通知が送られる
- [ ] ペイン内容が空のまま完了した場合、空振りとして失敗扱いになる
- [ ] ワーカーを Ctrl-C で停止すると、実行中のタスクタブがすべて閉じられる
- [ ] `mode: "herdr"` で herdr が未インストール・未起動の場合、起動時にエラー終了する

**回帰**

- [ ] `mode` 未設定（または `"default"`）時のタスク実行が現行と同一である（`claude -p` の引数・環境変数・完了判定・通知）。ただし `--append-subagent-system-prompt` は両モードで廃止され、内容は `--append-system-prompt` に統合されている
- [ ] `--project` 未指定時の既存動作に変更がない
