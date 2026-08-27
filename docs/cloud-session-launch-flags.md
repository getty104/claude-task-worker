# クラウドセッション起動引数の実測結果

`claude --cloud` が受理する起動フラグを実測した記録。`docs/prd-cloud-worker-execution.md` 4.2 の起動引数表を確定させるための調査（Issue #223、PRD 9-2 / 9-3 / 9-7 に対応）。

- 実測日: 2026-08-27
- 実測バージョン: `claude --version` → `2.1.247 (Claude Code)`
- 後続Issueが失効判定できるよう、`claude --version` がここより新しい場合はフラグの受理可否を再実測すること

## 実測環境

- 実行パス: `/Users/getty104/.local/bin/claude`
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
2. `--cloud` の TTY チェック
3. `--cloud` 固有の各種バリデーション（`--ref`/`--on-branch` の排他など）
4. クラウドセッション作成（ネットワーク）

根拠: 非TTY環境で `claude --cloud "ctw probe" --definitely-not-a-flag` は `error: unknown option` を返し、TTY エラーには到達しない。

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
```
Error: --cloud requires an interactive terminal.
Non-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.
```

### T2: `claude -p --cloud "<description>" "ping"`（非TTY、print + 新規作成）
exit=1
```
Error: --cloud cannot be combined with --print.
Starting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. To message an existing cloud session instead, pass its ID: `claude -p "message" --cloud <session-id>` (find IDs at claude.ai/code).
```

### T3: `claude -p --cloud <session_id> "ping"`（非TTY）
exit=0 → 受理される。既存セッションへのメッセージ投函として成功
```
Sent to cloud session.
Session ID: session_01B7H8tU5MCgei8ezfzeUafF
View: https://claude.ai/code/session_01B7H8tU5MCgei8ezfzeUafF?from=cli&m=0
```
pty 環境（`script` 経由）でも同一結果（exit=0、同一出力）。`-p` + `--cloud <session_id>` の投函は TTY を要求しない。

### T4: `claude --cloud <session_id>`（pty、対話アタッチ）
exit=1
```
Error: Attaching to an existing cloud session is not enabled for your account.
```
注記: T3（投函）は成功するのに、対話アタッチは**アカウント単位で無効**。投函とアタッチは別権限。

### T5: `claude --cloud "<description>" --permission-mode bypassPermissions`（pty）
exit=0 → 受理される。エラーなし、クラウドセッションが作成された
```
Created cloud session: CTW probe
View: https://claude.ai/code/session_012YC7iiz2qkr1qfTvSKYEvk?from=cli&m=0
Resume with: claude --teleport session_012YC7iiz2qkr1qfTvSKYEvk
This checkout is a linked working tree, a submodule or a checkout with a separate git directory; the new upload path does not support that yet, so the working tree is being uploaded the previous way for this session.
```
PRD 4.2 が記載する `Error: a cloud session cannot bypass permissions` は 2.1.247 では再現しなかった。

### T6: `claude --cloud "<description>" --disallowedTools Monitor`（pty）
exit=0 → 受理される。エラーなし、セッション作成
```
Created cloud session: ctw probe
View: https://claude.ai/code/session_013r58uU5RNBJzqRHwLe5Z8v?from=cli&m=0
Resume with: claude --teleport session_013r58uU5RNBJzqRHwLe5Z8v
```
PRD 4.2 が記載する `Error: a cloud session does not enforce tool restrictions yet` は 2.1.247 では再現しなかった。

### T7: 複合受理プローブ（pty）
```
claude --cloud "ctw probe" --append-system-prompt-file /tmp/ctw-sp.txt --model opus --effort high --advisor opus --chrome
```
exit=0 → 5フラグすべて受理される（いずれのフラグに対してもエラーが出ず、セッションが作成された）
```
Created cloud session: ctw probe
View: https://claude.ai/code/session_01B7H8tU5MCgei8ezfzeUafF?from=cli&m=0
Resume with: claude --teleport session_01B7H8tU5MCgei8ezfzeUafF
```
測定手法の注記: 5フラグを1回にまとめたのは、クラウドセッションの新規作成という外部副作用を最小化するため。バリデーションはいずれかのフラグが拒否された時点で `Error:` を出して終了する（T8・T9で確認済み）ため、まとめて受理された＝各フラグが個別にも受理されることを意味する。

### T8: `claude --cloud "<description>" --ref main --on-branch main`（pty）
exit=1 → 排他
```
Error: --on-branch and --ref both set the cloud session's base branch; pass one or the other
```
このエラー文言は、`--ref` と `--on-branch` が**どちらもベースブランチを指定するフラグ**であることを示す。PRD 4.2 が想定していた「`--ref` = ベースブランチ / `--on-branch` = 既存 PR ブランチ上で作業再開」という役割分担とは読み方が異なる。

### T9: `claude --cloud "<description>" --ref ctw-no-such-branch-xyz123`（pty）
exit=1
```
Error: --ref ctw-no-such-branch-xyz123 cannot be honored: the GitHub App is not
set up for this repository, so the session would be seeded from your local
working tree instead. Set up the GitHub integration at https://claude.ai/code,
or drop --ref to seed from local HEAD.
```

### T10: `claude --cloud "<description>" --on-branch ctw-no-such-branch-xyz123`（pty）
exit=1
```
Error: --on-branch ctw-no-such-branch-xyz123 cannot be honored: the GitHub App
is not set up for this repository, so the session would be seeded from your
local working tree instead. Set up the GitHub integration at
https://claude.ai/code, or drop --on-branch to seed from local HEAD.
```

T9 / T10 の解釈（重要）: 拒否理由は「ブランチが存在しない」ではなく「**このリポジトリで GitHub App 連携が未設定**」。したがって、この環境では `--ref` / `--on-branch` の**受理可否そのものが判定できていない**。ブランチ名の妥当性検証まで到達していないため、「既存ブランチ必須か」「リモート未存在ブランチを渡したときの挙動」は未実測。

### T11: GitHub App 未設定時のセッションのシード元（副次的観測）
T5 / T6 / T7 のセッション作成時に毎回以下が出力された:
```
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

- `session_012YC7iiz2qkr1qfTvSKYEvk`（T5）
- `session_013r58uU5RNBJzqRHwLe5Z8v`（T6）
- `session_01B7H8tU5MCgei8ezfzeUafF`（T7・T3・T4）

これらは実測の副産物であり、不要であれば claude.ai/code から削除してよい（削除操作は行っていない）。
