---
name: inspect-pencil-node
description: "Pencil CLI（`pencil`コマンド）だけを使って、.penファイル（Pencilで作成されたデザインファイル）の中のNodeのデザインデータ（属性・構造）とスクリーンショット画像を読み取り専用で取得するスキル。Node ID指定に加え、名前の正規表現（例: 「ヘッダー」「.*Button」）、Nodeタイプ（frame / text / image など）、再利用可能コンポーネント、特定Node配下、ドキュメント全体のトップレベルなど、**ID以外の指定方法**にも対応する。ユーザーが「.penのこのNodeの中身を見せて」「特定コンポーネントのデザインデータを取り出して」「Nodeのスクリーンショットだけ欲しい」「ヘッダーの構造を確認したい」「ボタンのスタイルをコピーしたい」「再利用可能コンポーネント一覧を見せて」「ドキュメント全体の構造を覗きたい」「全てのテキストNodeを取得して」のように.pen内の要素の調査・参照・確認・抜き出しを依頼した場合に必ずこのスキルを使う。インタラクティブモード（`claude-task-worker pencil interactive`）で `execute` の `Get` / `Print`（読み取り専用関数のみ）を使ってNode属性を取得し、`export_nodes` / `get_screenshot` で画像を`.pen`と同階層の`snapshots/`にPNG出力する。編集はしない（`save()` も変更系関数も呼ばない）ため、対象ファイルは絶対に書き換わらない。Pencil MCPには依存せず`pencil`コマンドのみで完結。"
---

# Inspect Pencil Node

Pencil CLI（`pencil`コマンド）**のみ**で `.pen` デザインファイル内のNodeのデータと画像を**読み取り専用**で取得するスキル。MCPサーバーには依存しない。公式ドキュメント: [docs.pencil.dev/for-developers/pencil-cli](https://docs.pencil.dev/for-developers/pencil-cli)

姉妹スキル `edit-pencil-design` が「編集 + 編集Nodeのスクショ」を担当するのに対し、こちらは「Nodeを覗き見るだけ」で `.pen` の中身は一切書き換えない。

Nodeの指定方法は5系統に対応し、併用も可能。`Get` の第1引数にNode IDを渡せば検索範囲をそのサブツリーに絞れる。

1. **Node ID指定** — `Print(Get("<id>", { depth: 2 }))`
2. **名前パターン検索（JS Regex）** — `Get(n => /header/i.test(n.name) && Print(n.id, n.name, n.type))`
3. **タイプ指定** — `Get(n => n.type === "frame" && Print(...))`（`frame` / `group` / `rectangle` / `ellipse` / `line` / `polygon` / `path` / `text` / `connection` / `note` / `icon_font` / `image` / `ref`）
4. **再利用可能コンポーネント抽出** — `Get(n => n.reusable && Print(n.id, n.name))`
5. **トップレベル取得** — `Get((n, c) => { c.skipChildren(); Print(n.id, n.name, n.type) })`

# 設計思想

本スキルで使うのは**インタラクティブモード**（`claude-task-worker pencil interactive -i -o`）のみ。`get_app_state` / `execute` / `get_screenshot` / `export_nodes` / `exit` を heredoc で呼ぶ。エージェントモード（`claude-task-worker pencil --in --out --prompt`）はAI編集用なので使わない。

`.pen` は暗号化バイナリで `Read` / `Grep` では読めないため、Node属性の取得・スクリーンショット出力はすべてインタラクティブモード経由で行う。

**CLI 0.3.x でツール構成が変わっている**。旧 `batch_get` / `get_editor_state` は廃止された。現在のシェル内ツールは `browser` / `execute` / `export_html` / `export_nodes` / `get_app_state` / `get_guidelines` / `get_screenshot` / `spawn_agents` のみで、**Node属性の取得は `execute` の中で `Get` / `Print` を呼ぶ形に一本化**されている。

# 前提条件の確認

`@pen.dev/cli` にはアセットURIを絶対URIとして解決できないバグがあり、`.pen` のアセット読み込みが失敗する。`claude-task-worker pencil` はこの修正をNode の loader hook として `NODE_OPTIONS` 経由で注入したうえで `pencil` を実行するラッパーで、引数・stdin・stdout・stderr・終了コードはすべてそのまま素通しする（heredocも従来どおり使える）ため、使い方は素の `pencil` と完全に同じ。本スキルでは以降すべてのコマンドを `claude-task-worker pencil` として実行し、素の `pencil` を直接呼ばない。

1. `claude-task-worker pencil version` — 未インストールなら `npm install -g @pen.dev/cli` を案内（Node.js 18以上必要。パッケージ名は 0.3.x で `@pencil.dev/cli` から改称され、`pen` / `pencil` の両方のbinを提供する。旧パッケージしか無い環境は 0.2.x の旧ツール構成のため必ず更新する）
2. `claude-task-worker pencil status` — 未認証なら `claude-task-worker pencil login`、または `PEN_CLI_KEY` 環境変数の設定を案内（0.2.x での名称は `PENCIL_CLI_KEY`）
3. 対象の `.pen` ファイルが存在するか
4. ユーザーの取得対象指定を上記5系統（＋サブツリー限定）のどれかにマップする。どれも曖昧な場合だけトップレベル走査で候補を提示

# 実行ルール

## ルール1: 読み取り目的では変更系の関数を絶対に呼ばない

ヘッドレス実行では `-o` の指定が必須なので、入力と同じパスを `-o` に渡す。**`save()` を呼ばない限りディスクへの書き込みは発生しない** — これがファイル不変性の担保（実測: `save()` を省いたセッションでは `-o` のパスにファイルが作られない）。heredocの末尾は必ず `exit()` で締める。

`execute` は編集用のツールでもあるため、本スキルで書いてよいのは**読み取り専用の関数だけ**:

- 使ってよい: `Get` / `Print` / `GetVariables` / `FindEmptySpace`、および純粋なJS（変数・ループ・条件・正規表現）
- **絶対に書かない**: `Insert` / `Copy` / `Update` / `Replace` / `Move` / `Delete` / `Generate` / `SetVariables`、そして `save()`

`execute` は失敗時に自セッション内の変更を巻き戻すが、それは保険であって許可ではない。上記の変更系関数が1つでも混ざったスニペットは書かない。

`export_html` / `browser` / `spawn_agents` / `get_guidelines` は本スキルの守備範囲外（HTML書き出し・実サイト取り込み・エージェント起動・ガイド取得）なので使わない。

**素の `pencil` を直接呼ばない**。実行はすべて `claude-task-worker pencil` 経由で行う（前提条件の確認を参照）。

## ルール2: インタラクティブモードを heredoc で非対話的に呼び出す

heredoc で固定のコマンド列を流し、結果を `${WORK_DIR}` 配下に保存する。

```bash
claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' > "${WORK_DIR}/out.txt"
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
   claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' > "${WORK_DIR}/nodes.txt"
   execute({ input: 'Get(n => /header|hero/i.test(n.name) && Print(n.id, n.name, n.type))' })
   exit()
   EOF
   ```

2. **動的な値は `jq` でJSONエンコードしてから `<<EOF`（クォート無し）に差し込む**。`echo "'... $pattern ...'"` のような自前組み立ては禁止（改行・クォート・バックスラッシュが含まれた瞬間に壊れる）。

   ```bash
   PATTERN_JSON=$(jq -Rs 'rtrimstr("\n")' <<< 'header|hero|nav')
   # → 正しくエスケープされたJSON文字列リテラル（前後にダブルクォート付き）になる

   claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<EOF > "${WORK_DIR}/nodes.txt"
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
claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen < "${WORK_DIR}/cmds.txt" > "${WORK_DIR}/nodes.txt"
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

`Get` のシグネチャ（`get_app_state({ include_canvas_design: true })` が返す `execute` ドキュメントが正）:

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
claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' > "${WORK_DIR}/state.txt"
get_app_state({ include_schema: true, include_canvas_design: true, include_scripts_and_shaders: false, include_browser: false })
exit()
EOF
```

`get_app_state` は4つのフラグすべてが必須。スキーマと `execute` ドキュメントが不要なら `include_schema` / `include_canvas_design` を `false` にすると出力が大幅に小さくなる（両方 `true` だと700行規模）。

**注意**: 広い visitor 走査や大きい `depth` は返却がコンテキストを溢れさせることがある。最初は `depth: 1〜2`、走査は `ctx.depth` で3〜4段に制限して軽く取り、必要に応じて深掘りする。

## ルール5: 画像は `export_nodes` で出し、`snapshots/` へリネームして置く

**CLI 0.3.x では `get_screenshot` にファイル出力パラメータが無く、`{ image: "<base64>", mimeType: "image/png" }` を標準出力へ返すだけ**。`export_nodes` も出力先は**ディレクトリ指定**で、ファイル名は**Node IDに固定**される（`<outputDir>/<nodeId>.png`）。したがって命名規則は「一次出力 → `mv` でリネーム」で満たす。

画像は `.pen` と同階層の `snapshots/` に保存し、ファイル名にタイムスタンプを必ず含める（同時実行・繰り返し実行での衝突回避）。

```bash
DESIGN="designs/login.pen"
SNAP_DIR="$(dirname "$DESIGN")/snapshots"
STEM="$(basename "$DESIGN" .pen)"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP_DIR"

# 複数Nodeを一括出力（一次出力は WORK_DIR）
claude-task-worker pencil interactive -i "$DESIGN" -o "$DESIGN" <<EOF
export_nodes({ nodeIds: ["node-a", "node-b"], outputDir: "${WORK_DIR}/img", format: "png", scale: 2 })
exit()
EOF

# Node ID固定のファイル名を規約どおりにリネームして永続化
for f in "${WORK_DIR}"/img/*.png; do
  mv "$f" "${SNAP_DIR}/${STEM}-$(basename "$f" .png)-${TS}.png"
done
```

`export_nodes` の引数: `nodeIds`（必須・配列）/ `outputDir`（必須）/ `format`（`png` | `jpeg` | `webp` | `pdf`、既定 `png`）/ `scale`（既定 `2`）/ `quality`（JPEG・WEBPのみ）。**`nodeIds` に `"document"` は渡せない**（`Failed to find a node with id document` になる）。ドキュメント全体の画像が要るときはトップレベルのフレームIDを列挙するか、下の `get_screenshot` を使う。

ドキュメント全体、または画像を目で確認したいだけの単一Nodeは `get_screenshot({ nodeId: "..." })`。`nodeId: "document"` はこちらでのみ有効。ファイルとして残すなら base64 を自分でデコードする。

```bash
claude-task-worker pencil interactive -i "$DESIGN" -o "$DESIGN" <<'EOF' > "${WORK_DIR}/shot.txt"
get_screenshot({ nodeId: "document" })
exit()
EOF
grep -o '"image": "[^"]*"' "${WORK_DIR}/shot.txt" | sed 's/.*: "//; s/"$//' | base64 -d > "${SNAP_DIR}/${STEM}-document-${TS}.png"
```

ファイル命名規則: `<.penファイル名のステム>-<Node名 or Node ID>-<YYYYMMDD-HHMMSS>.png`（例: `login.pen` の `header` Node → `snapshots/login-header-20260627-160500.png`）。スケールは視認性のため `scale: 2`（`export_nodes` の既定値）を推奨。

なお `get_screenshot` は高コストなので、構造・サイズの確認は `ctx.bounds` を `Print` する方で済ませ、色・字形・整列など視覚的な確認が要るときだけ撮る。

## ルール6: データと画像を同一heredocでまとめて取得してもよい

`execute` と `get_screenshot` / `export_nodes` は同じセッションで連続実行できる（コード例は使用例の例1参照）。標準出力に両者の結果が混ざる（特に `get_screenshot` の base64 は長大）ため、分離が容易な簡単なケースでは1回にまとめ、複雑なケースでは別々に呼ぶ。

## ルール7: 実行結果をユーザーに伝える

`.pen` の中身は直接確認できないため、最終報告に含める:

- 何をクエリしたか（Node ID指定 / 名前Regex / type / reusable / サブツリー / トップレベル のいずれか）
- ヒットしたNode一覧（id / name / type を簡潔に。検索の場合は件数も）
- Node属性の要約（geometry / 主要style / content / 子Nodeなど）
- 生データの保存パス（`${WORK_DIR}` 配下 — trap によりセッション終了で消える旨も一言添える）
- 出力したスクリーンショット画像の絶対パス（`snapshots/` に永続化）

ユーザーがデータを永続的に欲しがった場合は `cp "${WORK_DIR}/nodes.txt" <希望パス>` を案内する。

# 標準ワークフロー

1. **前提確認**: `claude-task-worker pencil version`、`claude-task-worker pencil status`、対象 `.pen` の存在
2. **作業ディレクトリ確保**（ルール3）
3. **`snapshots/` 準備**: `mkdir -p <.penと同じディレクトリ>/snapshots`
4. **取得スコープの決定**: 依頼を「ID / 名前Regex / type / reusable / サブツリー / トップレベル」にマップ。曖昧なときだけ `get_app_state` またはトップレベル走査で候補を提示
5. **属性取得**: heredoc で `execute({ input: 'Get(...)' })` → `${WORK_DIR}/nodes.txt`（必要なら `depth` / `resolveVariables` / `ctx.depth` 制限を調整）
6. **画像取得**: 複数Nodeは `export_nodes` → `mv` でリネーム、全体または単体の目視は `get_screenshot`（`nodeId: "document"` 可、base64をデコード）→ `snapshots/<stem>-<scope>-<timestamp>.png`
7. **要約報告**: ヒットNode一覧・属性の要点・画像パスを提示

# 使用例

## 例1: ログイン画面のヘッダーNodeを覗き見る（ID未知 → 名前検索で特定）

標準ワークフローどおり準備し、Node ID が分からないのでまず名前Regexで候補を洗い出す。

```bash
claude-task-worker pencil interactive -i designs/login.pen -o designs/login.pen <<'EOF' > "${WORK_DIR}/hits.txt"
execute({ input: 'Get((n, c) => /header/i.test(n.name) && Print(n.id, n.name, n.type, c.bounds.width, c.bounds.height))' })
exit()
EOF
```

ヒットした `header-01`（type=frame）について属性と画像を1セッションで取る。

```bash
TS="$(date +%Y%m%d-%H%M%S)"

claude-task-worker pencil interactive -i designs/login.pen -o designs/login.pen <<EOF > "${WORK_DIR}/combined.txt"
execute({ input: 'Print(Get("header-01", { depth: 2, resolveVariables: true }))' })
export_nodes({ nodeIds: ["header-01"], outputDir: "${WORK_DIR}/img", format: "png", scale: 2 })
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
claude-task-worker pencil interactive -i "$DESIGN" -o "$DESIGN" <<'EOF' > "${WORK_DIR}/components.txt"
execute({ input: 'Get(n => n.reusable && Print("COMP", n.id, n.name, n.type))' })
exit()
EOF

# マーカー行の2列目（id）だけを集めてJSON配列にする
IDS_JSON=$(grep -E '^COMP [A-Za-z0-9_-]+ ' "${WORK_DIR}/components.txt" | awk '{print $2}' | jq -R . | jq -sc .)

claude-task-worker pencil interactive -i "$DESIGN" -o "$DESIGN" <<EOF
export_nodes({ nodeIds: ${IDS_JSON}, outputDir: "${WORK_DIR}/img", format: "png", scale: 2 })
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

## シェル内ツール（CLI 0.3.x）

| ツール | 用途 |
|---|---|
| `get_app_state({ include_schema, include_canvas_design, include_scripts_and_shaders, include_browser })` | トップレベルNode・再利用可能コンポーネント・選択状態・`.pen` スキーマ・`execute` APIドキュメントの取得（4フラグすべて必須。曖昧時のフォールバック） |
| `execute({ input })` | **本スキルの中核**。`Get` / `Print` / `GetVariables` / `FindEmptySpace` の読み取り専用関数だけを使う（変更系関数は禁止） |
| `get_screenshot({ nodeId })` | 単一Nodeまたは `"document"` のPNGを**base64で返す**（ファイル出力パラメータは無い） |
| `export_nodes({ nodeIds, outputDir, format, scale, quality })` | 複数NodeをPNG/JPEG/WEBP/PDFで**ディレクトリへ**出力（ファイル名はNode ID固定。`"document"` は不可） |
| `export_html({ nodeIds, outputPath, format, ... })` | HTML書き出し（本スキルでは使わない） |
| `browser({ action, ... })` | 実サイトの読み込み・取り込み（本スキルでは使わない） |
| `get_guidelines({ category, name, params })` | デザインガイド/スタイルの取得（本スキルでは使わない） |
| `spawn_agents(...)` | サブエージェント起動（本スキルでは使わない） |
| `exit()` | シェル終了（heredoc末尾に必ず置く） |
| `save()` | ディスクへ書き出し（**このスキルでは絶対に呼ばない**） |

**廃止済み**: `batch_get` / `get_editor_state` / `snapshot_layout` / `get_variables`（CLI 0.3.1時点で存在しない）。それぞれ `execute` の `Get` / `get_app_state` / `ctx.bounds` の `Print` / `execute` の `GetVariables()` で代替する。

# トラブルシューティング

- **`pencil: command not found`**: `npm install -g @pen.dev/cli` を案内（Node.js 18以上必要）
- **認証エラー**: `claude-task-worker pencil login`、または `PEN_CLI_KEY` 環境変数を設定
- **`-o` が必須エラー**: ヘッドレス実行では `-o` 必須。入力と同じパスを指定し、`save()` を呼ばなければ変更されない
- **`Unknown tool: batch_get` / `get_editor_state`**: CLI 0.3.x で廃止済み。`execute` の `Get` と `get_app_state` に読み替える（早見表の「廃止済み」参照）
- **`get_screenshot` に `out` を渡しても画像ファイルができない**: 現行の `get_screenshot` はファイル出力パラメータを持たず base64 を返すだけ。ルール5のデコード手順を使うか `export_nodes` を使う
- **`export_nodes` で `Failed to find a node with id document`**: `export_nodes` は `"document"` を受け付けない。トップレベルのフレームIDを列挙するか `get_screenshot({ nodeId: "document" })` を使う
- **Node ID が分からない**: 名前Regex / type / `reusable` の visitor、あるいはトップレベル走査でID不要の取得ができる。まずそれを試し、絞り切れないときだけ `get_app_state` で候補を提示
- **走査の返却が大きすぎる**: `depth` を 1〜2 に下げる、visitorで `ctx.depth > N && c.skipChildren()` を効かせる、`Get(parentId, ...)` で範囲を限定する、`Print(Get(...))` のJSONダンプをやめて1Node1行の位置指定 `Print` に変える
- **`.pen` ファイルが見つからない**: パスを再確認
- **大きいNodeで画像取得が遅い/タイムアウト**: `scale: 1` に下げて再試行。それでも遅ければ子Nodeに絞る
- **誤ってファイルを書き換えた気がする**: `save()` を呼ばない限り原則変わらない。心配なら git diff で確認（事前に `git status` で clean を確認しておくとよい）
- **`execute` の結果が空 / 想定と違うNodeセット**: (1) heredoc/シェルの改行展開でJS文字列が壊れた可能性が高い（ルール2の4原則とセルフチェックの `cat` 目視を再確認）、(2) visitor が `undefined` を返して何も収集していない、(3) `Print` を書き忘れて戻り値が捨てられている、の順に疑う
