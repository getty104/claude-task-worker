# クラウドセッション起動引数の実測結果

`claude --cloud` が受理する起動フラグを実測した記録。`docs/prd-cloud-worker-execution.md` 4.2 の起動引数表を確定させるための調査（Issue #223、PRD 9-2 / 9-3 / 9-7 に対応）。

- 実測日: 2026-08-27
- 実測バージョン: `claude --version` → `2.1.247 (Claude Code)`
- 後続Issueが失効判定できるよう、`claude --version` がここより新しい場合はフラグの受理可否を再実測すること
- **追記（Issue #302 / claude 2.1.250）**: `--cloud <description>` の `description` は表示名ではなく**初期プロンプトとして即実行される**ことが後続の smoke test で判明した。本ファイルの測定時点ではこの前提を認識しておらず「作成 → 既存セッションへの投函」という2コマンド運用を想定していたが、description が即実行されるためその運用は同じ作業を2回実行させてしまう（1タスクで PR が2件作られる不具合の原因）。現行実装は作成コマンド1本で description にプロンプトを直接渡す方式に切り替えた（`docs/prd-cloud-worker-execution.md` 4.2）。以下の T1〜T11 の測定結果自体は改変していない
- **追記（Issue #374）**: T1 が示す「非TTY での `--cloud` 新規作成は拒否される」という TTY 要件自体は変わらないが、**現行実装は疑似 pty を割り当てることでこの要件を満たしている**。ワーカーは `createCloudSession()`（`src/process-manager.ts`）で `script(1)` 経由の `spawn`（`buildScriptCommand()`、`src/claude-args.ts`）を使って作成コマンドを起動しており、これは本ファイルの「実測環境」節で TTY のある実行に使っていた `script -q /dev/null <cmd>` と同じ手法を herdr のタスクタブに頼らず採用したものである。pty 出力に混ざる ANSI/OSC エスケープは `normalizePtyOutput()`（`src/herdr-runner.ts`）で除去してから `extractCloudSessionId()` にかける。T1 の測定結果（非TTY では拒否される）自体は現行実装でも有効である

## 実測環境

- 実行パス: `~/.local/bin/claude`
- OS: macOS (darwin 25.6.0)
- 実行ディレクトリ: git の **linked worktree**（`.claude/worktrees/<name>`）
- TTY のある実行は `script -q /dev/null <cmd>` で pty を割り当てて実施
- 実測当時は claude.ai 側の GitHub App 連携が未設定と判断していたが、下記「訂正（2026-08-29）」のとおりこれは Claude Code 側のバグ（[anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776)）による誤判定だったと判明している

## 訂正（2026-08-29）: `--ref` / `--on-branch` 拒否は GitHub App 未設定が原因ではない

本ファイルの T9 / T10 / T11 が観測した `Error: ... the GitHub App is not set up for this repository, ...` は、**GitHub App 連携が実際に未設定だったからではなく、Claude Code 側のバグによる誤判定**だった（[anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776)、2026-08-29 時点で `area:core` ラベル付き **OPEN**）。上流の `--debug` ログでは `Checking GitHub app installation for <owner>/<repo>` → `GitHub app is not installed … (status is null)` という判定になっており、GitHub App 連携済みのリポジトリ（public / private とも）でも同じ理由で拒否される。コメント欄では macOS / Windows 双方での再現も報告されている。

回避策は環境変数 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を付与すること。smoke test（claude 2.1.250、2026-08-29、public / private 双方のリポジトリ）で `--ref main` / `--on-branch <PR head>` のいずれもセッション**作成に成功する**ことを確認済み。確認できたのは「セッション作成が成功すること」のみで、その先（force-push の可否等）は未確認。

観測されたエラー文言・終了コード・コマンド自体は事実として以下にそのまま残す。「GitHub App が未設定である」「ブランチ名検証に到達しない」という**結論**の部分だけを上記のとおり訂正する。

## `--help` 掲載状況（2.1.247）

- 掲載あり: `--cloud [description|session_id|url]` / `--environment <environment_id>` / `--effort <level>` / `--chrome` / `--no-chrome` / `--model <model>` / `--permission-mode <mode>` / `--disallowedTools` / `--append-system-prompt <prompt>` / `--teleport [session]`
- 掲載なし: `--append-system-prompt-file` / `--system-prompt-file` / `--advisor` / `--ref` / `--on-branch` / `--remote`

補足:
- `--append-system-prompt-file` / `--system-prompt-file` は独立項目としては非掲載だが、`--bare` の説明文中に `--system-prompt[-file], --append-system-prompt[-file]` として言及がある
- `--remote` というフラグは存在しない（`--remote-control [name]` は別物で、Remote Control を有効にした対話セッションを開始するフラグ）
- 上記の非掲載フラグはいずれも**パーサには存在する**。非TTY環境で単独付与すると commander の `error: unknown option` は出ず、後段の TTY チェックのエラーに到達した（存在しないフラグでは `error: unknown option '--definitely-not-a-flag'` が返る）。つまり **`--help` 非掲載＝未実装ではない**

## パースとバリデーションの順序（実測）

1. commander の unknown option チェック（最初）
2. `--print`（`-p`）と `--cloud`（新規作成）の排他チェック
3. `--cloud`（新規作成）の TTY チェック
4. `--cloud` 固有の各種バリデーション（`--ref`/`--on-branch` の排他など）
5. クラウドセッション作成（ネットワーク、未実測）

根拠:
- 1: 非TTY環境で `claude --cloud "ctw probe" --definitely-not-a-flag` は `error: unknown option` を返し、後続のいずれのチェックにも到達しない
- 2 → 3: T2（非TTY・`-p` 併用・新規作成）は `Error: --cloud cannot be combined with --print.` を返し、T1 が示す TTY エラー（`Error: --cloud requires an interactive terminal.`）には到達しない。非TTYなのに TTY エラーではなく `--print` 排他エラーが返っている＝この経路では TTY チェックに到達していない。したがって `-p` 併用時は print 排他チェックが TTY チェックより先に評価される
- 4: T8（`--ref`/`--on-branch` 併用の排他）・T9/T10（GitHub App 誤判定エラー。上記「訂正」参照）はいずれも pty（TTYチェック通過後）でのみ検証しており、この段の内部順序（2・3との相対順を含む）は未確認
- 5: 未実測。ネットワーク呼び出し自体の失敗ケース（認証切れ等）は本調査で確認していない

**この順序は `-p` を併用した新規作成（T1・T2）でのみ裏付けが取れている。** `-p` を伴わない `--cloud` 新規作成時に TTY チェックと他のバリデーションがどの順で評価されるかは実測していない。

## 引数表（PRD 4.2 差し替え用）

| 引数 | ローカル | クラウド | 受理可否 | エラー文言 | 根拠 |
|------|---------|---------|---------|-----------|------|
| `-p <prompt>` | default モードのみ付与 | 付けない（新規作成は print モード非対応） | 新規作成は拒否／既存セッションへの追記投函は受理 | `Error: --cloud cannot be combined with --print.`（新規作成時） | T2, T3 |
| `--cloud <description>`（値あり・新規作成、非TTY） | なし | 付与 | 拒否（TTY必須） | `Error: --cloud requires an interactive terminal.` | T1 |
| `--cloud <session_id>`（既存セッションへの追記投函、`-p` 併用） | なし | 付与 | **受理**（TTY不要）。**ただし現行実装（Issue #302 以降）ではこの経路は使わない** — `--cloud <description>` の `description` は表示名ではなく初期プロンプトとして即実行される（claude 2.1.250 実測）ため、作成コマンドの description にプロンプトを直接渡す1コマンド方式へ切り替え、この投函コマンドは廃止した | — | T3 |
| `--cloud <session_id>`（対話アタッチ） | なし | 付与 | 拒否（アカウント単位で無効） | `Error: Attaching to an existing cloud session is not enabled for your account.` | T4 |
| `--ref <branch>` | なし | Issue系: ベースブランチ想定 | **確定**（smoke test、claude 2.1.250 / herdr 0.8.2、2026-08-29）: 指定ブランチを起点に `claude/<description由来>-<6文字>` 形式の**作業ブランチが新規に作られる**。作業ブランチ名は `--cloud` に渡した description に依存し、ローカル側から事前に名前を決めることはできない | 実測当時のバグ（#81776）による拒否文言: `Error: --ref <branch> cannot be honored: the GitHub App is not set up for this repository, so the session would be seeded from your local working tree instead. Set up the GitHub integration at https://claude.ai/code, or drop --ref to seed from local HEAD.` | T9、smoke test（2026-08-29） |
| `--on-branch <branch>` | なし | PR系: 既存PRブランチ想定 | **確定**（smoke test、claude 2.1.250 / herdr 0.8.2、2026-08-29）: クラウドセッションは指定した PR の head ブランチ上で**直接作業**し、push すると**その PR が更新される**（新しいブランチは切られない） | 実測当時のバグ（#81776）による拒否文言: `Error: --on-branch <branch> cannot be honored: the GitHub App is not set up for this repository, so the session would be seeded from your local working tree instead. Set up the GitHub integration at https://claude.ai/code, or drop --on-branch to seed from local HEAD.` | T10、smoke test（2026-08-29） |
| `--ref` と `--on-branch` の併用 | — | — | 拒否（排他） | `Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other` | T8 |
| `--permission-mode bypassPermissions` | 付与 | 付けない（PRD想定） | **受理される**（PRD想定と異なる） | エラーなし。セッション作成成功 | T5 |
| `--disallowedTools` | 付与 | 付けない（PRD想定） | **受理されるが VM 側ではツール制限として効かない**（smoke test、claude 2.1.250、2026-08-29 で確定。Issue #307） | エラーなし。セッション作成成功 | T6 |
| `--append-system-prompt-file` | 付与 | 要検証（PRD 9-2） | **受理されるが VM 側には反映されない**（smoke test、claude 2.1.250、2026-08-29 で確定。Issue #307） | エラーなし | T7 |
| `--model` / `--effort` / `--advisor` / `--chrome` | 付与 | 要検証（PRD 9-3） | **受理される**（起動引数としては拒否されない。VM側での反映は引き続き未確認） | エラーなし | T7 |

## 測定ログ（要旨）

各IDはコマンドと結論のみ（詳細は上の引数表・環境節を参照）。

- **T1** `claude --cloud "<desc>"`（非TTY・新規作成）→ exit=1: `Error: --cloud requires an interactive terminal.`
- **T2** `claude -p --cloud "<desc>" "ping"`（非TTY・print+新規作成）→ exit=1: `Error: --cloud cannot be combined with --print.`
- **T3** `claude -p --cloud <session_id> "ping"`（非TTY、既存セッションへの投函）→ exit=0・受理。pty でも同一結果（TTY不要）
- **T4** `claude --cloud <session_id>`（pty、対話アタッチ）→ exit=1: `Error: Attaching to an existing cloud session is not enabled for your account.`（T3の投函は成功するので、投函とアタッチは別権限）
- **T5** `claude --cloud "<desc>" --permission-mode bypassPermissions`（pty）→ exit=0・受理。PRD 旧版の想定エラー（`Error: a cloud session cannot bypass permissions`）は2.1.247で再現せず
- **T6** `claude --cloud "<desc>" --disallowedTools Monitor`（pty）→ exit=0・受理。PRD 旧版の想定エラー（`Error: a cloud session does not enforce tool restrictions yet`）も再現せず
  - **追試**（smoke test、claude 2.1.250、2026-08-29）: `--disallowedTools AskUserQuestion` 付きで作成したセッションが同ツールを「利用可能」と報告。**受理されるだけで VM 側ではツール制限として効かない**ことを確定（Issue #307）
- **T7** 複合受理プローブ（pty）: `claude --cloud "ctw probe" --append-system-prompt-file /tmp/ctw-sp.txt --model opus --effort high --advisor opus --chrome` → exit=0、5フラグすべて受理。1回にまとめたのはセッション作成という外部副作用の最小化のため（バリデーションは最初に拒否されたフラグで即エラー終了する＝まとめて通った時点で個別受理も保証される、T8/T9で確認済みの挙動）
  - **追試**（smoke test、claude 2.1.250、2026-08-29）: システムプロンプトファイルに仕込んだ合言葉を `--append-system-prompt-file` で渡してもセッションが答えられなかった。**受理されるが VM 側には反映されない**ことを確定（Issue #307）
- **T8** `claude --cloud "<desc>" --ref main --on-branch main`（pty）→ exit=1: `Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other`。両フラグが**どちらもベースブランチ指定**であることを示す（PRD旧版の役割分担想定とは異なる）
- **T9** `claude --cloud "<desc>" --ref ctw-no-such-branch-xyz123`（pty）→ exit=1: `Error: --ref ctw-no-such-branch-xyz123 cannot be honored: the GitHub App is not set up for this repository, so the session would be seeded from your local working tree instead. Set up the GitHub integration at https://claude.ai/code, or drop --ref to seed from local HEAD.`
- **T10** `claude --cloud "<desc>" --on-branch ctw-no-such-branch-xyz123`（pty）→ exit=1、T9と同文言（`--ref`→`--on-branch`に置換のみ）
  - T9/T10 の解釈（訂正済み）: 拒否理由は「ブランチ不在」でも「GitHub App 連携未設定」の実態でもなく、Claude Code 側のバグ（#81776）による誤判定。ブランチ名検証に到達していないため、`--ref`/`--on-branch` の**受理可否そのものが未判定**（回避策適用後はセッション作成まで到達する。上記「訂正」参照）
- **T11** シード元（T5/T6/T7で毎回観測。当時は GitHub App 未設定時の挙動と解釈していたが、上記の誤判定バグと同一のチェックに起因する可能性があり、実際の連携状態を裏付ける根拠としては扱わない）: `This checkout is a linked working tree, a submodule or a checkout with a separate git directory; the new upload path does not support that yet, so the working tree is being uploaded the previous way for this session.` → クラウドセッションは**ローカル作業ツリーをアップロードしてシードされる**（remote を clone するのではない）。PRD 4.4-1 の「VM は自前で clone するので worktree 不要」という前提が成立するかは**未確認**（連携済み判定のもとでの再実測が必要）

## PRD 4.2 からの差分

1. **`--permission-mode bypassPermissions` は拒否されない**（T5）。PRD が記載する `Error: a cloud session cannot bypass permissions` は 2.1.247 で再現しなかった
2. **`--disallowedTools` は拒否されない**（T6）。PRD が記載する `Error: a cloud session does not enforce tool restrictions yet` は 2.1.247 で再現しなかった。ただし受理されるだけで VM 側の制限としては効かない（smoke test、claude 2.1.250、2026-08-29）
3. **`--ref` / `--on-branch` はどちらもベースブランチ指定であり排他**（T8）。PRD が想定していた「`--ref` = ベースブランチ / `--on-branch` = 既存PRブランチ上で作業再開」という役割分担ではない

## 9-2（`--append-system-prompt-file` の代替 system-level control）の扱い

`--append-system-prompt-file` は T7 で受理されたため、PRD 9-2 が想定していた「拒否された場合に代替手段を探す」分岐には該当しない。代替 system-level control の調査は不要になった。「受理された＝クラウド VM 側で実際にシステムプロンプトとして反映される」わけではないことを smoke test（claude 2.1.250、2026-08-29）で確定した（Issue #307）。自律実行原則とツール制限指示は cloud 実行時のみ初期プロンプト本文（`--cloud <prompt>` の値）へ付加する実装へ切り替えた。

## 未実測項目

`--ref` / `--on-branch` の基本的な意味論（作業ブランチの作られ方、PR head 上での直接作業）は smoke test（claude 2.1.250 / herdr 0.8.2、2026-08-29）で確定済み（上記「引数表」参照）。以下は依然として未実測。

1. ~~**`--ref` / `--on-branch` のブランチ名検証以降の意味論**~~: **実測済み**（smoke test、claude 2.1.250 / herdr 0.8.2、2026-08-29）。上記「引数表」参照。リモート未存在ブランチでの挙動差など細部は引き続き未確認
2. ~~**`--append-system-prompt-file` の内容がクラウド VM 側で実際にシステムプロンプトへ反映されるか**~~: **実測済み**（smoke test、claude 2.1.250、2026-08-29。Issue #307）。**反映されない**（システムプロンプトに仕込んだ合言葉をセッションが「無し」と回答）。あわせて `--disallowedTools` も受理されるだけで VM 側のツール制限としては効かないことを確定（`AskUserQuestion` を「利用可能」と報告）
3. **`--model` / `--effort` / `--advisor` / `--chrome` がクラウド VM 側で実際に効くか**
   - 理由: 上と同じく、起動引数として拒否されないことのみを確認
   - 再現手順: セッション作成後に claude.ai 側のセッション設定、または `/model` 等のスラッシュコマンドで実際の値を確認する
4. **`--environment <environment_id>`（自己ホスト環境）**: PRD 6 でスコープ外のため未実測

## `--ref` 起動時のセッション開始時 HEAD（Issue #353）

`--ref <branch>` で起動した Issue 系クラウドセッションが、**セッション開始時点（1コミットも作る前）で既に新規作業ブランチ上にいるのか、ベース ref のままなのか**の実測。ベース ref のままかつそれがデフォルトブランチだと、`exec-issue` フェーズ0の「現在ブランチ＝デフォルトブランチなら中断」に引っかかり、worktree ガードを緩めても別条件で中断してしまう。

- 実測日: 2026-08-30（`exec-issue` の Issue #353 タスク自身のセッションで観測）
- 結果: **セッション開始時点で既に新規作業ブランチ上にいる**。`git rev-parse --abbrev-ref HEAD` → `claude/task-worker-issue-353-1tj47y`（`claude/<description 由来>-<6文字>` 形式）。`git symbolic-ref refs/remotes/origin/HEAD` は未設定だが、`git remote show origin` / REST（`gh api repos/{o}/{r} --jq .default_branch`）はいずれも `main` を返し、HEAD とは一致しない
- 帰結: クラウドでもデフォルトブランチ比較は**正しく通過する**ため、実装プランのステップ6で懸念していた「比較対象の調整」は不要。worktree 条件のみを免除すれば足りる
- 副次（同 Issue で修正済み）: `git symbolic-ref --short refs/remotes/origin/HEAD` はクラウド VM の clone では未設定で失敗する。`gh-compat.sh default-branch` は git 導出の次が `gh repo view --json`（GraphQL → 403）だったため、この環境では解決に失敗していた。フェーズ0は「デフォルトブランチ名の取得失敗＝中断」を fail-safe にしているため、worktree ガードだけを免除しても直後のこの行で必ず中断する。`resolve_default_branch()` に REST（`gh api repos/{owner}/{repo} --jq .default_branch`）を挟んで解消済み（修正後、本 VM で `main` を解決できることを確認）

## 実測の副作用

本実測により3件のクラウドセッションが作成された（T5・T6・T7/T3/T4、いずれもプロンプト未投入かT3で`"ping"`を1回投函のみ）。不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。セッションURLの閲覧には Anthropic アカウント認証が必要で、URL単体が漏れても第三者は閲覧できない。

---

# クラウドセッションの完了検知・セッションID・transcript の実測結果

`claude --cloud` で作ったクラウドセッションを herdr からドライブし、完了検知・セッションID取得・transcript 読み取りが既存実装のまま流用できるかを実測した記録（Issue #224 / S-2、PRD 9-4 / 9-8 / 9-9 / 受け入れ基準7 に対応）。上の「起動引数の実測結果」（Issue #223 / S-1）と同一環境・同一日の測定で、同じファイルにまとめている。

- 実測日: 2026-08-27
- 実測バージョン: `claude --version` → `2.1.247 (Claude Code)` / `herdr --version` → `herdr 0.8.2`
- `~/.config/claude-task-worker/config.json` の `mode`: `"herdr"`
- 挙動はバージョン依存のため、いずれかがここより新しい場合は再実測すること

## 実測環境

- 実行場所: herdr タブ（`tab create --cwd <worktree> --no-focus`）のルートペイン。`script` による疑似 pty ではなく**実TTY**
- 実行ディレクトリ: git の linked worktree（`.claude/worktrees/<worktree>`）
- S-1 と同じく、実測当時は claude.ai 側の **GitHub App 連携が未設定**と判断していたが、これは #81776 のバグによる誤判定だったと後日判明している（上記「訂正（2026-08-29）」参照）

## 結論

**PRD 4.4-2 が前提とする「クラウドセッションにアタッチし続けるローカルのドライバ」は、2.1.247 / 本アカウントでは存在しない。** したがって herdr の agent ステータスで*クラウドセッションの*完了を検知する経路は無い。

| 起動経路 | ローカルに残るか | 実行される場所 | herdr の agent 検出 | 完了シグナル | 出力のローカル取得 |
|---|---|---|---|---|---|
| `claude --cloud "<desc>"`（新規作成） | **残らない**（作成後 即 exit） | — | 不可（`agent_not_found`） | 無し | セッションIDが stdout に出るのみ |
| `claude --cloud <session_id>`（対話アタッチ） | — | — | — | — | アカウント単位で無効（S-1 T4） |
| `claude -p --cloud <session_id> "<msg>"` | 残らない（即 return） | **クラウド VM** | 不可 | 無し | 不可（CLI に取得手段なし） |
| `claude --teleport <session_id>` | 残る（TUI） | **ローカル** | **可**（`working`/`idle`/`done`/`blocked`） | **有り** | 可（ローカル transcript） |

一方、**driver 契約そのもの（`working` / `idle` / `done` / `blocked` の遷移）は teleport セッションで完全に成立した**（M-2 / M-4）。`observeAgentStatus()` / `waitForHerdrTask()` のロジックはローカル TUI に対しては正しく、クラウド実行で壊れるのは「ドライブ対象がローカルになってしまう」という接続経路の側である。

## PRD 項目への対応

| PRD | 問い | 実測結果 |
|---|---|---|
| 9-8 / 4.4-2 | herdr の agent ステータスがクラウドをドライブする TUI でも `working`/`idle`/`done` を返すか | **前提が成立しない**。クラウドをドライブし続けるローカル TUI が存在しない（M-1 / M-3）。teleport セッション（＝ローカル実行）に対しては非フォーカスで `working` → `done` を正しく返す（M-2） |
| 受け入れ基準7 | 質問待ちを `idle` として誤返却しないか | **誤返却しない**。`AskUserQuestion` で停止した状態は `blocked` を返し続けた（M-4）。`blocked` は `observeAgentStatus()` で待機継続に倒れるため誤完了は起きない |
| 9-9 | `agentGet()` の `sessionId` がクラウドセッションIDと一致し `https://claude.ai/code/<id>` として使えるか | **一致しない**。`agent_session` は `kind: "id"` で返るが `value` は**ローカル claude のセッションUUID**（例 `f9342ab2-…`）。クラウドセッションIDは `session_01…` 形式で別物。UUID を URL に入れると claude.ai は「このセッションは見つかりませんでした」を返す（M-3 / M-7） |
| 9-4 | `~/.claude/projects/*/<sessionId>.jsonl` が生成されるか | **クラウドセッションでは生成されない**。teleport セッションではローカルターンの分だけ生成され、`readFinalReport()` 相当（末尾の非 sidechain アシスタント発言）が正しく読める（M-6）。クラウド側で実行されたターンは transcript にもペインにも一切現れない |
| 4.4-5 | クラウドセッションの作業ブランチ名をローカルから取得できるか | **取得手段は無い**。CLI にクラウドセッションを列挙・照会する経路が無く（M-8）、ローカルの `~/.claude/sessions/<pid>.json` にもクラウドセッションとの紐付けは記録されない（M-9）。ブランチ名自体は claude.ai の Web UI でのみ確認できた（M-5）。**追記（smoke test、claude 2.1.250 / herdr 0.8.2、2026-08-29）**: `--ref <branch>` 使用時の作業ブランチ名は `claude/<description由来>-<6文字>` 形式で、`--cloud` に渡した description に依存する（＝ローカル側から事前に名前を決めることはできない点は従来の結論のまま）。`--on-branch <PR head>` 使用時は新規ブランチを切らず PR head 上で直接作業する |

## 測定ログ（要旨）

- **M-1** `claude --cloud "<desc>"` を herdr ペイン（実TTY）で実行 → セッション作成後、フォアグラウンドは即座に zsh へ戻り `herdr agent get` は `agent_not_found`。**TUI に留まらないため herdr は agent を検出できない**（S-1 T5 で疑似 pty により観測した exit=0 は pty 起因ではなく実TTYでも同じ）
- **M-2** `claude --teleport <session_id>` は同ペインで TUI を起動でき、`agent get` が agent を返す（`agent_session.value` はローカル claude のセッションUUID、`agent_status: idle`）。`herdr agent prompt` 投入後 3秒間隔ポーリングで `idle → working → done`（非フォーカスのまま `done` に到達し60sまで維持）を観測。**ローカル実行と完全に同じ遷移**で、`observeAgentStatus()` の `done` 即完了ルールがそのまま効く
- **M-3** `--teleport` の実行場所は**ローカル**。`uname -a; whoami; hostname; pwd; git rev-parse --abbrev-ref HEAD` を投入した結果、ローカルマシン（Darwin・ローカルユーザー・ローカル worktree・ローカルブランチ）で実行されていた。`--teleport` はクラウド VM をリモート操作するのではなく、セッションを手元へ引き寄せてローカルで継続するフラグ。ctrl-c で抜けた際の案内も `claude --resume <uuid>` とローカル resume を示し、`claude agents --json --all` にも `"kind": "interactive"` かつローカル `pid` 付きで列挙される（M-8）
- **M-4** 質問待ちは `blocked` を返す（`idle` 誤返却なし）。`AskUserQuestion` で選択肢待ちにしてポーリングすると `blocked` を36秒以上維持し `idle` へは落ちない。`observeAgentStatus()` は `blocked` を待機継続へ倒すため誤完了は起きない。受け入れ基準7を満たす
- **M-5** `claude -p --cloud <id> "<msg>"`（非TTY投函）は**即座に return**し、CLI から観測できる完了シグナルが一切無い。claude.ai の Web UI で確認すると、VM 側は Linux/x86_64/`root`/cwd `/home/user/repo` で正しく実行されていた（`git remote -v produced no output` の地の文含む）。判明事実: (1) VM は Linux/x86_64/`root`、(2) ブランチ名は**ローカル worktree のブランチ名がそのまま持ち込まれる**（S-1 T11と整合）、(3) **`git remote` が1件も無い**ため push も PR 作成もできない。(3) は実測当時 GitHub App 未連携が原因と解釈していたが、S-1 T11 と同じく #81776 のバグの影響が疑われるため、連携済み環境での再実測（本Issueのスコープ外）まで確定的な原因とはしない
- **M-6** クラウド側のターンはローカルへ降りてこない。M-5 の投函から100秒後に同セッションへ `--teleport` でアタッチすると会話履歴は空（`NO PRIOR HISTORY`）。ペイン内容にもローカル transcript にも一切現れないため、`buildHerdrTaskResult()` の transcript 経路・ペイン内容フォールバックのどちらでもクラウドの成果を回収できない。transcript は**クラウドセッションIDでは生成されない**が、teleport セッションのローカル UUID ではローカルターン実行後に生成され、`readFinalReport()` 相当（末尾の非 sidechain アシスタント発言）で `NO PRIOR HISTORY …` が正しく取り出せた。**実装自体は teleport セッションに対して無修正で機能する**（読めるのがローカルターンだけという制約が付くだけ）
- **M-7** `agentGet()` の sessionId は claude.ai の URL として使えない。M-2 で得たローカル UUID を `https://claude.ai/code/<uuid>` で開くと「このセッションは見つかりませんでした」。クラウドセッションIDの stdout 値（`session_01…` 形式）で開くと正しく表示される（M-5）。**ID形式が別系統**（ローカルはUUID、クラウドはULID様式）で、`src/herdr.ts` の `toAgentInfo()` が拾う値をそのまま Slack URL に流用できない
- **M-8** CLI にクラウドセッションを列挙・照会する手段は無い。`claude agents --json --all`（TTY不要）は**ローカルセッションのみ**を返しクラウドセッション（`session_01…`）は1件も含まれない（要素例: `pid`/`cwd`/`kind: "interactive"`/`sessionId`（ローカルUUID）/`status`）。`claude --help` の全サブコマンドにもクラウドセッション照会に相当するものは無い。副次的収穫として `claude agents --json` はローカルセッションの `status`（`idle`/`busy`）を herdr 非依存で返す（`mode: "default"` でも使える完了検知チャネル、本Issueのスコープ外）
- **M-9** ローカルにクラウドセッションIDの記録は残らない。`~/.claude/` 配下をクラウドセッションIDで検索しても本実測自身の transcript しかヒットせず、teleport セッションのローカルレコード（`~/.claude/sessions/<pid>.json`）にもクラウド側への参照は無い。**クラウドセッションIDを得られるのは `claude --cloud` / `claude -p --cloud <id>` の stdout だけ**（`Created cloud session:` / `View: https://claude.ai/code/<id>` 行のパース以外に手段が無い）

## PRD からの差分

1. **4.4-2 の前提（ドライバによる完了検知）が成立しない**。クラウドセッションにアタッチし続けるローカルプロセスが存在せず、`--teleport` はローカル実行に化ける（M-1 / M-3）。既存 `waitForHerdrTask()` の「流用」ではクラウドの完了を検知できない
2. **4.4-3 のフォールバックが両方とも空振りする**。transcript もペイン内容も、クラウド VM で実行されたターンを含まない（M-6）。最終レポートの取得経路は現状ゼロ
3. **9-9 の想定（`agentGet()` の sessionId ＝ クラウドセッションID）が誤り**（M-7）。取得元は起動コマンドの stdout になる
4. **受け入れ基準7 の「質問待ちを `idle` と誤返却しない」は満たされている**（M-4）。ただし検証できたのはローカル TUI に対する herdr の挙動であり、クラウドセッションの質問待ちについては観測経路が無いため未検証
5. **クラウドセッションに git remote が無い**（M-5）。当時は GitHub App 未設定が原因と解釈していたが、#81776（上記「訂正」参照）により実際の連携状態を反映した観測かどうかが不確かになっている。連携済み環境での再実測ができるまで、PR を作るワーカーのクラウド化はこの制約を前提に判断を保留する

## 未実測項目

1. **クラウド VM がリモートを clone する経路（remote あり・独自ブランチ）での挙動全般**
   - 理由: 実測当時は claude.ai 側の GitHub App 連携が未設定と判断していたが、#81776（上記「訂正」参照）によりこの判定自体の信頼性が確定していない。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を適用した場合にクラウド VM がリモート clone 経路へ入るかは未確認で、ブランチ名の決まり方・push 可否・`gh pr list` からの追跡可否がいずれも判定できていない
   - 再現手順: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を付与したうえで M-5 を再実行し、`git remote -v` / `git rev-parse --abbrev-ref HEAD` の出力を比較する
2. **クラウドセッションの質問待ち（`blocked` 相当）の観測**
   - 理由: クラウドセッションを観測できる CLI 経路が無いため（M-8）、状態を取得する手段そのものが存在しない
   - 再現手順: 対話アタッチ（`claude --cloud <session_id>`）がアカウントで有効化された環境で M-4 を再実行する
3. **対話アタッチが有効なアカウントでの完了検知**
   - 理由: 本アカウントでは `claude --cloud <session_id>` の対話アタッチが無効（S-1 T4）。有効なら「クラウドをドライブし続けるローカル TUI」が成立し、PRD 4.4-2 の前提が復活しうる
   - 再現手順: 対話アタッチが有効な環境で herdr ペインから `claude --cloud <session_id>` を実行し、M-2 と同じポーリングを行う
4. **`--teleport` した作業がクラウドセッションへ同期して戻るか**
   - 理由: teleport 側にクラウドの履歴が降りてこないこと（M-6）は確認したが、逆方向（ローカルで進めたターンが claude.ai 側に反映されるか）は確認していない
   - 再現手順: teleport セッションで1ターン実行したのち、claude.ai の当該セッション画面にそのターンが現れるかを確認する

## 実測の副作用

本実測により2件のクラウドセッションが作成された（M-1〜M-4はteleport経由でローカルターンを3回実行、M-5/M-6はクラウドVM側で1ターン実行）。不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。herdr のプローブ用タブは実測後にクローズ済み。

## 関連する別バグ（記録のみ・本Issueのスコープ外）

[anthropics/claude-code#87235](https://github.com/anthropics/claude-code/issues/87235): **スラッシュを含むブランチ名**（`team/branch` 形式）はリモートに存在してもクラウドセッションの revision として解決されない。`--on-branch` に PR の head ブランチを渡す PR 系ワーカー（`dependabot/npm_and_yarn/...` 等）に影響しうる。#81776 とは別バグで、本Issueの修正対象外のため記録のみ。
