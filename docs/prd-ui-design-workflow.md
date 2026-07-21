# PRD: UI実装Issueに対する Pencil デザイン先行ワークフロー

- ステータス: Draft
- 作成日: 2026-07-21
- 対象リポジトリ: getty104/claude-task-worker
- 関連 PRD: [prd-herdr-mode.md](./prd-herdr-mode.md) / [prd-multi-project-dispatch.md](./prd-multi-project-dispatch.md)

## 1. 背景・目的

現在のワーカーフローでは、Issue のトリアージ（`triage-created-issue`）が着手可能と判断すると `cc-exec-issue` が付き、`exec-issue` がそのまま実装 PR を作る。UI 実装タスクの場合、この経路には次の問題がある。

1. **デザインの根拠がないまま実装される**: `exec-issue` は Issue の description のみを入力に UI を組み立てるため、レイアウト・情報設計・状態バリエーションが実装者（AI）の即興判断になる。レビューで初めて「そもそもこの画面構成でよいのか」という議論が起き、実装をやり直すことになる。
2. **デザインの成果物がリポジトリに残らない**: 本リポジトリのプラグインには Pencil（`.pen`）を扱うスキル（`edit-pencil-design` / `inspect-pencil-node` / `resolve-pencil-conflict`）とエージェント（`pencil-design-updater` / `frontend-implementer`）が既に揃っているが、**ワーカーのフローからは一度も呼ばれない**。デザインは人が手動で作った場合のみ存在し、Issue とのひも付けも手作業になっている。
3. **デザインの合意点が実装セッションに届かない**: 仮に `.pen` が存在しても、Issue の description に参照が書かれていなければ `exec-issue` はそれを見ない（実行担当は description を唯一の入力として作業する設計のため）。

本アップデートでは、**UI 実装タスクと判定された Issue について、実装の前に Pencil でデザインを作り、それを独立した PR としてマージし、マージ後に元 Issue の description へデザイン参照を追記してから実装へ進む**フローを追加する。

### 解決する課題

- UI の見た目・構成が、実装 PR とは別に **デザイン PR 単体でレビュー・合意**できる（`.pen` + スナップショット PNG が差分に載る）
- 合意済みデザインがリポジトリに永続化され、以降の実装・改修が同じ `.pen` を参照できる
- description にデザイン参照が明記されるため、`exec-issue` セッションが確実にデザインを入力として実装できる（`frontend-implementer` エージェントへの委譲導線も既存のまま使える）
- デザイン PR のマージは既存の `triage-pr` / `fix-review-point` / `resolve-conflict` の PR ワーカー群にそのまま乗る（新しいマージ機構を作らない）

## 2. 用語

| 用語 | 意味 |
|------|------|
| UI 実装タスク | 画面・コンポーネントの新規追加や見た目の変更を伴う Issue。判定基準は 4.2 |
| デザインタスク | UI 実装タスクの前段として `.pen` を作成・更新するタスク |
| デザイン PR | デザインタスクが作る PR。変更内容は `.pen` とスナップショット PNG に限定される |
| デザインブランチ | デザイン PR の head ブランチ。`cc-ui-design-<Issue番号>` の固定命名 |
| 実装 Issue | 元の UI 実装タスクの Issue。デザイン PR のマージ後に `cc-exec-issue` へ進む |
| デザイン参照セクション | 実装 Issue の description 末尾に追記される `## UIデザイン` セクション（4.5） |

## 3. ユーザーストーリー

1. 開発者として、UI 実装 Issue を起票したら、実装が始まる前に Pencil デザインが自動で作られ、デザインだけを見て「この画面構成でよいか」をレビューしたい。
2. 開発者として、デザイン PR は普段の PR と同じフロー（`cc-triage-scope` → `triage-pr`）でレビュー・マージされてほしい。専用の承認手段を覚えたくない。
3. 開発者として、デザイン PR がマージされたら、元の Issue の description に「このデザインを参照して実装すること」と `.pen` のパスが自動で書かれ、そのまま `exec-issue` に流れてほしい。
4. 開発者として、UI を伴わない Issue（バックエンド修正・リファクタなど）ではこれまでどおり直接 `cc-exec-issue` に進んでほしい。
5. 開発者として、Pencil を使っていないリポジトリでは本フローが一切動かないでほしい（オプトイン）。
6. 開発者として、デザインが気に入らない場合は、デザイン PR にレビューコメントを書けば `fix-review-point` で修正され、マージ後に実装へ進んでほしい。
7. 開発者として、デザインが不要と後から判明した場合や、Pencil が使えない環境の場合に、フローが無限ループせず人の確認（`cc-need-human-check`）で止まってほしい。

## 4. 機能要件

### 4.1 全体フロー

```
cc-triage-scope
  → create-issue（分析）
  → cc-issue-created + triage-created-issue（ルーティング）
        ├─ UI実装タスクでない → cc-exec-issue（従来どおり）
        └─ UI実装タスク       → cc-create-ui-design            ★新規
              → create-ui-design ワーカー                       ★新規
                 ・.pen を作成/更新 + snapshots/ に PNG 出力
                 ・ブランチ cc-ui-design-<N> を push しデザインPRを作成
                 ・PR に cc-triage-scope（+ cc-ui-design）を付与
                 ・Issue に cc-ui-design-pr-created を付与
              → triage-pr / fix-review-point / resolve-conflict（既存）
                 ・デザインPRをレビューしてマージ
              → apply-ui-design ワーカー                        ★新規
                 ・preflight: デザインPRがMERGEDになるまで skip
                 ・Issue description に「## UIデザイン」を追記
                 ・cc-ui-design-ready + cc-exec-issue を付与
              → exec-issue（既存。デザインを参照して実装）
```

### 4.2 UI 実装タスクの判定（`triage-created-issue` スキルの拡張）

判定は既存のトリアージスキルに**パターン E-1**として追加する。評価順は パターン A（人の確認）→ B（クローズ）→ C（確認事項）→ D（description 反映）→ **E-1（UIデザイン要否）** → E（`cc-exec-issue`）とし、E-1 に該当した場合は `cc-exec-issue` を付けずに `cc-create-ui-design` のみを付与して終了する。

**前提ゲート（すべて満たす場合のみ E-1 を評価する）**

1. リポジトリ直下の `claude-task-worker.json` に `uiDesign.enabled === true` がある（4.6）
2. Issue に `cc-ui-design-ready` / `cc-ui-design-pr-created` / `cc-create-ui-design` のいずれも付いていない（デザイン済み・進行中の再デザイン防止）
3. description にデザイン参照セクション（`## UIデザイン`）が存在しない

**UI 実装タスクと判定する基準**（いずれかに該当）

- 画面・ページ・モーダル・フォーム等の**新規追加**
- 既存画面のレイアウト・情報設計・視覚表現の**変更**（要素の追加/削除/並び替え、状態表示の追加など）
- 再利用コンポーネントの新規作成、および見た目に影響する変更

**UI 実装タスクと判定しない基準**（該当すれば従来どおりパターン E）

- サーバーサイド・データモデル・バッチ・CI・ドキュメント・テストのみの変更
- 文言の差し替えのみ、ログ・計測の追加のみなど、レイアウトに影響しない微修正
- description が既に十分に具体的な UI 仕様（対象コンポーネント・配置・状態）を持ち、デザイン検討の余地がないと判断できる場合
- リポジトリにフロントエンド実装が存在しない

判定が割れる場合は**デザインを作らない側（パターン E）に倒す**。誤ってデザイン PR を挟むと、UI を伴わない Issue のリードタイムが 1 PR 分伸びるため。判定理由は Issue にコメントとして残す（人が事後に判断を追えるようにする）。

**手動オプトイン/オプトアウト**: 人が `cc-create-ui-design` を直接付ければトリアージ判定を経ずにデザインフローへ入れる。逆に `cc-ui-design-ready` を手で付ければ E-1 はスキップされる。

### 4.3 `create-ui-design` ワーカー（新規）

`createIssuePollingWorker` を使う Issue ワーカー。

| 項目 | 値 |
|------|-----|
| ワーカー名 | `create-ui-design` |
| トリガーラベル | `cc-create-ui-design` |
| 除外ラベル | `cc-ui-design-pr-created`, `cc-ui-design-ready`（基盤が付ける `cc-in-progress` / `cc-need-human-check` に加えて） |
| 起動スキル | `/claude-task-worker:create-ui-design`（新規スキル） |
| model / effort | `sonnet` / `high`（既定。`claude-task-worker.json` で上書き可） |
| ポーリング間隔 | 60 秒 |

**worktree のベースブランチ**

Issue が sub-issue（`parent` あり）の場合、実装 PR のベースは `cc-epic-<親Issue番号>` になる。**epic ブランチは作成時点の default ブランチから派生したきりで、その後の default ブランチへのマージは自動では取り込まれない**（`ensureEpicBranch()` は remote に epic ブランチがあればそのまま使う）。したがってデザイン PR のベースも実装と同じブランチに合わせる必要がある。

- `parent` なし → ベース = default ブランチ
- `parent` あり → ベース = `cc-epic-<親Issue番号>`（`ensureEpicBranch()` で用意する）

これは既存の `issue-worker.ts` のベース決定ロジックと同一のため、追加実装は不要（同じ経路を通る）。

**デザインブランチ**

`.pen` の変更は worktree のランダム名ブランチ（`adj-noun-4桁`）ではなく、**`cc-ui-design-<Issue番号>` の固定名ブランチ**へ push する。後段の `apply-ui-design` ワーカーがデザイン PR を head ref から一意に特定できるようにするため（`cc-epic-<N>` と同じ考え方）。ブランチの作成・push はスキル側が worktree 内で行う。

**スキルの責務（`/claude-task-worker:create-ui-design <Issue番号>`）**

1. 前提確認: `pencil version` / `pencil status`。未インストール・未認証ならデザインを作らず、Issue に理由をコメントして `cc-need-human-check` を付与し終了する
2. Issue の description・コメント履歴からデザイン要件（対象画面、要素、状態バリエーション、既存デザインとの関係）を抽出する
3. 既存デザインの調査: `uiDesign.designDir`（既定 `designs/`）配下の `.pen` を列挙し、対象画面に対応する既存ファイルがあれば**新規作成ではなく更新**する（`inspect-pencil-node` スキルで現状構造を把握する）
4. デザインの作成・更新は `pencil-design-updater` エージェント経由で `edit-pencil-design` スキルを使う（`.pen` は暗号化バイナリのため直接編集は禁止）
   - 新規: `<designDir>/<Issue番号>-<kebab-slug>.pen`
   - 更新: 既存パスをそのまま上書き
5. 編集・作成した Node のスクリーンショットを `<designDir>/snapshots/` に PNG 出力する（`edit-pencil-design` の既定挙動）
6. `git switch -c cc-ui-design-<Issue番号>` でデザインブランチを作り、`.pen` と PNG のみをコミット・push する（実装コードは含めない）
7. `gh pr create` でデザイン PR を作成する。PR body には次を含める:
   - 対象 Issue への**非 closing 参照**（`Refs #<N>`。`Closes` / `Fixes` は**禁止**。デザイン PR のマージで実装 Issue が閉じてしまうため）
   - デザインの意図・主要な構成・状態バリエーションの説明
   - スナップショット PNG の参照
8. PR 作成の成否を `gh pr list --head cc-ui-design-<N> --state open` で検証し、結果を報告して終了する

**デザイン不要と判明した場合**: ステップ 2 の段階で「UI 変更を伴わない」と判断した場合は、デザインを作らずに Issue へ理由をコメントし、`cc-ui-design-ready`（再デザイン抑止マーカー）と `cc-exec-issue` を付与して終了する（人手を介さず実装へ復帰させる）。

**`onCompleted`（ワーカーレベルの完了検証）**

`claude -p` の exit 0 は成果物を保証しないため、既存ワーカーと同じ最後の砦を置く。

1. `cc-need-human-check` が付いていれば何もせず `false` を返す（失敗通知）
2. `cc-ui-design-ready` が付いていれば「デザイン不要パス」として完了扱い（`true`）
3. `findPrNumberByHeadRef("cc-ui-design-<N>", "all")` でデザイン PR の実在を確認
   - 実在する → PR に `cc-triage-scope`（`triage-pr` への投入）と `cc-ui-design`（デザイン PR のマーカー）を付与し、Issue に `cc-ui-design-pr-created` を付与
   - 実在しない → Issue に `cc-need-human-check` を付与し、状況コメント（`epicPrMissingComment()` と同型）を投稿して `false` を返す

### 4.4 デザイン PR のレビュー・マージ（既存フローの再利用）

デザイン PR は新しい機構を作らず、既存の PR ワーカー群に乗せる。

- `triage-pr`（トリガー `cc-triage-scope`）がレビュー・CI 確認のうえマージする
- 指摘があれば `cc-fix-onetime` → `fix-review-point` が修正する
- コンフリクトは `cc-resolve-conflict` → `resolve-pr-conflict` が解消する。`.pen` のコンフリクトは同スキルが `resolve-pencil-conflict` へ委譲する既存の分岐がそのまま効く
- デザイン PR は Epic PR ではないため `cc-epic-issue` は付けない（`cc-release-ready` によるマージ保留の対象外＝通常どおりマージされる）

`triage-pr` スキルには、`cc-ui-design` ラベル付き PR に対するレビュー観点を追記する（コードレビューの観点をそのまま適用しても意味がないため）:

- 差分が `.pen` とスナップショット PNG に限定されているか（実装コードが混入していないか）
- スナップショットが差分に含まれ、デザイン意図が PR body から読み取れるか
- Issue の要件（対象画面・要素・状態）を満たしているか

### 4.5 `apply-ui-design` ワーカー（新規）

デザイン PR のマージを待って、実装 Issue の description にデザイン参照を書き戻すワーカー。

| 項目 | 値 |
|------|-----|
| ワーカー名 | `apply-ui-design` |
| トリガーラベル | `cc-ui-design-pr-created` |
| 除外ラベル | `cc-ui-design-ready`, `cc-exec-issue` |
| 起動スキル | `/claude-task-worker:apply-ui-design`（新規スキル） |
| model / effort | `sonnet` / `high` |
| ポーリング間隔 | 60 秒 |

**`preflight`（既存の `PreflightResult` を使用）**

`cc-ui-design-<N>` を head とする PR の状態を取得して分岐する。

| デザイン PR の状態 | 判定 |
|---|---|
| `MERGED` | `proceed`（description の更新へ進む） |
| `OPEN` | `skip`（レビュー・マージ待ち。次のポーリングで再評価） |
| `CLOSED`（未マージ） | Issue に `cc-need-human-check` と理由コメントを付けたうえで `skip`。デザインが却下された場合は人が方針を決める |
| PR が見つからない | 同上（`cc-need-human-check` + `skip`） |

`cc-need-human-check` は `issue-worker.ts` の共通除外ラベルに含まれるため、付与後は候補に上がらず無限リトライしない。

**スキルの責務（`/claude-task-worker:apply-ui-design <Issue番号>`）**

1. デザイン PR（`cc-ui-design-<N>`）の情報とマージ済みの `.pen` / スナップショットのパスを取得する
2. Issue の description 末尾にデザイン参照セクションを追記する（既存本文は保持し、既にセクションがある場合は置換する）:

   ```markdown
   ## UIデザイン

   本Issueの実装は、以下のUIデザインを**参照元**として行うこと。デザインと異なる実装が必要になった場合は、実装を進める前にIssueにコメントで理由を残すこと。

   - デザインファイル: `designs/<N>-<slug>.pen`
   - スナップショット: `designs/snapshots/<node>.png`
   - デザインPR: #<デザインPR番号>（マージ済み）

   ### 実装時の進め方

   1. `.pen` は暗号化バイナリのため直接読まない。`inspect-pencil-node` スキルで対象Nodeの構造・スタイルを取得する
   2. UIの実装は `frontend-implementer` エージェントに委譲し、上記デザインを参照元として実装する
   3. デザイン側の修正が必要になった場合は `.pen` を実装PRで直接編集せず、Issueにコメントを残す
   ```

   description の更新は、`triage-created-issue` の carve-out 手順と同じロスト・アップデート対策を踏襲する（`mktemp` で一意な一時ファイル、`gh issue edit` 直前に本文を再取得して差分を検証）
3. 更新結果を報告して終了する（ラベル操作はワーカー側が行う）

**`onCompleted`**

1. Issue の description を再取得し、`## UIデザイン` セクションと `.pen` パスが含まれることを検証する
2. 検証できた → `cc-ui-design-ready` と `cc-exec-issue` を付与する（トリガーラベル `cc-ui-design-pr-created` の除去は基盤が行う）
3. 検証できない → `cc-need-human-check` を付与し状況コメントを投稿して `false` を返す

### 4.6 リポジトリ設定（`claude-task-worker.json`）

Pencil を使っていないリポジトリで勝手にデザイン PR が作られないよう、**オプトイン**にする。

```json
{
  "uiDesign": {
    "enabled": true,
    "designDir": "designs"
  }
}
```

| キー | 既定値 | 意味 |
|---|---|---|
| `uiDesign.enabled` | `false` | 本ワークフローの有効化。`false` の間は `triage-created-issue` が E-1 を評価せず、2つの新ワーカーも起動時にログを出してポーリングしない |
| `uiDesign.designDir` | `"designs"` | `.pen` とスナップショットの配置先（リポジトリルートからの相対パス） |

- 検証方針は既存の `parseWorkerEntry()` と同じく「不正値は警告して既定値」
- `uiDesign.enabled: false` でも、人が手動で `cc-create-ui-design` を付けた場合は動かす（明示操作を尊重する）。この判断は 8-3 の確認事項とする

### 4.7 ラベル（新規 4 種）

`src/commands/init.ts` の `LABELS` に追加する。

| ラベル | 付与対象 | 意味 |
|---|---|---|
| `cc-create-ui-design` | Issue | デザイン作成待ち（`create-ui-design` のトリガー） |
| `cc-ui-design-pr-created` | Issue | デザイン PR 作成済み・マージ待ち（`apply-ui-design` のトリガー） |
| `cc-ui-design-ready` | Issue | デザイン反映済み（再デザイン抑止マーカー。デザイン不要と判定された場合も付与） |
| `cc-ui-design` | PR | デザイン PR のマーカー（`triage-pr` のレビュー観点切り替えに使う） |

### 4.8 `exec-issue` スキルの追記

`exec-issue` スキルには既に「`.pen` を参照元とする実装は `frontend-implementer` に委譲する」旨の記述がある。ここに、description に `## UIデザイン` セクションがある場合の扱いを明記する。

- セクションがある場合、実装前に `inspect-pencil-node` で対象 Node の構造・スタイルを取得し、それを根拠に実装する
- 実装 PR で `.pen` を編集しない（デザイン変更はデザインフローへ戻す）
- デザインと実装が乖離せざるを得ない場合は、その理由を実装 PR の body に記載する

### 4.9 CLI への登録

- `src/config.ts`: `WorkerName` に `"create-ui-design"` / `"apply-ui-design"` を追加、`WORKER_DEFAULTS` にエントリを追加
- `src/index.ts`: `WORKERS` マップ、`all` / `yolo` の `Promise.all`、`printUsage()` の Workers 一覧に追加
- `all` / `yolo` の両方に含める（`triage-*` のような「暴走リスクのあるワーカー」ではなく、ラベル駆動で明示的にトリガーされるため）

## 5. スコープ外

- Figma 連携（本 PRD は Pencil のみを対象とする）
- デザインシステム・デザイントークンの自動生成
- 実装 PR とデザインの差分検証（実装後のビジュアルリグレッション）
- デザイン PR の自動マージ判断の高度化（既存 `triage-pr` の判断をそのまま使う）
- 複数画面にまたがる Issue に対するデザインの分割（1 Issue = 1 デザイン PR とする）
- `.pen` を持たないリポジトリでの代替（HTML モックなど）

## 6. 実装方針

### 6.1 新規ファイル

| ファイル | 内容 |
|---|---|
| `src/workers/create-ui-design.ts` | デザイン作成ワーカー（`createIssuePollingWorker`） |
| `src/workers/apply-ui-design.ts` | デザイン反映ワーカー（`preflight` + `onCompleted`） |
| `plugin/skills/create-ui-design/SKILL.md` | デザイン作成スキル |
| `plugin/skills/apply-ui-design/SKILL.md` | description 更新スキル |

### 6.2 既存ファイルの変更

| ファイル | 変更 |
|---|---|
| `src/config.ts` | `WorkerName` / `WORKER_DEFAULTS` / `uiDesign` 設定の読み込みと検証 |
| `src/index.ts` | ワーカー登録・`all` / `yolo`・usage |
| `src/commands/init.ts` | ラベル 4 種の追加 |
| `src/gh.ts` | デザイン PR の状態取得ヘルパー（head ref から `state` / `mergedAt` を取得する関数）、Issue 本文取得ヘルパー |
| `plugin/skills/triage-created-issue/SKILL.md` | パターン E-1 の追加 |
| `plugin/skills/triage-pr/SKILL.md` | `cc-ui-design` PR のレビュー観点 |
| `plugin/skills/exec-issue/SKILL.md` | `## UIデザイン` セクションの扱い |
| `CLAUDE.md` / `README.md` | ワーカー・ラベルフロー表の更新 |

### 6.3 既存ガードの踏襲（必須）

新スキル 2 つは**ワーカー起動スキル**であるため、既存 10 スキルと同じ扱いにする。

- フロントマターに `Stop` フック（`plugin/scripts/stop-servers.mjs`）を設定する
- 「実行モードの制約」セクションに、本スキル固有のラベル遷移リスクを記述する（自律実行原則自体は `--append-system-prompt` に一元化済みのため複製しない）
- SKILL.md のプリアンブル（`!` インライン実行）には**失敗しうるコマンドを置かない**。`pencil version` / `pencil status` の確認は本文のステップ 0 で行い、失敗時はエラー内容を含む結果報告を出して終了する（空振りセッション対策）

### 6.4 テスト

- ワーカーの `preflight` / `onCompleted` の分岐（MERGED / OPEN / CLOSED / PR なし、description 検証の成否）をユニットテストする
- `uiDesign` 設定のパース（既定値・不正値の警告）をユニットテストする
- ラベル定義の追加は `init` のスナップショット的な確認で足りる

## 7. リスクと緩和

| リスク | 緩和 |
|---|---|
| UI タスクの誤判定でデザイン PR が乱発される | 判定が割れる場合はデザインを作らない側に倒す。`uiDesign.enabled` によるオプトイン。判定理由を Issue にコメントで残す |
| デザイン PR が `Closes #N` で実装 Issue を閉じてしまう | スキルで closing keyword を禁止し、`Refs #N` のみ許可する。`onCompleted` で Issue が CLOSED になっていないことを検証する |
| デザイン PR が長期間マージされず Issue が停滞する | `apply-ui-design` の `preflight` は `skip` を返すだけで状態を壊さない。停滞は `cc-ui-design-pr-created` ラベルで可視化される。滞留時間の通知は将来課題（8-4） |
| epic 配下の Issue でデザインが実装ブランチに存在しない | デザイン PR のベースを実装と同じ（`cc-epic-<親>` または default）に揃える（4.3） |
| `.pen` のコンフリクトでリベースが破壊的になる | 既存の `resolve-pr-conflict` → `resolve-pencil-conflict` の委譲に乗せる。デザイン PR は差分が `.pen` と PNG のみのため衝突面が小さい |
| Pencil 未インストール・未認証の環境で毎ポーリング空振りする | スキルのステップ 0 で検出し `cc-need-human-check` を付与して停止する（共通除外ラベルにより再取得されない） |
| デザイン反映後に人が description を書き換え、参照が消える | `cc-ui-design-ready` はラベルとして残る。`exec-issue` 側は description のセクション有無で判断するため、消えた場合はデザインなしで実装される（許容。8-5） |

## 8. 確認事項

1. **デザインの粒度**: 1 Issue = 1 `.pen` ファイルでよいか。既存 `.pen` に画面を追記していく運用（1 プロダクト = 1 ファイル）にすると、コンフリクトと PR 差分が大きくなる一方でデザインの一貫性は保ちやすい。本 PRD は「対応する既存ファイルがあれば更新、なければ新規」としているが、既存ファイルの対応付け基準を明文化すべきか。
2. **`triage-created-issue` への統合か、独立ワーカーか**: 本 PRD は既存トリアージにパターン E-1 を足す案。代わりに `cc-issue-created` を見る独立の判定ワーカーを作る案もあるが、ラベル遷移の分岐点が 2 箇所に増えるため採用していない。この判断でよいか。
3. **`uiDesign.enabled: false` のときの手動 `cc-create-ui-design`**: 4.6 では「明示操作を尊重して動かす」としているが、設定で完全に無効化（ワーカー自体を起動しない）する方が事故が少ないという判断もありうる。どちらを採るか。
4. **デザイン PR の滞留通知**: `cc-ui-design-pr-created` のまま N 日経過した Issue を Slack に通知する仕組みを本リリースに含めるか（現状はスコープ外としている）。
5. **description からデザイン参照が消えた場合の扱い**: `cc-ui-design-ready` が付いているのにセクションが無い状態を、`exec-issue` 側で検出して `cc-need-human-check` に落とすべきか、デザインなしで実装させてよいか。
6. **デザインレビューの人間ゲート**: 本 PRD ではデザイン PR も `triage-pr` が自動マージする。UI の見た目は人の合意を要する性質が強いため、デザイン PR には `cc-release-ready` 相当の「人が明示的にマージする」ゲートを設けるべきか。設けると自動化のリードタイムは伸びるが、意図しないデザインが実装まで通り抜ける事故は防げる。
