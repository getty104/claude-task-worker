# クラウドセッション起動引数の実測結果

`claude --cloud` が受理する起動フラグを実測した記録。`docs/prd-cloud-worker-execution.md` 4.2 の起動引数表を確定させるための調査（Issue #223、PRD 9-2 / 9-3 / 9-7 に対応）。

- 実測日: 2026-08-27
- 実測バージョン: `claude --version` → `2.1.247 (Claude Code)`
- 後続Issueが失効判定できるよう、`claude --version` がここより新しい場合はフラグの受理可否を再実測すること

## 実測環境

- 実行パス: `~/.local/bin/claude`
- OS: macOS (darwin 25.6.0)
- 実行ディレクトリ: git の **linked worktree**（`.claude/worktrees/<name>`）
- TTY のある実行は `script -q /dev/null <cmd>` で pty を割り当てて実施
- **このリポジトリでは claude.ai 側の GitHub App 連携が未設定**（`--ref` / `--on-branch` の結果に直結する前提）

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
- 4: T8（`--ref`/`--on-branch` 併用の排他）・T9/T10（GitHub App 未設定エラー）はいずれも pty（TTYチェック通過後）でのみ検証しており、この段の内部順序（2・3との相対順を含む）は未確認
- 5: 未実測。ネットワーク呼び出し自体の失敗ケース（認証切れ等）は本調査で確認していない

**この順序は `-p` を併用した新規作成（T1・T2）でのみ裏付けが取れている。** `-p` を伴わない `--cloud` 新規作成時に TTY チェックと他のバリデーションがどの順で評価されるかは実測していない。

## 引数表（PRD 4.2 差し替え用）

| 引数 | ローカル | クラウド | 受理可否 | エラー文言 | 根拠 |
|------|---------|---------|---------|-----------|------|
| `-p <prompt>` | default モードのみ付与 | 付けない（新規作成は print モード非対応） | 新規作成は拒否／既存セッションへの投函は受理 | `Error: --cloud cannot be combined with --print.`（新規作成時） | T2, T3 |
| `--cloud`（値なし・新規作成、非TTY） | なし | 付与 | 拒否（TTY必須） | `Error: --cloud requires an interactive terminal.` | T1 |
| `--cloud <session_id>`（既存セッションへの投函、`-p` 併用） | なし | 付与 | **受理**（TTY不要） | — | T3 |
| `--cloud <session_id>`（対話アタッチ） | なし | 付与 | 拒否（アカウント単位で無効） | `Error: Attaching to an existing cloud session is not enabled for your account.` | T4 |
| `--ref <branch>` | なし | Issue系: ベースブランチ想定 | **未実測**（GitHub App未設定のため到達不可） | `Error: --ref <branch> cannot be honored: the GitHub App is not set up for this repository, so the session would be seeded from your local working tree instead. Set up the GitHub integration at https://claude.ai/code, or drop --ref to seed from local HEAD.` | T9 |
| `--on-branch <branch>` | なし | PR系: 既存PRブランチ想定 | **未実測**（同上） | `Error: --on-branch <branch> cannot be honored: the GitHub App is not set up for this repository, so the session would be seeded from your local working tree instead. Set up the GitHub integration at https://claude.ai/code, or drop --on-branch to seed from local HEAD.` | T10 |
| `--ref` と `--on-branch` の併用 | — | — | 拒否（排他） | `Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other` | T8 |
| `--permission-mode bypassPermissions` | 付与 | 付けない（PRD想定） | **受理される**（PRD想定と異なる） | エラーなし。セッション作成成功 | T5 |
| `--disallowedTools` | 付与 | 付けない（PRD想定） | **受理される**（PRD想定と異なる） | エラーなし。セッション作成成功 | T6 |
| `--append-system-prompt-file` | 付与 | 要検証（PRD 9-2） | **受理される**（起動引数としては拒否されない。VM側での反映は未確認） | エラーなし | T7 |
| `--model` / `--effort` / `--advisor` / `--chrome` | 付与 | 要検証（PRD 9-3） | **受理される**（起動引数としては拒否されない。VM側での反映は未確認） | エラーなし | T7 |

## 測定ログ（verbatim）

### T1: `claude --cloud "<description>"`（非TTY、新規作成）
exit=1
```text
Error: --cloud requires an interactive terminal.
Non-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.
```

### T2: `claude -p --cloud "<description>" "ping"`（非TTY、print + 新規作成）
exit=1
```text
Error: --cloud cannot be combined with --print.
Starting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. To message an existing cloud session instead, pass its ID: `claude -p "message" --cloud <session-id>` (find IDs at claude.ai/code).
```

### T3: `claude -p --cloud <session_id> "ping"`（非TTY）
exit=0 → 受理される。既存セッションへのメッセージ投函として成功
```text
Sent to cloud session.
Session ID: session_<REDACTED-1>
View: https://claude.ai/code/session_<REDACTED-1>?from=cli&m=0
```
pty 環境（`script` 経由）でも同一結果（exit=0、同一出力）。`-p` + `--cloud <session_id>` の投函は TTY を要求しない。

### T4: `claude --cloud <session_id>`（pty、対話アタッチ）
exit=1
```text
Error: Attaching to an existing cloud session is not enabled for your account.
```
注記: T3（投函）は成功するのに、対話アタッチは**アカウント単位で無効**。投函とアタッチは別権限。

### T5: `claude --cloud "<description>" --permission-mode bypassPermissions`（pty）
exit=0 → 受理される。エラーなし、クラウドセッションが作成された
```text
Created cloud session: CTW probe
View: https://claude.ai/code/session_<REDACTED-2>?from=cli&m=0
Resume with: claude --teleport session_<REDACTED-2>
This checkout is a linked working tree, a submodule or a checkout with a separate git directory; the new upload path does not support that yet, so the working tree is being uploaded the previous way for this session.
```
PRD 4.2 が記載する `Error: a cloud session cannot bypass permissions` は 2.1.247 では再現しなかった。

### T6: `claude --cloud "<description>" --disallowedTools Monitor`（pty）
exit=0 → 受理される。エラーなし、セッション作成
```text
Created cloud session: ctw probe
View: https://claude.ai/code/session_<REDACTED-3>?from=cli&m=0
Resume with: claude --teleport session_<REDACTED-3>
```
PRD 4.2 が記載する `Error: a cloud session does not enforce tool restrictions yet` は 2.1.247 では再現しなかった。

### T7: 複合受理プローブ（pty）
```bash
claude --cloud "ctw probe" --append-system-prompt-file /tmp/ctw-sp.txt --model opus --effort high --advisor opus --chrome
```
exit=0 → 5フラグすべて受理される（いずれのフラグに対してもエラーが出ず、セッションが作成された）
```text
Created cloud session: ctw probe
View: https://claude.ai/code/session_<REDACTED-1>?from=cli&m=0
Resume with: claude --teleport session_<REDACTED-1>
```
測定手法の注記: 5フラグを1回にまとめたのは、クラウドセッションの新規作成という外部副作用を最小化するため。バリデーションはいずれかのフラグが拒否された時点で `Error:` を出して終了する（T8・T9で確認済み）ため、まとめて受理された＝各フラグが個別にも受理されることを意味する。

### T8: `claude --cloud "<description>" --ref main --on-branch main`（pty）
exit=1 → 排他
```text
Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other
```
このエラー文言は、`--ref` と `--on-branch` が**どちらもベースブランチを指定するフラグ**であることを示す。PRD 4.2 が想定していた「`--ref` = ベースブランチ / `--on-branch` = 既存 PR ブランチ上で作業再開」という役割分担とは読み方が異なる。

### T9: `claude --cloud "<description>" --ref ctw-no-such-branch-xyz123`（pty）
exit=1
```text
Error: --ref ctw-no-such-branch-xyz123 cannot be honored: the GitHub App is not
set up for this repository, so the session would be seeded from your local
working tree instead. Set up the GitHub integration at https://claude.ai/code,
or drop --ref to seed from local HEAD.
```

### T10: `claude --cloud "<description>" --on-branch ctw-no-such-branch-xyz123`（pty）
exit=1
```text
Error: --on-branch ctw-no-such-branch-xyz123 cannot be honored: the GitHub App
is not set up for this repository, so the session would be seeded from your
local working tree instead. Set up the GitHub integration at
https://claude.ai/code, or drop --on-branch to seed from local HEAD.
```

T9 / T10 の解釈（重要）: 拒否理由は「ブランチが存在しない」ではなく「**このリポジトリで GitHub App 連携が未設定**」。したがって、この環境では `--ref` / `--on-branch` の**受理可否そのものが判定できていない**。ブランチ名の妥当性検証まで到達していないため、「既存ブランチ必須か」「リモート未存在ブランチを渡したときの挙動」は未実測。

### T11: GitHub App 未設定時のセッションのシード元（副次的観測）
T5 / T6 / T7 のセッション作成時に毎回以下が出力された:
```text
This checkout is a linked working tree, a submodule or a checkout with a separate git directory; the new upload path does not support that yet, so the working tree is being uploaded the previous way for this session.
```
→ GitHub App 未設定のリポジトリでは、クラウドセッションは**ローカルの作業ツリーをアップロードしてシードされる**（リモートを clone するのではない）。PRD 4.4-1 が前提とする「クラウド VM は自前で clone するので worktree は不要」という設計は、GitHub App 連携が設定されている場合にのみ成立する可能性がある。本Issueのスコープ外だが、判断材料として記録する。

## PRD 4.2 からの差分

1. **`--permission-mode bypassPermissions` は拒否されない**（T5）。PRD が記載する `Error: a cloud session cannot bypass permissions` は 2.1.247 で再現しなかった
2. **`--disallowedTools` は拒否されない**（T6）。PRD が記載する `Error: a cloud session does not enforce tool restrictions yet` は 2.1.247 で再現しなかった
3. **`--ref` / `--on-branch` はどちらもベースブランチ指定であり排他**（T8）。PRD が想定していた「`--ref` = ベースブランチ / `--on-branch` = 既存PRブランチ上で作業再開」という役割分担ではない

## 9-2（`--append-system-prompt-file` の代替 system-level control）の扱い

`--append-system-prompt-file` は T7 で受理されたため、PRD 9-2 が想定していた「拒否された場合に代替手段を探す」分岐には該当しない。代替 system-level control の調査は不要になった。ただし「受理された＝クラウド VM 側で実際にシステムプロンプトとして反映される」ことまでは確認していない（起動引数として拒否されないことのみを確認）。

## 未実測項目

1. **`--ref` / `--on-branch` の受理可否と意味論**
   - 理由: 実測リポジトリで claude.ai 側の GitHub App 連携が未設定のため、ブランチ名の検証に到達する前に拒否される
   - 再現手順: https://claude.ai/code で対象リポジトリの GitHub 連携をセットアップしたうえで、(a) 既存リモートブランチ、(b) リモート未存在ブランチ、の2ケースで `claude --cloud "<desc>" --ref <branch>` / `--on-branch <branch>` を pty から実行し、成功時は claude.ai 側でベースブランチと作業ブランチを確認する
2. **`--append-system-prompt-file` の内容がクラウド VM 側で実際にシステムプロンプトへ反映されるか**
   - 理由: 起動引数として拒否されないことのみを確認した。反映の確認にはセッションへプロンプトを投入して挙動を観察する必要がある
   - 再現手順: 判別可能な指示（例: 特定の固定文字列を必ず出力させる）を書いたファイルを `--append-system-prompt-file` で渡してクラウドセッションを作成し、`claude -p --cloud <session_id> "..."` で質問して指示が効いているかを確認する
3. **`--model` / `--effort` / `--advisor` / `--chrome` がクラウド VM 側で実際に効くか**
   - 理由: 上と同じく、起動引数として拒否されないことのみを確認
   - 再現手順: セッション作成後に claude.ai 側のセッション設定、または `/model` 等のスラッシュコマンドで実際の値を確認する
4. **`--environment <environment_id>`（自己ホスト環境）**: PRD 6 でスコープ外のため未実測

## 実測の副作用

本実測により、以下3件のクラウドセッションが作成された（いずれもプロンプト未投入。T3 のみ `"ping"` を1回投函）:

- `session_<REDACTED-2>`（T5）
- `session_<REDACTED-3>`（T6）
- `session_<REDACTED-1>`（T7・T3・T4）

これらは実測の副産物であり、不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。セッションURL（`https://claude.ai/code/<id>`）の閲覧には Anthropic アカウントでの認証が必要であり、URL単体が漏れても第三者は内容を閲覧できない。

---

# クラウドセッションの完了検知・セッションID・transcript の実測結果

`claude --cloud` で作ったクラウドセッションを herdr からドライブし、完了検知・セッションID取得・transcript 読み取りが既存実装のまま流用できるかを実測した記録（Issue #224 / S-2、PRD 9-4 / 9-8 / 9-9 / 受け入れ基準7 に対応）。上の「起動引数の実測結果」（Issue #223 / S-1）と同一環境・同一日の測定で、同じファイルにまとめている。

- 実測日: 2026-08-27
- 実測バージョン: `claude --version` → `2.1.247 (Claude Code)` / `herdr --version` → `herdr 0.8.2`
- `~/.config/claude-task-worker/config.json` の `mode`: `"herdr"`
- 挙動はバージョン依存のため、いずれかがここより新しい場合は再実測すること

## 実測環境

- 実行場所: herdr タブ（`tab create --cwd <worktree> --no-focus`）のルートペイン。`script` による疑似 pty ではなく**実TTY**
- 実行ディレクトリ: git の linked worktree（`.claude/worktrees/clever-zenith-6645`）
- S-1 と同じく、このリポジトリでは claude.ai 側の **GitHub App 連携が未設定**

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
| 4.4-5 | クラウドセッションの作業ブランチ名をローカルから取得できるか | **取得手段は無い**。CLI にクラウドセッションを列挙・照会する経路が無く（M-8）、ローカルの `~/.claude/sessions/<pid>.json` にもクラウドセッションとの紐付けは記録されない（M-9）。ブランチ名自体は claude.ai の Web UI でのみ確認できた（M-5） |

## 測定ログ（verbatim）

### M-1: `claude --cloud "<desc>"` は実TTYでも即終了する

herdr ペイン（実TTY）で実行:

```console
$ claude --cloud "CTW S-2 completion probe"
Created cloud session: CTW S-2 completion probe
View: https://claude.ai/code/session_<REDACTED-4>?from=cli&m=0
Resume with: claude --teleport session_<REDACTED-4>
This checkout is a linked working tree, a submodule or a checkout with a separate git directory; the new upload path does not support that yet, so the working tree is being uploaded the previous way for this session.
$
```

直後の観測:

```console
$ herdr pane process-info --pane <pane>
  → foreground_processes: [{ "name": "zsh", ... }]     # claude は残っていない
$ herdr agent get <pane>
  {"error":{"code":"agent_not_found","message":"agent target <pane> not found"},"id":"cli:agent:get"}
```

シェルプロンプトが戻り、フォアグラウンドは zsh。**TUI に留まらないため herdr は agent を検出できない**。S-1 の T5 が `script` 疑似 pty で観測した exit=0 は pty 起因ではなく、実TTYでも同じ挙動だった。

### M-2: `claude --teleport <session_id>` はアタッチでき、状態遷移も正常

同じペインで実行すると TUI が起動し、`agent get` が agent を返した:

```console
$ claude --teleport session_<REDACTED-4>
 ▐▛███▛█   Claude Code v2.1.247
▝▜██████▀  Opus 5 (1M context) with high effort · Claude Max
  ▝▝ ▝▝    ~/programming/Claude/claude-task-worker/.claude/worktrees/clever-zenith-6645
⏺ Session resumed
```

```json
{"agent":"claude","agent_session":{"agent":"claude","kind":"id","source":"herdr:claude","value":"f9342ab2-b410-41e2-af7d-c3e3eb1ad598"},"agent_status":"idle", ... }
```

`herdr agent prompt` でプロンプトを投入し、3秒間隔でポーリングした結果（タブは非フォーカスのまま）:

```text
t=3s   idle
t=6s   working
t=9s   working
t=12s  done      ← 以降 60s まで done を維持
```

**ローカル実行と完全に同じ `idle` → `working` → `done` の遷移**。非フォーカスで `idle` に落ちず `done` に留まるため、`observeAgentStatus()` の `done` 即完了ルールがそのまま効く。

### M-3: `--teleport` の実行場所は**ローカル**

M-2 のプロンプトは `uname -a; whoami; hostname; pwd; git rev-parse --abbrev-ref HEAD` の実行と verbatim 報告を依頼したもの。ペインに出た結果:

```text
Darwin MacBook-Air-2.local 25.6.0 Darwin Kernel Version 25.6.0: ... arm64
<local-user>
MacBook-Air-2.local
~/programming/Claude/claude-task-worker/.claude/worktrees/clever-zenith-6645
clever-zenith-6645
```

**ローカルマシン（Darwin / ローカルユーザー / ローカル worktree / ローカルブランチ）で実行されている**。`--teleport` はクラウド VM をリモート操作するのではなく、セッションを手元へ引き寄せてローカルで継続するフラグ。ctrl-c で抜けた際の案内も `Resume this session with: claude --resume f9342ab2-…` とローカル resume を示す。

`claude agents --json --all` でも同セッションは `"kind": "interactive"` かつローカル `pid` 付きで列挙される（M-8 参照）。

### M-4: 質問待ちは `blocked` を返す（`idle` 誤返却なし）

teleport セッションに「`AskUserQuestion` ツールで質問だけして他は何もするな」と投入し、選択肢が表示された状態でポーリング:

```text
t=3s   done      ← 直前ターンの残り
t=6s   blocked
t=9s   blocked
...
t=36s  blocked   ← 36秒まで blocked を維持
```

**`blocked` を返し続け、`idle` へは落ちない**。`observeAgentStatus()` は `blocked` を `running`（待機継続）へ倒すため、質問待ちが完了扱いされる誤判定は発生しない。受け入れ基準7 のうち「質問待ちを `idle` として誤返却しないこと」は満たされている。

### M-5: `claude -p --cloud <id>` はクラウド VM で実行されるが、CLI からは何も観測できない

新規セッション `session_<REDACTED-5>` を作成し、非TTY（通常のシェル）から投函:

```console
$ claude -p --cloud session_<REDACTED-5> "Run this and report the raw output verbatim, nothing else: uname -a; whoami; hostname; pwd; git rev-parse --abbrev-ref HEAD; git remote -v"
Sent to cloud session.
Session ID: session_<REDACTED-5>
View: https://claude.ai/code/session_<REDACTED-5>?from=cli&m=0
```

**即座に return する**（実行完了を待たない）。exit code も出力も「送った」ことしか示さず、**完了シグナルにできる情報が一切無い**。

claude.ai の Web UI で確認すると、クラウド VM 側では正しく実行されていた:

```text
Linux vm 6.18.44-fc-v21 #1 SMP PREEMPT_DYNAMIC @0 x86_64 x86_64 x86_64 GNU/Linux
root
vm
/home/user/repo
clever-zenith-6645
```

続けてモデルの地の文:

```text
git remote -v produced no output — there are no remotes configured on this clone.
```

判明した事実:

1. クラウド VM は Linux / x86_64 / `root` / cwd `/home/user/repo`
2. ブランチ名は**ローカル worktree のブランチ名がそのまま持ち込まれている**（GitHub App 未設定のためワークツリーがアップロードされてシードされた結果。S-1 T11 と整合）
3. **`git remote` が1件も無い**。この構成のクラウドセッションは push も PR 作成もできない

3 は `exec-issue` をクラウド化する前提そのものに関わる（GitHub App 連携が未設定のままでは、クラウドセッションは成果物を GitHub へ出せない）。本Issueのスコープ外だが判断材料として記録する。

### M-6: クラウド側のターンはローカルへ降りてこない

M-5 の投函から 100 秒後、同じセッションへ `claude --teleport session_<REDACTED-5>` でアタッチした。TUI は `⏺ Session resumed` を表示したが会話履歴は空。「直前までのやり取りを教えて」と尋ねた応答:

```text
NO PRIOR HISTORY

このメッセージが会話の最初のユーザーメッセージです。それ以前のやり取りはありません。
（中略）
「別マシンから継続中のセッション」という注記はありますが、実際に引き継がれた会話履歴はこちら側には存在しません。
```

**クラウド VM で実行されたターン（M-5 の結果）は、teleport してもローカルには一切現れない。** ペイン内容にもローカル transcript にも入らないため、`buildHerdrTaskResult()` の transcript 経路・ペイン内容フォールバックのどちらでもクラウドの成果を回収できない。

transcript 自体の生成状況:

```console
# クラウドセッションID では存在しない
$ ls ~/.claude/projects/*/session_<REDACTED-4>.jsonl
ls: ...: No such file or directory

# teleport セッションのローカル UUID では、ローカルターン実行後に生成される
$ ls -la ~/.claude/projects/-Users-…-clever-zenith-6645/f2364f35-be0f-493b-8dc9-d38116d2c07d.jsonl
-rw-------  1 <local-user>  staff  106574 Aug 27 22:34 …
```

生成された transcript に対して `readFinalReport()` 相当（末尾から最初の非 sidechain アシスタント発言）を適用すると、上記の `NO PRIOR HISTORY …` が正しく取り出せた。**`findTranscriptPath()` / `readFinalReport()` の実装自体は teleport セッションに対して無修正で機能する**（読めるのがローカルターンだけ、という制約が付くだけ）。

### M-7: `agentGet()` の sessionId は claude.ai の URL として使えない

M-2 で得た `agent_session.value`（`f9342ab2-b410-41e2-af7d-c3e3eb1ad598`）を `https://claude.ai/code/<value>` として開いた結果:

```text
このセッションは見つかりませんでした
削除されたか、アクセス権限がない可能性があります。
```

一方、`claude --cloud` の stdout に出たクラウドセッションID（`session_<REDACTED-5>`）で開くと、投函したメッセージと VM 側の実行結果が表示された（M-5）。

**ID の形式からして別系統**（ローカルは UUID、クラウドは `session_01` プレフィックスの ULID 様式）。`src/herdr.ts` の `toAgentInfo()` が拾う `agent_session.value` を Slack 通知の URL に流用することはできない。

### M-8: CLI にクラウドセッションを列挙・照会する手段は無い

`claude agents --json --all`（ヘルプ上「アクティブなセッション（interactive と background）を JSON 配列で出力。TTY 不要」）を実行したが、**返るのはローカルセッションのみ**でクラウドセッション（`session_01…`）は1件も含まれない。要素の形は:

```json
{
  "pid": 36521,
  "cwd": "~/programming/Claude/claude-task-worker/.claude/worktrees/clever-zenith-6645",
  "kind": "interactive",
  "startedAt": 1787837238191,
  "sessionId": "f9342ab2-b410-41e2-af7d-c3e3eb1ad598",
  "name": "clever-zenith-6645-88",
  "status": "idle"
}
```

`claude --help` のサブコマンド（`agents` / `auth` / `auto-mode` / `doctor` / `gateway` / `import` / `install` / `mcp` / `plugin` / `project` / `setup-token` / `ultrareview` / `update`）にも、クラウドセッションの一覧・状態照会にあたるものは無い。

副次的な収穫として、`claude agents --json` は**ローカル**セッションについて `status`（`idle` / `busy`）を TTY 無しで返す。herdr に依存しない完了検知チャネルとして使える（`mode: "default"` でも効く）。本Issueのスコープ外だが記録する。

### M-9: ローカルにクラウドセッションIDの記録は残らない

`~/.claude/` 配下をクラウドセッションIDで検索した結果、ヒットしたのは**本実測セッション自身の transcript**（コマンドを実行した記録）だけで、claude が管理する紐付けレコードは存在しなかった。teleport セッションのローカルレコード `~/.claude/sessions/<pid>.json` にもクラウド側への参照は無い:

```json
{"pid":36521,"sessionId":"f9342ab2-b410-41e2-af7d-c3e3eb1ad598","cwd":"…/clever-zenith-6645","startedAt":1787837238191,"procStart":"Thu Aug 27 13:27:17 2026","version":"2.1.247","peerProtocol":1,"peerFeatures":["notify_idle","artifact_yield"],"kind":"interactive","entrypoint":"cli","pidDomain":"darwin","messagingSocketPath":"/tmp/cc-socks/36521.sock","name":"clever-zenith-6645-88","nameSource":"derived","nameSince":1787837238191,"status":"idle","updatedAt":1787837445256,"statusUpdatedAt":1787837445256}
```

**クラウドセッションIDを得られるのは `claude --cloud` / `claude -p --cloud <id>` の stdout だけ**。Slack へセッション URL を載せる実装（#238）は、起動コマンドの標準出力を `Created cloud session:` / `View: https://claude.ai/code/<id>` 行としてパースする以外に手段が無い。

## PRD からの差分

1. **4.4-2 の前提（ドライバによる完了検知）が成立しない**。クラウドセッションにアタッチし続けるローカルプロセスが存在せず、`--teleport` はローカル実行に化ける（M-1 / M-3）。既存 `waitForHerdrTask()` の「流用」ではクラウドの完了を検知できない
2. **4.4-3 のフォールバックが両方とも空振りする**。transcript もペイン内容も、クラウド VM で実行されたターンを含まない（M-6）。最終レポートの取得経路は現状ゼロ
3. **9-9 の想定（`agentGet()` の sessionId ＝ クラウドセッションID）が誤り**（M-7）。取得元は起動コマンドの stdout になる
4. **受け入れ基準7 の「質問待ちを `idle` と誤返却しない」は満たされている**（M-4）。ただし検証できたのはローカル TUI に対する herdr の挙動であり、クラウドセッションの質問待ちについては観測経路が無いため未検証
5. **GitHub App 未設定のクラウドセッションには git remote が無い**（M-5）。PR を作るワーカーをこの構成のままクラウド化することはできない

## 未実測項目

1. **GitHub App 連携済みリポジトリでの挙動全般**
   - 理由: 実測リポジトリで claude.ai 側の GitHub App 連携が未設定。クラウド VM がリモートを clone する経路（remote あり・独自ブランチ）に入れないため、ブランチ名の決まり方・push 可否・`gh pr list` からの追跡可否がいずれも判定できない
   - 再現手順: https://claude.ai/code で対象リポジトリの GitHub 連携をセットアップしたうえで M-5 を再実行し、`git remote -v` / `git rev-parse --abbrev-ref HEAD` の出力を比較する
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

本実測により以下2件のクラウドセッションが作成された:

- `session_<REDACTED-4>`（M-1 / M-2 / M-3 / M-4。teleport 経由でローカルターンを3回実行）
- `session_<REDACTED-5>`（M-5 / M-6。クラウド VM 側で1ターン実行）

不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。あわせて herdr のプローブ用タブは実測後にクローズ済み。
