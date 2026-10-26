# `.pen` ファイルフォーマット（直接編集用リファレンス）

`.pen` を JSON として直接編集するときの、Nodeデータのインターフェース定義。出典は pen.dev 公式の [The .pen Format](https://docs.pen.dev/for-developers/the-pen-format)（2026-10 時点、`version: "2.21"`）。末尾の TypeScript スキーマは同ページの「TypeScript Schema」の写し。公式は「破壊的変更がありうるライブドキュメント」としているため、扱う `.pen` の `version` がこれと違う場合は公式ページを確認する。

pen.dev CLI（`pencil interactive` の `execute`、`--prompt`）は使わない（無料プランでは利用日数に上限があり、上限に達すると読み書きとも止まるため）。編集は `edit-pencil-design` スキルの手順で JSON を直接書き換え、整合性は `scripts/pen.mjs validate`、画像は `scripts/pen.mjs render` で扱う。

## ファイルの実体

- **平文の JSON**（2スペースインデント）
- ルートは `Document`: `{ "version": "2.21", "themes"?, "imports"?, "variables"?, "children": [...] }`
- pen.dev が保存すると `fileToken`（UUID）がルートに付く。スキーマ外のキーだが**変更・削除しない**
- `version` は書き換えない（別バージョンの pen.dev で開くと保存時に変換される）

## オブジェクトツリー

- 各オブジェクトは `id`（文書内で一意。**`/` を含めない**。`scripts/pen.mjs new-id` で採番する）と `type` を持つ。`type` は `frame` / `group` / `rectangle` / `ellipse` / `polygon` / `path` / `text` / `note` / `prompt` / `context` / `icon` / `script` / `browser` / `ref`
- 子は `children` 配列に入れる（`frame` / `group` のみ）。配列の順序が描画順（後ろが手前）
- 人間可読な `name` を必ず付ける（スクリーンショットのファイル名・報告に使う）

## レイアウト

- トップレベルは無限キャンバス上の `x` / `y`（左上）。子の `x` / `y` は親の左上からの相対位置
- 親が `layout: "vertical" | "horizontal"` を持つと子の `x` / `y` は**無視**され、`gap` / `padding` / `justifyContent` / `alignItems` で並ぶ。絶対配置したい子だけ `layoutPosition: "absolute"`
- **`frame` の既定は `layout: "horizontal"`・幅高さ `fit_content`**。子を `x` / `y` で置きたい frame は `layout: "none"` を明示する
- サイズは数値、`"fit_content"`（子に合わせる。要 自分の layout）、`"fill_container"`（親に合わせる。要 親の layout）。`"fit_content(100)"` のように括弧でフォールバック値を付けられる
- `text` の `width` / `height` は `textGrowth`（`auto` / `fixed-width` / `fixed-width-height`）を指定しないと効かない

## 見た目

- `fill` / `stroke` / `effect`。色は `#RGB` / `#RRGGBB` / `#RRGGBBAA` の hex か `"$変数名"` のみ（`"red"` のような色名は不可）。不透明度は hex のアルファで表す
- `fill` は配列で重ねられる（文書順に描画）。グラデーション・画像（`url` は `.pen` からの相対パス）・メッシュグラデーションも可
- `stroke` は1つ（中に複数 fill 可）。太さは `strokeWidth`（一律 or `{top,right,bottom,left}`）
- `effect` は `shadow` / `blur` / `background_blur` / `shader` の配列
- アイコンは `type: "icon"` + `library`（`lucide` / `feather` / `Material Symbols Outlined|Rounded|Sharp` / `phosphor`）+ `icon`

## コンポーネントとインスタンス

- `reusable: true` を付けたオブジェクトがコンポーネント
- インスタンスは `{ "type": "ref", "ref": "<コンポーネントのid>" }`。インスタンス直下にプロパティを書くと上書き（override）になる
- 内部の子は `descendants` で上書きする。キーはコンポーネント内の子の `id`、入れ子のインスタンス越しは `"ok-button/label"` のように `/` で連結したパス
  - 値に `type` が**無い** → 列挙したプロパティだけ上書き
  - 値に `type` が**有る** → その子を丸ごと別オブジェクトに置き換え
  - 値に `children` だけを書く → その子は残して子要素だけ差し替え（カード・パネル等のコンテナ向け）
- `slot: ["<コンポーネントid>", ...]` を付けた frame は、そのコンポーネントのインスタンスを入れる差し込み口
- 既存コンポーネントと同じ見た目の要素を作るときは、複製せず `ref` で再利用する

## 変数とテーマ

- ルートの `variables` に `{ "<名前>": { "type": "color" | "number" | "string" | "boolean", "value": ... } }` を定義し、プロパティから `"$<名前>"` で参照する
- テーマ別の値は `value: [{ "value": ..., "theme": { "mode": "dark" } }, ...]`。**条件を満たす最後の要素**が勝つ
- ルートの `themes` が軸と選択肢を定義する（`{ "mode": ["light", "dark"] }`）。各軸の**先頭が既定**
- オブジェクトの `theme: { "mode": "dark" }` は、そのオブジェクト配下すべてに効く
- 文書に同じ役割の変数が既にあれば、hex を直書きせず変数を参照する

## 直接編集するときのルール

- **`id` は `scripts/pen.mjs new-id <file> <個数>` で採番する**（文書内で一意な5文字の英数字）。手で考えた `id` は使わない
- 人間可読な `name` を全Nodeに付ける（スクリーンショットのファイル名・報告に使う）
- `ref` の参照先・`descendants` のキー・`slot` の要素は実在する `id` でなければならない。`ref` の参照先は `reusable: true`
- 変数はルートの `variables` に定義してから `fill: "$color.primary"` のように参照する
- スキーマ外のプロパティ・不正な値を書かない。編集のたびに `scripts/pen.mjs validate <file> --base <編集前のファイル>` を通す（ID重複・`/` 入りID・未知の type / プロパティ・不正な色やサイズ・未定義の変数・参照切れ・`version` / `fileToken` の変更を検出する）

## TypeScript スキーマ

```typescript
/** Theme axis -> axis value. E.g. { 'device': 'phone' } */
export interface Theme { [key: string]: string; }
/** Dollar-prefixed variable name; binds the property to that variable. */
export type Variable = string;
export type NumberOrVariable = number | Variable;
/** Hex color: #RGB, #RRGGBB, or #RRGGBBAA. */
export type Color = string;
export type ColorOrVariable = Color | Variable;
export type BooleanOrVariable = boolean | Variable;
export type StringOrVariable = string | Variable;
export interface Layout {
  /** Flex layout direction. 'none'=absolutely positioned children. */
  layout?: "none" | "vertical" | "horizontal";
  /** Main-axis gap between children. Default 0. */
  gap?: NumberOrVariable;
  layoutIncludeStroke?: boolean;
  /** Inside padding. */
  padding?: /** all sides */ NumberOrVariable | /** [vertical, horizontal] */ [NumberOrVariable, NumberOrVariable] | /** [top, right, bottom, left] */ [NumberOrVariable, NumberOrVariable, NumberOrVariable, NumberOrVariable];
  /** Main-axis alignment. Default 'start'. */
  justifyContent?: "start" | "center" | "end" | "space_between" | "space_around";
  /** Cross-axis alignment. Default 'start'. */
  alignItems?: "start" | "center" | "end";
}
/** Dynamic layout size:
- fit_content: combined size of children, requires layout on the node (fallback when no children).
- fill_container: parent size, requires layout on the parent (fallback when not in a layout or when using absolute position).
Optional fallback in parens, e.g. 'fit_content(100)'. */
export type SizingBehavior = string;
/** Position relative to parent. X right, Y down. IGNORED when parent uses flex layout. */
export interface Position { x?: number; y?: number; }
export interface Size { width?: NumberOrVariable | SizingBehavior; height?: NumberOrVariable | SizingBehavior; }
/** Affine matrix [a, b, c, d, tx, ty]. */
export type AffineTransform = [number, number, number, number, number, number];
/** Override values for shader uniforms, keyed by uniform name. Uniforms annotated with `@resolution` or `@time` must not appear here. Allowed value shapes: number (float/int), boolean (bool), hex color string like `#RRGGBB[AA]` (color), array of 2-4 numbers (vec2/3/4), image URL or `pencil:object`/`pencil:background` string (sampler2D), or a variable reference `$name` (numeric uniforms accept number variables; color uniforms accept color variables). */
export interface ShaderUniforms { [key: string]: number | boolean | string | number[]; }
export type BlendMode = 'normal' | 'darken' | 'multiply' | 'linearBurn' | 'colorBurn' | 'light' | 'screen' | 'linearDodge' | 'colorDodge' | 'overlay' | 'softLight' | 'hardLight' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';
export type Fill = ColorOrVariable | {
type: "color";
enabled?: BooleanOrVariable;
blendMode?: BlendMode;
/** Fill opacity can only be set via the hex alpha channel. */
color: ColorOrVariable;
} | {
type: "gradient";
enabled?: BooleanOrVariable;
blendMode?: BlendMode;
gradientType?: "linear" | "radial" | "angular";
opacity?: NumberOrVariable;
/** Normalized to bbox. Default 0.5,0.5. */
center?: Position;
/** Normalized to bbox. Default 1,1. Linear: height = gradient length, width ignored. Radial/Angular: ellipse diameters. */
size?: { width?: NumberOrVariable; height?: NumberOrVariable };
/** Degrees CCW (0° up, 90° left, 180° down). */
rotation?: NumberOrVariable;
colors?: { color: ColorOrVariable; position: NumberOrVariable }[];
} | /** Image fill. URL is relative to the .pen file, e.g. `./image.jpg`. */ {
type: "image";
enabled?: BooleanOrVariable;
blendMode?: BlendMode;
opacity?: NumberOrVariable;
url?: string;
/** Default 'cover'. */
mode?: "cover" | "contain" | "stretch";
/** Crops the image. Maps normalized image coordinates (0..1 across its width and height) into the crop's 0..1 box, so [2, 0, 0, 1, -1, 0] is the right half. The mode fits the crop into the shape like a whole image, and cover keeps it inside the image. Defaults to identity, no crop. */
transform?: AffineTransform;
} | /** Shader fill. URL points to a WebGL 1.0 (#version 100) fragment shader file, relative to the .pen file, e.g. `./effect.glsl`. Uniforms are described via `@directive` annotations inside block comments in the shader source. A `vec2` uniform annotated with `@resolution` is auto-bound to the fill size in pixels. Other uniforms' user-set values are stored in `uniforms`. */ { type: "shader"; enabled?: BooleanOrVariable; blendMode?: BlendMode; opacity?: NumberOrVariable; url: string; uniforms?: ShaderUniforms } | /** Bezier-interpolated color grid, row-major. Keep edge points at default positions. */ {
type: "mesh_gradient";
enabled?: BooleanOrVariable;
blendMode?: BlendMode;
opacity?: NumberOrVariable;
columns?: number;
rows?: number;
/** Color per vertex. */
colors?: ColorOrVariable[];
/** columns * rows points in [0,1]. */
points?: (/** Auto-generated handles. */ [number, number] | /** Optional bezier handles (relative offsets); omitted = auto. */ { position: [number, number]; leftHandle?: [number, number]; rightHandle?: [number, number]; topHandle?: [number, number]; bottomHandle?: [number, number] })[];
};
export type Fills = Fill | Fill[];
export interface CanHaveStroke {
  stroke?: Fills;
  /** Stroke thickness, uniform or per side. */
  strokeWidth?: NumberOrVariable | { top?: NumberOrVariable; right?: NumberOrVariable; bottom?: NumberOrVariable; left?: NumberOrVariable };
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "miter" | "bevel" | "round";
  strokeAlignment?: "inner" | "center" | "outer";
}
export type Effect = /** Blurs the entire node. */ { enabled?: BooleanOrVariable; type: "blur"; radius?: NumberOrVariable } | /** Blurs the backdrop behind the node. */ { enabled?: BooleanOrVariable; type: "background_blur"; radius?: NumberOrVariable } | /** Inner or outer drop shadow. */ { type: "shadow"; enabled?: BooleanOrVariable; shadowType?: "inner" | "outer"; offset?: { x: NumberOrVariable; y: NumberOrVariable }; blur?: NumberOrVariable; color?: ColorOrVariable; blendMode?: BlendMode } | /** Post-processes the rendered node with a fragment shader. Same shader format as the shader fill. A `sampler2D` uniform set to `pencil:object` is bound to the rendered node. `@resolution` is the size of the node's visual bounds. */ { type: "shader"; enabled?: BooleanOrVariable; url: string; uniforms?: ShaderUniforms };
export type Effects = Effect | Effect[];
export interface CanHaveEffects { effect?: Effects; }
export interface CanHaveGraphics extends CanHaveEffects, CanHaveStroke { fill?: Fills; }
export interface Entity extends Position {
  /** Unique string; MUST NOT contain '/'. Auto-generated if omitted. */
  id: string;
  name?: string;
  context?: string;
  /** When true, can be duplicated via `ref` objects. Default false. */
  reusable?: boolean;
  theme?: Theme;
  enabled?: BooleanOrVariable;
  opacity?: NumberOrVariable;
  flipX?: BooleanOrVariable;
  flipY?: BooleanOrVariable;
  /** Absolute position detaches the object from parent's layout and can be absolute positioned. Default auto */
  layoutPosition?: "auto" | "absolute";
  metadata?: { type: string; [key: string]: any };
  /** Degrees CCW around top-left corner. */
  rotation?: NumberOrVariable;
}
export interface Rectangleish extends Entity, Size, CanHaveGraphics { cornerRadius?: NumberOrVariable | [NumberOrVariable, NumberOrVariable, NumberOrVariable, NumberOrVariable]; }
/** Position is the top-left corner. */
export interface Rectangle extends Rectangleish { type: "rectangle"; }
/** Defined by its bounding rectangle. */
export interface Ellipse extends Entity, Size, CanHaveGraphics {
  type: "ellipse";
  /** Ring inner/outer radius ratio. 0=solid, 1=hollow. Default 0. */
  innerRadius?: NumberOrVariable;
  /** Arc start angle, degrees CCW from right. Default 0. */
  startAngle?: NumberOrVariable;
  /** Arc length from startAngle. Positive=CCW, negative=CW. Range -360..360. Default 360. */
  sweepAngle?: NumberOrVariable;
}
/** Defined by its bounding rectangle. */
export interface Polygon extends Entity, Size, CanHaveGraphics { type: "polygon"; polygonCount?: NumberOrVariable; cornerRadius?: NumberOrVariable; }
export interface Path extends Entity, Size, CanHaveGraphics {
  /** Default 'nonzero'. */
  fillRule?: "nonzero" | "evenodd";
  /** SVG path. */
  geometry?: string;
  /** SVG coord-space [x,y,w,h] mapping onto the node box. Default: tight bbox of geometry. */
  viewBox?: [number, number, number, number];
  type: "path";
}
export interface TextStyle {
  fontFamily?: StringOrVariable;
  fontSize?: NumberOrVariable;
  fontWeight?: StringOrVariable;
  letterSpacing?: NumberOrVariable;
  fontStyle?: StringOrVariable;
  underline?: BooleanOrVariable;
  /** Multiplier of fontSize. Defaults to font's built-in. */
  lineHeight?: NumberOrVariable;
  textAlign?: "left" | "center" | "right" | "justify";
  textAlignVertical?: "top" | "middle" | "bottom";
  strikethrough?: BooleanOrVariable;
  href?: string;
}
export type TextContent = StringOrVariable;
export interface Text extends Entity, Size, CanHaveGraphics, TextStyle {
  type: "text";
  content?: TextContent;
  /** Required before width/height take effect.
'auto': grows to fit; no wrapping.
'fixed-width': width fixed, wraps; height grows.
'fixed-width-height': both fixed; may overflow. */
  textGrowth?: "auto" | "fixed-width" | "fixed-width-height";
}
export interface CanHaveChildren { children?: Child[]; }
/** Container to create hierarchy and layout. default layout=horizontal, width=fit_content, height=fit_content, clip=false. */
export interface Frame extends Rectangleish, CanHaveChildren, Layout {
  type: "frame";
  /** Clip overflow. Default false. */
  clip?: BooleanOrVariable;
  placeholder?: boolean;
  /** Marks frame as a slot for component instances. Array entries are IDs of recommended reusable child components (e.g. menu items inside a menu bar). */
  slot?: false | string[];
}
export interface Group extends Entity, CanHaveChildren, CanHaveEffects { type: "group"; }
export interface Note extends Entity, Size, TextStyle { type: "note"; content?: TextContent; }
export interface Prompt extends Entity, Size, TextStyle { type: "prompt"; content?: TextContent; model?: StringOrVariable; }
export interface Context extends Entity, Size, TextStyle { type: "context"; content?: TextContent; }
/** Icon from a library. The icon is scaled to fit the width and height. */
export interface Icon extends Entity, Size, CanHaveEffects {
  type: "icon";
  /** Valid: 'lucide', 'feather', 'Material Symbols Outlined', 'Material Symbols Rounded', 'Material Symbols Sharp', 'phosphor'. */
  library?: StringOrVariable;
  icon?: StringOrVariable;
  /** Variable weight, 100-700; only for libraries that support it. */
  weight?: NumberOrVariable;
  fill?: Fills;
}
/** Generates nested children from JavaScript. */
export interface Script extends Entity, Size {
  type: "script";
  /** Clip overflow. Default false. */
  clip?: BooleanOrVariable;
  /** JS file URI, relative to the .pen file. */
  scriptUri?: string;
  /** Input values by name. */
  inputs?: { [key: string]: string | number | boolean | Variable };
}
/** Live web page shown on the canvas. */
export interface Browser extends Entity, Size, CanHaveEffects, CanHaveStroke {
  type: "browser";
  /** Page URL. Empty shows a URL prompt. */
  url?: string;
  /** Device emulation preset id. Omit for responsive. */
  deviceId?: string;
  /** Page zoom factor. Default 1. */
  zoom?: number;
  scrollX?: number;
  scrollY?: number;
  cornerRadius?: NumberOrVariable | [NumberOrVariable, NumberOrVariable, NumberOrVariable, NumberOrVariable];
}
/** Reuses another object. */
export interface Ref extends Entity {
  type: "ref";
  /** ID of the referenced object. */
  ref: string;
  /** Customize descendant properties. */
  descendants?: { [key: string /** ID path of the descendant. */]: {} /** Based on the presence of `type`:
- `type` is not present = property overrides: the descendant node is updated with the listed properties.
- `type` is present = replacement: the descendant node is fully replaced with a new node tree. */ };
  [key: string]: any;
}
export type Child = Frame | Group | Rectangle | Ellipse | Path | Polygon | Text | Note | Prompt | Context | Icon | Script | Browser | Ref;
export type IdPath = string;
export interface Document { version: "2.21"; themes?: { [key: string /** RegEx: [^:]+ */]: string[] }; imports?: { [key: string]: string /** Value: relative URI of imported .pen file. Key: short alias. */ }; variables?: { [key: string /** RegEx: [^:]+ */]: { type: "boolean"; value: BooleanOrVariable | { value: BooleanOrVariable; theme?: Theme }[] } | { type: "color"; value: ColorOrVariable | { value: ColorOrVariable; theme?: Theme }[] } | { type: "number"; value: NumberOrVariable | { value: NumberOrVariable; theme?: Theme }[] } | { type: "string"; value: StringOrVariable | { value: StringOrVariable; theme?: Theme }[] } }; children: (Frame | Group | Rectangle | Ellipse | Polygon | Path | Text | Note | Context | Prompt | Icon | Script | Browser | Ref)[]; }
```
