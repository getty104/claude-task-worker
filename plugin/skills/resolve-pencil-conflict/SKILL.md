---
name: resolve-pencil-conflict
description: gitコンフリクト状態になった.penファイル（Pencilで作成されたデザインファイル）を、Pencil CLI（`pencil`コマンド）とgitだけで解消するスキル。.penは暗号化バイナリでテキストマージが不可能なため、コンフリクトマーカーの手編集や`git mergetool`は絶対に使わず、「片側採用 → もう一方の変更をPencilで再適用」のフローで解消する。ユーザーが.penファイルのコンフリクト解消、rebase/merge中に`UU`/`AA`状態になった.penの解消、テキストマージで破損した.penの復旧などを依頼した場合に必ずこのスキルを使用する。通常の.penの編集・新規作成は`edit-pencil-design`スキル、PR全体のコンフリクト解消フロー（rebase起点・force-push）は`resolve-pr-conflict`スキルの担当。
model: opus
effort: xhigh
---

# Resolve Pencil Conflict

gitコンフリクト状態になった `.pen` デザインファイルを「**片側採用 → もう一方の変更をPencilで再適用**」のフローで解消するスキル。

# 位置づけ（関連スキルとの分担）

| スキル | 担当 |
|---|---|
| **本スキル** | `.pen` ファイル単体のgitコンフリクト解消・破損復旧 |
| `edit-pencil-design` | `.pen` の通常の編集・新規作成（本スキルの再適用ステップで利用する） |
| `resolve-pr-conflict` | PR全体のコンフリクト解消フロー（rebase・force-push）。その過程で `.pen` のコンフリクトに遭遇した場合に本スキルへ委譲される |

# 重要な前提

- **テキストマージは絶対禁止**: `.pen` は暗号化バイナリのため、コンフリクトマーカー（`<<<<<<<` 等）の手編集や `git mergetool` によるテキストマージはファイルを破損させ、開けなくする
- **両側の変更を1ファイルに機械的にマージする手段は存在しない**: 解消は必ず「どちらか一方のバージョンをそのまま採用し、採用しなかった側の変更内容をPencilの編集として再適用する」方針で行う
- `.pen` は `Read` / `Grep` では読めない。中身の確認はすべて `pencil interactive` の `get_editor_state()` / `get_screenshot()` 経由で行う

# 前提条件の確認

1. `pencil version` — 未インストールなら `npm install -g @pencil.dev/cli` を案内（Node.js 18以上必要）。**Pencil CLIが使えない場合は本スキルのフローを実行できないため、無理に解消せず `git rebase --abort` / `git merge --abort` で中断してユーザーに報告する**
2. `pencil status` — 未認証なら `pencil login`、または `PENCIL_CLI_KEY` 環境変数の設定を案内
3. `git status --short` — 対象の `.pen` が実際にコンフリクト状態（`UU` / `AA` / `UD` / `DU`）であることを確認する

# 解消手順

## ステップ1: コンフリクト状態の確認

```bash
git status --short   # UU = 両側変更、AA = 両側追加、UD/DU = 片側削除
```

- `UD` / `DU`（片側がファイルを削除している）の場合は、ファイルを残すべきか自体が仕様判断になるため、無理に解消せずユーザーに確認する

## ステップ2: 作業ディレクトリの確保と3バージョンの取り出し

中間ファイルの保存先は固定パスにせず、実行ごとに一意なディレクトリを確保する（同時実行での上書き衝突を防ぎ、`trap` で途中失敗時も自動後始末される）。

```bash
WORK_DIR="$(mktemp -d -t pencil-conflict-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
```

index の stage から共通祖先・両側のバージョンを書き出す。

```bash
git show :1:path/to/design.pen > "${WORK_DIR}/base.pen" 2>/dev/null \
  || rm -f "${WORK_DIR}/base.pen"   # 共通祖先（AA コンフリクトでは stage :1 が無いため base.pen を作らない）
git show :2:path/to/design.pen > "${WORK_DIR}/ours.pen"    # ours 側
git show :3:path/to/design.pen > "${WORK_DIR}/theirs.pen"  # theirs 側
```

**ours/theirs の意味の反転に注意**: `git merge` 中は ours = 現在のブランチ / theirs = マージ対象ブランチだが、**`git rebase` 中は逆転**し、ours（`:2:` / `--ours`）= rebase先のターゲットブランチ側、theirs（`:3:` / `--theirs`）= 自分のブランチのコミット側になる。どちらが「自分のデザイン変更」かを取り違えると、採用と再適用が逆になり変更を取りこぼす。

## ステップ3: 各バージョンのNodeツリーを取得し、両側の変更内容を把握する

```bash
for v in base ours theirs; do
  [ "$v" = "base" ] && [ ! -s "${WORK_DIR}/base.pen" ] && continue   # AA: 共通祖先なしはスキップ
  pencil interactive -i "${WORK_DIR}/${v}.pen" -o "${WORK_DIR}/${v}.pen" <<'EOF' > "${WORK_DIR}/${v}.json"
get_editor_state()
exit()
EOF
done
```

数値フォーマットの揺れ（例: `13.995000000000001` と `13.995`）を差分と誤認しないよう、`jq` で正規化してから diff する。

```bash
for v in base ours theirs; do
  [ -f "${WORK_DIR}/${v}.json" ] || continue   # AA: base.json は生成されないためスキップ
  jq -S 'walk(if type == "number" then tonumber|tostring|tonumber else . end)' \
    "${WORK_DIR}/${v}.json" > "${WORK_DIR}/${v}.norm.json"
done

if [ -f "${WORK_DIR}/base.norm.json" ]; then
  diff "${WORK_DIR}/base.norm.json" "${WORK_DIR}/ours.norm.json"     # ours 側が変えたNode
  diff "${WORK_DIR}/base.norm.json" "${WORK_DIR}/theirs.norm.json"   # theirs 側が変えたNode
else
  diff "${WORK_DIR}/ours.norm.json" "${WORK_DIR}/theirs.norm.json"   # AA: 共通祖先が無いため両側を直接比較する
fi
```

必要に応じて `get_screenshot` で両側の見た目も確認する（出力先は `${WORK_DIR}` 配下でよい）。

## ステップ4: ベースの選択と採用

Node差分が大きい・プロンプトでの再現が難しい側をベースとして採用する（目安: 変更Node数が多い側。同程度なら自分のデザイン変更側をベースにし、相手側の変更を再適用する方が意図の取りこぼしが少ない）。

```bash
git checkout --ours -- path/to/design.pen    # または --theirs（ステップ2の反転注意を再確認）
git add path/to/design.pen
```

## ステップ5: 採用しなかった側の変更を再適用する

ステップ3で特定した「採用しなかった側のNode差分」を具体的な編集指示に落とし込み、**`edit-pencil-design` スキルの手順**（エージェントモード `--prompt`、または heredoc 安全規則に従った `batch_design`）で再適用する。編集前スナップショットは採用したベースのツリーになる。

## ステップ6: 両側の変更が揃ったことの検証とスクリーンショット

再適用後の `get_editor_state()` に「ours側の変更Node」「theirs側の変更Node」の両方が反映されていることをNodeツリー差分で確認し、`edit-pencil-design` の手順どおり影響Nodeのスクリーンショットを `.pen` と同階層の `snapshots/` に残す。base があるケース（ステップ3で base.norm.json との差分を確認済み）はその差分が両方反映されているかで検証し、base が無い（AA）ケースはours.norm.jsonとtheirs.norm.jsonの直接比較で洗い出した差分が両方反映されているかで検証する。

## ステップ7: git操作の続行

`git add path/to/design.pen` 済みであることを確認して `git rebase --continue` / `git merge --continue` で続行する。

両側の変更意図が両立できない（同じNodeを異なる方針で変更している等）と判明した場合は、無理に解消せず両側のスクリーンショットを提示してユーザーに確認する。

# 予防策

`.gitattributes` に `.pen` をバイナリとして明示しておくと、gitがテキストマージを試みてコンフリクトマーカーを埋め込みファイルを破損させる事故を防げる（コンフリクト自体は発生するが、常に本スキルのフローで安全に解消できる）:

```
*.pen binary
```

リポジトリに `.gitattributes` の指定が無い場合は、コンフリクト解消のついでに追加を提案する。

# トラブルシューティング

- **コンフリクトマーカーの混入等で `.pen` が破損して開けない**: テキストマージを実行してしまった典型的な事故。破損ファイルの修復は不可能なので、`git checkout --ours -- <path>` / `--theirs` で正常な側のバージョンに戻す（コンフリクト状態からやり直したい場合は `git checkout -m -- <path>` で3-way状態を復元できる）。その後、本スキルの手順で解消し直し、再発防止として `.gitattributes` への `*.pen binary` 追加を提案する
- **`AA`（両側追加）コンフリクトで `git show :1:` が失敗する**: 共通祖先が存在しないため想定内の挙動。ステップ2〜3のガードにより自動的に base 無し（ours/theirs 直接比較）として扱われるため、そのままステップ4以降を進めてよい
- **どちらの変更か判別できない**: `git log --oneline -- <path>` で両ブランチの該当コミットとメッセージを確認し、変更の出所を特定する。それでも判断できなければユーザーに確認する
- **`pencil` コマンドが使えない環境**: 本スキルのフローは実行不可。`git rebase --abort` / `git merge --abort` で中断し、Pencil CLIのセットアップ（`npm install -g @pencil.dev/cli` と認証）を案内する

# 実行結果の報告

- コンフリクトの種別（`UU` / `AA` / `UD`・`DU`）と対象 `.pen` の絶対パス
- 採用した側（ours / theirs とそれがどのブランチの変更か）と選択理由
- 再適用した変更内容（Node IDと概要）
- 検証結果（両側の変更が揃っていることの確認方法）と出力したスクリーンショットの絶対パス
- 実行したgit操作（`--continue` まで完了したか、中断したならその理由）
