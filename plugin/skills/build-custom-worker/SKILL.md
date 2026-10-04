---
name: build-custom-worker
description: "claude-task-worker のカスタムワーカー（`workerFiles` に登録する TS 定義）を、`AskUserQuestion` で要件を全項目確定させてから生成し、`claude-task-worker list-workers` でロード検証までするスキル。「カスタムワーカーを作って」「独自のワーカーを追加したい」「新しいラベルで動くワーカーを定義したい」といったリクエストで使用する。"
argument-hint: "[作りたいワーカーの概要]"
---

# Build Custom Worker

引数で受け取った概要をもとに `AskUserQuestion` でカスタムワーカーの要件を確定させ、`claude-task-worker/lib` だけを import するワーカー定義 TS を書き出し、`list-workers` でロード検証するスキル。

**このスキルは対話専用**。ユーザーと直接やり取りするため `context: fork` は持たず、ワーカーからも自動起動しない。

**スコープ**: ワーカー定義 TS・`claude-task-worker.json` の `workerFiles` / `workers.<name>` の書き出しとロード検証まで。起動するスキル本体（`command`）の作成、ラベル作成（`labels` への追記と `apply-labels`）は行わない。

# Instructions

## 実行ステップ

### 1. 入力の把握と現状確認

依頼内容:

$ARGUMENTS

引数が空でも質問フェーズで補う。次を確認する（質問の前提になる）。

- `claude-task-worker list-workers` を実行し、既存のワーカー名（プリセット・カスタム）と、既存カスタムワーカーのファイル（`source` 列）を控える。出力は `<name> <preset|custom> <enabled|disabled> <source>` の1ワーカー1行
- リポジトリ直下の `claude-task-worker.json` を読む（無ければ `{}` 扱い）。`workerFiles` の現状を把握する

`claude-task-worker` コマンドが無い場合は、`npx claude-task-worker` で代替できる旨を伝えて中断する（検証できないまま生成しない）。

### 2. 要件の質問（全項目確定までラウンドを繰り返す）

`AskUserQuestion` で、未確定の項目だけを1回につき最大4問ずつ質問する。**全項目が確定するまで生成しない**。回答が「その他」で曖昧・矛盾する場合は、次のラウンドで同じ項目を再質問する。調べれば分かること（既存ワーカー名・既存ファイル）は質問しない。

| 項目 | 内容 | 型 |
|---|---|---|
| ワーカー型 | `issue`（Issue をポーリング）／ `pr`（PR をポーリング）／ `scheduled`（時刻だけで起動。24時間に1回） | 全て |
| ワーカー名 | `list-workers` に存在しない名前（ステップ3で検証） | 全て |
| 起動スキル（`command`） | claude に渡すスキル／コマンド（例 `/my-plugin:my-skill`）。**プラグインのスキルは `/<plugin>:<skill>` 形式** | 全て |
| トリガーラベル | issue: `triggerLabels`（配列。複数ならすべて付いている Issue が対象）／ pr: `triggerLabel`（**単数・文字列**）／ scheduled: なし | issue, pr |
| 除外ラベル | `excludeLabels`（任意）。`cc-in-progress` / `cc-need-human-check` は常に自動で除外されるので聞かない | issue, pr |
| `workers.<name>` の値 | 下表。**既定と同じ値は書かない**ので、変えたい項目だけ聞く | 全て |
| 完了時の後処理 | `onCompleted` の要否と内容（下記） | issue, pr |
| 書き出し先 | 「既存ワーカーファイルへ追記」か「新規ファイル作成」。新規ならパス | 全て |

`workers.<name>` で指定できるキーと既定値（`claude-task-worker.json` に書く。カスタムワーカーの既定は `DEFAULT_WORKER_CONFIG`）:

| キー | 既定 | 意味 |
|---|---|---|
| `skill` | `command` の値 | 起動するスキルの上書き（通常は不要） |
| `model` | `opus` | 実行モデル |
| `advisorModel` | `""`（渡さない） | `--advisor` に渡すモデル |
| `effort` | `medium` | 推論の深さ |
| `pollingIntervalSeconds` | `60` | ポーリング間隔（正の数）。scheduled では「24時間経過したかの確認頻度」 |
| `cooldownSeconds` | `0` | 前回完了からの待機（issue / pr のみ） |
| `maxConcurrentTasks` | `1` | 同時実行数（issue / pr のみ） |
| `enabled` | `true` | `false` で `all` / `yolo` から外れ、個別起動も拒否される |

型ごとの追加項目:

- **issue**: `epicFilterTarget`（通常不要）、`preflight`（起動前に `"proceed" | "skip" | "mark-pr-created"` を返す関数）は、必要な場合のみ聞く
- **pr**: `keepTriggerLabel`（GitHub 側が付ける分類ラベルをトリガーにする場合のみ `true`。使う場合は `onFinally` で `excludeLabels` のラベルを付けること）
- **scheduled**: `enabled` コールバック（`() => boolean`）は特殊条件がある場合のみ

`onCompleted` の要否は、ユーザーが「完了後にやること」を挙げた場合だけ生成する。シグネチャ:

- issue: `(issueNumber, worktreeId, output, ctx) => Promise<boolean | void>`（`false` を返すと失敗通知になる）
- pr: `(pr, output) => Promise<void>`（ほかに `onFinally: (pr) => Promise<void>`）
- scheduled: 無し

後処理の中身が `lib` の公開 API（`addLabel` / `removeLabel` / `commentOnIssue` / `commentOnPR` / `closeIssue` など）で書ける範囲に収まらない場合は、その旨を伝えて内容を絞り込む。

### 3. 名前の衝突確認

ステップ1の `list-workers` の出力と、ユーザーが決めた名前を突き合わせる。プリセット名・既存カスタム名と一致する場合は**別名を `AskUserQuestion` で再質問**する（一致しなくなるまで繰り返す）。追記先の既存ファイルに同名の定義がある場合も同様。

### 4. 生成

要件がすべて確定してから書き出す。

**ワーカー定義 TS のルール**

- import は `claude-task-worker/lib` のみ。`claude-task-worker/src/...` など内部パスは import しない（`lib` の公開 export は `createIssuePollingWorker` / `createPrPollingWorker` / `createScheduledWorker` / `defineWorker` と `gh` 操作・`run` 等のヘルパー）
- 同一ファイル内の相対 import は拡張子付き（`./helper.ts`）
- ワーカーは **named export**（または default export）で、`createIssuePollingWorker` / `createPrPollingWorker` / `createScheduledWorker` / `defineWorker` の戻り値だけがロード対象。1ファイルに複数 export してよい
- コメントは「なぜ」が自明でない場合のみ。説明コメントは入れない
- `workers.<name>` の値（model・間隔など）は TS に書かない（ステップ5）

**テンプレート**

issue:

```ts
import { createIssuePollingWorker } from "claude-task-worker/lib";

export const myWorker = createIssuePollingWorker({
  name: "my-worker",
  command: "/my-plugin:my-skill",
  triggerLabels: ["cc-my-worker"],
  excludeLabels: ["cc-my-worker-done"],
});
```

`onCompleted` ありの issue:

```ts
import { addLabel, createIssuePollingWorker } from "claude-task-worker/lib";

export const myWorker = createIssuePollingWorker({
  name: "my-worker",
  command: "/my-plugin:my-skill",
  triggerLabels: ["cc-my-worker"],
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-my-worker-done");
  },
});
```

pr（トリガーは単数 `triggerLabel`）:

```ts
import { createPrPollingWorker } from "claude-task-worker/lib";

export const myPrWorker = createPrPollingWorker({
  name: "my-pr-worker",
  command: "/my-plugin:my-pr-skill",
  triggerLabel: "cc-my-pr-worker",
});
```

scheduled（トリガーラベルなし）:

```ts
import { createScheduledWorker } from "claude-task-worker/lib";

export const myScheduledWorker = createScheduledWorker({
  name: "my-scheduled-worker",
  command: "/my-plugin:my-scheduled-skill",
});
```

`onCompleted` 内で `lib` のヘルパーを呼ぶ場合は、`src/lib.ts` の export にある関数の**実際のシグネチャ**を確認してから書く（上の `addLabel` の引数は例。推測で書かない）。

**書き出し先**

- **既存ファイルへ追記**: 既存の import に不足分だけ足し、新しい `export const` を末尾へ追加する。既存の定義には触れない。`workerFiles` は変更しない（登録済みのため）
- **新規ファイル作成**: 指定パスに書き出し、`claude-task-worker.json` の `workerFiles` に追加する。パスは**設定ファイル（`claude-task-worker.json`）のあるディレクトリからの相対パス**で登録する（絶対パス／`~/...` も可だが、リポジトリで共有するなら相対）。`workerFiles` が未定義なら配列ごと作る。**`claude-task-worker.local.json` には書かない**（コミットして共有する定義のため）

### 5. `workers.<name>` の書き出し

ステップ2で既定から変えると決まった項目だけを、`claude-task-worker.json` の `workers.<name>` に書く。既定と同じ値は書かない。変更が1つも無ければ `workers.<name>` 自体を作らない。既存の JSON はキー順・インデントを保ったまま、必要なキーだけ追加する。

### 6. ロード検証

```bash
claude-task-worker list-workers
```

- exit 0 で、出力に新しいワーカー名が `custom` 行として現れれば成功
- exit 1 の場合はエラーメッセージ（`workerFiles: ...` 形式）に従って直し、再検証する:
  - `<path> does not exist` → `workerFiles` のパスを直す（設定ファイル基準の相対パスか確認）
  - `failed to load <path>: ...` → 構文・import（拡張子付き相対 import、`claude-task-worker/lib` の export 名）を直す
  - `exports no worker definition` → `create*Worker` / `defineWorker` の戻り値を `export` する
  - `collides with a preset worker` / `already defined in <file>` → ステップ3に戻って別名にする
- **修正→再検証は最大3回**。超えても解消しない場合は、残っているエラーメッセージをそのまま報告して終了する

### 7. 報告

成功時、次を簡潔に報告する。

- 書き出した／変更したファイル（TS・`claude-task-worker.json`）
- 起動コマンド: `claude-task-worker <name>`（個別）／ `claude-task-worker all`（他ワーカーと一括）
- トリガーラベルが未作成なら、`claude-task-worker.json` の `labels` に追加して `claude-task-worker apply-labels` を実行する案内
- 型補完が欲しければ `npm i -D claude-task-worker` で devDependency に入れられる（実行時の `claude-task-worker/lib` は CLI 自身に解決されるため、入れなくても動く）

## 中断条件

- 3ラウンド質問しても、ワーカー型・起動スキル・トリガー（issue / pr の場合）のいずれかが確定しない（確定していない項目を明示して終了）
- `claude-task-worker` コマンドを実行できない
- ステップ6の再検証が3回で通らない（残エラーを報告して終了）

## 注意事項

- 全項目確定前にファイルを書き出さない
- 既存のワーカー定義・`workerFiles` の既存エントリは変更・削除しない
- 生成するのは定義のみ。`command` が指すスキルが存在するかは検証しない（存在しない場合は報告に1行で挙げる）
