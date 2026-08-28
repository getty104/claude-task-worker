# クラウドセッションからの force-push 可否の実測結果

クラウドセッションで PR の head ブランチを開き、rebase 後の force-push が成立するかを実測した記録（Issue #227、PRD 9-6 / 5章の `resolve-conflict` 適合性に対応）。`resolve-conflict` を Phase 1 で非対応（✕）に据え置いてよいかの根拠になる。

- 実測日: 2026-08-28
- 実測バージョン: `claude --version` → **`2.1.248 (Claude Code)`**
- 先行実測（Issue #223 / #224、`docs/cloud-session-launch-flags.md`）は `2.1.247` での測定。本実測でパッチバージョンが1つ進んでいるが、**`--on-branch` の挙動は 2.1.247 と同一だった**（F-1 / F-2 が T10 と同一文言）。#223 の `--ref` / `--on-branch` に関する記述はこの範囲で 2.1.248 でも有効
- 後続Issueが失効判定できるよう、`claude --version` がここより新しい場合は再実測すること

## 実測環境

- 実行パス: `~/.local/bin/claude`
- OS: macOS (darwin 25.6.0)
- 実行ディレクトリ: git の **linked worktree**（`.claude/worktrees/<name>`）
- pty は `script -q /dev/null <cmd>` で割り当て
- **このリポジトリでは claude.ai 側の GitHub App 連携が未設定**（#223 T9 / T10 と同一の前提。本実測でも再確認、下記 F-1 / F-2）
- 測定時点でこのリポジトリに **Open な PR は0件**だったため、要件の「PR の head ブランチ」には実在するリモートブランチ（`feat/agent-browser-integration`）を代用した

## 結論

**force-push の可否は、この環境では測定できない（測定不能／GitHub App 未設定）。** 到達を阻むゲートが2つあり、どちらも「force-push が拒否された」ことを意味しない。

1. **`--on-branch` が前段で拒否される**（F-1 / F-2）。理由はブランチ名の妥当性ではなく GitHub App 連携の未設定で、「PR の head ブランチをクラウドセッションの作業ブランチにする」という前提自体を成立させられない
2. **`--on-branch` を付けずに作成したセッションでも push が資格情報に到達しない**。GitHub App 未設定のクラウドセッションはローカル作業ツリーのアップロードでシードされ、VM 側の clone には `git remote` が0件で、`git push --dry-run` が `fatal: No configured push destination.` で終わる（`docs/cloud-graphql-proxy-limits.md` の P-6、`docs/cloud-session-launch-flags.md` の M-5 / T11）。**これも push の可否を測ってはいない**（push 先が存在しないだけ）

| 検証したいこと | 結果 | 根拠 |
|---|---|---|
| PR の head ブランチをクラウドセッションの作業ブランチにできるか | **測定不能**（GitHub App 未設定） | F-1 |
| 固定名ブランチ（`ctw-last-run-<worker>` 相当）を作業ブランチにできるか | **測定不能**（同上。拒否文言は F-1 と同一） | F-2 |
| 拒否理由がブランチの実在有無に依存するか | **依存しない**。実在するブランチ（F-1）と実在しないブランチ（F-2）で文言が完全に一致 | F-1 / F-2 |
| 「push はセッションの作業ブランチのみ」制約が実在するか | **未確認**。制約に到達する前段で止まる | F-1 / F-2 / 既測 P-6 |
| rebase 後の force-push が push 制約に抵触するか | **測定不能**。GitHub App 連携済みの環境でしか判定できない | — |

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

1. **拒否理由は一貫して「GitHub App 未設定」**であり、ブランチの種類（PR の head か固定名か）にも実在有無にも依存しない。#223 T9 / T10 は実在しないブランチ名で測定していたため「ブランチが無いから拒否された可能性」を排除できていなかったが、F-1 が**実在するリモートブランチ**でも同一文言を返したことで、**GitHub App のチェックがブランチ名検証より前段にある**ことが確定した
2. 拒否はクラウドセッション作成（ネットワーク）より前段のため、**本実測ではクラウドセッションが1件も作成されていない**（#223 のパースとバリデーションの順序と整合）
3. したがって「セッションの作業ブランチではないブランチへの force-push が拒否されるか」（要件2）も、**拒否の観測に到達していない**。固定名ブランチが特別扱いされるかどうかは未判定

## PRD 項目への対応

| PRD | 問い | 実測結果 |
|---|---|---|
| 9-6 | クラウドセッションから PR ブランチへの force-push が可能か | **測定不能（GitHub App 未設定）**。`--on-branch` がブランチ検証の前段で拒否される（F-1 / F-2）。`--on-branch` を外した経路でも VM に remote が無く push が資格情報へ到達しない（既測 P-6） |
| 5章 制約「push はセッションの作業ブランチのみ」 | 制約の実在を確認できたか | **未確認**。制約に到達する前段（GitHub App 連携）で止まるため、制約そのものの検証はできていない。PRD の記載は claude CLI / ドキュメント由来のまま |
| 5章 適合性表 `resolve-conflict` | Phase 1 の ✕ を維持してよいか | **維持してよい**（下記） |

## `resolve-conflict` の Phase 判断

**Phase 1: ✕ 据え置き。** 根拠は2点で、いずれも「force-push が拒否される」ことを示すものではない点に注意する。

1. **可否が測定不能**。force-push できるという確証が無いまま許可すると、rebase 済みの状態で push に失敗し、PR が中途半端な状態（ローカル rebase 済み・リモート未更新）で残りうる
2. **この構成では push 先が存在しない**（既測 P-6）。GitHub App 未設定のリポジトリでは `resolve-conflict` に限らず、成果物を GitHub へ出すワーカー全般がクラウドで完結しない

**Phase 2 で再判定する際に必要な実測**は「未実測項目」の1。あわせて `.pen` の解決に `pencil` CLI と認証が要る点、コンフリクト判定の入力（`gh pr view --json mergeable`）が GraphQL 403 で取れない点（`docs/cloud-graphql-proxy-limits.md`）は本実測では変わっていない。

## 未実測項目

1. **GitHub App 連携済みリポジトリでの force-push 可否**
   - 理由: 実測リポジトリで claude.ai 側の GitHub App 連携が未設定のため、`--on-branch` がブランチ検証に到達しない
   - 再現手順: https://claude.ai/code で対象リポジトリの GitHub 連携をセットアップしたうえで、(a) Open な PR の head ブランチ、(b) `ctw-last-run-<worker>` のような固定名ブランチ、の2ケースで `claude --cloud "<desc>" --on-branch <branch>` を pty から実行する。セッションが作成できたら `claude -p --cloud <session_id>` で `git rebase` 後の `git push --force` を実行させ、成否とエラー文言を claude.ai の Web UI で確認する（`-p --cloud` の投函結果は CLI からは観測できない。`docs/cloud-session-launch-flags.md` の M-5 参照）
2. **「push はセッションの作業ブランチのみ」制約の実在と、その差し戻し文言**
   - 理由: 上と同じ理由で制約に到達しない
   - 再現手順: 1 でセッションが作成できたら、作業ブランチとは別のブランチ（例: `main`）へ push させて拒否文言を記録する
3. **固定名ブランチが特別扱いされるか**
   - 理由: F-2 が GitHub App のチェックで止まったため、固定名ブランチ固有の扱いがあるかは判定できていない
   - 再現手順: 1 の (b) をセッション作成まで到達させ、`src/last-run-pr.ts` と同じ `git push --force origin HEAD:refs/heads/ctw-last-run-<worker>` を実行させる

## 実測の副作用

**なし。** F-1 / F-2 はいずれもセッション作成前に拒否されたため、クラウドセッションは1件も作成されていない。GitHub App 連携の設定変更も行っていない。
