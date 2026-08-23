---
name: edit-pencil-design
description: Pencil CLI（`pencil`コマンド）だけを使って.penファイル（Pencilで作成されたデザインファイル）をAIプロンプトまたは決定論的な編集操作で修正・更新・新規作成するスキル。.penファイルの編集、ボタン追加、レイアウト変更、UIデザインの調整、Pencilデザインの更新、新しい.penデザインの作成などの依頼で必ず使用する。AI任せの編集・新規作成はエージェントモード（`claude-task-worker pencil --in --out --prompt`）で行い、既存ファイルは同一パスを指定して上書き、新規作成は`--in`を省略して`--out`に新しいパスを指定する。決定論的な編集はインタラクティブモード（`claude-task-worker pencil interactive`）の`execute`（`Insert` / `Update` / `Delete` など）で行い、最後に`save()`する。編集・作成後は「**編集・作成したコンポーネントのNodeだけ**」を`export_nodes` / `get_screenshot`でPNG出力し、`.pen`と同階層の`snapshots/`ディレクトリに保存する。Pencil MCPには依存せず`pencil`コマンドのみで完結する。.penファイルのgitコンフリクト解消・破損復旧は本スキルではなく`resolve-pencil-conflict`スキルの担当。
---

# Edit Pencil Design

Pencil CLI（`pencil`コマンド）**のみ**で `.pen` デザインファイルを編集・新規作成し、編集・作成Nodeだけのスクリーンショットを残すスキル。MCPサーバーには依存しない。公式ドキュメント: [docs.pencil.dev/for-developers/pencil-cli](https://docs.pencil.dev/for-developers/pencil-cli)

**CLI 0.3.x でツール構成が変わっている**。旧 `batch_design` / `batch_get` / `get_editor_state` / `snapshot_layout` / `get_variables` は廃止された。現在のシェル内ツールは `browser` / `execute` / `export_html` / `export_nodes` / `get_app_state` / `get_guidelines` / `get_screenshot` / `spawn_agents`（＋ `save()` / `exit()`）のみで、**Nodeの読み書きはどちらも `execute` に一本化**されている。パッケージ名も `@pen.dev/cli` に変わり、`pen` / `pencil` の両方のbinを提供する。

# 設計思想

Pencil CLI の2つの実行モードを使い分ける:

| モード | 起動方法 | できること |
|---|---|---|
| **エージェントモード** | `claude-task-worker pencil --in --out --prompt`（新規作成時は `--in` 省略） | AIプロンプトで `.pen` を編集・新規作成（**自然言語**での編集・作成はこのモードのみ） |
| **インタラクティブモード** | `claude-task-worker pencil interactive -i -o` | `get_app_state()` / `execute({ input })` / `get_screenshot()` / `export_nodes()` / `save()` / `exit()`。**決定論的な編集（Insert / Update / Delete 等）もこちらで完結する**（旧 `batch_design` の代替） |

`.pen` は暗号化バイナリで `Read` / `Grep` では読めないため、Node構造の確認・Node ID取得・Node単位スクリーンショットはすべて `claude-task-worker pencil interactive` 経由で行う。

# 重要な前提

- **既存ファイルの編集はその場で上書き更新する**（別名出力は二重管理を生むため避ける）
- **新規作成は `--in` を省略し、`--out` にまだ存在しないパスを指定する**（既存パスを `--out` に指定すると意図せぬ上書きになるため、実行前に存在チェックを必ず行う）
- **gitコンフリクトのテキストマージは絶対禁止**（`.pen` は暗号化バイナリのため、コンフリクトマーカーの手編集や `git mergetool` はファイルを破損させる。コンフリクト解消は `resolve-pencil-conflict` スキルの担当）
- **スクリーンショットはファイル全体ではなく編集・作成対象のNodeだけ**（差分レビューが容易になる）
- **素の `pencil` を直接呼ばない**。実行はすべて `claude-task-worker pencil` 経由で行う（理由は次節）

# 前提条件の確認

`@pen.dev/cli` にはアセットURIを絶対URIとして解決できないバグがあり、`.pen` のアセット読み込みが失敗する。`claude-task-worker pencil` はこの修正をNode の loader hook として `NODE_OPTIONS` 経由で注入したうえで `pencil` を実行するラッパーで、引数・stdin・stdout・stderr・終了コードはすべてそのまま素通しする（heredocも従来どおり使える）ため、使い方は素の `pencil` と完全に同じ。本スキルでは以降すべてのコマンドを `claude-task-worker pencil` として実行し、素の `pencil` を直接呼ばない。

1. `claude-task-worker pencil version` — 未インストールなら `npm install -g @pen.dev/cli` を案内（Node.js 18以上必要。旧パッケージ `@pencil.dev/cli` しか入っていない環境では 0.2.x の旧ツール構成になるため、必ず 0.3.x へ更新する）
2. `claude-task-worker pencil status` — 未認証なら `claude-task-worker pencil login`、または `PEN_CLI_KEY` 環境変数の設定を案内（0.2.x での名称は `PENCIL_CLI_KEY`）
3. 対象の `.pen` ファイルの存在確認 — **編集**なら先に存在している必要がある。**新規作成**なら存在していてはならない（既に存在する場合は、編集として扱うべきかユーザーに確認する）。新規作成では出力先ディレクトリを `mkdir -p` で用意する

# 実行ルール

## ルール1: 操作種別（編集 / 新規作成）とモードの選択

まず依頼が**既存ファイルの編集**か**新規ファイルの作成**かを判定する。

### 既存ファイルの編集（エージェント / `interactive` どちらも可）

- **エージェントモード** `claude-task-worker pencil --in path/to/design.pen --out path/to/design.pen --prompt "<修正内容>"`（短縮形 `-i` / `-o` / `-p`）— 自然言語で任せたい編集。大きめのリファイン、レイアウト調整、複数Nodeにまたがる修正向き
- **インタラクティブモードの `execute({ input: '...' })`** — 「このNodeの色を `#123456` に」「このフレームにテキストを1つ足す」のような決定論的な編集向き。結果が予測可能で差分も追いやすいが、heredoc/シェルの改行展開を誤るとサイレントに失敗するため、**ルール2の安全規則を必ず守る**

どちらのモードでも `--in` と `--out` には**同じ `.pen` パス**を指定する。

`execute` で編集する場合は、**先に `get_app_state({ include_schema: true, include_canvas_design: true, include_scripts_and_shaders: false, include_browser: false })` を1回呼んでスキーマと `execute` APIドキュメントを読む**（4フラグすべて必須）。プロパティ名を推測で書くと警告付きで無視され、無編集のまま `save()` が走る。

`execute` の主な関数（詳細は `get_app_state` が返すドキュメントが正）:

| 関数 | 用途 |
|---|---|
| `Insert(parent, nodeData)` | 子Nodeを末尾に追加。戻り値は生成されたNode ID |
| `Update(path, updateData)` | 既存Nodeのプロパティ更新 |
| `Copy(path, parent, copyNodeData)` / `Replace(path, nodeData)` / `Move(path, parent, index)` / `Delete(path)` | 複製 / 置換 / 移動 / 削除 |
| `Get(path \| visit, options)` / `Print(...)` | 読み取り（`inspect-pencil-node` と同じ。編集前後の確認に使う） |
| `SetVariables(vars, replace)` / `GetVariables()` | デザイン変数 |
| `Generate(nodeId, "ai" \| "stock", prompt)` | 画像fillの生成 |
| `FindEmptySpace({...})` | 空き領域の探索（新規フレームの配置先） |

`execute` の重要な性質:

- **エラー時はその `execute` 呼び出し内の変更と作成されたグローバルがすべて巻き戻る**（部分適用にはならない）
- **警告（warnings）はレスポンスに列挙される。無視せず次の `execute` で必ず直す**
- 呼び出しごとにスコープが独立する。値を持ち越すなら `const` / `let` を付けずに `myNode = Insert(...)` と書く
- 追加した全Nodeに人間可読な `name` を必ず付ける。`execute` は末尾に **name → 生成ID のマッピング**を返すので、これがそのまま「編集Nodeの特定」に使える
- `id` は指定しない（常にPencilが採番する）。コンポーネント作成は生成IDを受け取るために別の `execute` に分ける

### 新規ファイルの作成（エージェントモード、または空キャンバスからの `execute`）

```bash
claude-task-worker pencil --out path/to/new-design.pen --prompt "<作成したいデザインの内容>"
```

- `--in` を**省略**し、`--out` に新しい `.pen` パスを指定する
- 実行前に `--out` のパスが未使用であることを確認する（`[ -e path ]` チェック）。既に存在する場合は上書きせず、編集として扱うかユーザーに確認する
- 決定論的に組み立てたい場合は `claude-task-worker pencil interactive -o path/to/new-design.pen`（`-i` 省略＝空キャンバス）で `execute` の `Insert` を重ね、最後に `save()` する

## ルール2: インタラクティブモードを heredoc で非対話的に呼び出す

`claude-task-worker pencil interactive` は標準入力からコマンドを流せば非対話的に実行できる。

```bash
claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF'
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

   claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<EOF
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
claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen < "${WORK_DIR}/cmds.txt"
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

**新規作成の場合**は手順1をスキップし「空のツリー」として扱う（= 作成後の `after.json` に含まれる全Nodeが新規Node）。手順5の代わりに、`--out` のファイルが実際に生成されたこと・`after.json` にNodeが含まれることを確認し、どちらかを満たさなければ作成失敗として `${WORK_DIR}/edit.log` を確認のうえ再実行する。

`get_editor_state()` は廃止されたので、ツリーのスナップショットは `execute` の `Get` visitor で**1行のコンパクトJSON**として吐き出す（そのまま `jq` で比較できる）。

1. **編集前のスナップショット取得**（編集のみ）
   ```bash
   claude-task-worker pencil interactive -i path/to/design.pen -o path/to/design.pen <<'EOF' 2>/dev/null | sed -n 's/^TREE //p' > "${WORK_DIR}/before.json"
execute({ input: 'Print("TREE", JSON.stringify(Get((n,c)=>({d:c.depth,id:n.id,name:n.name,type:n.type,x:n.x,y:n.y,w:c.bounds.width,h:c.bounds.height,fill:n.fill,content:n.content}))))' })
exit()
EOF
   ```

   出力は `[{"d":0,"id":"F9RVcy","name":"Hero",...}, ...]` の1行JSON。**行頭マーカー `TREE ` を付けて `sed` で抜く**（`[INFO] Starting pen.dev (headless)...` のような起動ログも `[` で始まるため、`grep '^\['` では拾い分けられない）。属性を増やしたいときは visitor の返すオブジェクトに足す（重くなるので必要な分だけ）。

   heredoc本文と終端の `EOF` は**行頭から**書く（インデントすると終端が認識されない）。同じコマンドを `after.json` にも使うので、`.pen` パスと出力先だけ差し替える。

2. **編集（エージェントモード）** — 標準出力・標準エラーも `${WORK_DIR}` に流し、同時実行時のログ取り違えを防ぐ
   ```bash
   claude-task-worker pencil --in path/to/design.pen --out path/to/design.pen --prompt "<具体的な指示>" \
     > "${WORK_DIR}/edit.log" 2>&1
   ```

   `execute` で編集する場合はルール2のheredocで実行し、その出力も `${WORK_DIR}/edit.log` に残す。

3. **編集後のスナップショット取得** — 同様に `${WORK_DIR}/after.json` へ保存

4. **編集Nodeの特定**
   - `execute` で編集した場合は、レスポンス末尾の **`## Created nodes by name` のマッピング**（`Hero=cGySg` 形式）と、`Update` / `Delete` に渡した既知のIDがそのまま対象
   - エージェントモードの場合は before/after のJSON差分から判定: `after` にあって `before` に無い `id` → 新規追加Node、双方にあるが属性差分のある `id` → 変更Node
   - 判定が難しい場合（idの再採番、大規模な再構成など）は推定できる範囲で抽出し、残りはユーザーに確認。フォールバックとして影響を受けた最上位フレーム/コンポーネントのNode IDを1つ選んでスクリーンショットを取る

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

**CLI 0.3.x では `get_screenshot` にファイル出力パラメータが無く**、`{ image: "<base64>", mimeType: "image/png" }` を標準出力へ返すだけ。`export_nodes` も出力先は**ディレクトリ指定**で、ファイル名は**Node IDに固定**される（`<outputDir>/<nodeId>.png`）。したがって命名規則は「一次出力 → `mv` でリネーム」で満たす。

**新規作成の場合**は全Nodeが新規のため、`after.json` のトップレベルフレーム（画面・ページ単位のNode）を対象にする。多数ある場合は主要なフレームに絞る。

```bash
DESIGN="designs/login.pen"
SNAP_DIR="$(dirname "$DESIGN")/snapshots"
STEM="$(basename "$DESIGN" .pen)"
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$SNAP_DIR"

claude-task-worker pencil interactive -i "$DESIGN" -o "$DESIGN" <<EOF
export_nodes({ nodeIds: ["<編集Node1 ID>", "<編集Node2 ID>"], outputDir: "${WORK_DIR}/img", format: "png", scale: 2 })
exit()
EOF

for f in "${WORK_DIR}"/img/*.png; do
  mv "$f" "${SNAP_DIR}/${STEM}-$(basename "$f" .png)-${TS}.png"
done
```

`export_nodes` の引数: `nodeIds`（必須・配列）/ `outputDir`（必須）/ `format`（`png` | `jpeg` | `webp` | `pdf`、既定 `png`）/ `scale`（既定 `2`）/ `quality`。**`nodeIds` に `"document"` は渡せない**（`Failed to find a node with id document`）。

画像を自分の目で確認したいだけなら `get_screenshot({ nodeId: "<Node ID>" })`（`"document"` はこちらでのみ有効）。ファイルとして残すなら base64 を自分でデコードする。

```bash
claude-task-worker pencil interactive -i "$DESIGN" -o "$DESIGN" <<'EOF' > "${WORK_DIR}/shot.txt"
get_screenshot({ nodeId: "<Node ID>" })
exit()
EOF
grep -o '"image": "[^"]*"' "${WORK_DIR}/shot.txt" | sed 's/.*: "//; s/"$//' | base64 -d > "${SNAP_DIR}/${STEM}-<node>-${TS}.png"
```

- ファイル命名規則: `<.penファイル名のステム>-<Node名 or Node ID>-<YYYYMMDD-HHMMSS>.png`（例: `login.pen` の `header` Node → `snapshots/login-header-20260627-153045.png`）。タイムスタンプ込みにより `snapshots/` 内も同時実行で衝突しない
- 新規Nodeが親コンテナ内に追加された場合、親Node IDも対象に加えると配置確認しやすい
- **ファイル全体のエクスポート（エージェントモードの `--export`）は原則使わない**。ユーザーが明示的に全体画像を要求した場合のみ `claude-task-worker pencil --in <path> --export <全体画像のpath> --export-scale 2` を補助的に使う
- スクリーンショットはコスト高。サイズ・配置の確認だけなら `execute` の `Get` visitor で `ctx.bounds` / `ctx.problems`（`"partially clipped"` / `"fully clipped"`）を `Print` する方が安く確実

## ルール6: 実行結果をユーザーに伝える

`.pen` の中身は直接確認できないため、最終報告に必ず含める:

- 実行したコマンド（エージェントモードのCLIと、インタラクティブモードのheredoc）
- 編集・作成したと判定したNode（IDと、可能なら名前・type）
- 更新または新規作成した `.pen` ファイルの絶対パス
- 出力したNode単位スクリーンショット画像の絶対パス（対象Nodeごと）

# 標準ワークフロー

1. **前提確認**: `claude-task-worker pencil version`（0.3.x であること）、`claude-task-worker pencil status`
2. **操作種別の判定と対象ファイル確認**: 編集なら `.pen` が存在すること、新規作成なら `--out` のパスが未使用であること（ルール1）
3. **作業ディレクトリ確保**（ルール3）
4. **`snapshots/` 準備**: `mkdir -p <.penと同じディレクトリ>/snapshots`
5. **編集前スナップショット**（編集のみ）: ルール4のツリーダンプ（`Print("TREE", ...)`）→ `${WORK_DIR}/before.json`
6. **編集/作成実行**（ルール1。`execute` を使うなら先に `get_app_state` でスキーマ確認。ログは `${WORK_DIR}/edit.log` へ）
7. **編集/作成後スナップショット**: 同じツリーダンプ → `${WORK_DIR}/after.json`
8. **失敗検出**: 編集はルール4-5 の `jq` 正規化 diff で「実質的編集が無い」ケースを検出（該当すればルール2に戻る）。新規作成は `--out` ファイルの存在と `after.json` にNodeが含まれることを確認
9. **対象Node特定**: `execute` なら生成IDマッピング、エージェントモードは before/after の差分、新規作成は `after.json` のトップレベルフレーム
10. **Node単位スクリーンショット**（ルール5。タイムスタンプ込み）
11. **報告**（ルール6。`${WORK_DIR}` は trap で自動削除）

# 使用例

## 編集A（自然言語）: ログインページに「Forgot password?」リンクを追加

標準ワークフローどおり before.json 取得 → `claude-task-worker pencil --in designs/login.pen --out designs/login.pen --prompt "Add a 'Forgot password?' link below the password input, aligned to the right" > "${WORK_DIR}/edit.log" 2>&1` → after.json 取得。差分から新規Node `forgot-link-01` を特定したら:

```bash
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p designs/snapshots
claude-task-worker pencil interactive -i designs/login.pen -o designs/login.pen <<EOF
export_nodes({ nodeIds: ["forgot-link-01"], outputDir: "${WORK_DIR}/img", format: "png", scale: 2 })
exit()
EOF
mv "${WORK_DIR}/img/forgot-link-01.png" "designs/snapshots/login-forgot-link-${TS}.png"
```

## 編集B（決定論的）: 同じリンクを `execute` で正確に追加する

```bash
claude-task-worker pencil interactive -i designs/login.pen -o designs/login.pen <<'EOF' > "${WORK_DIR}/edit.log" 2>&1
get_app_state({ include_schema: true, include_canvas_design: true, include_scripts_and_shaders: false, include_browser: false })
execute({ input: 'Insert("password-field-01", { type: "text", name: "Forgot Password Link", content: "パスワードをお忘れですか？", fontSize: 13, fill: "#2563EB" })' })
save()
exit()
EOF
```

`## Created nodes by name` に出る `Forgot Password Link=<id>` がそのまま対象Node ID。`Error` や warnings が出ていたら `save()` の結果を信用せず、警告内容を直して再実行する。

## 新規作成: 404エラーページ

```bash
# 出力先が未使用であることを確認（既存なら上書きせず、編集として扱うか確認する）
[ -e designs/error-404.pen ] && { echo "designs/error-404.pen は既に存在します" >&2; exit 1; }

# 作成（--in は省略、--out に新しいパス）
claude-task-worker pencil --out designs/error-404.pen \
  --prompt "Create a 404 error page with a large '404' heading, a 'ページが見つかりません' message, and a primary button linking back to home" \
  > "${WORK_DIR}/edit.log" 2>&1

# 作成結果の確認（before は無いので after のみ）
[ -f designs/error-404.pen ] || { echo "作成失敗: edit.log を確認してください" >&2; exit 1; }
```

その後 `after.json` を取得し、トップレベルフレーム（例: `error-404-page`）を同様に `export_nodes` で `snapshots/` へ出力する。

# 主要オプション/コマンド早見表

## エージェントモード（編集・新規作成用）

`--in/-i <path>`（入力。**新規作成時は省略**）、`--out/-o <path>`（出力。編集時は `--in` と同じパス、新規作成時は未使用の新しいパス）、`--prompt/-p <text>`（編集・作成指示）、`--prompt-file/-f <path>`（画像・テキストファイルの添付。参照デザインを渡すときに使う。繰り返し指定可）、`--agent <claude|codex|gemini>`（既定 `claude`）、`--model/-m <id>`（`claude-opus-5`（既定） / `claude-fable-5` / `claude-sonnet-5` / `claude-haiku-4-5` など。`--list-models` で一覧）、`--effort <level>`、`--repo/-C <path>`（エージェントの作業ディレクトリ）、`--max-failed-calls <n>`、`--verbose/-v`、`--export/-e <path>` / `--export-scale <n>` / `--export-type <png|jpeg|webp|pdf>`（ファイル全体の画像出力。本スキルでは原則使わない）

## インタラクティブモード（読み書き・スクショ用）

起動オプション: `--in / -i <path>`（省略で空キャンバス）、`--out / -o <path>`（ヘッドレス時必須）、`--app / -a <name>`（起動中アプリへ接続）、`--help / -h`

シェル内ツール:
- `get_app_state({ include_schema, include_canvas_design, include_scripts_and_shaders, include_browser })` — トップレベルNode・再利用可能コンポーネント・選択状態・`.pen` スキーマ・`execute` APIドキュメント（4フラグすべて必須）
- `execute({ input })` — **読み書きの中核**。`Insert` / `Update` / `Copy` / `Replace` / `Move` / `Delete` / `SetVariables` / `Generate` / `Get` / `Print` / `GetVariables` / `FindEmptySpace`
- `get_screenshot({ nodeId })` — 単一Nodeまたは `"document"` のPNGを**base64で返す**（出力パスパラメータは無い）
- `export_nodes({ nodeIds, outputDir, format, scale, quality })` — 複数NodeをPNG/JPEG/WEBP/PDFで**ディレクトリへ**出力（ファイル名はNode ID固定、`"document"` 不可）
- `export_html({ nodeIds, outputPath, format, includeHtmlScaffold, includeLayerIds, includeLayerNames })` — HTML + Tailwind / HTML + CSS への書き出し
- `get_guidelines({ category, name, params })` — デザインガイド（`guide`）とスタイル（`style`）の取得。新規作成で作風を揃えたいときに使う
- `browser({ action, target, querySelector, url })` — 統合ブラウザで実サイトを読み込み、キャンバスへ取り込み/スクショ/DOM取得
- `spawn_agents(...)` — サブエージェント起動（本スキルでは使わない）
- `save()` — 編集結果を `.pen` に書き出す（読み取り目的なら省略）
- `exit()` — シェル終了

**廃止済み**: `batch_design` / `batch_get` / `get_editor_state` / `snapshot_layout` / `get_variables`（CLI 0.3.1時点で存在しない）。それぞれ `execute` の変更系関数 / `execute` の `Get` / `get_app_state`（＋ `Get` のツリーダンプ）/ `ctx.bounds` の `Print` / `execute` の `GetVariables()` で代替する。

# トラブルシューティング

- **`pencil: command not found` / 認証エラー**: 前提条件の確認どおり `npm install -g @pen.dev/cli`（Node.js 18以上）／`claude-task-worker pencil login` または `PEN_CLI_KEY` を案内
- **`Unknown tool: batch_design` / `batch_get` / `get_editor_state`**: CLI 0.3.x で廃止済み。`execute` と `get_app_state` に読み替える（早見表の「廃止済み」参照）。`claude-task-worker pencil version` が 0.2.x なら旧パッケージ `@pencil.dev/cli` を掴んでいるので 0.3.x を入れ直す
- **`Invalid syntax. Expected: tool_name({ key: value })`**: `execute` の `input` をダブルクォートで囲んだ中にダブルクォート文字列を注入して入れ子が壊れている。ルール2の原則2（`input` はシングルクォート囲み）を適用する
- **`-o` が必須エラー**: ヘッドレス実行では `-o` 必須。ルール2のとおり `-i` と同じパスを指定する（`save()` を呼ばなければ変更は永続化されない）
- **`get_screenshot` に `out` を渡しても画像ファイルができない**: 現行の `get_screenshot` はファイル出力パラメータを持たず base64 を返すだけ。ルール5のデコード手順を使うか `export_nodes` を使う
- **`export_nodes` で `Failed to find a node with id document`**: `export_nodes` は `"document"` を受け付けない。トップレベルのフレームIDを列挙するか `get_screenshot({ nodeId: "document" })` を使う
- **`execute` が warnings を返した**: プロパティ名・値がスキーマと合っていない。`get_app_state({ include_schema: true })` でスキーマを確認し、次の `execute` で直してから `save()` する
- **編集Nodeが特定できない**（idが再採番される/大規模変更）: 影響を受けた最上位フレーム/コンポーネントを代表として1つエクスポートし、ユーザーに確認を求める
- **`.pen` ファイルが見つからない**: パスを再確認。新規作成の依頼であれば `--in` を省略して `--out` に新しいパスを指定する（ルール1の新規作成手順）
- **新規作成したはずなのに `--out` にファイルが無い / `after.json` のNodeが空**: `${WORK_DIR}/edit.log` を確認し、`--prompt` を具体化して再実行。認証エラーやプロンプト拒否がログに残っていることが多い。`execute` で作成した場合は `save()` の呼び忘れも疑う
- **新規作成の `--out` に指定したパスが既に存在する**: 上書きせず中断し、既存ファイルの編集として扱うか別パスに作成するかをユーザーに確認する
- **`.pen` がgitコンフリクト状態（`git status` で `UU` / `AA` など）、またはコンフリクトマーカー混入で破損して開けない**: 本スキルの対象外。テキストマージは絶対にせず、`resolve-pencil-conflict` スキルで解消・復旧する
- **想定と違う編集結果**: `--prompt` をより具体的に書き直して再実行するか、決定論的に決めたい部分を `execute` へ移す。`.pen` は上書きされるため、重要な編集前にはユーザーに git コミット等のバックアップを促す
- **編集したはずなのに小数点正規化（例: `13.995000000000001` → `13.995`）だけが残っている**: heredoc経由の `execute` でJS引数が壊れ、`save()` だけ走った典型的な事故。ルール2の4原則（`<<'EOF'` / `jq -Rs .`・`printf '%s'` / リテラル `\n`）とセルフチェックの `cat` 目視を順に確認して再実行し、ルール4-5 の正規化 diff で「数値正規化だけ」でないことを確認してから報告する
