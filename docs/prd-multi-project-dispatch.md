# PRD: マルチプロジェクトディスパッチ機能（`--project` オプション）

- ステータス: Draft
- 作成日: 2026-07-11
- 対象リポジトリ: getty104/claude-task-worker

## 1. 背景・目的

`claude-task-worker` は現在、カレントディレクトリのリポジトリを対象に GitHub Issues/PR をポーリングしてタスクを実行する。複数リポジトリでワーカーを動かしたい場合、ユーザーはリポジトリごとにターミナルを開き、各ディレクトリで個別にコマンドを起動する必要がある。

本機能は、ターミナルワークスペースマネージャー [herdr](https://github.com/) を利用して、**1コマンドで複数リポジトリの claude-task-worker を一斉起動・一元管理**できるようにする。

### 解決する課題

- リポジトリ数分のターミナル起動・`cd`・コマンド入力という手作業の繰り返しをなくす
- 複数リポジトリで動いているワーカーの稼働状況を1画面で把握できるようにする
- 一括起動したワーカー群を1回の操作（Ctrl-C）でまとめて安全に停止できるようにする

## 2. 用語

| 用語 | 意味 |
|------|------|
| ディスパッチャー | `--project` 付きで起動された claude-task-worker プロセス。ワーカーは実行せず、herdr 経由で各プロジェクトへコマンドを配送・監視する |
| ワーカーセッション | ディスパッチャーが herdr tab 内で起動した `claude-task-worker <command>` プロセス |
| projects.json | プロジェクト名 → リポジトリパスのマッピングを定義する設定ファイル |

## 3. ユーザーストーリー

1. 開発者として、`projects.json` に登録した複数リポジトリのワーカーを `claude-task-worker all --project all` の1コマンドで一斉起動したい。
2. 開発者として、特定のプロジェクトだけを `--project my-app` のように名前指定で起動したい。
3. 開発者として、ディスパッチャーの画面で「どのプロジェクトのワーカーが今動いているか」を一覧で確認したい。
4. 開発者として、herdr の Pane 内でワーカーを個別に終了した場合、ディスパッチャーの一覧から自動的に消えてほしい。
5. 開発者として、ディスパッチャーを Ctrl-C で終了したら、起動した全ワーカーが停止し、作成された herdr タブがすべて閉じられてほしい。

## 4. 機能要件

### 4.1 設定ファイル: projects.json

- パス: `$XDG_CONFIG_HOME/claude-task-worker/projects.json`（`XDG_CONFIG_HOME` 未設定時は `~/.config/claude-task-worker/projects.json`）
- 形式: `projects`（プロジェクト名 → リポジトリ絶対パス）と `projectGroups`（グループ名 → プロジェクト名の配列）の2セクションを持つ JSON オブジェクト

```json
{
  "projects": {
    "my-app": "/Users/getty104/programming/my-app",
    "time-card": "/Users/getty104/programming/IGSA/time-card"
  },
  "projectGroups": {
    "igsa": ["time-card"],
    "all-mine": ["my-app", "time-card"]
  }
}
```

- `projects`: プロジェクト名をキー、リポジトリの絶対パスを値とするフラットなオブジェクト（必須）
- `projectGroups`: グループ名をキー、そのグループに含める**プロジェクト名の配列**を値とするオブジェクト（任意。省略・空でも可）

バリデーション:

- `projects` の値が絶対パスでない、またはディレクトリとして存在しない場合はエラーメッセージを出して該当エントリの起動をスキップする（他のプロジェクトの起動は継続する）
- `projectGroups` の配列要素が `projects` に存在しないプロジェクト名を参照している場合はエラーメッセージを出し、その参照をスキップする（他は継続する）
- **名前空間の一意性**: `projects` のキーと `projectGroups` のキーは同一の名前空間として扱い、両者にまたがって重複するキーがあってはならない。重複がある場合はエラー終了する
- **予約語 `all`**: `projects` / `projectGroups` のいずれのキーにも `all` を定義できない。定義されている場合は起動時にエラー終了する
- ファイルが存在しない・JSON として不正な場合・`projects` セクションを欠く場合、`--project` 指定時はエラー終了する（`--project` 未指定の従来動作には一切影響しない）
- 既存の `claude-task-worker.json`（cwd 直下・ワーカー設定）とは独立したファイルとする。ワーカーごとの設定は従来どおり各リポジトリ側の `claude-task-worker.json` が使われる

### 4.2 CLI インターフェース: `--project` オプション

```
claude-task-worker <command> [--project <projectName>] [既存オプション...]
```

- `--project <name>`: projects.json の `projects` に定義された**プロジェクト名**、または `projectGroups` に定義された**グループ名**を指定する
  - **グループ名を指定した場合**、そのグループに含まれる全プロジェクトを対象に展開する
  - 繰り返し指定可能（`--epic` / `--label` と同じ collectFlagValues パターン）。複数指定時は指定された全プロジェクト／グループを対象とする（プロジェクト名とグループ名は混在指定できる）
  - 複数の指定によって同一プロジェクトが重複した場合は一意化する（同じプロジェクトを二重起動しない）
  - `--project all` を指定した場合、`projects` に定義された**全プロジェクト**を対象とする（`all` は予約語。projects.json のいずれのキーにも `all` を定義できず、定義時は起動時にエラーとする）
- 未定義の名前（`projects` にも `projectGroups` にも一致しない）が指定された場合は、利用可能なプロジェクト名・グループ名の一覧を表示してエラー終了する
- `--project` と組み合わせ可能なコマンドはワーカー系コマンドのみ（`exec-issue` / `fix-review-point` / `create-issue` / `update-issue` / `answer-issue-questions` / `triage-created-issue` / `triage-pr` / `resolve-conflict` / `check-dependabot` / `epic-issue` / `all` / `yolo`）。`init` / `install` / `update` / `usage` / `version` と組み合わせた場合はエラー終了する
- `--epic` / `--label` は `--project` と併用可能とし、各ワーカーセッションへそのまま引き継ぐ

使用例:

```bash
claude-task-worker all --project all
claude-task-worker all --project my-app --project time-card
claude-task-worker all --project igsa            # グループ igsa に含まれる全プロジェクト
claude-task-worker exec-issue --project my-app --epic 100
```

### 4.3 ディスパッチ処理（herdr 連携）

`--project` 指定時、ディスパッチャーは対象プロジェクトごとに以下を実行する:

1. **タブ作成**: `herdr tab create --label <projectName> --cwd <リポジトリパス> --no-focus`
   - レスポンス JSON の `result.root_pane.pane_id` と `result.tab.tab_id` を保持する
2. **コマンド送信**: 取得した `pane_id` に対して `herdr pane send-text <pane_id> <command>` でワーカー起動コマンドを送信し、続けて `herdr pane send-keys <pane_id> enter` で実行する
   - 送信するコマンドは、ディスパッチャー自身が受け取った引数から `--project <value>` の組だけを取り除いたもの（例: `claude-task-worker all --epic 100`）
   - シェルエスケープが必要な引数（ラベル名のスペース等）は適切にクォートする

herdr の実インターフェース（確認済み・2026-07-11 時点）:

```
herdr tab create [--workspace <workspace_id>] [--cwd PATH] [--label TEXT] [--env KEY=VALUE] [--focus] [--no-focus]
herdr tab close <tab_id>
herdr tab get <tab_id>
herdr pane send-text <pane_id> <text>
herdr pane send-keys <pane_id> <key> [key ...]
herdr pane process-info [--pane ID]
```

`herdr tab create` のレスポンス例:

```json
{
  "id": "cli:tab:create",
  "result": {
    "root_pane": { "pane_id": "w7:p6", "tab_id": "w7:t4", "cwd": "/private/tmp", "...": "..." },
    "tab": { "tab_id": "w7:t4", "label": "my-app", "...": "..." },
    "type": "tab_created"
  }
}
```

エラー時は `{"error":{"code":"...","message":"..."},"id":"..."}` 形式の JSON が返る。`error` キーの有無で成否を判定する。

前提条件チェック:

- ディスパッチ開始前に herdr サーバーの疎通を確認する（例: `herdr tab list` の成否）。herdr が未インストール・サーバー未起動の場合は、インストール/起動方法を案内するエラーメッセージを出して終了する

### 4.4 稼働ワーカーの一覧表示

- ディスパッチャーは、起動した全ワーカーセッションを一覧表示し続ける（既存 `process-manager.ts` のリアルタイムステータステーブルと同様の体験）
- 表示項目（案）:

```
┌──────────────┬──────────┬─────────┬──────────┬────────────┐
│ Project      │ Tab      │ Pane    │ Status   │ Uptime     │
├──────────────┼──────────┼─────────┼──────────┼────────────┤
│ my-app       │ w7:t4    │ w7:p6   │ running  │ 00:12:34   │
│ time-card    │ w7:t5    │ w7:p7   │ running  │ 00:12:30   │
└──────────────┴──────────┴─────────┴──────────┴────────────┘
```

- **生存監視**: 一定間隔（デフォルト 5〜10 秒程度）で各 pane を `herdr pane process-info --pane <pane_id>` によりポーリングし、`foreground_processes` に claude-task-worker（node）プロセスが存在するかで稼働状態を判定する
  - ワーカーが Pane 内で終了した（フォアグラウンドがシェルに戻った）場合: そのワーカーを一覧から削除し、対応するタブを `herdr tab close <tab_id>` で閉じる（→ 確認事項 8-1）
  - Pane/タブがユーザー操作で閉じられていた場合（`pane_not_found` 等のエラー）: 一覧から削除する
- 全ワーカーが一覧から消えた場合、ディスパッチャーは正常終了する

### 4.5 シャットダウン処理

ディスパッチャーが SIGINT / SIGTERM を受けた場合:

1. 生存中の全ワーカーセッションに対し、`herdr pane send-keys <pane_id> ctrl-c` を送信してワーカーの graceful shutdown（既存挙動: 新規タスク停止→実行中タスク完了待ち）を開始する
2. 各 pane の process-info をポーリングし、ワーカープロセスの終了を待つ（タイムアウト付き。デフォルト案: 10 分）
3. タイムアウトした場合は Ctrl-C を再送して強制終了（既存の 2 回 Ctrl-C = force kill 挙動）を促し、さらに待機する
4. 全ワーカー終了後（またはタイムアウト後）、作成した全タブを `herdr tab close <tab_id>` で削除する
5. ディスパッチャー自身が終了する

ディスパッチャーが SIGKILL 等で即死した場合はタブのクリーンアップは実行できない。次回 `--project` 起動時に、同名ラベルの残存タブを検出した場合の扱いは確認事項とする（→ 確認事項 8-2）。

### 4.6 重複起動の防止

- 同一プロジェクトに対する多重ディスパッチを防ぐため、タブ作成前に `herdr tab list` を確認し、同じラベル（プロジェクト名）のタブが既に存在する場合は該当プロジェクトの起動をスキップして警告を表示する

## 5. 非機能要件

- herdr の各 CLI 呼び出しは JSON レスポンスをパースして成否判定し、失敗時は `[dispatcher]` プレフィックス付きでログ出力する（既存のログ規約に準拠）
- 1プロジェクトの起動失敗が他プロジェクトの起動・監視を妨げない（既存の「エラーは try-catch でログ出力し、クラッシュせず継続」規約に準拠）
- ポーリング間隔・シャットダウンタイムアウトは定数として切り出し、将来的に設定可能にできる構造にする

## 6. 実装方針（案）

既存アーキテクチャへの影響を最小化するため、以下のモジュール構成とする:

| ファイル | 役割 |
|----------|------|
| `src/herdr.ts` | herdr CLI ラッパー（`gh.ts` と同パターン）。`tabCreate` / `tabClose` / `tabList` / `paneSendText` / `paneSendKeys` / `paneProcessInfo` を提供し、JSON パース・エラー判定を集約 |
| `src/projects-config.ts` | `projects.json`（`projects` / `projectGroups`）のロード・バリデーション・対象プロジェクト解決（グループ展開・`all` 展開）。`config.ts` の loadConfig と同パターン |
| `src/dispatcher.ts` | ディスパッチ本体。タブ作成→コマンド送信→生存監視→一覧表示→シャットダウンのライフサイクル管理 |
| `src/index.ts` | `--project` フラグのパース。指定時はワーカー起動の代わりに dispatcher を起動する分岐を追加 |

処理フロー:

```
claude-task-worker all --project all
        │
        ├─ projects.json ロード・対象プロジェクト解決
        ├─ herdr 疎通確認・既存タブ重複チェック
        │
        ├─ for each project:
        │    herdr tab create --label <name> --cwd <path> --no-focus
        │      → pane_id, tab_id を記録
        │    herdr pane send-text <pane_id> "claude-task-worker all"
        │    herdr pane send-keys <pane_id> enter
        │
        ├─ 監視ループ（一覧表示 + pane process-info ポーリング）
        │    終了検知 → 一覧から削除・タブ close
        │    全滅 → ディスパッチャー正常終了
        │
        └─ SIGINT/SIGTERM
             → 全 pane に ctrl-c 送信 → 終了待ち → 全タブ close → exit
```

## 7. スコープ外

- herdr 以外のターミナルマルチプレクサ（tmux 等)への対応
- リモートホスト上のリポジトリへのディスパッチ（`herdr --remote`）
- projects.json の CRUD コマンド（`claude-task-worker project add` 等）— 初期リリースでは手動編集とする
- ワーカーセッションのログ集約（各 Pane で直接確認する）
- ディスパッチャー多重起動の排他制御（タブラベルの重複チェックのみで担保する）

## 8. 確認事項

1. **ワーカー自然終了時のタブの扱い**: Pane 内でワーカーが終了した場合、本 PRD ではタブも自動 close する案としたが、終了時のログを Pane に残したい場合はタブを残す（一覧からの削除のみ行う）方が良いか？
2. **残存タブの回収**: ディスパッチャーが SIGKILL で即死した場合に残るタブを、次回起動時に自動 close して作り直すか、重複警告としてスキップに留めるか？（本 PRD は後者=スキップを既定とする）
3. **`herdr pane run` の利用**: `herdr pane run <pane_id> <command>` が存在するため、`send-text` + `send-keys enter` の代替となり得る。挙動差（シェル履歴・プロンプト経由か否か）を実装時に検証し、適した方を採用する。
4. **一覧表示と既存ステータステーブルの共存**: ディスパッチャーは自身ではワーカーを実行しないため既存テーブルとは競合しない想定だが、表示実装は `process-manager.ts` のテーブル描画を共通化するか個別実装にするかを実装時に判断する。

## 9. 受け入れ基準

- [ ] `~/.config/claude-task-worker/projects.json` に定義した複数プロジェクトが `--project all` で一斉起動される
- [ ] `--project <name>` で指定プロジェクトのみ起動される（複数指定可）
- [ ] `--project <groupName>` で `projectGroups` に定義したグループに含まれる全プロジェクトが起動される（プロジェクト名との混在指定・重複の一意化を含む）
- [ ] 各プロジェクトの herdr タブが「label=プロジェクト名 / cwd=リポジトリパス」で作成される
- [ ] タブ作成レスポンスの `pane_id` に対して claude-task-worker コマンドが送信・実行される
- [ ] `--epic` / `--label` オプションがワーカーセッションへ引き継がれる
- [ ] ディスパッチャーに稼働中ワーカーの一覧が表示され、Pane 内でワーカーを終了すると一覧から消える
- [ ] ディスパッチャーを Ctrl-C で終了すると、全ワーカーが graceful shutdown され、作成された全タブが `herdr tab close` で削除される
- [ ] 未定義プロジェクト名・projects.json 不在・herdr 未起動の各ケースで適切なエラーメッセージが表示される
- [ ] `--project` 未指定時の既存動作に変更がない
