---
name: resolve-pencil-conflict
description: gitコンフリクト状態になった.penファイル（Pencilで作成されたデザインファイル。平文JSON）を、gitとJSONの直接編集（`edit-pencil-design`の手順）だけで解消するスキル。.penをテキストマージするとNode IDの重複・参照切れ・JSON構文の破損を起こしやすいため、コンフリクトマーカーの手編集や`git mergetool`は使わず、「片側採用 → もう一方の変更をNode単位で再適用 → `scripts/pen.mjs validate`で整合性確認」のフローで解消する。ユーザーが.penファイルのコンフリクト解消、rebase/merge中に`UU`/`AA`状態になった.penの解消、テキストマージで破損した.penの復旧などを依頼した場合に必ずこのスキルを使用する。通常の.penの編集・新規作成は`edit-pencil-design`スキル、PR全体のコンフリクト解消フロー（rebase起点・force-push）は`resolve-pr-conflict`スキルの担当。
model: opus
effort: medium
context: fork
---

# Resolve Pencil Conflict

gitコンフリクト状態になった `.pen` デザインファイルを「**片側採用 → もう一方の変更をNode単位で再適用**」のフローで解消するスキル。pen.dev CLI（`pencil interactive`）は使わない。

# 位置づけ（関連スキルとの分担）

| スキル | 担当 |
|---|---|
| **本スキル** | `.pen` ファイル単体のgitコンフリクト解消・破損復旧 |
| `edit-pencil-design` | `.pen` の通常の編集・新規作成（本スキルの再適用ステップで利用する） |
| `resolve-pr-conflict` | PR全体のコンフリクト解消フロー（rebase・force-push）。その過程で `.pen` のコンフリクトに遭遇した場合に本スキルへ委譲される |

# 重要な前提

- **コンフリクトマーカーを手で解かない**: `.pen` は平文JSONだが、マーカー（`<<<<<<<` 等）の手編集や `git mergetool` によるテキストマージは、行単位では噛み合っても Node ID の重複・`ref` の参照切れ・JSON構文の破損を起こしやすい
- **解消は「どちらか一方のバージョンをそのまま採用し、採用しなかった側の変更内容を Node 単位の編集として再適用する」方針で行う**（再適用は `edit-pencil-design` の手順。最後に `scripts/pen.mjs validate` で整合性を確かめる）
- コンフリクト中の `.pen` はマーカー混入で JSON として壊れていることがあるため、中身の確認は `git show :2:<path>` 等で取り出した各版に対して行う

```bash
PEN=(node "${CLAUDE_PLUGIN_ROOT}/scripts/pen.mjs")
```

# 解消手順

## ステップ1: コンフリクト状態の確認

```bash
git status --short   # UU = 両側変更、AA = 両側追加、UD/DU = 片側削除
```

- `UD` / `DU`（片側がファイルを削除している）の場合は、ファイルを残すべきか自体が仕様判断になるため、無理に解消せず `git rebase --abort` / `git merge --abort` で中断し、どちら側が削除しているか・双方のブランチと該当コミットを含めて中断理由を報告して終了する（呼び出し元・人間がその報告を基に判断する）

## ステップ2: 作業ディレクトリの確保と3バージョンの取り出し

中間ファイルの保存先は固定パスにせず、実行ごとに一意なディレクトリを確保する（同時実行での上書き衝突を防ぎ、`trap` で途中失敗時も自動後始末される）。

```bash
WORK_DIR="$(mktemp -d -t pen-conflict-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

git show :1:path/to/design.pen > "${WORK_DIR}/base.pen" 2>/dev/null \
  || rm -f "${WORK_DIR}/base.pen"   # 共通祖先（AA コンフリクトでは stage :1 が無いため base.pen を作らない）
git show :2:path/to/design.pen > "${WORK_DIR}/ours.pen"    # ours 側
git show :3:path/to/design.pen > "${WORK_DIR}/theirs.pen"  # theirs 側
```

**ours/theirs の意味の反転に注意**: `git merge` 中は ours = 現在のブランチ / theirs = マージ対象ブランチだが、**`git rebase` 中は逆転**し、ours（`:2:` / `--ours`）= rebase先のターゲットブランチ側、theirs（`:3:` / `--theirs`）= 自分のブランチのコミット側になる。どちらが「自分のデザイン変更」かを取り違えると、採用と再適用が逆になり変更を取りこぼす。

## ステップ3: 各バージョンのNodeツリーを平らにして、両側の変更内容を把握する

各版を「Node 1件1行（`children` を除いた属性＋親の `id`）」に平らにしてから比べる。入れ子のまま diff すると、Node の移動や兄弟の追加で無関係な行までずれる。

```bash
FLAT='[paths(objects and has("id") and has("type")) as $p | getpath($p) as $n
  | ($p | .[:-2]) as $pp
  | {parent: (if ($pp | length) > 0 then getpath($pp).id else null end), order: ($p | last)} + ($n | del(.children))]
  | sort_by(.id) | .[]'
for v in base ours theirs; do
  [ -s "${WORK_DIR}/${v}.pen" ] || continue   # AA: 共通祖先なしはスキップ
  jq -cS "$FLAT" "${WORK_DIR}/${v}.pen" > "${WORK_DIR}/${v}.norm.json"
  jq -cS '{variables, themes, imports}' "${WORK_DIR}/${v}.pen" >> "${WORK_DIR}/${v}.norm.json"
done

if [ -f "${WORK_DIR}/base.norm.json" ]; then
  diff "${WORK_DIR}/base.norm.json" "${WORK_DIR}/ours.norm.json"     # ours 側が変えたNode
  diff "${WORK_DIR}/base.norm.json" "${WORK_DIR}/theirs.norm.json"   # theirs 側が変えたNode
else
  diff "${WORK_DIR}/ours.norm.json" "${WORK_DIR}/theirs.norm.json"   # AA: 共通祖先が無いため両側を直接比較する
fi
```

1行が1 Node なので、diff の行がそのまま「どの Node が追加・削除・変更されたか」になる（`parent` の変化は移動、`order`（親の `children` 内の位置）の変化は並べ替え＝表示順・重なり順の変更、最終行は変数・テーマの変更）。

必要に応じて両側の見た目も確認する（画像は `${WORK_DIR}` 配下でよい。描画の警告が出た部分は近似なので、判断は上の差分を正とする）。

```bash
"${PEN[@]}" render "${WORK_DIR}/ours.pen" --out "${WORK_DIR}/ours-img" document
"${PEN[@]}" render "${WORK_DIR}/theirs.pen" --out "${WORK_DIR}/theirs-img" document
```

## ステップ4: ベースの選択と採用

Node差分が大きい・再適用での再現が難しい側をベースとして採用する（目安: 変更Node数が多い側。同程度なら自分のデザイン変更側をベースにし、相手側の変更を再適用する方が意図の取りこぼしが少ない）。

```bash
git checkout --ours -- path/to/design.pen    # または --theirs（ステップ2の反転注意を再確認）
```

## ステップ5: 採用しなかった側の変更を再適用する

ステップ3で特定した「採用しなかった側のNode差分」を、**`edit-pencil-design` スキルの手順**（JSON の直接編集 ＋ `"${PEN[@]}" validate`）で再適用する。採用しなかった側で追加された Node は、その側の JSON から Node オブジェクトをそのまま持ってきてよい（`id` が採用側と重複していないことは `validate` が確かめる）。

## ステップ6: 両側の変更が揃ったことの検証とスクリーンショット

`"${PEN[@]}" validate path/to/design.pen` が通ること、再適用後のツリー（ステップ3と同じ `jq`）に「ours側の変更Node」「theirs側の変更Node」の両方が反映されていることを確認し、`edit-pencil-design` の手順どおり影響Nodeのスクリーンショットを `.pen` と同階層の `snapshots/` に残す。検証の基準は、base があるケースはステップ3の base.norm.json との差分、base が無い（AA）ケースは ours.norm.json と theirs.norm.json の直接比較で洗い出した差分が、両方反映されているか。

## ステップ7: git操作の続行

`git add path/to/design.pen` に加え、ステップ6で `snapshots/` に保存したスクリーンショットも `git status --short` で対象を確認してから `git add` し、`git rebase --continue` / `git merge --continue` で続行する（画像をステージしないと続行後のコミットに入らない）。

両側の変更意図が両立できない（同じNodeを異なる方針で変更している等）と判明した場合は、無理に解消せず `git rebase --abort` / `git merge --abort` で中断し、両側のスクリーンショットのパスと両立できない理由（対象Node・双方の変更内容）を報告して終了する（呼び出し元・人間がその報告を基に判断する）。

# 予防策

`.gitattributes` で `.pen` のテキストマージを止めておくと、gitがコンフリクトマーカーを埋め込んでファイルを破損させる事故を防げる。両側が変更していれば、行が重なっていなくても自動マージせずマーカー無しのコンフリクト（`UU`）になり、常に本スキルのフローで安全に解消できる:

```
*.pen -merge
```

`binary`（= `-diff -merge -text`）は使わない。`.pen` は平文JSONなので、`-diff` まで付けると `git diff` / PRの差分で変更プロパティが読めなくなる（`triage-pr` や `update-design-md` は差分を読む）。既に `*.pen binary` が書かれていれば `*.pen -merge` へ置き換える。

リポジトリに `.gitattributes` の指定が無い場合は、コンフリクト解消のついでに追加を提案する。

# トラブルシューティング

- **コンフリクトマーカーの混入等で `.pen` が破損している**: テキストマージを実行してしまった典型的な事故。`git checkout --ours -- <path>` / `--theirs` で正常な側のバージョンに戻す（コンフリクト状態からやり直したい場合は `git checkout -m -- <path>` で3-way状態を復元できる）。その後、本スキルの手順で解消し直し、`.gitattributes` への `*.pen -merge` 追加を提案する
- **`AA`（両側追加）コンフリクトで `git show :1:` が失敗する**: 共通祖先が存在しないため想定内。ステップ2〜3のガードにより自動的に base 無し（ours/theirs 直接比較）として扱われる
- **どちらの変更か判別できない**: `git log --oneline -- <path>` で両ブランチの該当コミットとメッセージを確認し、変更の出所を特定する。それでも判断できなければ無理に解消せず `git rebase --abort` / `git merge --abort` で中断し、確認した事実（両側のコミット・スクリーンショット）を添えて報告して終了する

# 実行結果の報告

- コンフリクトの種別（`UU` / `AA` / `UD`・`DU`）と対象 `.pen` の絶対パス
- 採用した側（ours / theirs とそれがどのブランチの変更か）と選択理由
- 再適用した変更内容（Node IDと概要）
- 検証結果（`validate` の結果と、両側の変更が揃っていることの確認方法）と出力したスクリーンショットの絶対パス
- 実行したgit操作（`--continue` まで完了したか、中断したならその理由）
