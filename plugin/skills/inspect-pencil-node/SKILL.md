---
name: inspect-pencil-node
description: ".penファイル（pen.devで作成されたデザインファイル。平文JSON）の中のNodeのデザインデータ（属性・構造・レイアウト解決後のサイズ）とスクリーンショット画像を読み取り専用で取得するスキル。Node ID指定に加え、名前の正規表現（例: 「ヘッダー」「.*Button」）、Nodeタイプ（frame / text / icon など）、再利用可能コンポーネント、特定Node配下、ドキュメント全体のトップレベルなど、**ID以外の指定方法**にも対応する。ユーザーが「.penのこのNodeの中身を見せて」「特定コンポーネントのデザインデータを取り出して」「Nodeのスクリーンショットだけ欲しい」「ヘッダーの構造を確認したい」「ボタンのスタイルをコピーしたい」「再利用可能コンポーネント一覧を見せて」「ドキュメント全体の構造を覗きたい」「全てのテキストNodeを取得して」のように.pen内の要素の調査・参照・確認・抜き出しを依頼した場合に必ずこのスキルを使う。属性は`jq`、変数解決・コンポーネント展開後の値は`scripts/pen.mjs resolve`、レイアウト解決後の矩形とはみ出しは`scripts/pen.mjs layout`、画像は`scripts/pen.mjs render`（Chromiumで描画）で取得し、画像は`.pen`と同階層の`snapshots/`にPNG出力する。`.pen`は一切書き換えない。pen.dev CLI（`pencil interactive`）は使わない。"
---

# Inspect Pencil Node

`.pen` デザインファイル内のNodeのデータと画像を**読み取り専用**で取得するスキル。姉妹スキル `edit-pencil-design` が「編集 + 編集Nodeのスクショ」を担当するのに対し、こちらは `.pen` を一切書き換えない。pen.dev CLI（`pencil interactive`）は使わない。

`.pen` は平文JSONで、構造は `${CLAUDE_PLUGIN_ROOT}/references/pen-format.md`。読み方は目的で使い分ける:

| 欲しいもの | 手段 |
|---|---|
| ファイルに**書かれた**属性・構造・Node検索 | `jq` |
| `"$変数"` を値に解決し、`ref` を展開した後の属性（インスタンス内の子は `"<インスタンスID>/<子ID>"`） | `$PEN resolve <file> <id\|パス> [--theme mode=dark]` |
| **レイアウト解決後**の矩形（canvas 座標の `x` / `y` / `width` / `height`）と、親からのはみ出し（`problem`: `"partially clipped"` / `"fully clipped"`） | `$PEN layout <file> [id\|パス]` |
| 画像 | `$PEN render <file> --out <dir> [id\|パス\|document ...]` |

```bash
PEN="node ${CLAUDE_PLUGIN_ROOT}/scripts/pen.mjs"
```

`layout` / `render` は Chromium で描画するので数秒かかる。構造・値の確認は `jq` / `resolve`、サイズ・はみ出しは `layout`、色・字形・整列など見た目でしか分からないものだけ `render` を使う。

# Nodeの指定方法（`jq`）

Nodeは `children` の入れ子なので、ツリー全体から `id` と `type` を持つオブジェクトを拾う（fill / effect も `type` を持つが `id` は持たない）。

```bash
NODES='[.children | .. | objects | select(has("id") and has("type"))]'

jq "$NODES | map({id, name, type})" design.pen                                   # 全Node
jq '.children | map({id, name, type, x, y, width, height})' design.pen            # トップレベル
jq "$NODES | map(select(.name // \"\" | test(\"header\"; \"i\"))) | map({id, name, type})" design.pen   # 名前の正規表現
jq "$NODES | map(select(.type == \"text\")) | map({id, name, content})" design.pen                       # タイプ指定
jq "$NODES | map(select(.reusable == true)) | map({id, name})" design.pen                                # コンポーネント一覧
jq --arg id header-01 "$NODES | map(select(.id == \$id)) | .[0]" design.pen                              # ID指定（サブツリーごと）
jq --arg id header-01 "$NODES | map(select(.id == \$id)) | .[0] | [.. | objects | select(has(\"id\") and has(\"type\"))] | map({id, name, type})" design.pen   # 特定Node配下
jq '.variables, .themes' design.pen                                                # 変数・テーマ
```

- **インスタンス（`type: "ref"`）の中身はファイルに書かれていない**（参照先コンポーネントの子＋`descendants` の上書き）。中身や上書き後の値は `$PEN resolve design.pen <インスタンスID>` で見る
- 指定が曖昧なら、トップレベル一覧から候補を提示する

# 画像

```bash
DESIGN="designs/login.pen"
WORK_DIR="$(mktemp -d -t pen-inspect-XXXXXX)"; trap 'rm -rf "$WORK_DIR"' EXIT
SNAP_DIR="$(dirname "$DESIGN")/snapshots"
STEM="$(basename "$DESIGN" .pen)"
TS="$(date +%Y%m%d-%H%M%S)"
$PEN render "$DESIGN" --out "${WORK_DIR}/img" header-01 footer-01 > "${WORK_DIR}/render.json"
mkdir -p "$SNAP_DIR"
for f in $(jq -r '.images[].file' "${WORK_DIR}/render.json"); do
  mv "$f" "${SNAP_DIR}/${STEM}-$(basename "$f" .png)-${TS}.png"
done
jq '.images[] | {target, warnings}' "${WORK_DIR}/render.json"
```

- ファイル名: `<.penのステム>-<Node名>-<YYYYMMDD-HHMMSS>.png`（タイムスタンプで同時実行・繰り返し実行でも衝突しない）。既定は2倍解像度
- 呼び出し元が「見るだけ」で永続化を求めていなければ、`snapshots/` へ移さず `${WORK_DIR}` のまま `Read` で見てよい
- レンダラーは pen.dev 本体ではなく、HTML/CSS へ変換して Chromium で描画している。**描画しきれない表現（取得できなかったフォント・アイコン、`mesh_gradient` / shader、`script` / `browser` Node、ライブラリへの `ref` など）は `warnings` に出る**。警告の対象部分は近似なので、その部分の値は画像ではなく `resolve` / `layout` の値を正として報告する

# 実行結果の報告

- 対象を特定した方法（ID / 名前検索 / タイプ / コンポーネント / サブツリー / トップレベル）と、該当Node（ID・名前・type）
- 取得した属性（必要なら `resolve` / `layout` の値）
- 出力した画像の絶対パスと、描画の警告（無ければ「なし」）

# トラブルシューティング

- **`JSON として読めない` / `コンフリクトマーカーが残っている`**: コンフリクト中か破損している。中身は `git show :2:<path>` などで各版を取り出して読む（解消は `resolve-pencil-conflict`）
- **`resolve` で `"<id>" が見つからない`**: インスタンス内の子は `"<インスタンスID>/<子ID>"` で指す
- **`playwright を読み込めない`**: `npx -y @playwright/mcp@latest install-browser --no-shell chromium`（`claude-task-worker install` も同じことをする）
