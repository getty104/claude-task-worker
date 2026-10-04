# 4. 設定とカスタムワーカーのパッケージ化（ハンズオン）

[3章](./custom-worker.md) で作ったワーカーは1つのリポジトリの中で完結していた。複数のリポジトリで同じワーカー・同じ設定を使いたい場合、リポジトリごとにコピーすると更新のたびに全部を直すことになる。

この章では、**設定・ワーカー定義・スキルを1つのリポジトリ（以下「パック」）にまとめ、`--inherit-config` で各リポジトリから読み込む**構成を作る。

## 配るものと届け方

パックで配るものは3種類あり、それぞれ届け方が違う。

| 配るもの | 中身 | 届け方 |
|---|---|---|
| 設定 | `labels` / `workerFiles` / `workers.<name>` | `--inherit-config <パック>/shared.json` で土台として読ませる |
| ラベル | `labels` に列挙した名前 | 各リポジトリで `apply-labels --inherit-config` を実行して GitHub に作る |
| ワーカー定義 | `workers/*.ts` | `shared.json` の `workerFiles` から参照する（パスはパック基準で解決される） |
| スキル | `SKILL.md` | パックを Claude Code プラグインにして各マシンへインストールする |

スキルだけ届け方が違うのは、スキルを読むのがワーカーではなく `claude` だから。ワーカーは各リポジトリの worktree で `claude` を起動するので、スキルは「リポジトリにコミットされている」か「プラグインとして入っている」必要がある。パックではプラグインを使う。

## 完成形

```text
ctw-pack/
├── .claude-plugin/
│   └── marketplace.json          # このリポジトリをプラグインのマーケットプレイスにする
├── plugin/
│   ├── .claude-plugin/plugin.json
│   └── skills/
│       └── summarize-issue/SKILL.md
├── workers/
│   ├── index.ts                  # ワーカー定義
│   └── helpers.ts
└── shared.json                   # 共通設定（--inherit-config で読ませる）
```

適用先のリポジトリ側に置くのは、そのリポジトリだけの差分（任意）と `lastRun` だけになる。

## Step 1. パックのリポジトリを作る

```bash
mkdir -p ~/src/ctw-pack && cd ~/src/ctw-pack
git init
mkdir -p .claude-plugin plugin/.claude-plugin plugin/skills/summarize-issue workers
```

## Step 2. スキルをプラグインにする

`plugin/.claude-plugin/plugin.json`:

```json
{
  "name": "ctw-pack",
  "version": "0.1.0",
  "description": "チーム共通の claude-task-worker 用スキル"
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "ctw-pack",
  "owner": { "name": "my-team" },
  "plugins": [
    { "name": "ctw-pack", "source": "./plugin", "description": "チーム共通の claude-task-worker 用スキル" }
  ]
}
```

`plugin/skills/summarize-issue/SKILL.md` には [3章 Step 1](./custom-worker.md#step-1-スキルを書く) のスキルをそのまま置く（3章でリポジトリに置いたものは、パックへ移したら削除してよい）。

プラグインのスキルは **`/<プラグイン名>:<スキル名>`** で呼ばれる。ここでは `/ctw-pack:summarize-issue` になる。

## Step 3. ワーカー定義を置く

`workers/helpers.ts`:

```ts
export const isWip = (title: string): boolean => /^\[?WIP\]?/i.test(title);
```

`workers/index.ts`:

```ts
import { addLabel, createIssuePollingWorker } from "claude-task-worker/lib";
import { isWip } from "./helpers.ts";

export const summarizeIssue = createIssuePollingWorker({
  name: "summarize-issue",
  command: "/ctw-pack:summarize-issue",
  triggerLabels: ["cc-summarize"],
  excludeLabels: ["cc-summarized"],
  preflight: async (issue) => (isWip(issue.title) ? "skip" : "proceed"),
  onCompleted: async (issueNumber) => {
    await addLabel("issue", issueNumber, "cc-summarized");
  },
});
```

- `command` はプラグイン名付きにする
- パック内の相対 import は拡張子付き（`./helpers.ts`）

## Step 4. 共通設定を書く

`shared.json`:

```json
{
  "labels": ["cc-summarize", "cc-summarized"],
  "workerFiles": ["workers/index.ts"],
  "workers": {
    "summarize-issue": { "model": "sonnet", "effort": "low" },
    "exec-issue": { "maxConcurrentTasks": 2 },
    "check-dependabot": { "enabled": false }
  }
}
```

- `workerFiles` の相対パスは **`shared.json` のあるディレクトリ（パック）基準**で解決される。適用先リポジトリのどこから起動しても同じファイルを指す
- プリセットワーカーの設定（`exec-issue` の同時実行数、`check-dependabot` の無効化など）もここで揃えられる
- 書けるキーはリポジトリの `claude-task-worker.json` と同じ（[README](../README.md#claude-task-workerjsonリポジトリ)）。ただし `uiDesign` と `lastRun` は後述の理由でパックに書かない

コミットして GitHub へ push する（チームで共有する場合）。

```bash
git add -A && git commit -m "feat: initial ctw-pack" && git remote add origin git@github.com:my-team/ctw-pack.git && git push -u origin main
```

## Step 5. カスタムワーカー用のラベルを定義する

カスタムワーカーが使うラベル（トリガー・除外・`onCompleted` で付けるもの）は GitHub 側に存在しないと付けられない。ラベルは**リポジトリごと**に作る必要があるので、パックでは名前の一覧だけを `shared.json` の `labels` に持ち、各リポジトリで生成コマンドを実行する。

### 1. 使うラベルを洗い出す

ワーカー定義に出てくるラベルをすべて `labels` に列挙する。

| ワーカー定義の項目 | 例 |
|---|---|
| `triggerLabels` / `triggerLabel` | `cc-summarize` |
| `excludeLabels` | `cc-summarized` |
| `onCompleted` / `onFinally` / `preflight` 内の `addLabel` | `cc-summarized` |

プリセットのラベル（`cc-in-progress` / `cc-need-human-check` / `cc-triage-scope` など）は書かなくても常に作られる。書いても重複して作られることはない。

```json
{
  "labels": ["cc-summarize", "cc-summarized"]
}
```

ラベル名にはパック固有の接頭辞を付けておくと、プリセットや他のパックと衝突しない（例: `pack-summarize`）。

### 2. 生成する

適用先のリポジトリで実行する。

```bash
cd ~/src/my-app
claude-task-worker apply-labels --inherit-config ~/src/ctw-pack/shared.json
```

```text
[init] Ensured label: cc-triage-scope
...
[init] Ensured label: cc-summarize
[init] Ensured label: cc-summarized
```

- プリセット＋`labels` のラベルを作る。既にあれば何もしないのと同じ結果になる（冪等）ので、パックへラベルを足すたびに再実行してよい
- 色はラベル名から自動で決まり、どのリポジトリでも同じ色になる。手で変えた色は再実行で元に戻る
- 説明文（description）は付かない。必要なら GitHub 上で設定する
- 新しいリポジトリでは `init --inherit-config` がラベル生成も兼ねる（Step 7）

### 3. 複数リポジトリへまとめて生成する

`apply-labels` は `--project` と併用できないので、シェルで回す。

```bash
for repo in ~/src/app-a ~/src/app-b; do
  (cd "$repo" && claude-task-worker apply-labels --inherit-config ~/src/ctw-pack/shared.json)
done
```

### 4. 確認する

```bash
gh label list --search cc-summarize
```

### 注意

- リポジトリ直下の `claude-task-worker.json` に `labels` を書くと、パックの `labels` の後ろへ**追記**される（Step 8）。リポジトリ固有のラベルだけを書けばよい
- パックからラベルを消しても GitHub 上のラベルは削除されない。不要になったら `gh label delete <name>` で消す

## Step 6. プラグインをインストールする

ワーカーを動かすマシンごとに1回行う。

```bash
claude plugin marketplace add ~/src/ctw-pack        # GitHub 上なら my-team/ctw-pack でもよい
claude plugin install ctw-pack@ctw-pack
```

確認: `claude -p "/ctw-pack:summarize-issue 12"` が動けばスキルは届いている。

## Step 7. リポジトリに適用する

### 新しいリポジトリの場合

`init` に `--inherit-config` を付けて実行する。

```bash
cd ~/src/my-app
claude-task-worker init --inherit-config ~/src/ctw-pack/shared.json
```

- ラベルはプリセット＋`shared.json` の `labels` が作られる
- `shared.json` が既にあるので上書きされない（無い場合は既定値でそこに生成される）
- リポジトリ直下の `claude-task-worker.json` には `lastRun` だけが書かれる

### `init` 済みのリポジトリの場合

既存の `claude-task-worker.json` はそのままパックと組み合わせられる。配列（`labels` / `workerFiles`）はパックの値に追記されるので、古いバージョンの `init` が書いていた `"labels": []` / `"workerFiles": []` が残っていてもパックの値はそのまま使われる。

ただし自分で書いたキーはパックより優先される。パックに任せたいキー（`workers.<name>` の設定など）は削除する。

```json
{
  "lastRun": { "update-coding-guidelines": "2026-10-01T00:00:00.000Z" },
  "uiDesign": { "enabled": false, "designDir": "designs", "yolo": false }
}
```

ラベルを作る（詳細は Step 5）:

```bash
claude-task-worker apply-labels --inherit-config ~/src/ctw-pack/shared.json
```

### ロードを確認して起動する

```bash
claude-task-worker list-workers --inherit-config ~/src/ctw-pack/shared.json
claude-task-worker all --inherit-config ~/src/ctw-pack/shared.json
```

`list-workers` に `summarize-issue  custom  enabled  /Users/me/src/ctw-pack/workers/index.ts` が出ていれば、パックのワーカーが読まれている。起動のたびに `--inherit-config` を付ける。コマンド名は第1引数でなければならないので、短縮するならシェル関数にする。

```bash
ctw() { claude-task-worker "$1" --inherit-config ~/src/ctw-pack/shared.json "${@:2}"; }
ctw all
ctw exec-issue --epic 120
```

フラグを毎回付けたくない場合は、リポジトリ直下の `claude-task-worker.json`（個人ごとにパスが違うなら `claude-task-worker.local.json`）に `inheritConfig` を書く。フラグと同じ挙動になり、以降は `claude-task-worker all` だけで土台が読まれる（`--project` の転送先でも各リポジトリの値が使われる）。

```json
{ "inheritConfig": "~/src/ctw-pack/shared.json" }
```

- 相対パスはこのファイルのあるディレクトリ（リポジトリ直下）基準、`~` はホーム展開
- `--inherit-config` を付けた場合はフラグが勝つ。`init` の生成先はフラグ指定時だけ変わる（キーでは変わらない）

## Step 8. リポジトリごとの差分を書く

設定は次の順に重なり、**後のものが勝つ**。

```text
--inherit-config / inheritConfig のファイル  <  ./claude-task-worker.json  <  ./claude-task-worker.local.json
（パック・共通）              （リポジトリ・コミットする）   （個人・コミットしない）
```

オブジェクトはキー単位でマージされるので、変えたいキーだけを書けばよい。例えば my-app だけ要約を opus で回すなら、my-app の `claude-task-worker.json` に:

```json
{
  "workers": { "summarize-issue": { "model": "opus" } }
}
```

`effort: "low"` はパックの値が残る。

配列（`labels` / `workerFiles`）は置き換えではなく、パックの値の後ろへ**追記**される（同じ値は1つにまとめる）。リポジトリ固有のワーカーやラベルを足すときは、増やしたいものだけを書く。

```json
{
  "labels": ["cc-my-app-only"],
  "workerFiles": ["ctw/local-workers.ts"]
}
```

この場合、ワーカーはパックの `workers/index.ts` と `ctw/local-workers.ts` の両方から、ラベルはパックの2つと `cc-my-app-only` が使われる。パックのワーカーファイルをリポジトリ側にも重ねて書くと、同じワーカー名が2回定義されて読み込みエラーになるので書かない。

パックの配列を減らす（パックのワーカーを使わない）ことはできない。使わないワーカーは `workers.<name>.enabled: false` で止める。

## Step 9. 複数リポジトリへ一括で適用する

`--project` と組み合わせると、`--inherit-config` のパスは絶対パスにして各プロジェクトへ転送される。

```bash
claude-task-worker all --project all --inherit-config ~/src/ctw-pack/shared.json
```

## パックの更新

| 変えたもの | 反映方法 |
|---|---|
| `shared.json` / `workers/*.ts` | 各マシンでパックを `git pull` → ワーカーを再起動 |
| `labels` | 上記に加えて、各リポジトリで `apply-labels --inherit-config` を再実行 |
| スキル | `plugin.json` の `version` を上げて push → 各マシンで `claude plugin marketplace update ctw-pack && claude plugin update ctw-pack@ctw-pack` |

## パックに書かないもの

| キー | 理由 | 置き場所 |
|---|---|---|
| `uiDesign` | スキル（`create-ui-design` など）はリポジトリ直下の `claude-task-worker.json` を直接読むため、パックに書いてもスキルに届かない | リポジトリ直下 |
| `lastRun` | 定期ワーカーの実行記録はリポジトリごとの値で、リポジトリ直下だけを読み書きする | リポジトリ直下（ワーカーが自動更新） |
| `remoteEnvId` | クラウド環境 ID は人ごとに違う | `claude-task-worker.local.json` |

## クラウド実行で使う

`--cloud` ではワーカー定義と設定はローカルで読まれ、スキルだけがクラウド VM で動く。VM にもパックのプラグインが必要なので、claude.ai の環境設定のセットアップスクリプトに追記する。

```bash
npx claude-task-worker install
npx claude-task-worker cloud-setup
claude plugin marketplace add my-team/ctw-pack
claude plugin install ctw-pack@ctw-pack
```

詳細は [5. クラウド実行](./cloud.md)。

## 型補完（任意）

パックで `npm init -y && npm i -D claude-task-worker` すると、エディタで `claude-task-worker/lib` の型が効く。実行時は CLI 自身の lib に解決されるので、適用先のリポジトリに `node_modules` は要らない。`node_modules/` は `.gitignore` へ入れておく。
