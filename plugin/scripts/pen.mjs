#!/usr/bin/env node
/* global fetch, Buffer, structuredClone, setTimeout, document -- document は page.evaluate 内（ブラウザ側）で使う */
// .pen（pen.dev のデザインファイル。平文JSON）を pen.dev CLI なしで扱うツール。
// フォーマットは plugin/references/pen-format.md。
//
//   node pen.mjs validate <file.pen> [--base <編集前のファイル>]
//   node pen.mjs new-id <file.pen> [個数]
//   node pen.mjs resolve <file.pen> <id|パス> [--theme 軸=値 ...]
//   node pen.mjs layout <file.pen> [id|パス] [--theme 軸=値 ...]
//   node pen.mjs render <file.pen> --out <dir> [id|パス|document ...] [--scale N] [--theme 軸=値 ...]
//
// validate は問題があれば1行1件で stderr に出して exit 1。
// render は Chromium で HTML として描画し、PNG と各Nodeの解決後ボックスを書き出す。
// stdout には { images, boxesFile, warnings } の JSON を出す。描画しきれない表現は
// warnings に出す（黙って省かない）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// ---------- スキーマ ----------

const ENTITY = [
  "id",
  "type",
  "name",
  "context",
  "reusable",
  "theme",
  "enabled",
  "opacity",
  "flipX",
  "flipY",
  "layoutPosition",
  "metadata",
  "rotation",
  "x",
  "y",
];
const SIZE = ["width", "height"];
const STROKE = ["stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin", "strokeAlignment"];
const GRAPHICS = ["fill", "effect", ...STROKE];
const LAYOUT = ["layout", "gap", "layoutIncludeStroke", "padding", "justifyContent", "alignItems"];
const TEXT_STYLE = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "letterSpacing",
  "fontStyle",
  "underline",
  "lineHeight",
  "textAlign",
  "textAlignVertical",
  "strikethrough",
  "href",
];

const KEYS = {
  frame: [...ENTITY, ...SIZE, ...GRAPHICS, "cornerRadius", "children", ...LAYOUT, "clip", "placeholder", "slot"],
  group: [...ENTITY, "children", "effect"],
  rectangle: [...ENTITY, ...SIZE, ...GRAPHICS, "cornerRadius"],
  ellipse: [...ENTITY, ...SIZE, ...GRAPHICS, "innerRadius", "startAngle", "sweepAngle"],
  polygon: [...ENTITY, ...SIZE, ...GRAPHICS, "polygonCount", "cornerRadius"],
  path: [...ENTITY, ...SIZE, ...GRAPHICS, "fillRule", "geometry", "viewBox"],
  text: [...ENTITY, ...SIZE, ...GRAPHICS, ...TEXT_STYLE, "content", "textGrowth"],
  note: [...ENTITY, ...SIZE, ...TEXT_STYLE, "content"],
  prompt: [...ENTITY, ...SIZE, ...TEXT_STYLE, "content", "model"],
  context: [...ENTITY, ...SIZE, ...TEXT_STYLE, "content"],
  icon: [...ENTITY, ...SIZE, "effect", "library", "icon", "weight", "fill"],
  script: [...ENTITY, ...SIZE, "clip", "scriptUri", "inputs"],
  browser: [...ENTITY, ...SIZE, "effect", ...STROKE, "url", "deviceId", "zoom", "scrollX", "scrollY", "cornerRadius"],
  ref: null, // インスタンスは任意のプロパティを上書きできる
};

const ENUMS = {
  layout: ["none", "vertical", "horizontal"],
  justifyContent: ["start", "center", "end", "space_between", "space_around"],
  alignItems: ["start", "center", "end"],
  layoutPosition: ["auto", "absolute"],
  textGrowth: ["auto", "fixed-width", "fixed-width-height"],
  textAlign: ["left", "center", "right", "justify"],
  textAlignVertical: ["top", "middle", "bottom"],
  strokeAlignment: ["inner", "center", "outer"],
  strokeLinecap: ["butt", "round", "square"],
  strokeLinejoin: ["miter", "bevel", "round"],
  fillRule: ["nonzero", "evenodd"],
};

const COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SIZING_RE = /^(fit_content|fill_container)(\(\s*-?\d+(\.\d+)?\s*\))?$/;
const isVar = (v) => typeof v === "string" && v.startsWith("$");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ---------- 走査 ----------

export function walk(nodes, fn, parent = null) {
  for (const n of nodes ?? []) {
    if (!isObj(n)) continue;
    fn(n, parent);
    walk(n.children, fn, n);
  }
}

export function indexById(doc) {
  const map = new Map();
  walk(doc.children, (n) => {
    if (typeof n.id === "string" && !map.has(n.id)) map.set(n.id, n);
  });
  return map;
}

// ---------- validate ----------

function checkColor(v, where, errors) {
  if (typeof v === "string" && !isVar(v) && !COLOR_RE.test(v))
    errors.push(`${where}: 色は #RGB / #RRGGBB / #RRGGBBAA か "$変数" で書く（"${v}"）`);
}

function checkFills(v, where, errors) {
  for (const f of Array.isArray(v) ? v : [v]) {
    if (typeof f === "string") checkColor(f, where, errors);
    else if (isObj(f)) {
      if (!["color", "gradient", "image", "shader", "mesh_gradient"].includes(f.type))
        errors.push(`${where}: 未知の fill type "${f.type}"`);
      if (f.type === "color") checkColor(f.color, where, errors);
      for (const c of f.colors ?? []) checkColor(isObj(c) ? c.color : c, where, errors);
    } else errors.push(`${where}: fill の形が不正`);
  }
}

function collectVarRefs(value, out) {
  if (isVar(value)) out.push(value.slice(1));
  else if (Array.isArray(value)) value.forEach((v) => collectVarRefs(v, out));
  else if (isObj(value)) Object.values(value).forEach((v) => collectVarRefs(v, out));
}

function checkProps(n, where, doc, errors) {
  for (const [k, allowed] of Object.entries(ENUMS)) {
    if (n[k] !== undefined && !isVar(n[k]) && !allowed.includes(n[k]))
      errors.push(`${where}: ${k} は ${allowed.join(" / ")} のいずれか（"${n[k]}"）`);
  }
  for (const k of SIZE) {
    const v = n[k];
    if (v !== undefined && typeof v !== "number" && !isVar(v) && !(typeof v === "string" && SIZING_RE.test(v)))
      errors.push(`${where}: ${k} は数値 / "fit_content" / "fill_container" / "$変数"（"${v}"）`);
  }
  if (n.fill !== undefined) checkFills(n.fill, `${where}.fill`, errors);
  if (n.stroke !== undefined) checkFills(n.stroke, `${where}.stroke`, errors);
  const vars = [];
  for (const [k, v] of Object.entries(n)) {
    if (["id", "type", "name", "context", "metadata", "children", "descendants", "ref"].includes(k)) continue;
    collectVarRefs(v, vars);
  }
  for (const name of vars) {
    if (!doc.variables || !(name in doc.variables)) errors.push(`${where}: 未定義の変数 "$${name}"`);
  }
}

/** 文書の整合性を検査し、エラー文字列の配列を返す（空なら問題なし）。 */
export function validateDoc(doc, base = null) {
  const errors = [];
  if (!isObj(doc)) return ["ルートがオブジェクトではない"];
  if (typeof doc.version !== "string") errors.push("ルートの version が無い");
  if (!Array.isArray(doc.children)) errors.push("ルートの children が配列ではない");
  if (base) {
    if (base.version !== doc.version) errors.push(`version を書き換えている（${base.version} → ${doc.version}）`);
    if (base.fileToken !== doc.fileToken) errors.push("fileToken を変更・削除している");
  }
  const seen = new Set();
  const ids = indexById(doc);
  walk(doc.children, (n, parent) => {
    const where = `${n.id ?? "(id なし)"}${n.name ? `「${n.name}」` : ""}`;
    if (typeof n.id !== "string" || n.id === "") errors.push(`${where}: id が無い`);
    else {
      if (n.id.includes("/")) errors.push(`${where}: id に "/" を含めない`);
      if (seen.has(n.id)) errors.push(`${where}: id が重複している`);
      seen.add(n.id);
    }
    if (!(n.type in KEYS)) {
      errors.push(`${where}: 未知の type "${n.type}"`);
      return;
    }
    const keys = KEYS[n.type];
    if (keys) {
      for (const k of Object.keys(n)) if (!keys.includes(k)) errors.push(`${where}: ${n.type} に無いプロパティ "${k}"`);
    }
    if (n.children !== undefined && !["frame", "group"].includes(n.type))
      errors.push(`${where}: children を持てるのは frame / group のみ`);
    if (
      parent &&
      parent.layout === "none" &&
      typeof n.width === "string" &&
      n.width.startsWith("fill_container") &&
      !/\(/.test(n.width)
    ) {
      // 親に layout が無い fill_container はフォールバック値が無いと 0 になる
      errors.push(`${where}: 親が layout:"none" なのに width が fill_container（フォールバック値なし）`);
    }
    checkProps(n, where, doc, errors);
    if (n.type === "ref") {
      const local = typeof n.ref === "string" && ids.get(n.ref);
      const imported =
        typeof n.ref === "string" && n.ref.includes(":") && doc.imports && n.ref.split(":")[0] in doc.imports;
      if (!local && !imported) errors.push(`${where}: ref の参照先 "${n.ref}" が無い`);
      if (local && !local.reusable) errors.push(`${where}: ref の参照先 "${n.ref}" が reusable:true ではない`);
      if (local && isObj(n.descendants)) {
        const inner = new Set();
        walk(local.children, (c) => inner.add(c.id));
        for (const key of Object.keys(n.descendants)) {
          if (!inner.has(key.split("/")[0]))
            errors.push(`${where}: descendants のキー "${key}" がコンポーネント内に無い`);
        }
      }
    }
    if (Array.isArray(n.slot)) for (const s of n.slot) if (!ids.has(s)) errors.push(`${where}: slot の "${s}" が無い`);
  });
  return errors;
}

// ---------- new-id ----------

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
export function newIds(doc, count = 1, rand = Math.random) {
  const used = new Set(indexById(doc).keys());
  const out = [];
  while (out.length < count) {
    let id = "";
    for (let i = 0; i < 5; i++) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
    if (!used.has(id)) {
      used.add(id);
      out.push(id);
    }
  }
  return out;
}

// ---------- resolve（変数解決＋インスタンス展開） ----------

function defaultTheme(doc) {
  const t = {};
  for (const [axis, values] of Object.entries(doc.themes ?? {})) if (values.length) t[axis] = values[0];
  return t;
}

export function resolveVariable(doc, name, theme, warn, depth = 0) {
  const def = doc.variables?.[name];
  if (!def) {
    warn(`未定義の変数 "$${name}"`);
    return undefined;
  }
  let value = def.value;
  if (Array.isArray(value)) {
    let hit;
    for (const e of value) {
      const cond = isObj(e) ? (e.theme ?? {}) : {};
      if (Object.entries(cond).every(([k, v]) => theme[k] === v)) hit = isObj(e) ? e.value : e;
    }
    value = hit;
  }
  if (isVar(value) && depth < 10) return resolveVariable(doc, value.slice(1), theme, warn, depth + 1);
  return value;
}

function resolveValues(doc, value, theme, warn) {
  if (isVar(value)) return resolveVariable(doc, value.slice(1), theme, warn);
  if (Array.isArray(value)) return value.map((v) => resolveValues(doc, v, theme, warn));
  if (isObj(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveValues(doc, v, theme, warn)]));
  return value;
}

const clone = (v) => structuredClone(v);

function applyDescendants(root, descendants) {
  const byId = new Map();
  walk(root.children, (c, parent) => byId.set(c.id, { node: c, parent }));
  for (const [key, override] of Object.entries(descendants ?? {})) {
    const [head, ...rest] = key.split("/");
    const hit = byId.get(head);
    if (!hit) continue;
    if (rest.length) {
      // 入れ子のインスタンスへ持ち越し、そのインスタンスの展開時に適用する
      hit.node.descendants = { ...(hit.node.descendants ?? {}), [rest.join("/")]: override };
    } else if (isObj(override) && "type" in override) {
      const siblings = hit.parent ? hit.parent.children : root.children;
      siblings[siblings.indexOf(hit.node)] = { ...clone(override), id: hit.node.id };
    } else if (isObj(override)) {
      Object.assign(hit.node, clone(override));
    }
  }
}

/**
 * Node を描画可能な形へ解決する。ref は展開し、"$変数" は値へ置き換える。
 * 各 Node に _path（インスタンス内は "インスタンスID/子ID"）を付ける。
 */
export function resolveNode(doc, node, opts = {}) {
  const ids = opts.ids ?? indexById(doc);
  const warn = opts.warn ?? (() => {});
  let theme = { ...(opts.theme ?? defaultTheme(doc)), ...(node.theme ?? {}) };
  const prefix = opts.prefix ?? "";
  const depth = opts.depth ?? 0;
  const pathId = prefix + node.id;
  let n = node;
  // インスタンス配下の Node は "インスタンスID/子ID"（入れ子のインスタンスを越えるたびに連結）で指す
  let childPrefix = prefix;
  if (n.type === "ref") {
    const comp = ids.get(n.ref);
    if (!comp || depth > 20) {
      warn(
        `${pathId}: ref "${n.ref}" を解決できない（${String(n.ref).includes(":") ? "imports のライブラリは未対応" : "参照先なし"}）。プレースホルダーで描画`,
      );
      return {
        type: "_placeholder",
        _path: pathId,
        name: n.name,
        x: n.x,
        y: n.y,
        width: n.width ?? 100,
        height: n.height ?? 40,
        label: `ref ${n.ref}`,
      };
    }
    const inst = clone(comp);
    delete inst.reusable;
    const { ref: _ref, descendants, type: _type, ...overrides } = n;
    Object.assign(inst, clone(overrides));
    applyDescendants(inst, descendants);
    // コンポーネント自身の theme も配下に効く（ref インスタンスの theme が優先）
    theme = { ...(opts.theme ?? defaultTheme(doc)), ...(comp.theme ?? {}), ...(node.theme ?? {}) };
    n = inst;
    childPrefix = `${pathId}/`;
  }
  const { children, theme: _t, ...props } = n;
  const out = resolveValues(doc, props, theme, (m) => warn(`${pathId}: ${m}`));
  out._path = pathId;
  if (node.type === "ref") out._ref = node.ref;
  if (Array.isArray(children)) {
    out.children = children
      .filter(isObj)
      .map((c) =>
        resolveNode(doc, c, { ...opts, ids, theme, prefix: childPrefix, depth: depth + (node.type === "ref" ? 1 : 0) }),
      );
  }
  return out;
}

export function findByPath(resolvedRoots, target) {
  let found = null;
  walk(resolvedRoots, (n) => {
    if (!found && (n._path === target || n.id === target)) found = n;
  });
  return found;
}

export function resolveDocument(doc, opts = {}) {
  const ids = indexById(doc);
  return doc.children.filter(isObj).map((c) => resolveNode(doc, c, { ...opts, ids }));
}

// ---------- HTML 生成 ----------

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const px = (v) => (typeof v === "number" ? `${v}px` : "0px");

function parseSizing(v) {
  if (typeof v === "number") return { kind: "fixed", value: v };
  if (typeof v !== "string") return { kind: "default" };
  const m = v.match(/^(fit_content|fill_container)(?:\(\s*(-?[\d.]+)\s*\))?$/);
  if (!m) return { kind: "default" };
  return { kind: m[1], fallback: m[2] !== undefined ? Number(m[2]) : undefined };
}

function fillLayers(fills, baseDir, warn, where) {
  const layers = [];
  for (const f of Array.isArray(fills) ? fills : fills === undefined ? [] : [fills]) {
    if (typeof f === "string") layers.push(`linear-gradient(${f},${f})`);
    else if (!isObj(f) || f.enabled === false) continue;
    else if (f.type === "color") layers.push(`linear-gradient(${f.color},${f.color})`);
    else if (f.type === "gradient") {
      const stops = (f.colors ?? []).map((c) => `${c.color} ${(c.position ?? 0) * 100}%`).join(",");
      const cx = (f.center?.x ?? 0.5) * 100;
      const cy = (f.center?.y ?? 0.5) * 100;
      if ((f.gradientType ?? "linear") === "linear")
        layers.push(`linear-gradient(${(360 - (f.rotation ?? 0)) % 360}deg,${stops})`);
      else if (f.gradientType === "radial")
        layers.push(
          `radial-gradient(ellipse ${(f.size?.width ?? 1) * 50}% ${(f.size?.height ?? 1) * 50}% at ${cx}% ${cy}%,${stops})`,
        );
      else layers.push(`conic-gradient(from ${-(f.rotation ?? 0)}deg at ${cx}% ${cy}%,${stops})`);
      if (f.opacity !== undefined && f.opacity !== 1) warn(`${where}: グラデーションの opacity は描画に反映していない`);
    } else if (f.type === "image") {
      let url = f.url ?? "";
      // setContent したページからは file:// を読めないことがあるため、ローカル画像は data URL で埋め込む
      if (!/^[a-z]+:/i.test(url)) {
        const file = path.resolve(baseDir, url);
        const mime =
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".svg": "image/svg+xml",
          }[path.extname(file).toLowerCase()] ?? "application/octet-stream";
        try {
          url = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
        } catch (e) {
          warn(`${where}: image fill "${f.url}" を読めない（${e.message}）`);
          continue;
        }
      }
      const size = { contain: "contain", stretch: "100% 100%" }[f.mode] ?? "cover";
      layers.push(`url("${url}") center/${size} no-repeat`);
      if (f.transform) warn(`${where}: image fill の transform（切り抜き）は描画に反映していない`);
    } else {
      warn(`${where}: fill type "${f.type}" は描画できない`);
      const first = f.colors?.find?.((c) => typeof c === "string");
      if (first) layers.push(`linear-gradient(${first},${first})`);
    }
  }
  return layers.reverse(); // .pen は文書順に重ねる（後ろが上）、CSS は先頭が上
}

function firstColor(fills) {
  for (const f of Array.isArray(fills) ? [...fills].reverse() : [fills]) {
    if (typeof f === "string") return f;
    if (isObj(f) && f.type === "color") return f.color;
    if (isObj(f) && f.type === "gradient") return f.colors?.[0]?.color;
  }
  return undefined;
}

function radius(v) {
  if (Array.isArray(v)) return v.map(px).join(" ");
  return typeof v === "number" ? px(v) : null;
}

function effects(n, warn, where) {
  const shadows = [];
  const filters = [];
  let backdrop = null;
  for (const e of Array.isArray(n.effect) ? n.effect : n.effect ? [n.effect] : []) {
    if (!isObj(e) || e.enabled === false) continue;
    if (e.type === "shadow")
      shadows.push(
        `${e.shadowType === "inner" ? "inset " : ""}${px(e.offset?.x ?? 0)} ${px(e.offset?.y ?? 0)} ${px(e.blur ?? 0)} 0 ${e.color ?? "#00000040"}`,
      );
    else if (e.type === "blur") filters.push(`blur(${px(e.radius ?? 0)})`);
    else if (e.type === "background_blur") backdrop = `blur(${px(e.radius ?? 0)})`;
    else warn(`${where}: effect "${e.type}" は描画できない`);
  }
  return { shadows, filters, backdrop };
}

function strokeOverlay(n, shapeRadius) {
  if (n.stroke === undefined) return "";
  const color = firstColor(n.stroke);
  if (!color) return "";
  const w = n.strokeWidth ?? 1;
  const sides =
    typeof w === "number" ? { top: w, right: w, bottom: w, left: w } : { top: 0, right: 0, bottom: 0, left: 0, ...w };
  const align = n.strokeAlignment ?? "inner";
  const inset = (s) => (align === "inner" ? 0 : align === "center" ? -s / 2 : -s);
  const style = [
    "position:absolute",
    "pointer-events:none",
    "box-sizing:border-box",
    `top:${px(inset(sides.top))}`,
    `right:${px(inset(sides.right))}`,
    `bottom:${px(inset(sides.bottom))}`,
    `left:${px(inset(sides.left))}`,
    `border-style:solid`,
    `border-color:${color}`,
    `border-width:${px(sides.top)} ${px(sides.right)} ${px(sides.bottom)} ${px(sides.left)}`,
    shapeRadius ? `border-radius:${shapeRadius}` : "",
  ].filter(Boolean);
  return `<div style="${esc(style.join(";"))}"></div>`;
}

const JUSTIFY = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
  space_between: "space-between",
  space_around: "space-around",
};
const ALIGN = { start: "flex-start", center: "center", end: "flex-end" };

function sizeCss(n, axis, parentFlex, defaultKind, out, warn, where) {
  const prop = axis === "x" ? "width" : "height";
  const s = parseSizing(n[prop]);
  const kind = s.kind === "default" ? defaultKind : s.kind;
  if (kind === "fixed") out.push(`${prop}:${px(s.value)}`);
  else if (kind === "fill_container") {
    if (parentFlex) {
      if (parentFlex.mainAxis === axis) out.push("flex-grow:1", "flex-basis:0", `min-${prop}:0`);
      else out.push("align-self:stretch");
    } else if (s.fallback !== undefined) out.push(`${prop}:${px(s.fallback)}`);
    else warn(`${where}: ${prop} が fill_container だが親に layout が無い（0 として描画）`);
  } else if (kind === "fit_content") {
    if (s.fallback !== undefined && !n.children?.length) out.push(`${prop}:${px(s.fallback)}`);
    else out.push(`${prop}:fit-content`);
  }
}

const UNSUPPORTED_TYPES = new Set(["script", "browser"]);

/** 解決済み Node を HTML 文字列にする。parentFlex は親が flex のときの { mainAxis }。 */
export function nodeHtml(n, ctx, parentFlex = null) {
  const where = n._path;
  const warn = (m) => ctx.warn(m, n._path);
  if (n.enabled === false) return "";
  const css = ["box-sizing:border-box", "flex-shrink:0"];
  const absolute = !parentFlex || n.layoutPosition === "absolute";
  css.push(absolute ? `position:absolute;left:${px(n.x ?? 0)};top:${px(n.y ?? 0)}` : "position:relative");
  if (typeof n.opacity === "number") css.push(`opacity:${n.opacity}`);
  const transforms = [];
  if (n.rotation) transforms.push(`rotate(${-n.rotation}deg)`);
  if (n.flipX) transforms.push("scaleX(-1)");
  if (n.flipY) transforms.push("scaleY(-1)");
  if (transforms.length) css.push("transform-origin:0 0", `transform:${transforms.join(" ")}`);
  const fx = effects(n, warn, where);
  const attrs = `data-pen-id="${esc(n._path)}" data-pen-name="${esc(n.name ?? "")}" data-pen-type="${esc(n.type)}"`;
  const r = radius(n.cornerRadius);
  let inner = "";

  if (
    n.type === "frame" ||
    n.type === "rectangle" ||
    n.type === "ellipse" ||
    n.type === "_placeholder" ||
    UNSUPPORTED_TYPES.has(n.type)
  ) {
    const layout = n.type === "frame" ? (n.layout ?? "horizontal") : "none";
    const flex = layout !== "none" ? { mainAxis: layout === "horizontal" ? "x" : "y" } : null;
    const def = n.type === "frame" ? "fit_content" : "default";
    sizeCss(n, "x", parentFlex, def, css, warn, where);
    sizeCss(n, "y", parentFlex, def, css, warn, where);
    if (flex) {
      css.push("display:flex", `flex-direction:${layout === "horizontal" ? "row" : "column"}`);
      if (n.gap !== undefined) css.push(`gap:${px(n.gap)}`);
      if (n.justifyContent) css.push(`justify-content:${JUSTIFY[n.justifyContent]}`);
      css.push(`align-items:${ALIGN[n.alignItems ?? "start"]}`);
    }
    if (n.padding !== undefined) {
      const p = Array.isArray(n.padding) ? n.padding : [n.padding];
      css.push(`padding:${(p.length === 2 ? [p[0], p[1]] : p).map(px).join(" ")}`);
    }
    const layers = fillLayers(n.fill, ctx.baseDir, warn, where);
    if (n.type === "_placeholder" || UNSUPPORTED_TYPES.has(n.type)) {
      if (UNSUPPORTED_TYPES.has(n.type)) warn(`${where}: type "${n.type}" は描画できない（プレースホルダー）`);
      layers.push("repeating-linear-gradient(45deg,#E5E7EB 0 8px,#F3F4F6 8px 16px)");
      inner += `<span style="font:11px sans-serif;color:#6B7280">${esc(n.label ?? n.type)}</span>`;
    }
    if (layers.length) css.push(`background:${layers.join(",")}`);
    const shapeR = n.type === "ellipse" ? "50%" : r;
    if (shapeR) css.push(`border-radius:${shapeR}`);
    if (n.type === "ellipse" && (n.innerRadius || (n.sweepAngle !== undefined && Math.abs(n.sweepAngle) < 360)))
      warn(`${where}: ellipse の innerRadius / 円弧は描画に反映していない`);
    if (n.clip) css.push("overflow:hidden");
    if (fx.shadows.length) css.push(`box-shadow:${fx.shadows.join(",")}`);
    if (fx.filters.length) css.push(`filter:${fx.filters.join(" ")}`);
    if (fx.backdrop) css.push(`backdrop-filter:${fx.backdrop}`);
    inner += (n.children ?? []).map((c) => nodeHtml(c, ctx, flex)).join("");
    inner += strokeOverlay(n, shapeR);
    return `<div ${attrs} style="${esc(css.join(";"))}">${inner}</div>`;
  }

  if (n.type === "group") {
    // group は子の外接矩形がそのまま大きさ。子は group 基準の絶対座標
    css.push("width:0", "height:0", "overflow:visible");
    if (fx.filters.length) css.push(`filter:${fx.filters.join(" ")}`);
    if (fx.shadows.length) warn(`${where}: group の shadow は描画に反映していない`);
    inner = (n.children ?? []).map((c) => nodeHtml(c, ctx, null)).join("");
    return `<div ${attrs} data-pen-group="1" style="${esc(css.join(";"))}">${inner}</div>`;
  }

  if (n.type === "text" || n.type === "note" || n.type === "prompt" || n.type === "context") {
    const growth = n.textGrowth ?? "auto";
    if (n.type === "text") {
      if (growth === "auto") css.push("white-space:pre", "width:max-content");
      else {
        sizeCss(n, "x", parentFlex, "default", css, warn, where);
        css.push("white-space:pre-wrap", "overflow-wrap:anywhere");
        if (growth === "fixed-width-height") sizeCss(n, "y", parentFlex, "default", css, warn, where);
      }
      const color = firstColor(n.fill) ?? "#000000";
      css.push(`color:${color}`);
      if (Array.isArray(n.fill) && n.fill.length > 1) warn(`${where}: テキストの複数 fill は最上位の色だけで描画`);
      if (isObj(n.fill) && n.fill.type === "gradient") warn(`${where}: テキストのグラデーション fill は先頭色で描画`);
    } else {
      sizeCss(n, "x", parentFlex, "default", css, warn, where);
      sizeCss(n, "y", parentFlex, "default", css, warn, where);
      css.push("white-space:pre-wrap", "background:#FEF3C7", "padding:8px", "color:#78350F");
    }
    const family = n.fontFamily ?? "Inter";
    const fontKey = `${family}|${fontWeight(n.fontWeight)}|${n.fontStyle === "italic" ? "italic" : "normal"}`;
    ctx.fonts.add(fontKey);
    (ctx.fontUsers[fontKey] ??= []).push(n._path);
    css.push(
      `font-family:'${family.replace(/['"]/g, "")}',sans-serif`,
      `font-size:${px(n.fontSize ?? 14)}`,
      `font-weight:${fontWeight(n.fontWeight)}`,
    );
    if (n.fontStyle) css.push(`font-style:${n.fontStyle}`);
    if (n.letterSpacing) css.push(`letter-spacing:${px(n.letterSpacing)}`);
    if (n.lineHeight) css.push(`line-height:${n.lineHeight}`);
    if (n.textAlign) css.push(`text-align:${n.textAlign}`);
    const deco = [n.underline && "underline", n.strikethrough && "line-through"].filter(Boolean);
    if (deco.length) css.push(`text-decoration:${deco.join(" ")}`);
    if (n.textAlignVertical && growth === "fixed-width-height") {
      css.push(
        "display:flex",
        "flex-direction:column",
        `justify-content:${{ top: "flex-start", middle: "center", bottom: "flex-end" }[n.textAlignVertical]}`,
      );
    }
    if (fx.shadows.length)
      css.push(
        `text-shadow:${fx.shadows
          .filter((s) => !s.startsWith("inset"))
          .map((s) => s.replace(/ 0 (#[0-9a-fA-F]+)$/, " $1"))
          .join(",")}`,
      );
    if (fx.filters.length) css.push(`filter:${fx.filters.join(" ")}`);
    return `<div ${attrs} style="${esc(css.join(";"))}">${n.textAlignVertical && growth === "fixed-width-height" ? `<span>${esc(n.content)}</span>` : esc(n.content)}</div>`;
  }

  if (n.type === "icon") {
    sizeCss(n, "x", parentFlex, "default", css, warn, where);
    sizeCss(n, "y", parentFlex, "default", css, warn, where);
    const color = firstColor(n.fill) ?? "#000000";
    css.push(`color:${color}`, "display:flex", "align-items:center", "justify-content:center");
    if (fx.shadows.length)
      css.push(
        `filter:${fx.shadows
          .filter((s) => !s.startsWith("inset"))
          .map((s) => `drop-shadow(${s.replace(/ 0 (#[0-9a-fA-F]+)$/, " $1")})`)
          .join(" ")}`,
      );
    const lib = n.library ?? "lucide";
    if (lib.startsWith("Material Symbols")) {
      ctx.materialFonts.add(lib);
      const size = Math.min(typeof n.width === "number" ? n.width : 24, typeof n.height === "number" ? n.height : 24);
      const wght = Number(n.weight ?? 400) || 400;
      const style = `font-family:'${String(lib).replace(/['"\\]/g, "")}';font-size:${size}px;line-height:1;font-variation-settings:'wght' ${wght}`;
      inner = `<span style="${esc(style)}" data-pen-material="${esc(n.icon)}">${esc(n.icon)}</span>`;
    } else {
      inner = `<span data-pen-icon="${esc(lib)}|${esc(n.icon)}|${esc(n.weight ?? "")}" style="display:block;width:100%;height:100%"></span>`;
      ctx.icons.add(`${lib}|${n.icon}`);
    }
    return `<div ${attrs} style="${esc(css.join(";"))}">${inner}</div>`;
  }

  if (n.type === "path" || n.type === "polygon") {
    sizeCss(n, "x", parentFlex, "default", css, warn, where);
    sizeCss(n, "y", parentFlex, "default", css, warn, where);
    const fillColor = firstColor(n.fill) ?? "none";
    if (isObj(n.fill) && n.fill.type !== "color") warn(`${where}: ${n.type} の ${n.fill.type} fill は先頭色で描画`);
    const strokeColor = n.stroke !== undefined ? firstColor(n.stroke) : null;
    const sw = typeof n.strokeWidth === "number" ? n.strokeWidth : 1;
    const strokeAttrs = strokeColor
      ? ` stroke="${esc(strokeColor)}" stroke-width="${sw}" stroke-linecap="${esc(n.strokeLinecap ?? "butt")}" stroke-linejoin="${esc(n.strokeLinejoin ?? "miter")}" vector-effect="non-scaling-stroke"`
      : "";
    if (fx.shadows.length)
      css.push(
        `filter:${fx.shadows
          .filter((s) => !s.startsWith("inset"))
          .map((s) => `drop-shadow(${s.replace(/ 0 (#[0-9a-fA-F]+)$/, " $1")})`)
          .join(" ")}`,
      );
    if (n.type === "polygon") {
      const count = Math.max(3, n.polygonCount ?? 3);
      const pts = Array.from({ length: count }, (_, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / count;
        return `${50 + 50 * Math.cos(a)},${50 + 50 * Math.sin(a)}`;
      }).join(" ");
      if (n.cornerRadius) warn(`${where}: polygon の cornerRadius は描画に反映していない`);
      inner = `<svg viewBox="0 0 100 100" preserveAspectRatio="none" width="100%" height="100%" style="display:block;overflow:visible"><polygon points="${pts}" fill="${esc(fillColor)}"${strokeAttrs}/></svg>`;
    } else {
      const vb = Array.isArray(n.viewBox) ? ` viewBox="${esc(n.viewBox.map(Number).join(" "))}"` : "";
      inner = `<svg${vb} data-pen-autoviewbox="${vb ? "" : "1"}" preserveAspectRatio="none" width="100%" height="100%" style="display:block;overflow:visible"><path d="${esc(n.geometry ?? "")}" fill="${esc(fillColor)}" fill-rule="${esc(n.fillRule ?? "nonzero")}"${strokeAttrs}/></svg>`;
    }
    return `<div ${attrs} style="${esc(css.join(";"))}">${inner}</div>`;
  }

  warn(`${where}: type "${n.type}" は描画できない`);
  return "";
}

const ICON_URLS = {
  lucide: (name) => `https://unpkg.com/lucide-static@latest/icons/${name}.svg`,
  feather: (name) => `https://unpkg.com/feather-icons@latest/dist/icons/${name}.svg`,
  phosphor: (name) => `https://unpkg.com/@phosphor-icons/core@latest/assets/regular/${name}.svg`,
};

async function fetchIcons(keys, warn) {
  const out = {};
  for (const key of keys) {
    const [lib, name] = key.split("|");
    const url = ICON_URLS[lib]?.(name);
    if (!url) {
      warn(`アイコンライブラリ "${lib}" は未対応（${name}）`);
      continue;
    }
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out[key] = (await res.text()).replace(/<svg/, '<svg width="100%" height="100%" style="display:block"');
    } catch (e) {
      warn(`アイコン ${lib}/${name} を取得できない（${e.message}）`);
    }
  }
  return out;
}

const WEIGHTS = {
  thin: 100,
  extralight: 200,
  light: 300,
  normal: 400,
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  extrabold: 800,
  black: 900,
};
export const fontWeight = (w) =>
  /^\d+$/.test(String(w ?? "")) ? Number(w) : (WEIGHTS[String(w ?? "").toLowerCase()] ?? 400);

function rangesOf(block) {
  const m = block.match(/unicode-range:\s*([^;]+)/);
  if (!m) return null;
  return m[1].split(",").map((r) => {
    const [a, b] = r.trim().replace(/^U\+/i, "").split("-");
    if (a.includes("?")) return [parseInt(a.replace(/\?/g, "0"), 16), parseInt(a.replace(/\?/g, "F"), 16)];
    return [parseInt(a, 16), parseInt(b ?? a, 16)];
  });
}

// Google Fonts の CSS とフォント本体を Node 側で取得して data URL で埋め込む
// （ブラウザから直接読ませるとプロキシ環境で届かないことがある）。
// 使っている文字を含む unicode-range のファイルだけを取る（日本語フォントは数百ファイルに分かれている）。
async function fetchFontCss(ctx, text, warn) {
  const codes = [...text].map((c) => c.codePointAt(0));
  const queries = [];
  const byFamily = new Map();
  for (const key of ctx.fonts) {
    const [family, weight, style] = key.split("|");
    if (!byFamily.has(family)) byFamily.set(family, new Set());
    byFamily.get(family).add(`${style === "italic" ? 1 : 0},${fontWeight(weight)}`);
  }
  for (const [family, tuples] of byFamily) {
    const sorted = [...tuples].sort((a, b) => a.split(",")[0] - b.split(",")[0] || a.split(",")[1] - b.split(",")[1]);
    queries.push({ family, query: `family=${family.replace(/ /g, "+")}:ital,wght@${sorted.join(";")}` });
  }
  for (const family of ctx.materialFonts)
    queries.push({
      family,
      query: `family=${family.replace(/ /g, "+")}:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200`,
    });
  let css = "";
  for (const { family, query } of queries) {
    try {
      const res = await fetch(`https://fonts.googleapis.com/css2?${query}&display=block`, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const block of (await res.text()).match(/@font-face\s*{[^}]*}/g) ?? []) {
        const ranges = rangesOf(block);
        if (ranges && !codes.some((c) => ranges.some(([a, b]) => c >= a && c <= b))) continue;
        const url = block.match(/url\(([^)]+)\)/)?.[1];
        if (!url) continue;
        const font = await fetch(url);
        if (!font.ok) throw new Error(`HTTP ${font.status}`);
        css += block.replace(url, `data:font/woff2;base64,${Buffer.from(await font.arrayBuffer()).toString("base64")}`);
      }
    } catch (e) {
      warn(`フォント "${family}" を Google Fonts から取得できない（${e.message}）`);
    }
  }
  return css;
}

// ---------- Playwright ----------

async function loadChromium() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    // 未導入なら Playwright MCP の playwright-core を探す
  }
  // Playwright MCP（plugin/.mcp.json）と同じ playwright-core を使えば、install が取得した
  // chromium のリビジョンと必ず一致する（playwright-core@latest だとずれる）
  const out = execFileSync("npx", ["-y", "-p", "@playwright/mcp@latest", "-c", 'printf %s "$PATH"'], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const bin = out.split(path.delimiter).find((p) => p.includes(`${path.sep}_npx${path.sep}`));
  if (!bin)
    throw new Error(
      "playwright を読み込めない（npx -y @playwright/mcp@latest install-browser --no-shell chromium を実行して取得する）",
    );
  return createRequire(path.join(bin, "..", "noop.js"))("playwright-core").chromium;
}

const safeName = (s) =>
  String(s)
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "node";

export async function render(doc, { baseDir, outDir, targets = [], scale = 2, theme }) {
  const warnings = [];
  const warn = (message, nodePath = null) => warnings.push({ node: nodePath, message });
  const roots = resolveDocument(doc, { theme, warn: (m) => warn(m, m.split(":")[0]) });
  const ctx = { baseDir, warn, fonts: new Set(), fontUsers: {}, icons: new Set(), materialFonts: new Set() };
  const body = roots.map((n) => nodeHtml(n, ctx, null)).join("");
  const icons = await fetchIcons(ctx.icons, (m) => warn(m));
  const text = [...new Set(JSON.stringify(roots))].join("");
  const fontCss = await fetchFontCss(ctx, text, warn);
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}html,body{margin:0;background:transparent}#canvas{position:relative}</style></head><body><div id="canvas">${body}</div></body></html>`;
  if (process.env.PEN_DEBUG_HTML) fs.writeFileSync(process.env.PEN_DEBUG_HTML, html);

  const chromium = await loadChromium();
  // install は --no-shell で headless shell を取得しないため、通常の chromium を使う
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage({ deviceScaleFactor: scale, viewport: { width: 1280, height: 800 } });
    await page
      .setContent(html, { waitUntil: "load", timeout: 30000 })
      .catch(() => warn("フォント等の読み込みが30秒で終わらなかった"));
    const result = await page.evaluate(
      async ({ icons, fonts }) => {
        await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 10000))]);
        for (const el of document.querySelectorAll("[data-pen-icon]")) {
          const [lib, name] = el.dataset.penIcon.split("|");
          el.innerHTML = icons[`${lib}|${name}`] ?? "";
        }
        for (const svg of document.querySelectorAll('svg[data-pen-autoviewbox="1"]')) {
          const b = svg.getBBox();
          if (b.width || b.height) svg.setAttribute("viewBox", `${b.x} ${b.y} ${b.width || 1} ${b.height || 1}`);
        }
        const missingFonts = fonts.filter((f) => {
          const [family, weight, style] = f.split("|");
          return (
            !document.fonts.check(`${style} ${weight} 16px "${family}"`) ||
            ![...document.fonts].some((ff) => ff.family.replace(/"/g, "") === family && ff.status === "loaded")
          );
        });
        // キャンバスを負の座標まで含めて左上へ寄せる
        const canvas = document.getElementById("canvas");
        let minX = 0;
        let minY = 0;
        for (const el of canvas.children) {
          const r = el.getBoundingClientRect();
          minX = Math.min(minX, r.left);
          minY = Math.min(minY, r.top);
        }
        canvas.style.left = `${-minX}px`;
        canvas.style.top = `${-minY}px`;
        const base = canvas.getBoundingClientRect();
        const rectOf = (el) => {
          const rects = [el, ...(el.dataset.penGroup ? el.querySelectorAll("[data-pen-id]") : [])]
            .map((e) => e.getBoundingClientRect())
            .filter((r) => r.width || r.height);
          if (!rects.length) return el.getBoundingClientRect();
          const l = Math.min(...rects.map((r) => r.left));
          const t = Math.min(...rects.map((r) => r.top));
          return {
            left: l,
            top: t,
            width: Math.max(...rects.map((r) => r.right)) - l,
            height: Math.max(...rects.map((r) => r.bottom)) - t,
          };
        };
        const round = (v) => Math.round(v * 100) / 100;
        const boxes = [...document.querySelectorAll("[data-pen-id]")].map((el) => {
          const r = rectOf(el);
          const parentEl = el.parentElement.closest("[data-pen-id]");
          const box = {
            id: el.dataset.penId,
            name: el.dataset.penName,
            type: el.dataset.penType,
            parent: parentEl?.dataset.penId ?? null,
            x: round(r.left - base.left),
            y: round(r.top - base.top),
            width: round(r.width),
            height: round(r.height),
          };
          // 親の外へはみ出した Node（pen.dev の ctx.problems 相当）
          if (parentEl && !parentEl.dataset.penGroup) {
            const p = parentEl.getBoundingClientRect();
            const ix = Math.min(r.left + r.width, p.right) - Math.max(r.left, p.left);
            const iy = Math.min(r.top + r.height, p.bottom) - Math.max(r.top, p.top);
            if (ix <= 0 || iy <= 0) box.problem = "fully clipped";
            else if (ix < r.width - 0.5 || iy < r.height - 0.5) box.problem = "partially clipped";
          }
          return box;
        });
        return { missingFonts, boxes };
      },
      { icons, fonts: [...ctx.fonts] },
    );
    for (const f of result.missingFonts) {
      const [family, weight] = f.split("|");
      for (const user of ctx.fontUsers[f])
        warn(
          `${user}: フォント "${family}" (${weight}) を読み込めず代替フォントで描画（文字幅・折り返しがずれうる）`,
          user,
        );
    }

    if (!outDir) return { images: [], boxes: result.boxes, warnings: [...new Set(warnings.map((w) => w.message))] };
    fs.mkdirSync(outDir, { recursive: true });
    const tops = roots.filter((n) => n.enabled !== false).map((n) => n._path);
    const wanted = targets.length ? targets : tops;
    const images = [];
    const usedNames = new Set();
    for (const target of wanted) {
      let clip;
      let label;
      if (target === "document") {
        const bs = result.boxes.filter((b) => tops.includes(b.id));
        const l = Math.min(...bs.map((b) => b.x));
        const t = Math.min(...bs.map((b) => b.y));
        clip = {
          x: l,
          y: t,
          width: Math.max(...bs.map((b) => b.x + b.width)) - l,
          height: Math.max(...bs.map((b) => b.y + b.height)) - t,
        };
        label = "document";
      } else {
        const b = result.boxes.find((x) => x.id === target) ?? result.boxes.find((x) => x.id.endsWith(`/${target}`));
        if (!b) {
          warn(`対象 "${target}" が見つからない`, target);
          continue;
        }
        clip = { x: b.x, y: b.y, width: Math.max(1, b.width), height: Math.max(1, b.height) };
        label = b.name || b.id;
      }
      const base = await page.evaluate(() => document.getElementById("canvas").getBoundingClientRect().toJSON());
      let name = safeName(label);
      if (usedNames.has(name)) name = `${name}-${safeName(target)}`;
      usedNames.add(name);
      const file = path.join(outDir, `${name}.png`);
      await page.setViewportSize({
        width: Math.ceil(Math.max(1280, base.x + clip.x + clip.width)),
        height: Math.ceil(Math.max(800, base.y + clip.y + clip.height)),
      });
      await page.screenshot({
        path: file,
        omitBackground: true,
        clip: { ...clip, x: base.x + clip.x, y: base.y + clip.y },
      });
      const nodeWarnings = warnings
        .filter(
          (w) =>
            target === "document" ||
            !w.node ||
            w.node === target ||
            w.node.startsWith(`${target}/`) ||
            isDescendant(roots, target, w.node),
        )
        .map((w) => w.message);
      images.push({ target, file, warnings: [...new Set(nodeWarnings)] });
    }
    return { images, boxes: result.boxes, warnings: [...new Set(warnings.map((w) => w.message))] };
  } finally {
    await browser.close();
  }
}

function isDescendant(roots, ancestor, nodePath) {
  const a = findByPath(roots, ancestor);
  if (!a) return false;
  let hit = false;
  walk(a.children, (n) => {
    if (n._path === nodePath) hit = true;
  });
  return hit;
}

function isUnderBox(boxes, ancestor, box) {
  const byId = new Map(boxes.map((b) => [b.id, b]));
  for (let p = box.parent; p; p = byId.get(p)?.parent) if (p === ancestor) return true;
  return false;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const positional = [];
  const flags = { theme: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base" || a === "--out" || a === "--scale") flags[a.slice(2)] = argv[++i];
    else if (a === "--theme") {
      const arg = argv[++i] ?? "";
      const eq = arg.indexOf("=");
      if (eq <= 0) {
        console.error(`--theme は 軸=値 で指定する（"${arg}"）`);
        process.exit(2);
      }
      flags.theme[arg.slice(0, eq)] = arg.slice(eq + 1);
    } else positional.push(a);
  }
  return { positional, flags };
}

function readDoc(file) {
  const text = fs.readFileSync(file, "utf8");
  if (/^(<{7}|={7}|>{7})/m.test(text)) throw new Error(`${file}: コンフリクトマーカーが残っている`);
  return JSON.parse(text);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const file = positional[0];
  if (!cmd || !file) {
    console.error("usage: pen.mjs validate|new-id|resolve|layout|render <file.pen> ...");
    process.exit(2);
  }
  let doc;
  try {
    doc = readDoc(file);
  } catch (e) {
    console.error(`JSON として読めない: ${e.message}`);
    process.exit(1);
  }
  const theme = Object.keys(flags.theme).length ? { ...defaultTheme(doc), ...flags.theme } : undefined;
  if (cmd === "validate") {
    const errors = validateDoc(doc, flags.base ? readDoc(flags.base) : null);
    for (const e of errors) console.error(e);
    if (errors.length) process.exit(1);
    console.log("ok");
  } else if (cmd === "new-id") {
    const count = Number(positional[1] ?? 1);
    if (!Number.isInteger(count) || count <= 0) {
      console.error(`個数は正の整数で指定する（"${positional[1]}"）`);
      process.exit(2);
    }
    console.log(newIds(doc, count).join("\n"));
  } else if (cmd === "resolve") {
    const warnings = [];
    const node = findByPath(resolveDocument(doc, { theme, warn: (m) => warnings.push(m) }), positional[1]);
    if (!node) {
      console.error(`"${positional[1]}" が見つからない`);
      process.exit(1);
    }
    for (const w of warnings) console.error(`warning: ${w}`);
    console.log(JSON.stringify(node, null, 2));
  } else if (cmd === "layout") {
    // 画像を出さずに、レイアウト解決後のボックス（canvas 座標）とはみ出しだけを返す
    const result = await render(doc, { baseDir: path.dirname(path.resolve(file)), outDir: null, scale: 1, theme });
    const target = positional[1];
    const boxes = target
      ? result.boxes.filter(
          (b) => b.id === target || b.id.startsWith(`${target}/`) || isUnderBox(result.boxes, target, b),
        )
      : result.boxes;
    for (const w of result.warnings) console.error(`warning: ${w}`);
    console.log(JSON.stringify(boxes, null, 2));
  } else if (cmd === "render") {
    if (!flags.out) {
      console.error("--out <dir> が必要");
      process.exit(2);
    }
    const scale = Number(flags.scale ?? 2);
    if (!Number.isFinite(scale) || scale <= 0) {
      console.error(`--scale は正の数で指定する（"${flags.scale}"）`);
      process.exit(2);
    }
    const outDir = path.resolve(flags.out);
    const result = await render(doc, {
      baseDir: path.dirname(path.resolve(file)),
      outDir,
      targets: positional.slice(1),
      scale,
      theme,
    });
    // ボックスは画像と同じ場所に置くと snapshots/ のコミット対象に紛れるため一時ディレクトリへ
    const boxesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pen-boxes-")), "boxes.json");
    fs.writeFileSync(boxesFile, JSON.stringify(result.boxes, null, 2));
    console.log(JSON.stringify({ images: result.images, boxesFile, warnings: result.warnings }, null, 2));
  } else {
    console.error(`未知のコマンド: ${cmd}`);
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
