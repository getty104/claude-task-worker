---
name: edit-pencil-design
description: .penファイル（pen.devで作成されたデザインファイル。平文JSON）を**JSONの直接編集**で修正・更新・新規作成し、編集・作成したNodeだけを自前レンダラー（`scripts/pen.mjs render`。Chromiumで描画）でPNG出力して`.pen`と同階層の`snapshots/`に保存するスキル。.penファイルの編集、ボタン追加、レイアウト変更、UIデザインの調整、pen.devデザインの更新、新しい.penデザインの作成などの依頼で必ず使用する。pen.dev CLI（`pencil interactive`）は使わない。Nodeデータは`references/pen-format.md`の.penフォーマット定義に従って書き、編集のたびに`scripts/pen.mjs validate`で整合性（ID重複・参照切れ・未知プロパティ・未定義変数など）を検査する。.penファイルのgitコンフリクト解消・破損復旧は本スキルではなく`resolve-pencil-conflict`スキルの担当。
---

# Edit Pencil Design

`.pen` デザインファイルを**JSONの直接編集**で編集・新規作成し、編集・作成Nodeだけの画像を残すスキル。pen.dev CLI（`pencil interactive`）は使わない（無料プランでは利用日数に上限があり、上限に達すると読み書きとも止まるため）。

道具は2つだけ:

- **編集**: `Edit` / `Write`（値の機械的な一括置換だけ `jq` 可）。Nodeデータの形は `${CLAUDE_PLUGIN_ROOT}/references/pen-format.md`
- **検査・ID採番・描画**: `node "${CLAUDE_PLUGIN_ROOT}/scripts/pen.mjs" <validate|new-id|resolve|layout|render>`（以下 `PEN` と書く）

```bash
PEN="node ${CLAUDE_PLUGIN_ROOT}/scripts/pen.mjs"
```

# 重要な前提

- **既存ファイルの編集はその場で上書き更新する**（別名出力は二重管理を生むため避ける）
- **新規作成は出力先が未使用であることを確認してから作る**（`[ -e path ]`。既に存在するなら編集として扱う）
- **gitコンフリクトの解消は本スキルの担当外**（`resolve-pencil-conflict`）。コンフリクトマーカーの残った `.pen` を編集しない（`PEN validate` が拒否する）
- **スクリーンショットはファイル全体ではなく編集・作成対象のNodeだけ**（差分レビューが容易になる）

# 編集のルール

pen.dev CLI が担っていたスキーマ検証・ID採番・参照解決を、次のルールと `PEN validate` で代わりに担保する。

1. **`id` は `PEN new-id <file> <個数>` で採番する**（文書内で一意な5文字の英数字が返る）。手で考えた `id` は使わない（重複・`/` 混入の元）。追加する全Nodeに人間可読な `name` を付ける
2. **プロパティ名・値は `pen-format.md` のスキーマにあるものだけ**を書く。色は `#RGB` / `#RRGGBB` / `#RRGGBBAA` か `"$変数"`、サイズは数値 / `"fit_content"` / `"fill_container"`
3. **ルートの `version` と `fileToken` に触らない**
4. **既存コンポーネントと同じ見た目の要素は `ref` で再利用する**（複製しない）。インスタンス内の子の差し替えは `descendants`（キーはコンポーネント内の子の `id`、入れ子のインスタンス越しは `"a/b"`）
5. **文書に同じ役割の変数があれば hex を直書きせず `"$変数"` を参照する**。変数を新設するときはルートの `variables` に定義してから参照する
6. 大きな変更も「Nodeの追加 / プロパティ変更 / 置き換え / 移動 / 削除」に分解して少しずつ書き、`PEN validate` を挟む（壊れた箇所を特定しやすい）

`Edit` は JSON の一部分を文字列一致で置き換えるため、`old_string` には対象Nodeの `"id": "<id>"` を含めて一意にする。削除・移動で配列のカンマを崩しやすいので、検査は必ず通す。

# 標準ワークフロー

1. **作業ディレクトリ確保**: `WORK_DIR="$(mktemp -d -t pen-edit-XXXXXX)"; trap 'rm -rf "$WORK_DIR"' EXIT`（同時実行で中間ファイルが衝突しないように）
2. **編集前の状態を控える**（編集のみ）: `cp path/to/design.pen "${WORK_DIR}/before.pen"`、`$PEN validate path/to/design.pen` で**編集前から**壊れていないかを見る（壊れていれば、自分の編集の失敗と取り違えないよう報告に書いてから進める）
3. **構造の把握**: `inspect-pencil-node` スキルの手順（`jq` / `PEN resolve` / `PEN layout`）で対象Nodeと周辺の構造・使われている変数・コンポーネントを確認する。`DESIGN.md` があればトークンも確認する
4. **ID採番 → 編集**（上記ルール）
5. **検査**: `$PEN validate path/to/design.pen --base "${WORK_DIR}/before.pen"`（新規作成は `--base` なし）。エラーが1件でもあれば直して再実行する。**エラーが残ったまま次へ進まない**
6. **レイアウト確認**: `$PEN layout path/to/design.pen <対象ID>` で解決後のサイズ・位置と `problem`（`"partially clipped"` / `"fully clipped"`＝親からのはみ出し）を確認する。画像より安いので、サイズ・配置の確認はこちらで済ませる
7. **編集Nodeのスクリーンショット**（下記）
8. **報告**

# スクリーンショット

```bash
DESIGN="designs/login.pen"
SNAP_DIR="$(dirname "$DESIGN")/snapshots"
STEM="$(basename "$DESIGN" .pen)"
TS="$(date +%Y%m%d-%H%M%S)"
$PEN render "$DESIGN" --out "${WORK_DIR}/img" <編集Node1 ID> <編集Node2 ID> > "${WORK_DIR}/render.json"
jq -r '.images[] | "\(.file)\t\(.target)"' "${WORK_DIR}/render.json" | while IFS=$'\t' read -r f target; do
  mkdir -p "$SNAP_DIR"
  mv "$f" "${SNAP_DIR}/${STEM}-$(basename "$f" .png)-${TS}.png"
done
jq '.images[] | {target, warnings}' "${WORK_DIR}/render.json"
```

- 対象は `id` のほか、インスタンス内の子を `"<インスタンスID>/<子ID>"` で指せる。`document` で全体
- 新規作成は全Nodeが新規なので、トップレベルフレーム（画面・ページ単位）を対象にする
- 新規Nodeが親コンテナ内に追加された場合、親も対象に加えると配置確認しやすい
- ファイル名: `<.penのステム>-<Node名>-<YYYYMMDD-HHMMSS>.png`（タイムスタンプで同時実行でも衝突しない）
- 既定は2倍解像度（`--scale` で変更）。`"$変数"` はテーマの既定値で描画する（`--theme mode=dark` で切り替え）

## 描画の限界（警告を必ず読む）

レンダラーは pen.dev 本体ではなく、`.pen` を HTML/CSS に変換して Chromium で描画している。**描画しきれない表現は省かずに `warnings` に出す**（プレースホルダーや近似で描いたもの）。代表例: 取得できなかったフォント・アイコン、`mesh_gradient` / shader、`script` / `browser` Node、`imports` のライブラリへの `ref`、楕円の円弧、image fill の切り抜き。

警告が出た画像は**その部分が参考扱い**であることを報告に書く（どのNodeの何が近似か）。警告の対象部分は画像ではなく JSON の値が正であり、後段（実装・レビュー）もそう扱う。警告を消すために、デザインを描画できる表現へ勝手に変えない。

# 実行結果の報告

- 編集・作成したNode（ID・名前・type）と、更新または新規作成した `.pen` の絶対パス
- `PEN validate` の結果（編集前から存在したエラーがあればそれも）
- 出力したスクリーンショットの絶対パスと、描画の警告（無ければ「なし」）

# トラブルシューティング

- **`JSON として読めない`**: 直前の `Edit` でカンマ・括弧を崩した。`${WORK_DIR}/before.pen` と比べて直す
- **`ref の参照先 "<id>" が reusable:true ではない`**: コンポーネント側に `"reusable": true` を付けるか、参照先を見直す
- **`<type> に無いプロパティ`**: スキーマ外のキー。`pen-format.md` で正しい名前を確認する（例: `text` の色は `color` ではなく `fill`）
- **`playwright を読み込めない`**: `npx -y @playwright/mcp@latest install-browser --no-shell chromium`（`claude-task-worker install` も同じことをする）
