---
name: edit-pencil-design
description: pen.dev CLI（`pencil` / `pen`コマンド）だけを使って.penファイル（pen.devで作成されたデザインファイル）を`execute`による決定論的な編集操作で修正・更新・新規作成するスキル。.penファイルの編集、ボタン追加、レイアウト変更、UIデザインの調整、pen.devデザインの更新、新しい.penデザインの作成などの依頼で必ず使用する。有料の`--prompt`（エージェントモード）は使わず、編集・新規作成はすべてインタラクティブモード（`pencil interactive`）の`execute`（`Insert` / `Update` / `Delete` など）で行い、最後に`save()`する。`Insert` / `Update` に渡すNodeデータは`references/pen-format.md`の.penフォーマット定義に従う。既存ファイルは`-i`と`-o`に同一パスを指定して上書き、新規作成は`-i`を省略して`-o`に新しいパスを指定する。編集・作成後は「**編集・作成したコンポーネントのNodeだけ**」を`execute`の`Export` / `TakeScreenshot`でPNG出力し、`.pen`と同階層の`snapshots/`ディレクトリに保存する。pen.dev MCPには依存せず`pencil`コマンドのみで完結する。.penファイルのgitコンフリクト解消・破損復旧は本スキルではなく`resolve-pencil-conflict`スキルの担当。
---

# Edit Pencil Design

pen.dev CLI（`pencil` コマンド。`pen` も同じバイナリ）**のみ**で `.pen` デザインファイルを編集・新規作成し、編集・作成Nodeだけのスクリーンショットを残すスキル。MCPサーバーには依存しない。公式ドキュメント: [docs.pen.dev/for-developers/pen-cli](https://docs.pen.dev/for-developers/pen-cli)

**`--prompt`（エージェントモード）は有料になったため使わない**。編集・新規作成は `pencil interactive` の `execute` で行い、`Insert` / `Update` / `Replace` に渡すNodeデータは `${CLAUDE_PLUGIN_ROOT}/references/pen-format.md`（[docs.pen.dev/for-developers/the-pen-format](https://docs.pen.dev/for-developers/the-pen-format) を元にした .pen フォーマット定義）に従って書く。

**CLI 0.3.5 でシェル内ツールが5つに整理された**。現在あるのは `browser` / `execute` / `get_app_state` / `get_style` / `read_skill`（＋ `save()` / `exit()`）のみ。**Nodeの読み書きも画像出力も `execute` に一本化**されている（`Export` / `TakeScreenshot` は `execute` の中の関数であってツールではない）。廃止済みツールは早見表の「廃止済み」を参照。パッケージ名は `@pen.dev/cli` で、`pen` / `pencil` の両方のbinを提供する。

# 設計思想

pen.dev CLI のうち、`--prompt` を伴わない次の機能だけを使う:

| モード | 起動方法 | 用途 |
|---|---|---|
| **インタラクティブモード** | `pencil interactive -i -o`（新規作成時は `-i` 省略） | `read_skill()` / `get_app_state()` / `get_style()` / `execute({ input })` / `save()` / `exit()`。**編集・新規作成（Insert / Update / Delete 等）も画像出力（`Export` / `TakeScreenshot`）もこちらで完結する** |
| **エクスポート** | `pencil --in <path> --export <path>` | ファイル全体の画像出力（ユーザーが全体画像を明示的に求めた場合のみ） |

`.pen` の実体は平文JSON（[The .pen Format](https://docs.pen.dev/for-developers/the-pen-format)）だが、手でJSONを書き換えずに `execute` を通す。`execute` はNodeデータをスキーマ検証してエラー時に丸ごと巻き戻し、ID採番とレイアウト解決も pen.dev 側で行うため、ID重複・参照切れ・未知プロパティの黙殺といった手編集の事故が起きない。Node構造の確認・Node ID取得・Node単位スクリーンショットも `pencil interactive` 経由で行う。

# 重要な前提

- **既存ファイルの編集はその場で上書き更新する**（別名出力は二重管理を生むため避ける）
- **新規作成は `-i` を省略し、`-o` にまだ存在しないパスを指定する**（既存パスを `-o` に指定すると意図せぬ上書きになるため、実行前に存在チェックを必ず行う）
- **gitコンフリクトのテキストマージは絶対禁止**（コンフリクトマーカーの手編集や `git mergetool` はNode ID・参照の整合を壊してファイルを破損させる。コンフリクト解消は `resolve-pencil-conflict` スキルの担当）
- **スクリーンショットはファイル全体ではなく編集・作成対象のNodeだけ**（差分レビューが容易になる）

# 前提条件の確認

1. `pencil version` — 未インストールなら `npm install -g @pen.dev/cli` を案内（Node.js 22.19以上必要。**0.3.5 未満はツール構成が違う**ため、その場合も更新する）
2. `pencil status` — 未認証なら `pencil login`、または `PEN_CLI_KEY` 環境変数の設定を案内
3. 対象の `.pen` ファイルの存在確認 — **編集**なら先に存在している必要がある。**新規作成**なら存在していてはならない（既に存在する場合は、編集として扱うべきかユーザーに確認する）。新規作成では出力先ディレクトリを `mkdir -p` で用意する

# 実行ルール

## ルール1: 操作種別（編集 / 新規作成）とモードの選択

まず依頼が**既存ファイルの編集**か**新規ファイルの作成**かを判定する。

### 既存ファイルの編集（`execute`）

インタラクティブモードの `execute({ input: '...' })` で編集する。大きめのリファインやレイアウト調整も、変更内容を `Insert` / `Update` / `Replace` / `Move` / `Delete` の組み合わせに分解して行う（自然言語で任せる手段は使わない）。heredoc/シェルの改行展開を誤るとサイレントに失敗するため、**ルール2の安全規則を必ず守る**。`-i` と `-o` には**同じ `.pen` パス**を指定する。

編集前に次を読む:

- **`${CLAUDE_PLUGIN_ROOT}/references/pen-format.md`** — `Insert` / `Update` / `Replace` に渡すNodeデータの形（`type` ごとのプロパティ、レイアウト、fill、`ref` / `descendants`、変数参照 `"$name"`）。**Nodeデータは .pen ファイル内のオブジェクトと同じ形**で、`children` に子Nodeを入れ子で書ける
- **`read_skill({ path: "execute.md" })`** — `execute` のAPIドキュメント（`get_app_state` はAPIドキュメントを返さない）。インストール済みCLIとリファレンスのスキーマが食い違う疑いがあれば `read_skill({ path: "pen-schema.md" })` を正とする

プロパティ名を推測で書くと schema-validation エラーでその `execute` が巻き戻る（`save()` だけが走って無編集になる）。

`execute` の主な関数（詳細は `read_skill({ path: "execute.md" })` が返すドキュメントが正）:

| 関数 | 用途 |
|---|---|
| `Insert(parent, nodeData)` | 子Nodeを末尾に追加。戻り値は生成されたNode ID |
| `Update(path, updateData)` | 既存Nodeのプロパティ更新 |
| `Copy(path, parent, copyNodeData)` / `Replace(path, nodeData)` / `Move(path, parent, index)` / `Delete(path)` | 複製 / 置換 / 移動 / 削除 |
| `Get(path \| visit, options)` / `Print(...)` | 読み取り（`inspect-pencil-node` と同じ。編集前後の確認に使う） |
| `SetVariables(vars, replace)` / `GetVariables()` | デザイン変数 |
| `Generate(nodeId, "ai" \| "svg" \| "stock", prompt)` | 画像・SVGの生成。プロンプトをAIで解釈する機能で課金対象になりうるため、アイコンで足りるなら `type: "icon"`、既存画像があるなら image fill を優先する |
| `FindEmptySpace({...})` | 空き領域の探索（新規フレームの配置先） |
| `TakeScreenshot(nodeIds)` | Nodeを描画してレスポンスに画像を添付（`"document"` 可。旧 `get_screenshot`） |
| `Export(nodeIds, format, outputPath, options)` | Nodeをファイルへ書き出し（旧 `export_nodes` / `export_html`。ルール5参照） |

`execute` の重要な性質:

- **エラー時はその `execute` 呼び出し内の変更と作成されたグローバルがすべて巻き戻る**（部分適用にはならない）
- **失敗したスニペットは丸ごと投げ直さず `edits` で直す**。失敗レスポンスに `editId` が出るので、次の呼び出しは `execute({ editId: "<id>", edits: [{ find: "...", replace: "..." }] })` の形にする（パッチ後のスニペットが最初から再実行される）
- **警告（warnings）はレスポンスに列挙される。無視せず次の `execute` で必ず直す**
- 呼び出しごとにスコープが独立する。値を持ち越すなら `const` / `let` を付けずに `myNode = Insert(...)` と書く
- 追加した全Nodeに人間可読な `name` を必ず付ける。`execute` は末尾に **name → 生成ID のマッピング**を返すので、これがそのまま「編集Nodeの特定」に使える
- `id` は指定しない（常にPencilが採番する）。コンポーネント作成は生成IDを受け取るために別の `execute` に分ける

### 新規ファイルの作成（空キャンバスからの `execute`）

- `pencil interactive -o path/to/new-design.pen`（`-i` を**省略**＝空キャンバス）で `execute` の `Insert(document, {...})` を重ね、最後に `save()` する
- 実行前に `-o` のパスが未使用であることを確認する（`[ -e path ]` チェック）。既に存在する場合は上書きせず、編集として扱う
- 作風を揃えたいがブランド指定も `DESIGN.md` も無い場合は `get_style()` でスタイルのアーキタイプを読み込んでから組み立てる

## ルール2: インタラクティブモードを heredoc で非対話的に呼び出す

`pencil interactive` は標準入力からコマンドを流せば非対話的に実行できる。

```bash
pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF'
execute({ input: 'Update("title-01", { fill: "#123456" })' })
save()
exit()
EOF
```

- `-i` と `-o` には**編集対象と同じ `.pen` パス**を指定（ヘッドレスモードでは `-o` が必須）
- `save()` を呼ばなければファイルへの変更は永続化されない（読み取りのみなら `save()` 不要。実測でも `save()` 無しのセッションは `-o` のパスにファイルを作らない）
- 最後に必ず `exit()` を呼ぶ

### heredoc / シェルの改行展開を正しく扱う（重要）

`execute({ input: '...' })` の中身はJS文字列リテラルなので、複数行のスニペットは `\n` の**2文字**で区切って渡す。シェルが文字列内の `\n` を実改行に展開するとJS文字列が閉じずパースエラーになり、Pencil側は**その `execute` を失敗させたまま `save()` だけが走る**。結果、小数点正規化（`13.995000000000001` → `13.995`）のような無害な差分だけがディスクに残る。**失敗が表面上は成功に見える事故パターンなので必読**。

| シェル / コマンド | `"a\nb"` の扱い |
|---|---|
| zsh の組み込み `echo` | **`\n` を実改行に展開**（デフォルト挙動） |
| bash の組み込み `echo` | デフォルトでは展開しない（`-e` で展開） |
| `printf '%s' "..."` | 移植性ありで `\n` を2文字のまま出力 |
| `print -r -- "..."` (zsh) | エスケープ解釈なし |
| heredoc `<<'EOF'`（クォート付） | **本文をリテラルのまま渡す**（`\n` は2文字のまま、変数展開も無し） |
| heredoc `<<EOF`（クォート無） | 変数展開・コマンド置換は行うが、リテラル `\n` は2文字のまま |

原則は「**JS/JSON文字列リテラル内の `\n` は2文字（バックスラッシュ + n）のままPencilに届けること**」。`execute` のスニペットを複数文に分ける区切りにも同じ `\n` を使う（`'a=Insert(...)\nUpdate(...)'`）。

#### 改行を確実に2文字のまま渡すための4原則

1. **heredoc は最優先で `<<'EOF'`（シングルクォート付き）を使う** — 変数展開もエスケープ解釈も止まり、本文のJSがそのままPencilに届く。

2. **動的な値は `jq` でJSONエンコードしてから heredoc に差し込む**。`echo "{\"text\": \"$user_input\"}"` のような自前組み立ては禁止（改行・ダブルクォート・バックスラッシュが含まれた瞬間に壊れる）。

   ```bash
   TEXT_JSON=$(jq -Rs 'rtrimstr("\n")' <<< "Hello
   World")
   # → "Hello\nWorld" という、正しくエスケープされたJSON文字列リテラルになる

   pencil interactive -i path/to/design.pen -o path/to/design.pen <<EOF
   execute({ input: 'Update("title-01", { content: ${TEXT_JSON} })' })
   save()
   exit()
   EOF
   ```

   **`input` はシングルクォートで囲み、注入する値（前後にダブルクォート付き）は `input` 内のダブルクォート文字列として使う**。`input` をダブルクォートで囲むと注入値のダブルクォートと入れ子が壊れ、`Invalid syntax. Expected: tool_name({ key: value })` になる。

3. **`echo` を使わない。`printf '%s'` または `print -r --`（zsh）を使う**。

   ```bash
   # NG (zshで\nが実改行に化けてスニペットが壊れる)
   ARGS=$(echo 'Update("t1", { content: "Hello\nWorld" })')
   # OK
   ARGS=$(printf '%s' 'Update("t1", { content: "Hello\nWorld" })')
   ```

4. **JS値として改行が必要なら、リテラル `\n` の2文字で書く**（heredoc本文に実改行を含むテキストを直接書かない）。

#### 失敗を早く検出するセルフチェック

Pencilに流す前に「シェルが解釈した最終文字列」を `cat` で目視する。

```bash
cat > "${WORK_DIR}/cmds.txt" <<'EOF'
execute({ input: 'Update("t1", { content: "line1\nline2" })' })
save()
exit()
EOF
cat "${WORK_DIR}/cmds.txt"   # 文字列リテラル内の \n が2文字のまま残っていることを目視
pencil interactive -i path/to/design.pen -o path/to/design.pen < "${WORK_DIR}/cmds.txt"
```

`\n` が実改行に化けていたら即失敗。`<<'EOF'` に修正してやり直す。あわせて `execute` のレスポンスに `Error` / warnings が出ていないかも必ず確認する（出ていれば `save()` してはいけない）。

## ルール3: 同時実行で競合しない一時ディレクトリを毎回確保する

中間ファイルの保存先を固定パスにすると、同じ `.pen` の同時編集で上書き衝突が起きる。開始時に `mktemp -d` で実行ごとに一意なディレクトリを確保する（`trap` で途中失敗時も自動後始末される）。

```bash
WORK_DIR="$(mktemp -d -t pencil-edit-XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT
```

`before.json` / `after.json` などの中間ファイルは**必ず `${WORK_DIR}` 配下**に置く（`/tmp/before.json` のような固定パスは使わない）。

## ルール4: 編集の前後でNodeツリーを取得し、対象Nodeを特定する

**新規作成の場合**は手順1をスキップし「空のツリー」として扱う（= 作成後の `after.json` に含まれる全Nodeが新規Node）。手順5の代わりに、`-o` のファイルが実際に生成されたこと・`after.json` にNodeが含まれることを確認し、どちらかを満たさなければ作成失敗として `${WORK_DIR}/edit.log` を確認のうえ再実行する。

`get_editor_state()` は廃止されたので、ツリーのスナップショットは `execute` の `Get` visitor で**1行のコンパクトJSON**として吐き出す（そのまま `jq` で比較できる）。

1. **編集前のスナップショット取得**（編集のみ）
   ```bash
   pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' 2>/dev/null | sed -n 's/^TREE //p' > "${WORK_DIR}/before.json"
execute({ input: 'Print("TREE", JSON.stringify(Get((n,c)=>({d:c.depth,id:n.id,name:n.name,type:n.type,x:n.x,y:n.y,w:c.bounds.width,h:c.bounds.height,fill:n.fill,content:n.content}))))' })
exit()
EOF
   ```

   出力は `[{"d":0,"id":"F9RVcy","name":"Hero",...}, ...]` の1行JSON。**行頭マーカー `TREE ` を付けて `sed` で抜く**（`[INFO] Starting pen.dev (headless)...` のような起動ログも `[` で始まるため、`grep '^\['` では拾い分けられない）。属性を増やしたいときは visitor の返すオブジェクトに足す（重くなるので必要な分だけ）。

   heredoc本文と終端の `EOF` は**行頭から**書く（インデントすると終端が認識されない）。同じコマンドを `after.json` にも使うので、`.pen` パスと出力先だけ差し替える。

2. **編集（`execute`）** — ルール2のheredocで実行し、標準出力・標準エラーを `${WORK_DIR}/edit.log` に流す（同時実行時のログ取り違えを防ぐ）。`edit.log` に `Error` / `[ERROR]` / warnings が出ていないことを確認する

3. **編集後のスナップショット取得** — 同様に `${WORK_DIR}/after.json` へ保存

4. **編集Nodeの特定**
   - レスポンス末尾の **`## Created nodes by name` のマッピング**（`"Hero": "cGySg"` 形式）と、`Update` / `Replace` / `Move` / `Delete` に渡した既知のIDがそのまま対象
   - 取りこぼしの確認として before/after のJSON差分も見る: `after` にあって `before` に無い `id` → 新規追加Node、双方にあるが属性差分のある `id` → 変更Node

5. **「実質的な編集が無い」ケースの検出 → 編集失敗扱いにする**（編集のみ。新規作成では前述のファイル生成チェックで代替）

   差分が「Node IDの追加・削除なし、type / name / 構造の変化なし、数値フォーマットの正規化のみ（例: `13.995000000000001` → `13.995`、`100.0` → `100`）」なら、`execute` のスニペットが壊れて適用されず `save()` だけ走った可能性が極めて高い（ルール2のトラブルの典型的な観測像）。編集失敗として報告し、再実行する。チェックは `jq` で数値表現を正規化してから diff:

   ```bash
   jq -S 'walk(if type == "number" then tonumber|tostring|tonumber else . end)' \
     "${WORK_DIR}/before.json" > "${WORK_DIR}/before.norm.json"
   jq -S 'walk(if type == "number" then tonumber|tostring|tonumber else . end)' \
     "${WORK_DIR}/after.json"  > "${WORK_DIR}/after.norm.json"

   if diff -q "${WORK_DIR}/before.norm.json" "${WORK_DIR}/after.norm.json" >/dev/null; then
     echo "編集失敗の疑い: 構造に有意な差分なし。heredocのJS引数が壊れていないかルール2を再確認してください" >&2
     exit 1
   fi
   ```

   この検証は編集Node特定の直前に必ず通す。

## ルール5: 編集・作成したNodeだけをスクリーンショットし `snapshots/` に保存する

**CLI 0.3.5 では画像出力も `execute` の関数**（`Export` / `TakeScreenshot`）に一本化された。`Export` の出力先は画像フォーマットでは**ディレクトリ指定**で、ファイル名は**Node IDに固定**される（`<outputPath>/<nodeId>.png`）。したがって命名規則は「一次出力 → `mv` でリネーム」で満たす。

**新規作成の場合**は全Nodeが新規のため、`after.json` のトップレベルフレーム（画面・ページ単位のNode）を対象にする。多数ある場合は主要なフレームに絞る。

```bash
DESIGN="designs/login.pen"
SNAP_DIR="$(dirname "$DESIGN")/snapshots"
STEM="$(basename "$DESIGN" .pen)"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP_DIR"

pencil interactive -i "$DESIGN" -o "$DESIGN" <<EOF
execute({ input: 'Export(["<編集Node1 ID>", "<編集Node2 ID>"], "png", "${WORK_DIR}/img")' })
exit()
EOF

for f in "${WORK_DIR}"/img/*.png; do
  mv "$f" "${SNAP_DIR}/${STEM}-$(basename "$f" .png)-${TS}.png"
done
```

`Export(nodeIds, format, outputPath, options?)` の仕様: `nodeIds`（必須・配列）/ `format`（`png` | `jpeg` | `webp` | `pdf` | `html-tailwind` | `html-css`）/ `outputPath`（画像はディレクトリ、HTMLは出力ファイルのパス。**相対パスは `pencil interactive` を起動したcwd基準**）/ `options`（`scale` 既定 `2` / `quality` / HTML用の `includeHtmlScaffold` など）。書き出したファイルの絶対パスがレスポンスに列挙される。`pdf` は全Nodeが1つの `export.pdf` にまとまる。**`nodeIds` に `"document"` は渡せない**（`Failed to find a node with id document`）。

画像を自分の目で確認したいだけなら `TakeScreenshot(["<Node ID>"])`（`"document"` はこちらでのみ有効）。レスポンスに `{ nodeId, image: "<base64>", mimeType }` の配列が返るので、ファイルとして残すなら base64 を自分でデコードする。

```bash
pencil interactive -i "$DESIGN" -o "$DESIGN" <<'EOF' > "${WORK_DIR}/shot.txt"
execute({ input: 'TakeScreenshot(["<Node ID>"])' })
exit()
EOF
grep -o '"image": "[^"]*"' "${WORK_DIR}/shot.txt" | sed 's/.*: "//; s/"$//' | base64 -d > "${SNAP_DIR}/${STEM}-<node>-${TS}.png"
```

- ファイル命名規則: `<.penファイル名のステム>-<Node名 or Node ID>-<YYYYMMDD-HHMMSS>.png`（例: `login.pen` の `header` Node → `snapshots/login-header-20260627-153045.png`）。タイムスタンプ込みにより `snapshots/` 内も同時実行で衝突しない
- 新規Nodeが親コンテナ内に追加された場合、親Node IDも対象に加えると配置確認しやすい
- **ファイル全体のエクスポート（`--export`）は原則使わない**。ユーザーが明示的に全体画像を要求した場合のみ `pencil --in <path> --export <全体画像のpath> --export-scale 2` を補助的に使う
- スクリーンショットはコスト高。サイズ・配置の確認だけなら `execute` の `Get` visitor で `ctx.bounds` / `ctx.problems`（`"partially clipped"` / `"fully clipped"`）を `Print` する方が安く確実
- `Export` / `TakeScreenshot` は編集と同じ `execute` 呼び出しの末尾に置いてよい（同一呼び出し内の変更が反映される）。ただし失敗した `execute` の画像は返らない

## ルール6: 実行結果をユーザーに伝える

`.pen` の中身は直接確認できないため、最終報告に必ず含める:

- 実行したコマンド（インタラクティブモードのheredoc）
- 編集・作成したと判定したNode（IDと、可能なら名前・type）
- 更新または新規作成した `.pen` ファイルの絶対パス
- 出力したNode単位スクリーンショット画像の絶対パス（対象Nodeごと）

# 標準ワークフロー

1. **前提確認**: `pencil version`（0.3.5 以上であること）、`pencil status`
2. **操作種別の判定と対象ファイル確認**: 編集なら `.pen` が存在すること、新規作成なら `-o` のパスが未使用であること（ルール1）
3. **作業ディレクトリ確保**（ルール3）
4. **`snapshots/` 準備**: `mkdir -p <.penと同じディレクトリ>/snapshots`
5. **編集前スナップショット**（編集のみ）: ルール4のツリーダンプ（`Print("TREE", ...)`）→ `${WORK_DIR}/before.json`
6. **編集/作成実行**（ルール1。先に `references/pen-format.md` と `read_skill({ path: "execute.md" })` でNodeデータの形とAPIを確認。ログは `${WORK_DIR}/edit.log` へ）
7. **編集/作成後スナップショット**: 同じツリーダンプ → `${WORK_DIR}/after.json`
8. **失敗検出**: 編集はルール4-5 の `jq` 正規化 diff で「実質的編集が無い」ケースを検出（該当すればルール2に戻る）。新規作成は `-o` ファイルの存在と `after.json` にNodeが含まれることを確認
9. **対象Node特定**: `execute` の生成IDマッピングと操作したID（before/after の差分で取りこぼしを確認）、新規作成は `after.json` のトップレベルフレーム
10. **Node単位スクリーンショット**（ルール5。タイムスタンプ込み）
11. **報告**（ルール6。`${WORK_DIR}` は trap で自動削除）

# 使用例

## 編集: ログインページに「パスワードをお忘れですか？」リンクを追加

標準ワークフローどおり before.json を取得し、ツリーからパスワード入力欄を含むフォームのフレーム（例: `login-form-01`）を特定したうえで:

```bash
pencil interactive -i designs/login.pen -o designs/login.pen <<'EOF' > "${WORK_DIR}/edit.log" 2>&1
execute({ input: 'Insert("login-form-01", { type: "text", name: "Forgot Password Link", content: "パスワードをお忘れですか？", fontSize: 13, fill: "#2563EB", underline: true })' })
save()
exit()
EOF
```

`## Created nodes by name` に出る `"Forgot Password Link": "<id>"` がそのまま対象Node ID。`Error` や warnings が出ていたら `save()` の結果を信用せず、`editId` + `edits` で直して再実行する。対象Node（と親の `login-form-01`）をルール5の `Export` で `snapshots/` へ出力する。

## 新規作成: 404エラーページ

```bash
# 出力先が未使用であることを確認（既存なら上書きせず、編集として扱う）
[ -e designs/error-404.pen ] && { echo "designs/error-404.pen は既に存在します" >&2; exit 1; }

# 作成（-i は省略＝空キャンバス、-o に新しいパス）。子Nodeは children に入れ子で書ける
pencil interactive -o designs/error-404.pen <<'EOF' > "${WORK_DIR}/edit.log" 2>&1
execute({ input: 'page=Insert(document, { type: "frame", name: "404 Page", x: 0, y: 0, width: 1440, height: 900, fill: "#FFFFFF", layout: "vertical", justifyContent: "center", alignItems: "center", gap: 24, children: [{ type: "text", name: "Heading", content: "404", fontSize: 96, fontWeight: "700", fill: "#111827" }, { type: "text", name: "Message", content: "ページが見つかりません", fontSize: 20, fill: "#4B5563" }, { type: "frame", name: "Home Button", padding: [12, 24], cornerRadius: 8, fill: "#2563EB", children: [{ type: "text", name: "Label", content: "ホームへ戻る", fontSize: 16, fill: "#FFFFFF" }] }] })' })
save()
exit()
EOF

# 作成結果の確認（before は無いので after のみ）
[ -f designs/error-404.pen ] || { echo "作成失敗: edit.log を確認してください" >&2; exit 1; }
```

その後 `after.json` を取得し、トップレベルフレーム（`## Created nodes by name` の `"404 Page"`）を `execute` の `Export` で `snapshots/` へ出力する。

# 主要オプション/コマンド早見表

## インタラクティブモード（編集・新規作成・読み取り・スクショ用）

起動オプション: `--in / -i <path>`（省略で空キャンバス＝新規作成）、`--out / -o <path>`（ヘッドレス時必須。編集時は `-i` と同じパス）、`--app / -a <name>`（起動中アプリへ接続）、`--preview-output <path>` / `--enable-preview`（変更ごとにプレビューPNGを保存）、`--help / -h`（全ツールの引数リファレンス）

シェル内ツール（CLI 0.3.5 はこの5つのみ）:
- `read_skill({ path })` — pen.dev 公式スキルの取得。引数なしで `SKILL.md`、`{ path: "pen-schema.md" }` で `.pen` スキーマ、`{ path: "execute.md" }` で `execute` APIドキュメント（`guide/web-app.md` など SKILL.md から参照されるファイルも読める）
- `get_app_state()` — **引数なし**。トップレベルNode・再利用可能コンポーネント・選択状態・統合ブラウザの状態のみ（スキーマとAPIドキュメントは返さないので `read_skill` を使う）
- `execute({ input })` / `execute({ editId, edits })` — **読み書き・画像出力の中核**。`Insert` / `Update` / `Copy` / `Replace` / `Move` / `Delete` / `SetVariables` / `Generate` / `Get` / `Print` / `GetVariables` / `FindEmptySpace` / `TakeScreenshot` / `Export`。失敗時は `editId` + `edits` でパッチして再実行する
- `get_style({ name, params })` — 視覚スタイルのアーキタイプ（フォント・配色・イメージ）。引数なしで一覧、`{ name }` で必要paramsの確認、`{ name, params }` で読み込み。ブランド指定が無い新規作成で作風を揃えたいときに使う
- `browser({ action, target, querySelector, url })` — 統合ブラウザで実サイトを読み込み、キャンバスへ取り込み/スクショ/DOM取得
- `save()` — 編集結果を `.pen` に書き出す（読み取り目的なら省略）／ `exit()` — シェル終了

## エクスポート（ファイル全体の画像。本スキルでは原則使わない）

`pencil --in <path> --export <path> --export-scale <n> --export-type <png|jpeg|webp|pdf>`。形式は拡張子ではなく `--export-type` で決まる。失敗しても終了コードが0になりうるため、出力ファイルの存在を確認する。

## 使わないオプション

`--prompt/-p` / `--prompt-file/-f` / `--tasks/-t`（AIエージェントの実行。有料のため本スキルでは使わない）。`--agent` / `--model` / `--effort` などエージェント用のオプションも同様。

**廃止済み**: `get_screenshot` / `export_nodes` / `export_html` / `get_guidelines` / `spawn_agents`（0.3.5 で削除。呼ぶと `Unknown tool: ...`）、および 0.2.x の `batch_design` / `batch_get` / `get_editor_state` / `snapshot_layout` / `get_variables`。読み替えは順に `execute` の `TakeScreenshot` / `Export` / `Export`（`html-tailwind` / `html-css`）/ `read_skill` ＋ `get_style` / 代替なし、`execute` の変更系関数 / `Get` / `get_app_state`（＋ `Get` のツリーダンプ）/ `ctx.bounds` の `Print` / `GetVariables()`。

# トラブルシューティング

- **`pencil: command not found` / 認証エラー**: 前提条件の確認どおり `npm install -g @pen.dev/cli`（Node.js 18以上）／`pencil login` または `PEN_CLI_KEY` を案内
- **`Unknown tool: get_screenshot` / `export_nodes` / `export_html` / `get_guidelines` / `spawn_agents` / `batch_design` / `batch_get` / `get_editor_state`**: 廃止済み。早見表の「廃止済み」の読み替え表に従う（多くは `execute` の中の関数へ移動している）。`pencil version` が 0.3.5 未満なら入れ直す
- **`get_app_state({ include_schema: true, ... })` が効かない / スキーマが返らない**: 0.3.5 の `get_app_state` は引数を取らず、スキーマと `execute` APIドキュメントは `read_skill({ path: "pen-schema.md" })` / `read_skill({ path: "execute.md" })` から取る
- **`Invalid syntax. Expected: tool_name({ key: value })`**: `execute` の `input` をダブルクォートで囲んだ中にダブルクォート文字列を注入して入れ子が壊れている。ルール2の原則2（`input` はシングルクォート囲み）を適用する
- **`-o` が必須エラー**: ヘッドレス実行では `-o` 必須。ルール2のとおり `-i` と同じパスを指定する（`save()` を呼ばなければ変更は永続化されない）
- **`TakeScreenshot` で画像ファイルができない**: `TakeScreenshot` はレスポンスに base64 を添付するだけ。ファイルとして残すならルール5のデコード手順を使うか `Export` を使う
- **`Export` で `Failed to find a node with id document`**: `Export` は `"document"` を受け付けない。トップレベルのフレームIDを列挙するか `TakeScreenshot(["document"])` を使う
- **`execute` が warnings / `Invalid properties` を返した**: プロパティ名・値がスキーマと合っていない（`- /colr unexpected property` のようにJSON Pointerで示される）。`references/pen-format.md`（食い違う疑いがあれば `read_skill({ path: "pen-schema.md" })`）で確認し、`editId` + `edits` で直してから `save()` する
- **編集Nodeが特定できない**（idが再採番される/大規模変更）: 影響を受けた最上位フレーム/コンポーネントを代表として1つエクスポートし、ユーザーに確認を求める
- **`.pen` ファイルが見つからない**: パスを再確認。新規作成の依頼であれば `-i` を省略して `-o` に新しいパスを指定する（ルール1の新規作成手順）
- **新規作成したはずなのに `-o` にファイルが無い / `after.json` のNodeが空**: `${WORK_DIR}/edit.log` を確認する。`save()` の呼び忘れ、`execute` のエラー（巻き戻り）、認証エラーのいずれかがログに残っていることが多い
- **新規作成の `-o` に指定したパスが既に存在する**: 上書きせず中断し、既存ファイルの編集として扱う
- **`.pen` がgitコンフリクト状態（`git status` で `UU` / `AA` など）、またはコンフリクトマーカー混入で破損して開けない**: 本スキルの対象外。テキストマージは絶対にせず、`resolve-pencil-conflict` スキルで解消・復旧する
- **想定と違う編集結果**: `Get` で対象Nodeの現状属性を確認し、`execute` のスニペットを具体化して再実行する（`--prompt` には切り替えない）。`.pen` は上書きされるため、重要な編集前にはユーザーに git コミット等のバックアップを促す
- **編集したはずなのに小数点正規化（例: `13.995000000000001` → `13.995`）だけが残っている**: heredoc経由の `execute` でJS引数が壊れ、`save()` だけ走った典型的な事故。ルール2の4原則（`<<'EOF'` / `jq -Rs .`・`printf '%s'` / リテラル `\n`）とセルフチェックの `cat` 目視を順に確認して再実行し、ルール4-5 の正規化 diff で「数値正規化だけ」でないことを確認してから報告する
