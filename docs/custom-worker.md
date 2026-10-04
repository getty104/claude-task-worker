# 3. カスタムワーカーを作る（ハンズオン）

プリセットにない工程を自動化したいとき、自分のワーカーを TypeScript で定義して追加できる。ビルドも `tsconfig` も要らない。この章では「`cc-summarize` ラベルが付いた Issue に要約コメントを付けるワーカー」を作りながら手順を覚える。

前提: [1章](./getting-started.md) を終え、対象リポジトリで `claude-task-worker init` 済みであること。

## 仕組み（3行）

1. ワーカーは「トリガーラベルが付いていて自分が Assignee の Issue/PR」を見つけると、worktree を作って `claude -p "<command> <番号>"` を起動する
2. `<command>` は Claude Code のスキル（スラッシュコマンド）。作業の中身はスキルに書く
3. スキルが正常終了したら、ワーカーがトリガーラベルを外し、`onCompleted` で次のラベルを付ける

つまりカスタムワーカー作りは **「スキルを書く」+「どのラベルでそのスキルを呼ぶかを TS で宣言する」** の2つ。

## 完成形

```text
my-app/
├── .claude/skills/summarize-issue/SKILL.md   # 作業内容（スキル）
├── ctw/workers.ts                            # ワーカー定義
└── claude-task-worker.json                   # workerFiles / labels / workers に追記
```

## Step 1. スキルを書く

対象リポジトリに `.claude/skills/summarize-issue/SKILL.md` を作る。

```markdown
---
name: summarize-issue
description: 指定した Issue の本文とコメントを読み、3行の要約をコメントとして投稿する
argument-hint: "[issue-number]"
---

# Summarize Issue

対象 Issue: #$ARGUMENTS

1. `gh issue view $ARGUMENTS --json title,body,comments` で内容を取得する
2. 「目的」「現状」「次にやること」の3行に要約する
3. `gh issue comment $ARGUMENTS --body "<要約>"` で投稿する
4. 投稿した要約を最終報告として出力して終了する

ユーザーへの質問はしない。情報が足りなければ、足りない点を要約の3行目に書く。
```

スキルを書くときのポイント:

- **ワーカーから自動で起動され、応答する人はいない**。質問せずに最後まで終わる手順にする
- 最後に出力した文章が Slack 通知の本文になる（`claude -p` の標準出力）
- ワーカーは**正常終了 = 完了**とみなしてラベルを進める。失敗したら非0で終わるか、何も出力しないまま終わらせない

単体で動くことを先に確かめる（実際にコメントが投稿される点に注意）:

```bash
claude -p "/summarize-issue 12"
```

確認できたらコミットして push する。**ワーカーは worktree をリモートのデフォルトブランチから作る**ので、push していないスキルはワーカーからは見えない。

```bash
git add .claude/skills && git commit -m "feat: add summarize-issue skill" && git push
```

## Step 2. ワーカーを定義する

`ctw/workers.ts` を作る。

```ts
import { addLabel, createIssuePollingWorker } from "claude-task-worker/lib";

export const summarizeIssue = createIssuePollingWorker({
  name: "summarize-issue",
  command: "/summarize-issue",
  triggerLabels: ["cc-summarize"],
  excludeLabels: ["cc-summarized"],
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-summarized");
  },
});
```

| 項目 | 意味 |
|---|---|
| `name` | ワーカー名。`claude-task-worker <name>` で起動する名前になり、`workers.<name>` の設定キーにもなる |
| `command` | 起動するスキル。`claude -p "/summarize-issue 12"` のように番号が後ろに付く |
| `triggerLabels` | すべて付いている Issue が対象（AND） |
| `excludeLabels` | 1つでも付いていれば対象外。`cc-in-progress` / `cc-need-human-check` は自動で除外される |
| `onCompleted` | スキルが正常終了した後に呼ばれる |

`claude-task-worker/lib` は実行中の CLI 自身に解決されるので、`npm install` は不要。

## Step 3. 設定ファイルに登録する

`claude-task-worker.json` に `workerFiles` と `labels` を足す（既存のキーは残す）。

```json
{
  "labels": ["cc-summarize", "cc-summarized"],
  "workerFiles": ["ctw/workers.ts"]
}
```

`workerFiles` のパスは、設定ファイルのあるディレクトリからの相対パス・絶対パス・`~/...` のいずれか。

ラベルを作り、ロードを確認する:

```bash
claude-task-worker apply-labels
claude-task-worker list-workers
```

`list-workers` の出力に次の行が出れば成功。

```text
summarize-issue  custom  enabled  /Users/me/src/my-app/ctw/workers.ts
```

失敗すると `workerFiles: ...` で始まるエラーと exit 1 になる。主な原因:

| メッセージ | 対処 |
|---|---|
| `does not exist` | `workerFiles` のパスを直す |
| `failed to load` | 構文エラー・import 名の誤り。相対 import は拡張子付き（`./helpers.ts`）で書く |
| `exports no worker definition` | `create*Worker` / `defineWorker` の戻り値を `export` する |
| `collides with a preset worker` / `already defined in` | `name` を変える |

## Step 4. 動かす

```bash
claude-task-worker summarize-issue
```

別のターミナルでテスト用 Issue を作る。

```bash
gh issue create --title "要約テスト" --body "ログイン画面が遅いという報告。原因は未調査。" \
  --assignee @me --label cc-summarize
```

1分以内に拾われ、要約コメントが付き、ラベルが `cc-summarize` → `cc-summarized` に変わる。

`all` / `yolo` にもカスタムワーカーは自動で含まれる。

```bash
claude-task-worker all
```

## Step 5. 調整する

モデル・間隔などは TS ではなく `claude-task-worker.json` の `workers.<name>` で変える（プリセットと同じ仕組み）。

```json
{
  "workers": {
    "summarize-issue": { "model": "sonnet", "effort": "low", "pollingIntervalSeconds": 300 }
  }
}
```

| キー | カスタムワーカーの既定 |
|---|---|
| `model` | `opus` |
| `effort` | `medium` |
| `pollingIntervalSeconds` | `60` |
| `cooldownSeconds` | `0` |
| `maxConcurrentTasks` | `1` |
| `enabled` | `true`（`false` で `all` / `yolo` から外れる） |
| `skill` | `command` を上書きしたいときだけ |

## 応用

### PR を対象にする

```ts
import { createPrPollingWorker } from "claude-task-worker/lib";

export const changelogCheck = createPrPollingWorker({
  name: "changelog-check",
  command: "/check-changelog",
  triggerLabel: "cc-changelog-check", // PR は単数・文字列
});
```

`onCompleted` は `(pr, output) => Promise<void>`、ほかに成否に関わらず呼ばれる `onFinally: (pr) => Promise<void>` がある。

### 時刻で動かす（24時間に1回）

```ts
import { createScheduledWorker } from "claude-task-worker/lib";

export const dailyDigest = createScheduledWorker({
  name: "daily-digest",
  command: "/daily-digest",
});
```

スキルには `"/daily-digest 1"`（対象期間の日数）が渡る。最終実行時刻は `claude-task-worker.json` の `lastRun` に記録され、ワーカーが記録用の PR を自動で作る。

### 起動前に条件を見る（`preflight`）

```ts
export const summarizeIssue = createIssuePollingWorker({
  name: "summarize-issue",
  command: "/summarize-issue",
  triggerLabels: ["cc-summarize"],
  preflight: async (issue) => (issue.title.startsWith("[WIP]") ? "skip" : "proceed"),
});
```

`"skip"` を返すとそのポーリングでは起動しない。

### 成果物を検証して失敗扱いにする

`onCompleted` で `false` を返すと、完了通知ではなく失敗通知が送られる。スキルが正常終了しても期待した成果物が無い場合に使う。

```ts
import { addLabel, commentOnIssue, createIssuePollingWorker } from "claude-task-worker/lib";

export const summarizeIssue = createIssuePollingWorker({
  name: "summarize-issue",
  command: "/summarize-issue",
  triggerLabels: ["cc-summarize"],
  excludeLabels: ["cc-summarized"],
  onCompleted: async (issueNumber, _worktreeId, output) => {
    if (output.trim() === "") {
      await addLabel("issue", issueNumber, "cc-need-human-check");
      await commentOnIssue(issueNumber, "要約を生成できませんでした。");
      return false;
    }
    await addLabel("issue", issueNumber, "cc-summarized");
  },
});
```

`claude-task-worker/lib` が公開する関数は [`src/lib.ts`](../src/lib.ts) が一覧（ラベル操作・コメント・Issue/PR 取得など）。

### 1ファイルに複数定義・ファイル分割

1ファイルから複数のワーカーを `export` できる。共通処理を別ファイルに切り出す場合は拡張子付きで import する。

```ts
import { shouldSkip } from "./helpers.ts";
```

### 型補完

エディタで型補完が欲しい場合は、ワーカーを置いたディレクトリで `npm i -D claude-task-worker` する。実行時の `claude-task-worker/lib` は CLI 自身に解決されるので、入れなくても動く。

## 注意点

- TS は**型注釈を取り除くだけ**で実行する（Node.js の `stripTypeScriptTypes`）。`enum`・`namespace`・コンストラクタ引数プロパティのような、型を消すだけでは JS にならない構文は使えない
- `name` はプリセットのワーカー名・CLI のコマンド名（`all` / `init` など）と重複できない
- `--project` で起動した場合、ディスパッチャー自身は `workerFiles` を読まない。転送先の各プロジェクトのプロセスがそれぞれの設定から読む
- ワーカーはローカルで動く。`--cloud` でもワーカー定義はローカルで読まれ、スキルだけがクラウドで動く（スキルをクラウド VM で使えるようにする方法は [4章](./config-package.md#クラウド実行で使う)）

## 対話で作る

Claude Code で `/claude-task-worker:build-custom-worker` を実行すると、ワーカー型・ラベル・スキル名などを質問形式で確定させてから、定義ファイルの生成と `list-workers` での検証までを行う。

## 次に読む

作ったワーカーとスキルを複数リポジトリで使い回すには: [4. 設定とカスタムワーカーのパッケージ化](./config-package.md)
