---
name: inspect-pencil-node
description: "pen.dev CLI（`pencil` / `pen`コマンド）だけを使って、.penファイル（pen.devで作成されたデザインファイル）の中のNodeのデザインデータ（属性・構造）とスクリーンショット画像を読み取り専用で取得するスキル。Node ID指定に加え、名前の正規表現（例: 「ヘッダー」「.*Button」）、Nodeタイプ（frame / text / image など）、再利用可能コンポーネント、特定Node配下、ドキュメント全体のトップレベルなど、**ID以外の指定方法**にも対応する。ユーザーが「.penのこのNodeの中身を見せて」「特定コンポーネントのデザインデータを取り出して」「Nodeのスクリーンショットだけ欲しい」「ヘッダーの構造を確認したい」「ボタンのスタイルをコピーしたい」「再利用可能コンポーネント一覧を見せて」「ドキュメント全体の構造を覗きたい」「全てのテキストNodeを取得して」のように.pen内の要素の調査・参照・確認・抜き出しを依頼した場合に必ずこのスキルを使う。インタラクティブモード（`pencil interactive`）で `execute` の `Get` / `Print`（読み取り専用関数のみ）を使ってNode属性を取得し、同じ `execute` の `Export` / `TakeScreenshot` で画像を`.pen`と同階層の`snapshots/`にPNG出力する。編集はしない（`save()` も変更系関数も呼ばない）ため、対象ファイルは絶対に書き換わらない。pen.dev MCPには依存せず`pencil`コマンドのみで完結。"
---

# Inspect Pencil Node

pen.dev CLI（`pencil` コマンド。`pen` も同じバイナリ）**のみ**で `.pen` デザインファイル内のNodeのデータと画像を**読み取り専用**で取得するスキル。MCPサーバーには依存しない。公式ドキュメント: [docs.pen.dev/for-developers/pen-cli](https://docs.pen.dev/for-developers/pen-cli)

姉妹スキル `edit-pencil-design` が「編集 + 編集Nodeのスクショ」を担当するのに対し、こちらは「Nodeを覗き見るだけ」で `.pen` の中身は一切書き換えない。

Nodeの指定方法は5系統に対応し、併用も可能。`Get` の第1引数にNode IDを渡せば検索範囲をそのサブツリーに絞れる。

1. **Node ID指定** — `Print(Get("<id>", { depth: 2 }))`
2. **名前パターン検索（JS Regex）** — `Get(n => /header/i.test(n.name) && Print(n.id, n.name, n.type))`
3. **タイプ指定** — `Get(n => n.type === "frame" && Print(...))`（`frame` / `group` / `rectangle` / `ellipse` / `line` / `polygon` / `path` / `text` / `connection` / `note` / `icon_font` / `image` / `ref`）
4. **再利用可能コンポーネント抽出** — `Get(n => n.reusable && Print(n.id, n.name))`
5. **トップレベル取得** — `Get((n, c) => { c.skipChildren(); Print(n.id, n.name, n.type) })`

# 設計思想

本スキルで使うのは**インタラクティブモード**（`pencil interactive -i -o`）のみ。`read_skill` / `get_app_state` / `execute` / `exit` を heredoc で呼ぶ。エージェントモード（`pencil --in --out --prompt`）はAI編集用なので使わない。

`.pen` は暗号化バイナリで `Read` / `Grep` では読めないため、Node属性の取得・スクリーンショット出力はすべてインタラクティブモード経由で行う。

**CLI 0.3.5 でシェル内ツールが5つに整理された**。現在あるのは `browser` / `execute` / `get_app_state` / `get_style` / `read_skill` のみで、**Node属性の取得も画像出力も `execute` の中で `Get` / `Print` / `Export` / `TakeScreenshot` を呼ぶ形に一本化**されている。

# 前提条件の確認

1. `pencil version` — 未インストールなら `npm install -g @pen.dev/cli` を案内（Node.js 18以上必要。`pen` / `pencil` の両方のbinを提供する。**0.3.5 未満はツール構成が違う**ため、その場合も更新する）
2. `pencil status` — 未認証なら `pencil login`、または `PEN_CLI_KEY` 環境変数の設定を案内
3. 対象の `.pen` ファイルが存在するか
4. ユーザーの取得対象指定を上記5系統（＋サブツリー限定）のどれかにマップする。どれも曖昧な場合だけトップレベル走査で候補を提示

# 実行ルール

## ルール1: 読み取り目的では変更系の関数を絶対に呼ばない

ヘッドレス実行では `-o` の指定が必須なので、入力と同じパスを `-o` に渡す。**`save()` を呼ばない限りディスクへの書き込みは発生しない** — これがファイル不変性の担保（実測: `save()` を省いたセッションでは `-o` のパスにファイルが作られない）。heredocの末尾は必ず `exit()` で締める。

`execute` は編集用のツールでもあるため、本スキルで書いてよいのは**読み取り専用の関数だけ**:

- 使ってよい: `Get` / `Print` / `GetVariables` / `FindEmptySpace` / `TakeScreenshot` / `Export`（いずれも `.pen` を変更しない）、および純粋なJS（変数・ループ・条件・正規表現）
- **絶対に書かない**: `Insert` / `Copy` / `Update` / `Replace` / `Move` / `Delete` / `Generate` / `SetVariables`、そして `save()`

`execute` は失敗時に自セッション内の変更を巻き戻すが、それは保険であって許可ではない。上記の変更系関数が1つでも混ざったスニペットは書かない。

`browser` / `get_style` は本スキルの守備範囲外（実サイト取り込み・スタイルアーキタイプ取得）なので使わない。`Export` の `html-tailwind` / `html-css` 形式も使わない（HTML書き出しは調査目的ではない）。

## ルール2: インタラクティブモードを heredoc で非対話的に呼び出す

heredoc で固定のコマンド列を流し、結果を `${WORK_DIR}` 配下に保存する。

```bash
pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' > "${WORK_DIR}/out.txt"
execute({ input: 'Print(Get("<node-id>", { depth: 2 }))' })
exit()
EOF
```

`execute` の返り値は**JSONではなくテキスト**（`## Print output` セクションに `Print` の各行が並ぶ）。`Print(Get(...))` のようにオブジェクトを渡した場合だけJSONが1行で出る。中間ファイルの拡張子は `.txt` にしておき、JSONだけを取り出したいときは該当行を `jq` に通す。

### heredoc / シェルの改行展開を正しく扱う（重要）

`execute({ input: '...' })` の中身はJS文字列リテラルなので、複数行のスニペットは `\n` の**2文字**で区切って渡す。シェルが `\n` を実改行に展開するとJS文字列が閉じられずパースエラーになり、「**結果が空**」「**想定と違うNodeが返る**」という失敗が起きる。読み取り専用なのでファイルは壊れないが、調査結果が壊れて後続の判断を狂わせる。姉妹スキル `edit-pencil-design` と同じ改行ルール（シェル別の `\n` 展開挙動の表を含む）を必ず守る。

原則は「**JS/JSON文字列リテラル内の `\n` は2文字（バックスラッシュ + n）のままPencilに届けること**」。`<<'EOF'`（クォート付）は本文をリテラルのまま渡し、`<<EOF`（クォート無）は変数展開するがリテラル `\n` は2文字のまま。zsh の組み込み `echo` は `\n` を実改行に展開する（デフォルト挙動）ため使わない。

#### 改行を確実に2文字のまま渡すための4原則

1. **heredoc は最優先で `<<'EOF'`（シングルクォート付き）を使う** — Regex内のバックスラッシュもそのままPencilに届く。

   ```bash
   pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' > "${WORK_DIR}/nodes.txt"
   execute({ input: 'Get(n => /header|hero/i.test(n.name) && Print(n.id, n.name, n.type))' })
   exit()
   EOF
   ```

2. **動的な値は `jq` でJSONエンコードしてから `<<EOF`（クォート無し）に差し込む**。`echo "'... $pattern ...'"` のような自前組み立ては禁止（改行・クォート・バックスラッシュが含まれた瞬間に壊れる）。

   ```bash
   PATTERN_JSON=$(jq -Rs 'rtrimstr("\n")' <<< 'header|hero|nav')
   # → 正しくエスケープされたJSON文字列リテラル（前後にダブルクォート付き）になる

   pencil interactive -i path/to/design.pen -o path/to/design.pen <<EOF > "${WORK_DIR}/nodes.txt"
   execute({ input: 're = new RegExp(${PATTERN_JSON}, "i"); Get(n => re.test(n.name) && Print(n.id, n.name, n.type))' })
   exit()
   EOF
   ```

   **`input` はシングルクォートで囲み、注入する値（JSONエンコード済み＝前後にダブルクォート付き）は input 内のダブルクォート文字列として使う**。`input` をダブルクォートで囲むと注入値のダブルクォートと入れ子が壊れ、`Invalid syntax. Expected: tool_name({ key: value })` になる。リテラルのパターンを直接書く場合は `/hero|header/i` のRegexリテラルでよい。

3. **`echo` を使わない。`printf '%s'` または `print -r --`（zsh）を使う**。

   ```bash
   # NG (zshで\nが実改行に化けてスニペットが壊れる)
   SNIPPET=$(echo 'Print("line1\nline2")')
   # OK
   SNIPPET=$(printf '%s' 'Print("line1\nline2")')
   ```

4. **JS値として改行が必要なら、リテラル `\n` の2文字で書く**（heredoc本文に実改行を含むテキストを直接書かない）。

#### 失敗を早く検出するセルフチェック

Pencilに流す前に「シェルが解釈した最終文字列」を `cat` で目視する。

```bash
cat > "${WORK_DIR}/cmds.txt" <<'EOF'
execute({ input: 'Get(n => /header/i.test(n.name) && Print(n.id, n.name))' })
exit()
EOF
cat "${WORK_DIR}/cmds.txt"   # \n やバックスラッシュが2文字のまま残っていることを目視
pencil interactive -i path/to/design.pen -o path/to/design.pen < "${WORK_DIR}/cmds.txt" > "${WORK_DIR}/nodes.txt"
```

`\n` が実改行に化けていたら即失敗。`<<'EOF'` に修正してやり直す。

## ルール3: 同時実行で競合しない一時ディレクトリを毎回確保する

中間ファイルの保存先を固定パスにすると、同じ `.pen` の同時 inspect で上書き衝突が起きる。開始時に `mktemp -d` で実行ごとに一意なディレクトリを確保する（`trap` で途中失敗時も自動後始末される）。

```bash
WORK_DIR="$(mktemp -d -t pencil-inspect-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
```

中間ファイル・画像の一次出力先は必ず `${WORK_DIR}` 配下に置き、`/tmp/out.json` のような固定パスは使わない。

## ルール4: `execute` の `Get` で対象Nodeを決定・取得する（ID指定にこだわらない）

`Get` は「IDで取る」「visitorで検索する」「サブツリーだけ走査する」「ドキュメント全体を走査する」を1関数でこなせるので、依頼の解像度に合わせてスニペットを組み立てる。

| ユーザーの依頼 | `execute` の `input` |
|---|---|
| 「id=`btn-cta` の中身を見せて」 | `Print(Get("btn-cta", { depth: 2 }))` |
| 「ヘッダー Nodeのプロパティを教えて」 | `Get(n => /header/i.test(n.name) && Print(n.id, n.name, n.type))` → 特定後に `Print(Get("<id>", { depth: 2 }))` |
| 「全テキストNodeを抜き出して」 | `Get(n => n.type === "text" && Print(n.id, n.name, n.content))` |
| 「再利用可能コンポーネント一覧」 | `Get(n => n.reusable && Print(n.id, n.name))` |
| 「ヘッダー配下のNodeを全部」 | `Get("<headerId>", (n, c) => Print(c.depth, n.id, n.name, n.type))` |
| 「ざっと全体構造を見たい」 | `Get((n, c) => { c.skipChildren(); Print(n.id, n.name, n.type) })`（トップレベルのみ） |

`Get` のシグネチャ（`read_skill({ path: "execute.md" })` が返す `execute` ドキュメントが正）:

```ts
function Get(path: string, options?: GetOptions): Child;          // 1Node（子はネストして返る）
function Get<T>(path: string, visit: Visit<T>, options?: GetOptions): T[];  // サブツリー走査
function Get<T>(visit: Visit<T>, options?: GetOptions): T[];      // ドキュメント全体を走査
type Visit<T> = (node: Child, ctx: Ctx) => T | undefined;         // undefined を返すと収集しない
```

| `GetOptions` | 意味 |
|---|---|
| `depth` | 返却ツリーの深さ（`0` = そのNodeのみ。省略した子は `"..."` になる。深くすると重い） |
| `resolveVariables` | `true` で variable 参照を実値に展開 |
| `resolveInstances` | `true` で `ref` コンポーネントインスタンスを実体展開（展開後のidは `instanceId/childId` 形式） |
| `includePathGeometry` | `true` で `path` Nodeの幾何データを省略せず返す |

| `Ctx`（visitorの第2引数） | 用途 |
|---|---|
| `ctx.depth` / `ctx.index` | 階層・兄弟内の位置。探索の深さ制限は `ctx.depth > N && c.skipChildren()` で自前に行う（旧 `searchDepth` の代替） |
| `ctx.bounds` | 親座標系での解決済み矩形（`x` / `y` / `width` / `height`）。サイズ確認はスクショより安い |
| `ctx.parentCtx` | 親のCtx。祖先はチェーンを辿る |
| `ctx.problems` | `"partially clipped"` / `"fully clipped"`（親からのはみ出し） |
| `ctx.skipChildren()` | この子孫へ降りない |

**旧 `batch_get` からの読み替え**: `nodeIds` → `Get(id)` を対象ごとに呼ぶ、`patterns` → visitorの条件式、`parentId` → `Get(parentId, visit)`、`readDepth` → `GetOptions.depth`、`searchDepth` → `ctx.depth` + `skipChildren()`。

`Print` は1引数ずつ「文字列はそのまま・他はJSON」で1行に連結して返すので、**一覧は「1Node1行の位置指定行」、単体の構造ダンプだけ `Print(Get(...))` のJSON**、と使い分けると出力が小さく保てる。

それでも候補が絞れない（「あのヘッダー的なやつ」のように曖昧）場合は、まず `get_app_state` でトップレベルNodeと再利用可能コンポーネントの一覧を取り、3〜5件の候補をユーザーに提示する。**ID必須ではない**のがポイント。

```bash
pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' > "${WORK_DIR}/state.txt"
get_app_state()
exit()
EOF
```

`get_app_state()` は**引数を取らない**（0.3.5 でフラグは廃止）。返るのはトップレベルNode・再利用可能コンポーネント・選択状態・統合ブラウザの状態だけで軽い。`.pen` スキーマや `execute` APIドキュメントが要る場合は `read_skill({ path: "pen-schema.md" })` / `read_skill({ path: "execute.md" })` を使う（どちらも数百行あるので、本スキルの範囲では通常不要）。

**注意**: 広い visitor 走査や大きい `depth` は返却がコンテキストを溢れさせることがある。最初は `depth: 1〜2`、走査は `ctx.depth` で3〜4段に制限して軽く取り、必要に応じて深掘りする。

## ルール5: 画像は `execute` の `Export` で出し、`snapshots/` へリネームして置く

**CLI 0.3.5 では画像出力も `execute` の関数**（`Export` / `TakeScreenshot`）。`Export` の出力先は画像フォーマットでは**ディレクトリ指定**で、ファイル名は**Node IDに固定**される（`<outputPath>/<nodeId>.png`）。したがって命名規則は「一次出力 → `mv` でリネーム」で満たす。

画像は `.pen` と同階層の `snapshots/` に保存し、ファイル名にタイムスタンプを必ず含める（同時実行・繰り返し実行での衝突回避）。

```bash
DESIGN="designs/login.pen"
SNAP_DIR="$(dirname "$DESIGN")/snapshots"
STEM="$(basename "$DESIGN" .pen)"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP_DIR"

# 複数Nodeを一括出力（一次出力は WORK_DIR）
pencil interactive -i "$DESIGN" -o "$DESIGN" <<EOF
execute({ input: 'Export(["node-a", "node-b"], "png", "${WORK_DIR}/img")' })
exit()
EOF

# Node ID固定のファイル名を規約どおりにリネームして永続化
for f in "${WORK_DIR}"/img/*.png; do
  mv "$f" "${SNAP_DIR}/${STEM}-$(basename "$f" .png)-${TS}.png"
done
```

`Export(nodeIds, format, outputPath, options?)` の仕様: `nodeIds`（必須・配列）/ `format`（`png` | `jpeg` | `webp` | `pdf` | `html-tailwind` | `html-css`）/ `outputPath`（画像はディレクトリ、HTMLは出力ファイル。**相対パスは `pencil interactive` を起動したcwd基準**）/ `options`（`scale` 既定 `2` / `quality`）。書き出したファイルの絶対パスがレスポンスに列挙される。**`nodeIds` に `"document"` は渡せない**（`Failed to find a node with id document` になる）。ドキュメント全体の画像が要るときはトップレベルのフレームIDを列挙するか、下の `TakeScreenshot` を使う。

ドキュメント全体、または画像を目で確認したいだけの単一Nodeは `TakeScreenshot(["..."])`。`"document"` はこちらでのみ有効。レスポンスに `{ nodeId, image: "<base64>", mimeType }` の配列が返るので、ファイルとして残すなら base64 を自分でデコードする。

```bash
pencil interactive -i "$DESIGN" -o "$DESIGN" <<'EOF' > "${WORK_DIR}/shot.txt"
execute({ input: 'TakeScreenshot(["document"])' })
exit()
EOF
grep -o '"image": "[^"]*"' "${WORK_DIR}/shot.txt" | sed 's/.*: "//; s/"$//' | base64 -d > "${SNAP_DIR}/${STEM}-document-${TS}.png"
```

ファイル命名規則: `<.penファイル名のステム>-<Node名 or Node ID>-<YYYYMMDD-HHMMSS>.png`（例: `login.pen` の `header` Node → `snapshots/login-header-20260627-160500.png`）。スケールは視認性のため既定の `2` のまま使う。

なおスクリーンショットは高コストなので、構造・サイズの確認は `ctx.bounds` を `Print` する方で済ませ、色・字形・整列など視覚的な確認が要るときだけ撮る。

## ルール6: データと画像を同一heredocでまとめて取得してもよい

属性取得の `Get` / `Print` と画像出力の `Export` / `TakeScreenshot` は同じ `execute` 呼び出しに並べても、同じセッションで連続する `execute` に分けてもよい（コード例は使用例の例1参照）。標準出力に両者の結果が混ざる（特に `TakeScreenshot` の base64 は長大）ため、分離が容易な簡単なケースでは1回にまとめ、複雑なケースでは別々に呼ぶ。

## ルール7: 実行結果をユーザーに伝える

`.pen` の中身は直接確認できないため、最終報告に含める:

- 何をクエリしたか（Node ID指定 / 名前Regex / type / reusable / サブツリー / トップレベル のいずれか）
- ヒットしたNode一覧（id / name / type を簡潔に。検索の場合は件数も）
- Node属性の要約（geometry / 主要style / content / 子Nodeなど）
- 生データの保存パス（`${WORK_DIR}` 配下 — trap によりセッション終了で消える旨も一言添える）
- 出力したスクリーンショット画像の絶対パス（`snapshots/` に永続化）

ユーザーがデータを永続的に欲しがった場合は `cp "${WORK_DIR}/nodes.txt" <希望パス>` を案内する。

# 標準ワークフロー

1. **前提確認**: `pencil version`、`pencil status`、対象 `.pen` の存在
2. **作業ディレクトリ確保**（ルール3）
3. **`snapshots/` 準備**: `mkdir -p <.penと同じディレクトリ>/snapshots`
4. **取得スコープの決定**: 依頼を「ID / 名前Regex / type / reusable / サブツリー / トップレベル」にマップ。曖昧なときだけ `get_app_state` またはトップレベル走査で候補を提示
5. **属性取得**: heredoc で `execute({ input: 'Get(...)' })` → `${WORK_DIR}/nodes.txt`（必要なら `depth` / `resolveVariables` / `ctx.depth` 制限を調整）
6. **画像取得**: 複数Nodeは `execute` の `Export` → `mv` でリネーム、全体または単体の目視は `TakeScreenshot`（`"document"` 可、base64をデコード）→ `snapshots/<stem>-<scope>-<timestamp>.png`
7. **要約報告**: ヒットNode一覧・属性の要点・画像パスを提示

# 使用例

## 例1: ログイン画面のヘッダーNodeを覗き見る（ID未知 → 名前検索で特定）

標準ワークフローどおり準備し、Node ID が分からないのでまず名前Regexで候補を洗い出す。

```bash
pencil interactive -i designs/login.pen -o designs/login.pen <<'EOF' > "${WORK_DIR}/hits.txt"
execute({ input: 'Get((n, c) => /header/i.test(n.name) && Print(n.id, n.name, n.type, c.bounds.width, c.bounds.height))' })
exit()
EOF
```

ヒットした `header-01`（type=frame）について属性と画像を1セッションで取る。

```bash
TS="$(date +%Y%m%d-%H%M%S)"

pencil interactive -i designs/login.pen -o designs/login.pen <<EOF > "${WORK_DIR}/combined.txt"
execute({ input: 'Print(Get("header-01", { depth: 2, resolveVariables: true }))\nExport(["header-01"], "png", "${WORK_DIR}/img")' })
exit()
EOF

mkdir -p designs/snapshots
mv "${WORK_DIR}/img/header-01.png" "designs/snapshots/login-header-01-${TS}.png"
```

報告例: Node `header-01`（type=frame, name="Header"）、主要属性（幅 1280px / 高さ 64px / 背景色 #FFFFFF / 子要素: Logo, NavMenu, ProfileButton）、スクリーンショットパス、生データパス（セッション終了で削除される旨を添える）。

## 例2: 再利用可能コンポーネントを一覧化し画像も一括出力（ID未指定）

ユーザー: 「`system.pen` にどんな再利用可能コンポーネントが入ってる？ 全部教えて」

```bash
DESIGN="design-system/system.pen"
SNAP_DIR="design-system/snapshots"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP_DIR"

# 再利用可能コンポーネントを一括検索（1Node1行。行頭に固定マーカーを付けて機械抽出を安全にする）
pencil interactive -i "$DESIGN" -o "$DESIGN" <<'EOF' > "${WORK_DIR}/components.txt"
execute({ input: 'Get(n => n.reusable && Print("COMP", n.id, n.name, n.type))' })
exit()
EOF

# マーカー行の2列目（id）だけを集めてJSON配列にする
IDS_JSON=$(grep -E '^COMP [A-Za-z0-9_-]+ ' "${WORK_DIR}/components.txt" | awk '{print $2}' | jq -R . | jq -sc .)

pencil interactive -i "$DESIGN" -o "$DESIGN" <<EOF
execute({ input: 'Export(${IDS_JSON}, "png", "${WORK_DIR}/img")' })
exit()
EOF

for f in "${WORK_DIR}"/img/*.png; do
  mv "$f" "${SNAP_DIR}/system-$(basename "$f" .png)-${TS}.png"
done
```

標準出力には `OK` / `Global variables ...` / `## Print output` などの周辺行が混ざるので、**ID抽出は `Print` の第1引数に固定マーカー（例: `"COMP"`）を置いて `grep` で絞る**。列数だけの判定はNode名に空白が含まれると壊れる。件数が多い場合は一覧を提示し、ユーザーが選んだものに対して画像取得を続行する。

報告では検出したコンポーネントの type / name / 主要プロパティを表形式で、画像パスと生データパスを併記する。

# 主要オプション/コマンド早見表

## インタラクティブモード起動オプション

`--in / -i <path>`（入力 `.pen`）、`--out / -o <path>`（出力 `.pen`。ヘッドレス時必須、`save()`を呼ばないため書き換わらない）、`--app / -a <name>`（起動中アプリへ接続。本スキルでは使わない）、`--help / -h`（ツールリファレンス表示）

## シェル内ツール（CLI 0.3.5 はこの5つのみ）

| ツール | 用途 |
|---|---|
| `get_app_state()` | **引数なし**。トップレベルNode・再利用可能コンポーネント・選択状態・統合ブラウザの状態（曖昧時のフォールバック） |
| `read_skill({ path })` | pen.dev 公式スキルの取得。`{ path: "pen-schema.md" }` で `.pen` スキーマ、`{ path: "execute.md" }` で `execute` APIドキュメント（本スキルの範囲では通常不要） |
| `execute({ input })` | **本スキルの中核**。`Get` / `Print` / `GetVariables` / `FindEmptySpace` / `TakeScreenshot` / `Export` の読み取り専用関数だけを使う（変更系関数は禁止） |
| `get_style({ name, params })` | 視覚スタイルのアーキタイプ取得（本スキルでは使わない） |
| `browser({ action, ... })` | 実サイトの読み込み・取り込み（本スキルでは使わない） |
| `exit()` | シェル終了（heredoc末尾に必ず置く） |
| `save()` | ディスクへ書き出し（**このスキルでは絶対に呼ばない**） |

`execute` の中の画像関数: `TakeScreenshot(nodeIds)` は指定Node（`"document"` 可）の画像を**base64でレスポンスに添付**、`Export(nodeIds, format, outputPath, options?)` は**ファイルへ書き出し**（画像はディレクトリ出力・ファイル名はNode ID固定・`"document"` 不可）。

**廃止済み**: `get_screenshot` / `export_nodes` / `export_html` / `get_guidelines` / `spawn_agents`（0.3.5 で削除。呼ぶと `Unknown tool: ...`）、および 0.2.x の `batch_get` / `get_editor_state` / `snapshot_layout` / `get_variables`。読み替えは順に `execute` の `TakeScreenshot` / `Export` / `Export`（`html-tailwind` / `html-css`）/ `read_skill` ＋ `get_style` / 代替なし、`execute` の `Get` / `get_app_state` / `ctx.bounds` の `Print` / `GetVariables()`。

# トラブルシューティング

- **`pencil: command not found`**: `npm install -g @pen.dev/cli` を案内（Node.js 18以上必要）
- **認証エラー**: `pencil login`、または `PEN_CLI_KEY` 環境変数を設定
- **`-o` が必須エラー**: ヘッドレス実行では `-o` 必須。入力と同じパスを指定し、`save()` を呼ばなければ変更されない
- **`Unknown tool: get_screenshot` / `export_nodes` / `export_html` / `get_guidelines` / `batch_get` / `get_editor_state`**: 廃止済み。早見表の「廃止済み」の読み替え表に従う（多くは `execute` の中の関数へ移動している）。`pencil version` が 0.3.5 未満なら入れ直す
- **`get_app_state({ include_schema: true, ... })` が効かない**: 0.3.5 の `get_app_state` は引数を取らない。スキーマ・APIドキュメントは `read_skill({ path: ... })` から取る
- **`TakeScreenshot` で画像ファイルができない**: `TakeScreenshot` はレスポンスに base64 を添付するだけ。ルール5のデコード手順を使うか `Export` を使う
- **`Export` で `Failed to find a node with id document`**: `Export` は `"document"` を受け付けない。トップレベルのフレームIDを列挙するか `TakeScreenshot(["document"])` を使う
- **Node ID が分からない**: 名前Regex / type / `reusable` の visitor、あるいはトップレベル走査でID不要の取得ができる。まずそれを試し、絞り切れないときだけ `get_app_state` で候補を提示
- **走査の返却が大きすぎる**: `depth` を 1〜2 に下げる、visitorで `ctx.depth > N && c.skipChildren()` を効かせる、`Get(parentId, ...)` で範囲を限定する、`Print(Get(...))` のJSONダンプをやめて1Node1行の位置指定 `Print` に変える
- **`.pen` ファイルが見つからない**: パスを再確認
- **大きいNodeで画像取得が遅い/タイムアウト**: `scale: 1` に下げて再試行。それでも遅ければ子Nodeに絞る
- **誤ってファイルを書き換えた気がする**: `save()` を呼ばない限り原則変わらない。心配なら git diff で確認（事前に `git status` で clean を確認しておくとよい）
- **`execute` の結果が空 / 想定と違うNodeセット**: (1) heredoc/シェルの改行展開でJS文字列が壊れた可能性が高い（ルール2の4原則とセルフチェックの `cat` 目視を再確認）、(2) visitor が `undefined` を返して何も収集していない、(3) `Print` を書き忘れて戻り値が捨てられている、の順に疑う
