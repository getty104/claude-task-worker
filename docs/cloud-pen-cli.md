# クラウド VM への pencil CLI 導入と認証経路の実測結果

Issue #332 に対応する実測記録。pen 系ワーカー（`create-ui-design` / `apply-ui-design`）のクラウド実行を阻む「`pencil` CLI がクラウド VM に未導入・未認証」という前提を実測で確定させる。`resolve-conflict` も `.pen` を扱うが、同ワーカーの `CLOUD_DENIED_WORKERS` 入りの理由は `pencil` ではない（後述「未実測項目」6）。`CLOUD_DENIED_WORKERS` からの `create-ui-design` / `apply-ui-design` の除外は #335、pen 系ワーカーの E2E smoke test は #338、`CLAUDE.md` のワーカー別適合性表の更新は #339 の担当であり、いずれも本記録のスコープ外である。

- 実測日: 2026-08-30
- 実測環境: Claude Code on the web のクラウドセッション（`claude-task-worker` の `--cloud` 実行）。リポジトリ `getty104/claude-task-worker`、ブランチ `claude/task-worker-exec-332-vwedgm`（ベース `cc-epic-328`）
- OS: Linux 6.18.44-fc-v22
- `claude --version` → `2.1.251 (Claude Code)`
- `node -v` → `v22.22.2` / `npm -v` → `10.9.7`
- グローバル npm prefix: `/opt/node22`
- `pencil version` → `pen 0.3.5`（`pencil --version` というフラグは存在しないため、バージョンは `pencil version` サブコマンドか npm 側から取る）
- 後続Issueが失効判定できるよう、`@pen.dev/cli` のバージョンがここより新しい場合は再実測すること

## 結論

| 要件 | 結果 |
|---|---|
| セットアップスクリプト経由で `pencil` がクラウド VM に導入されるか | **成立**（ただし後述のとおり、セットアップスクリプトの実行そのものは間接確認。測定ログ1） |
| `PEN_CLI_KEY` 方式で認証（`pencil status` が終了コード0）が成立するか | **成立**（測定ログ2） |
| 旧 `@pencil.dev/cli` がクラウド VM に残っていないか | **成立**（不在。ただし「導入済み状態からの削除」は未実測。測定ログ3） |
| `.pen` に対する読み取り専用操作（`execute` の `Get` / `Print`）が動くか | **成立**（測定ログ4） |

「認証・導入のいずれかが成立しない場合はその事実と原因を docs に記録して Issue を完了とする」という想定条件は、上記のとおりいずれも成立したため該当しない。

## 測定ログ

### 1. 導入状況

- `command -v pencil` → `/opt/node22/bin/pencil`
- `command -v pen` → `/opt/node22/bin/pen`
- `npm ls -g --depth=0` の該当行 → `@pen.dev/cli@0.3.5`。`@pencil.dev/cli` は一覧に存在しない
- 同一覧に `claude-task-worker@0.97.0` / `@colbymchenry/codegraph@1.6.0` / `@google/design.md@0.4.0` も存在する
- `~/.claude/plugins/cache/claude-task-worker/` が存在する（プラグイン導入済み）
- `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` 配下に `chromium` / `chromium-1194` / `chromium-1234` / `chromium_headless_shell-*` / `ffmpeg-1011` が存在する

**ここは推論を含む**: claude.ai の環境設定欄はクラウドセッション内から読めないため、「セットアップスクリプトが `npx claude-task-worker install` を実行した」ことは直接確認していない。上記のとおり `install` コマンドが導入する一式（CLI 本体・Pen CLI・CodeGraph CLI・DESIGN.md CLI・プラグインキャッシュ・Playwright の chromium）がすべて揃っていることからの推論である。

### 2. 認証

- `PEN_CLI_KEY` はクラウド VM のプロセス環境に存在する（**値は出力していない**）
- `pencil status` → 終了コード **0**、`Method: CLI Key (PEN_CLI_KEY)`、`Status: ● Active`
- **同コマンドの出力にはアカウント情報（メールアドレス・氏名・組織名・プロフィール URL・ワークスペース名）が含まれるため、この docs には転記していない**
- `src/commands/pen.ts` の `warnIfPenLoggedOut()` は `pencil status` の失敗を案内するだけで、認証を成立させる能動的な処理は持たない。キーは CLI 本体がプロセス環境変数から直接読む。したがってワーカー側のコード変更は不要である

### 3. 旧パッケージ `@pencil.dev/cli`

- セットアップ完了後の状態で `npm ls -g --depth=0` に `@pencil.dev/cli` は存在しない
- 不在状態で `npm uninstall -g @pencil.dev/cli` を実行 → 終了コード **0**、出力は `up to date in 224ms`。**エラーにならず no-op で完了する**
- 実行後も `command -v pencil` は `/opt/node22/bin/pencil`（`@pen.dev/cli@0.3.5`）へ解決される
- `CLAUDE.md` は「旧パッケージ未インストール時の `npm uninstall` 失敗はログのみで続行する」と記述しているが、**クラウド VM の npm 10.9.7 ではそもそも失敗しない**（終了コード0の no-op）。この差は `installPenCli()` の挙動に影響しない（どちらでも後続の導入へ進む）ため、コード・`CLAUDE.md` の修正は本 Issue のスコープ外とする
- **未実測**: 旧パッケージが実際に導入済みの状態からの削除。検証にはグローバル環境へ旧パッケージを入れ直す必要があり、`pencil` の解決先を一時的に不定にする破壊的操作になるため実施しなかった（安全側の判断）

### 4. `.pen` への読み取り専用操作

- 本リポジトリに `.pen` は 0 件（`git ls-files '*.pen'`）。そのため**リポジトリ外のスクラッチ領域**に使い捨ての `.pen` を生成した（コミットしていない）
- 生成は AI エージェントモード（`pencil --prompt`）を使わず、ヘッドレスの `pencil interactive --out probe.pen` へ stdin から以下を投入する決定論的な手段で行った:
  ```
  execute({ input: 'frame=Insert(document,{type:"frame",name:"ProbeFrame",width:400,height:200,fill:"#FFFFFF"});Insert(frame,{type:"frame",name:"ProbeChild",width:100,height:40,fill:"#1A1C1E"})' })
  save()
  exit()
  ```
  → `Created nodes by name` に `"ProbeFrame": "NG2hU"` / `"ProbeChild": "sidIz"` が返り、485 バイトの `.pen` が保存された
- 読み取りは `pencil interactive --in probe.pen --out readonly-out.pen` へ以下を投入し、`save()` を**呼ばずに** `exit()` した:
  ```
  execute({ input: 'Get((n,c)=>{c.skipChildren();Print(n.id,n.name,n.type)})' })
  execute({ input: 'Get(n=>Print(n.id,n.name,n.type,n.width,n.height))' })
  exit()
  ```
- 出力（`## Print output`）:
  - 1回目（`skipChildren()` でトップレベルのみ）: `NG2hU ProbeFrame frame`
  - 2回目（全ノード）: `NG2hU ProbeFrame frame 400 200` と `sidIz ProbeChild frame 100 40`
- **入力 `.pen` の sha256 は実行前後で不変**（`3e86a9c9…`）
- `--out` に指定した `readonly-out.pen` は `save()` を呼ばなかったため**作成されない**。ヘッドレスモードは `--out` を必須とするが、`save()` を呼ばない限り書き出しは発生しない
- 補足: 最初の試行で text ノードを `{type:"text", name:"…", text:"…"}` で挿入しようとしたところ `Invalid properties: /text unexpected property, got "text"` となり、**同一 `execute` ブロックの全操作がロールバックされた**（frame の挿入も含めて）。0.3.5 における text ノードの正しいプロパティ名は本実測では調査していない（読み取り確認の目的には不要なため frame のみで再実行した）

## シークレットの扱い

`PEN_CLI_KEY` はシークレットであり、値をリポジトリ・Issue・PR・ログ・この docs へ書かない。本実測でも存在の有無のみを確認し値は出力していない。設定場所（claude.ai の環境設定の環境変数欄）と発行手順（pen.dev の組織設定 > Developer Keys）は `README.md` の「Pen CLI のログイン」節に既出のため、ここでは再掲せず README を参照する。`pencil status` の出力にはアカウント情報が含まれるため、ログを貼るときは `Method` / `Status` 行と終了コードに限ること。

## 実測の副作用

- AI エージェントモード（`pencil --prompt`）は使っていないため、pen.dev 側アカウントに生成物は残っていない見込み
- 使い捨ての `.pen` はリポジトリ外に置き、コミットしていない
- `npm uninstall -g @pencil.dev/cli` は不在状態での no-op であり、グローバル環境を変更していない
- クラウド VM は使い捨てのためこれらの残置物はセッション終了とともに失われる

## 未実測項目

1. 旧 `@pencil.dev/cli` が導入済みの状態からの `npm uninstall -g` の成否（破壊的操作のため未実施）
2. `.pen` に対する**書き込み系**操作（`save()` を伴う編集）のクラウド VM 上の成否。本 Issue の要件は読み取り専用1件であり、書き込みの確認は #338 の E2E smoke test の担当
3. `pencil` のエージェントモード（`pencil --in --out --prompt`）のクラウド VM 上の成否。`create-ui-design` は同モードに依存するため、#335 でのクラウド化判断にはこの実測が必要
4. `create-ui-design` / `apply-ui-design` ワーカーの E2E 実行（#338 の担当）
5. pen.dev 公式ドキュメント（https://docs.pen.dev/for-developers/pen-cli）による `PEN_CLI_KEY` の一次情報確認。`WebFetch` では本文を取得できず（JS 実行が必要なドキュメントサイトと見られる）、README の既存記述を根拠として扱っている
6. `resolve-conflict` の `CLOUD_DENIED_WORKERS` 拒否理由は force-push 可否の未測定（#333 の担当）であり `pencil` ではない。したがって本記録が成立しても同ワーカーは解除対象にならない
