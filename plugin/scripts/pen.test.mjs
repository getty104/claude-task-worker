import { test } from "node:test";
import assert from "node:assert/strict";
import { validateDoc, newIds, resolveDocument, findByPath, nodeHtml, fontWeight } from "./pen.mjs";

const doc = () => ({
  version: "2.21",
  themes: { mode: ["light", "dark"] },
  variables: {
    primary: { type: "color", value: [{ value: "#2563EB" }, { value: "#60A5FA", theme: { mode: "dark" } }] },
    gap: { type: "number", value: 16 },
  },
  children: [
    {
      id: "btn",
      type: "frame",
      name: "Button",
      reusable: true,
      fill: "$primary",
      children: [{ id: "lbl", type: "text", name: "Label", content: "Search" }],
    },
    {
      id: "card",
      type: "frame",
      name: "Card",
      layout: "vertical",
      gap: "$gap",
      children: [
        { id: "go", type: "ref", ref: "btn", descendants: { lbl: { content: "Go" } } },
        { id: "dark", type: "ref", ref: "btn", theme: { mode: "dark" } },
        { id: "bar", type: "rectangle", width: "fill_container", height: 1, fill: "#E5E7EB" },
      ],
    },
  ],
});

test("validateDoc accepts a well-formed document", () => {
  assert.deepEqual(validateDoc(doc()), []);
});

test("validateDoc reports the mistakes execute used to reject", () => {
  const d = doc();
  d.children[1].children.push(
    { id: "bar", type: "rectangle" },
    { id: "a/b", type: "text", fil: "#000" },
    { id: "x1", type: "ref", ref: "nope" },
    { id: "x2", type: "rectangle", fill: "red", width: "half" },
    { id: "x3", type: "text", fill: "$missing" },
    { id: "x4", type: "ref", ref: "btn", descendants: { ghost: {} } },
    { id: "x5", type: "frame", layout: "grid" },
  );
  const errors = validateDoc(d).join("\n");
  for (const fragment of [
    "id が重複",
    'id に "/"',
    '"fil"',
    '"nope" が無い',
    '"red"',
    '"half"',
    "$missing",
    '"ghost"',
    "layout は",
  ]) {
    assert.match(errors, new RegExp(fragment.replace(/[$/()]/g, "\\$&")), fragment);
  }
});

test("validateDoc with base rejects version / fileToken changes", () => {
  const base = { ...doc(), fileToken: "t" };
  const edited = { ...doc(), version: "3", fileToken: undefined };
  const errors = validateDoc(edited, base).join("\n");
  assert.match(errors, /version/);
  assert.match(errors, /fileToken/);
});

test("newIds returns ids unused in the document and among themselves", () => {
  let i = 0;
  const seq = [0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.9, 0.9, 0.9, 0.9, 0.9];
  const d = doc();
  d.children.push({ id: "AAAAA", type: "rectangle" });
  const ids = newIds(d, 2, () => seq[i++ % seq.length]);
  assert.equal(ids.length, 2);
  assert.ok(!ids.includes("AAAAA"));
  assert.notEqual(ids[0], ids[1]);
});

test("resolveDocument expands refs, applies descendants and theme-aware variables", () => {
  const roots = resolveDocument(doc());
  assert.equal(findByPath(roots, "go/lbl").content, "Go");
  assert.equal(findByPath(roots, "go").fill, "#2563EB");
  assert.equal(findByPath(roots, "dark").fill, "#60A5FA");
  assert.equal(findByPath(roots, "dark/lbl").content, "Search");
  assert.equal(findByPath(roots, "card").gap, 16);
});

test("resolveDocument applies the component's own theme under ref instances, ref theme winning", () => {
  const d = doc();
  d.children[0].theme = { mode: "dark" };
  const roots = resolveDocument(d);
  assert.equal(findByPath(roots, "go").fill, "#60A5FA");
  d.children[1].children[0].theme = { mode: "light" };
  assert.equal(findByPath(resolveDocument(d), "go").fill, "#2563EB");
});

test("resolveDocument routes slash keys into nested instances", () => {
  const d = doc();
  d.children.unshift({
    id: "bar2",
    type: "frame",
    reusable: true,
    children: [{ id: "inner", type: "ref", ref: "btn" }],
  });
  d.children[2].children.push({
    id: "tb",
    type: "ref",
    ref: "bar2",
    descendants: { "inner/lbl": { content: "Deep" } },
  });
  const roots = resolveDocument(d);
  assert.equal(findByPath(roots, "tb/inner/lbl").content, "Deep");
});

test("resolveDocument turns an unresolvable ref into a placeholder with a warning", () => {
  const d = doc();
  d.children.push({ id: "lost", type: "ref", ref: "ghost" });
  const warnings = [];
  const roots = resolveDocument(d, { warn: (m) => warnings.push(m) });
  assert.equal(findByPath(roots, "lost").type, "_placeholder");
  assert.match(warnings.join(), /ghost/);
});

test("nodeHtml maps layout to flexbox and fill_container to flex-grow / stretch", () => {
  const card = findByPath(resolveDocument(doc()), "card");
  const html = nodeHtml(card, {
    baseDir: ".",
    warn: () => {},
    fonts: new Set(),
    fontUsers: {},
    icons: new Set(),
    materialFonts: new Set(),
  });
  assert.match(html, /display:flex;flex-direction:column/);
  assert.match(html, /data-pen-id="bar"[^>]*align-self:stretch/);
  assert.match(html, /data-pen-id="go\/lbl"/);
});

test("nodeHtml warns instead of silently dropping what it cannot draw", () => {
  const warnings = [];
  const ctx = {
    baseDir: ".",
    warn: (m) => warnings.push(m),
    fonts: new Set(),
    fontUsers: {},
    icons: new Set(),
    materialFonts: new Set(),
  };
  nodeHtml({ _path: "s", type: "script", width: 10, height: 10 }, ctx);
  nodeHtml({ _path: "m", type: "rectangle", fill: { type: "mesh_gradient" } }, ctx);
  nodeHtml({ _path: "e", type: "rectangle", effect: { type: "shader", url: "x.glsl" } }, ctx);
  assert.equal(warnings.length, 3);
});

test("fontWeight normalizes keywords and numbers", () => {
  assert.equal(fontWeight("600"), 600);
  assert.equal(fontWeight("bold"), 700);
  assert.equal(fontWeight(undefined), 400);
});
