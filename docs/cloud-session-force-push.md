# クラウドセッションからの force-push 可否の実測結果

クラウドセッションで PR の head ブランチを開き、rebase 後の force-push が成立するかを実測した記録（Issue #227 / #333、PRD 9-6 / 5章の `resolve-conflict` 適合性に対応）。`resolve-conflict` を Phase 1 で非対応（✕）に据え置いてよいかの根拠になる。

本ファイルは2回の実測を含む。**結論は2回目（F-3 以降）が正**で、1回目（F-1 / F-2）は Claude Code 側のバグでセッション作成前に止まった記録として残してある。

| 実測 | 日付 | バージョン | 観測地点 | 到達点 |
|---|---|---|---|---|
| 1回目（F-1 / F-2、Issue #227） | 2026-08-28 | `2.1.248` | ローカル（macOS、pty からセッション作成を試行） | セッション作成前に拒否（#81776 のバグ）。**force-push は未測定** |
| 2回目（F-3 〜 F-6、Issue #333） | 2026-08-30 | `2.1.251` | **クラウドセッション内から**（実行中のセッション自身で git を操作） | **force-push の成否まで到達。可否が確定** |

- 後続Issueが失効判定できるよう、`claude --version` が `2.1.251` より新しい場合は再実測すること
- 1回目の実測メタ情報: 先行実測（Issue #223 / #224、`docs/cloud-session-launch-flags.md`）は `2.1.247` での測定。1回目でパッチバージョンが1つ進んでいるが、**`--on-branch` の挙動は 2.1.247 と同一だった**（F-1 / F-2 が T10 と同一文言）。#223 の `--ref` / `--on-branch` に関する記述はこの範囲で 2.1.248 でも有効

## 実測環境

- 実行パス: `~/.local/bin/claude`
- OS: macOS (darwin 25.6.0)
- 実行ディレクトリ: git の **linked worktree**（`.claude/worktrees/<name>`）
- pty は `script -q /dev/null <cmd>` で割り当て
- 実測当時は claude.ai 側の GitHub App 連携が未設定と判断していたが（#223 T9 / T10 と同一の前提。本実測でも再確認、下記 F-1 / F-2）、これは Claude Code 側のバグ（[anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776)、2026-08-29 時点 OPEN）による誤判定だったと後日判明している。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を付与するとセッション作成には成功することを smoke test（claude 2.1.250、2026-08-29、public / private 双方）で確認済み。ただし force-push の可否など本実測の観測項目は未確認のまま
- 測定時点でこのリポジトリに **Open な PR は0件**だったため、要件の「PR の head ブランチ」には実在するリモートブランチ（`feat/agent-browser-integration`）を代用した

## 結論（2026-08-30 再実測が正）

**クラウドセッションから force-push は可能。** 任意の固定名ブランチの自己作成と push も可能で、「push はセッションの作業ブランチのみ」という制約は**実在しない**。一方で**ref の削除だけは HTTP 403 で拒否される**（新規作成・force 更新は同じ経路で通る）。

| 検証したいこと | 結果 | 根拠 |
|---|---|---|
| 既存ブランチへの force-push が可能か | **可能**。通常 push は non-fast-forward で拒否され、`--force-with-lease` は `(forced update)` で成功。GitHub 側の SHA も実際に巻き戻った | F-3 |
| 任意の固定名ブランチ（`cc-ui-design-<N>` 相当）を自己作成して push できるか | **できる**。`--ref` で作られた作業ブランチとは別に `git checkout -b cc-ui-design-999` → `git push -u` が成功 | F-4 |
| 「push はセッションの作業ブランチのみ」制約が実在するか | **実在しない**。作業ブランチ上から別名 ref への push が成功 | F-4 / F-5 |
| 固定名ブランチが特別扱いされるか | **されない**。`cc-ui-design-999` と `ctw-probe-333-*` で挙動差なし | F-4 / F-5 |
| ref の**削除**が可能か | **不可**。`git push --delete` / zero-oid refspec のいずれも `HTTP 403`。直後に同じ ref への force 更新は成功するため、削除操作に固有の拒否 | F-6 |
| `--on-branch` で作成したセッション**自身**による force-push | **測定不能**（クラウドセッション内から入れ子のセッションを作成できない。理由は F-7） | F-7 |

再実測は**クラウドセッション内から**行った。1回目がセッション作成の手前で止まったのに対し、2回目は「実行中のクラウドセッション自身に git を叩かせる」ことで、セッション作成のゲートを迂回して push の可否そのものを直接観測している。

この結果により、1回目の結論表・PRD 9-6 の「未測定」・「未実測項目」1〜3 はすべて解消した（詳細は各節）。あわせて、**旧 P-6 / M-5 の「VM に `git remote` が0件で push 先が存在しない」という観測は、少なくとも現行のクラウド実行環境には当てはまらない**（F-5 の環境節）。

### 1回目（2026-08-28）時点の結論（履歴）

**force-push の可否は、1回目の実測時点では測定できていない。** 到達を阻んだゲートは2つで、当時はどちらも GitHub App 連携の未設定が理由と解釈していたが、実際には #81776 のバグによる誤判定であり、「force-push が拒否された」ことを意味するものではない（下記のとおり訂正）。

**追記（2026-08-29 smoke test）**: `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` を付与した `--on-branch <PR head>` の実測により、`--on-branch` の意味論が確定した——クラウドセッションは指定した PR の head ブランチ上で**直接作業**し、push するとその PR が更新される（新しいブランチは切られない）。これにより本実測が到達できなかった「PR の head ブランチをクラウドセッションの作業ブランチにできるか」（F-1 の手前で止まっていた論点）が解消し、再測定の前提が整った。ただし**force-push 可否そのものの実測は本 smoke test のスコープ外**であり、下記「未実測項目」の1〜3は Phase 2 の残課題として引き続き未実測のまま維持する（可否を実測したわけではない）。—— この段落は 2026-08-29 時点の判断であり、**1〜3 はいずれも 2026-08-30 の再実測（F-3 / F-4 / F-5）で解消済み**。

1. **`--on-branch` が前段で拒否される**（F-1 / F-2）。理由はブランチ名の妥当性でも GitHub App 連携の未設定でもなく、#81776 のバグによる誤判定。回避策適用前の本実測では「PR の head ブランチをクラウドセッションの作業ブランチにする」という前提の成立可否まで到達できていない
2. **`--on-branch` を付けずに作成したセッションでも push が資格情報に到達しない**。実測当時は GitHub App 未設定が理由と解釈していたクラウドセッションがローカル作業ツリーのアップロードでシードされ、VM 側の clone には `git remote` が0件で、`git push --dry-run` が `fatal: No configured push destination.` で終わる（`docs/cloud-graphql-proxy-limits.md` の P-6、`docs/cloud-session-launch-flags.md` の M-5 / T11。いずれも #81776 の誤判定バグの影響下での観測であり、連携済み環境での再実測が必要）。**これも push の可否を測ってはいない**（push 先が存在しないだけ）

1回目時点の結論表（**すべて 2026-08-30 の再実測で解消済み**。現行の結論は上の「結論（2026-08-30 再実測が正）」を参照）:

| 検証したいこと | 結果 | 根拠 |
|---|---|---|
| PR の head ブランチをクラウドセッションの作業ブランチにできるか | **本実測では未測定**（#81776 のバグでセッション作成前に拒否。回避策の再実測が必要） | F-1 |
| 固定名ブランチ（`ctw-last-run-<worker>` 相当）を作業ブランチにできるか | **本実測では未測定**（同上。拒否文言は F-1 と同一） | F-2 |
| 拒否理由がブランチの実在有無に依存するか | **依存しない**。実在するブランチ（F-1）と実在しないブランチ（F-2）で文言が完全に一致（この事実は #81776 のバグの誤判定条件とも整合する） | F-1 / F-2 |
| 「push はセッションの作業ブランチのみ」制約が実在するか | **未確認**。本実測では制約に到達する前段で止まる | F-1 / F-2 / 既測 P-6 |
| rebase 後の force-push が push 制約に抵触するか | **本実測では未測定**。回避策適用後の再実測が必要 | — |

## 測定ログ（verbatim）

### F-1: `claude --cloud "<desc>" --on-branch <実在するリモートブランチ>`（pty）

Open な PR が無いため、PR の head ブランチの代わりに実在するリモートブランチ `feat/agent-browser-integration` を指定。

exit=1
```
Error: --on-branch feat/agent-browser-integration cannot be honored: the GitHub
App is not set up for this repository, so the session would be seeded from your
local working tree instead. Set up the GitHub integration at
https://claude.ai/code, or drop --on-branch to seed from local HEAD.
```

### F-2: `claude --cloud "<desc>" --on-branch ctw-last-run-update-coding-guidelines`（pty）

`src/last-run-pr.ts` が `git push --force origin HEAD:refs/heads/ctw-last-run-<worker>` で使う固定名ブランチ（＝セッションの作業ブランチではないブランチ）の実名。リモートには未存在。

exit=1
```
Error: --on-branch ctw-last-run-update-coding-guidelines cannot be honored: the
GitHub App is not set up for this repository, so the session would be seeded
from your local working tree instead. Set up the GitHub integration at
https://claude.ai/code, or drop --on-branch to seed from local HEAD.
```

### F-1 / F-2 の解釈

1. **拒否理由は一貫して同一文言**であり、ブランチの種類（PR の head か固定名か）にも実在有無にも依存しない。#223 T9 / T10 は実在しないブランチ名で測定していたため「ブランチが無いから拒否された可能性」を排除できていなかったが、F-1 が**実在するリモートブランチ**でも同一文言を返したことで、**このチェックがブランチ名検証より前段にある**ことが確定した。当時はこれを「GitHub App 未設定」と解釈していたが、後日 [anthropics/claude-code#81776](https://github.com/anthropics/claude-code/issues/81776) として、GitHub App 連携済みのリポジトリでも同じチェックが `status is null` と誤判定してこの文言を返すバグであることが判明した（2026-08-29 時点 OPEN）。回避策 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` の適用でセッション作成には成功することを smoke test で確認済み（本ファイルの再実測は未実施）
2. 拒否はクラウドセッション作成（ネットワーク）より前段のため、**本実測ではクラウドセッションが1件も作成されていない**（#223 のパースとバリデーションの順序と整合）
3. したがって「セッションの作業ブランチではないブランチへの force-push が拒否されるか」（要件2）も、**拒否の観測に到達していない**。固定名ブランチが特別扱いされるかどうかは未判定。回避策適用後の再実測が必要

## 再実測（2026-08-30、クラウドセッション内から）

### 実測環境（2回目）

- 実測日: 2026-08-30
- `claude --version` → **`2.1.251 (Claude Code)`**
- **観測地点: クラウドセッションの内側**。`claude-task-worker` の `exec-issue` ワーカーが `--cloud` で起動した Issue #333 のタスクセッション自身が、自分の VM 上で git を実行して測定した。1回目がセッション作成のゲート（#81776）で止まったのに対し、**すでに走っているセッションから測る**ことでそのゲートを迂回している
- OS: Linux（コンテナ。`claude-code_2-1-251_agent`）
- セッションの作成引数: `--ref cc-epic-328`（Issue #333 の parent が #328 のため）。セッションは `claude/task-worker-exec-333-uxfbvz` という作業ブランチを**自分で切っており**、`--ref` の確定済み意味論（`claude/<description由来>-<6文字>`）と一致する
  - 測定開始時点で `HEAD == origin/cc-epic-328`（`1c3943c`）、作業ブランチはリモート未存在
- git remote: `origin  https://github.com/getty104/claude-task-worker`（fetch / push とも設定済み）
- 認証: `credential.https://github.com.helper = !/usr/bin/gh auth git-credential`（`credential.interactive false`）
- 通信経路: `HTTPS_PROXY=http://127.0.0.1:42321`（エージェントプロキシ）。`git config http.proxy` は未設定で env 経由。**GraphQL を403にするのと同じプロキシを通したうえで push は成功している**（`docs/cloud-graphql-proxy-limits.md` のゲートは git の push には及ばない）
- テスト用ブランチ: `ctw-probe-333-forcepush` / `ctw-probe-333-other` / `cc-ui-design-999`。いずれも使い捨てで、実作業中のブランチや PR の head は使っていない。スラッシュを含まないため [#87235](https://github.com/anthropics/claude-code/issues/87235) との交絡はない
- 判定は git の出力だけでなく **GitHub 側のブランチ SHA**（GitHub MCP `list_branches` および `git ls-remote`）で裏取りした

### F-3: 既存ブランチへの force-push（`--force-with-lease`）

`origin/main` を起点に使い捨てブランチを作り、コミットAを push（`SHA_A=8fdfa8b`）。次に `git reset --hard origin/main` で履歴を巻き戻して**別内容の**コミットB（`SHA_B=3db2632`）を作り、非 fast-forward の状態を作ってから push した。

**(a) 通常 push（force が実際に必要だったことの裏付け）** — exit=1
```
To https://github.com/getty104/claude-task-worker
 ! [rejected]        HEAD -> ctw-probe-333-forcepush (non-fast-forward)
error: failed to push some refs to 'https://github.com/getty104/claude-task-worker'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. If you want to integrate the remote changes,
hint: use 'git pull' before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
```

**(b) `git push origin HEAD:refs/heads/ctw-probe-333-forcepush --force-with-lease=...:8fdfa8b...`** — exit=0
```
To https://github.com/getty104/claude-task-worker
 + 8fdfa8b...3db2632 HEAD -> ctw-probe-333-forcepush (forced update)
```

**GitHub 側の裏取り**: `list_branches` が `ctw-probe-333-forcepush` → `3db26320d2f0c44edf3e0a05f9a6a6eb3b64657c` を返し、リモートの ref が実際に `SHA_A` から `SHA_B` へ**巻き戻った**ことを確認。`resolve-pr-conflict` が使う `--force-with-lease`（`--force` ではない）で成功している。

### F-4: 任意の固定名ブランチの自己作成と push

`--ref` で作られた作業ブランチとは無関係に、セッション内から固定名ブランチを切って push した。

```
git checkout -b cc-ui-design-999 origin/main
git push -u origin cc-ui-design-999
```
exit=0
```
 * [new branch]      cc-ui-design-999 -> cc-ui-design-999
branch 'cc-ui-design-999' set up to track 'origin/cc-ui-design-999'.
```

**GitHub 側の裏取り**: `cc-ui-design-999` → `0acc52dd2794e0de891c9a574787baf5834c3956`。

**`--ref` の作業ブランチとの関係**: 作業ブランチ（`claude/task-worker-exec-333-uxfbvz`）は測定開始時点でリモートに存在せず、`cc-ui-design-999` はそれとは独立に新規作成された。つまり `--ref` が作る `claude/<...>-<6文字>` は**セッションのローカルな既定ブランチにすぎず、push 先を縛るものではない**。

### F-5: 作業ブランチ以外の ref への push

セッションの作業ブランチをチェックアウトした状態から、**別名の ref** へ push した（「push はセッションの作業ブランチのみ」制約の直接検証）。

```
git checkout claude/task-worker-exec-333-uxfbvz
git push origin HEAD:refs/heads/ctw-probe-333-other
```
exit=0
```
 * [new branch]      HEAD -> ctw-probe-333-other
```

**GitHub 側の裏取り**: `ctw-probe-333-other` → `1c3943cd5048e1997ed10e65525b5fe867587e7f`。

**したがって「push はセッションの作業ブランチのみ」という制約は実在しない。** PRD 5章がこの制約を claude CLI / ドキュメント由来で記載していたが、実測はそれを支持しない。あわせて、旧 P-6 / M-5 の「VM 側の clone には `git remote` が0件で `git push --dry-run` が `fatal: No configured push destination.` で終わる」という観測も、**現行のクラウド実行環境には当てはまらない**（remote も認証情報も揃っている。実測環境節を参照）。

### F-6: ref の削除は 403 で拒否される（計画外の発見）

テスト用ブランチの後片付けで判明した。**新規作成・force 更新は通るのに、削除だけが拒否される。**

**(a) `git push origin --delete ctw-probe-333-other`** — exit=1
```
error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403
send-pack: unexpected disconnect while reading sideband packet
fatal: the remote end hung up unexpectedly
Everything up-to-date
```

**(b) zero-oid refspec 形式 `git push origin :refs/heads/ctw-probe-333-other`** — exit=1、(a) と同一文言。複数 ref をまとめて削除する形（`--delete a b c`）でも同一。

**(c) 対照実験: 直後に同じ ref を force 更新** — exit=0
```
 + 1c3943c...c2e08a1 HEAD~1 -> ctw-probe-333-other (forced update)
```

同一セッション・同一 ref・同一資格情報で、**削除だけが 403、force 更新は成功**する。したがってこれは資格情報の不在でもブランチ保護でもなく、**削除操作に固有の拒否**である。拒否の主体（エージェントプロキシによるフィルタか、トークンの権限か）は本実測では**特定できていない**（推測で埋めない）。

**GitHub MCP 側にも代替手段がない**: 本セッションで利用可能な GitHub MCP のツール一覧にブランチ削除に相当するものは存在しない（`create_branch` はあるが delete は無い）。したがって**クラウドセッションからリモートブランチを削除する手段は現時点で無い**。

補強材料として、リポジトリには過去のクラウド実行 Issue が残した `ctw-probe-330-base` / `ctw-probe-331-a` / `ctw-probe-331-b` / `ctw-probe-331-base` が残存しており、同じ制限に当たっていた可能性が高い（当時の記録には削除失敗の記述が無いため断定はしない）。

### F-7: `--on-branch` セッション自身による force-push は測定不能

クラウドセッション内から入れ子でクラウドセッションを作成しようとしたが、**`--cloud` の処理に到達する前に初回起動のテーマ選択ダイアログで停止**した。

```
timeout 240 script -q -c 'claude --cloud "<desc>" --on-branch ctw-probe-333-forcepush' /dev/null
```
→ exit=124（タイムアウト）、標準出力なし。pty 出力をファイルへ捕捉した再試行で停止位置が判明した（抜粋、エスケープ除去）:
```
Welcome to Claude Code v2.1.251
Let's get started.
Choose the text style that looks best with your terminal
To change this later, run /theme
  1. Auto (match terminal)
> 2. Dark mode
  3. Light mode
  ...
```

コンテナに初回起動のオンボーディング状態が無いため、非対話で先へ進めない。**クラウドセッションは1件も作成されていない**（`Created cloud session:` の出力なし、`ctw-probe-333-forcepush` の SHA も `3db2632` のまま不変）。オンボーディングを回避するための設定書き換えは、実測環境を変質させるうえ本Issueのスコープ外のため行っていない。

なお、これは herdr モードで既知の「起動時ダイアログが `agent prompt` を食う」現象（`CLAUDE.md`）と同種の事象である。

### 再実測の限界（測定していないこと）

推測で埋めないため、次の3点は**未測定**として明記する。

1. **ブランチ保護下での force-push**。本リポジトリは測定時点で保護が無く（`list_branches` が `main` を含む全ブランチで `protected: false` を返す）、保護されたブランチへの force-push がどう扱われるかは測っていない。GitHub の通常の挙動としては保護設定が優先されるはずだが、実測していない
2. **Open な PR の head ブランチへの force-push**。F-3 のテスト用ブランチには PR を紐づけていない。git のレイヤでは PR の有無で ref 更新の可否は変わらないが、それは実測ではなく一般論なので結論には含めない
3. **`--on-branch` で作成したセッション自身**による force-push（F-7 のとおり測定不能）。ただし F-3 は同じ VM・同じ資格情報・同じプロキシ経路での force-push が通ることを示しており、`--on-branch` が push 権限を変える兆候は観測されていない

## PRD 項目への対応

| PRD | 問い | 実測結果 |
|---|---|---|
| 9-6 | クラウドセッションから PR ブランチへの force-push が可能か | **可能**（F-3）。`--force-with-lease` が `(forced update)` で成功し、GitHub 側の ref も実際に巻き戻った。ただし測定対象は PR を紐づけていない使い捨てブランチであり、Open な PR の head を対象にした force-push は未測定（「再実測の限界」2） |
| 5章 制約「push はセッションの作業ブランチのみ」 | 制約の実在を確認できたか | **実在しない**（F-4 / F-5）。作業ブランチ以外の ref への push・固定名ブランチの自己作成がいずれも成功した。PRD の記載は claude CLI / ドキュメント由来の推定であり、実測はこれを支持しない |
| 5章 適合性表 `resolve-conflict` | Phase 1 の ✕ を維持してよいか | **force-push を理由とする ✕ の根拠は消滅した**。ただし別の理由（`.pen` の `pencil` CLI と認証、コンフリクト判定入力の GraphQL 403）で ✕ 自体は維持（下記） |
| （新規） | ref の削除が可能か | **不可**（F-6）。`git push --delete` が 403。GitHub MCP にも代替が無い。PRD には対応項目が無かったため本実測で追加した論点 |

## `resolve-conflict` の Phase 判断（2026-08-30 更新）

**✕ 据え置き。ただし据え置きの理由が入れ替わった。**

`src/config.ts` の `CLOUD_DENIED_WORKERS` は `resolve-conflict` の拒否理由を「rebase 後の force-push がクラウド環境で可能か未測定のため」としているが、**この根拠は F-3 で消滅した**（force-push は可能）。それでも ✕ を維持するのは、force-push とは独立した次の2点が未解決だからである。

1. **`.pen` のコンフリクト解決に `pencil` CLI とその認証が要る**（クラウド VM への導入・ログインが未確認）
2. **コンフリクト判定の入力が取れない**。`gh pr view --json mergeable` が GraphQL 403（`docs/cloud-graphql-proxy-limits.md`）。GitHub MCP の `pull_request_read` で代替できるかは未実測

したがって Phase 2 で `resolve-conflict` をクラウド化する際に残っているのは上記2点であり、**force-push の可否はもはやブロッカーではない**。`CLOUD_DENIED_WORKERS` のコメントを実測に追随させる修正が必要だが、**本Issueはコードを変更しないため未実施**（後続Issueの対象）。

## `apply-ui-design` の preflight への影響（要件4の判定）

**代替案の記録は不要。現行の preflight はそのまま成立する。**

Issue #333 は「固定名ブランチを作れない場合、`apply-ui-design` の preflight（`findPrStateByHeadRef(designBranchName(N))` による head ref 完全一致）が成立しないため代替案を docs に記録する」ことを要件としていたが、**F-4 で固定名ブランチの自己作成と push が可能であることが確定した**ため、この条件分岐には該当しない。

- `create-ui-design` がクラウド実行された場合も、セッション内から `git checkout -b cc-ui-design-<N>` → push で固定名ブランチを head にできる（F-4 でまさに `cc-ui-design-999` を作成・push している）
- `--ref` が作る `claude/<...>-<6文字>` は push 先を縛らない（F-4 / F-5）ため、「クラウドセッションは自分で決めた作業ブランチしか push できない」という前提自体が成り立たない
- したがって `src/workers/ui-design.ts` の `designBranchName()` と `src/workers/apply-ui-design.ts` の head ref 特定（`src/gh.ts` の `findPrStateByHeadRef()`）は**変更不要**

ただし `create-ui-design` をクラウド化する場合、**PR 作成時に固定名ブランチを head として明示的に push する必要がある**（セッション既定の作業ブランチのまま PR を作ると head ref が `claude/<...>` になり preflight が空振りする）。これは実装側の注意点であり、本Issueのスコープ外。

## 未実測項目

1回目の「未実測項目」1〜3 は **2026-08-30 の再実測ですべて解消した**。

1. ~~**回避策適用後の force-push 可否**~~: **実測済み**（F-3）。可能。`--force-with-lease` で `(forced update)`、GitHub 側の ref も巻き戻る
2. ~~**「push はセッションの作業ブランチのみ」制約の実在**~~: **実測済み**（F-4 / F-5）。**制約は実在しない**
3. ~~**固定名ブランチが特別扱いされるか**~~: **実測済み**（F-4）。特別扱いはされず、`cc-ui-design-999` を自己作成して push できる

以下は再実測後に残った項目。

4. **ブランチ保護下での force-push の扱い**
   - 理由: 本リポジトリは測定時点で保護設定が無い（`list_branches` が全ブランチで `protected: false`）ため、保護されたブランチでの挙動を測れていない
   - 再現手順: テスト用リポジトリで対象ブランチに保護（force-push 禁止）を設定し、クラウドセッションから F-3 と同じ手順を実行して拒否文言を記録する
5. **Open な PR の head ブランチへの force-push**
   - 理由: F-3 のテスト用ブランチには PR を紐づけていない。git のレイヤでは PR の有無で ref 更新の可否は変わらないはずだが、実測していないので結論に含めない
   - 再現手順: 使い捨てブランチで PR を作成し、rebase 後に `git push --force-with-lease` して PR の head SHA が追随することを確認する
6. **`--on-branch` で作成したセッション自身による force-push**
   - 理由: クラウドセッション内から入れ子のセッションを作成できない（F-7、初回起動のテーマ選択ダイアログで停止）
   - 再現手順: **ローカル端末**（オンボーディング済み・実 TTY）から `claude --cloud "<desc>" --on-branch <使い捨てブランチ>` でセッションを作成し、そのセッションに rebase → `git push --force-with-lease` を行わせて、GitHub 側のブランチ SHA が巻き戻ったかで判定する
7. **ref 削除の 403 の主体**
   - 理由: F-6 で削除が拒否されることは確定したが、エージェントプロキシによるフィルタか GitHub トークンの権限かを切り分けていない
   - 再現手順: `HTTPS_PROXY` を外した経路（許可されていれば）での削除、および同じトークンでの REST `DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}` を比較する

## 実測の副作用

### 1回目（2026-08-28）

**なし。** F-1 / F-2 はいずれもセッション作成前に拒否されたため、クラウドセッションは1件も作成されていない。GitHub App 連携の設定変更も行っていない。

### 2回目（2026-08-30）

**テスト用ブランチが3件リモートに残っている。削除には人手が必要。** F-6 のとおりクラウドセッションからは ref を削除できず、GitHub MCP にも代替手段が無いため、後片付けを完了できなかった。

| ブランチ | 最終 SHA | 備考 |
|---|---|---|
| `ctw-probe-333-forcepush` | `3db2632` | F-3 の対象 |
| `ctw-probe-333-other` | `c2e08a1` | F-5 の対象。F-6 (c) の対照実験で最後に force 更新した |
| `cc-ui-design-999` | `0acc52d` | F-4 の対象。**優先して削除すること** — `cc-ui-design-<N>` はデザイン先行フローの名前空間で、`apply-ui-design` が head ref 完全一致でデザインPRを探す対象と衝突しうる（Issue #999 は存在しないため現時点で実害は無い） |

削除コマンド（ローカル端末から）:
```
git push origin --delete ctw-probe-333-forcepush ctw-probe-333-other cc-ui-design-999
```

いずれのブランチにも PR は紐づけていない。ラベルも付与していないため、どのワーカーのポーリング対象にもならない。クラウドセッションは1件も新規作成していない（F-7 は作成前に停止）。ローカルの probe ブランチと作業ファイルは削除済み。
