import { test } from "node:test";
import assert from "node:assert/strict";
import type * as InitModule from "./init";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
const { withInitDefaults, CLOUD_DEFAULT_PERMISSION_MODE, CLAUDE_SETTINGS_DEFAULTS } = (await import(
  "./init.ts"
)) as typeof InitModule;

const allDefaults = {
  permissions: { defaultMode: CLOUD_DEFAULT_PERMISSION_MODE },
  ...CLAUDE_SETTINGS_DEFAULTS,
};

test("withInitDefaults creates the file content when settings.json is absent", () => {
  assert.deepEqual(JSON.parse(withInitDefaults(null, false) ?? ""), allDefaults);
});

test("withInitDefaults keeps unrelated settings and the rest of permissions", () => {
  const existing = JSON.stringify({
    hooks: { Stop: [{ matcher: "*" }] },
    permissions: { allow: ["Bash(git *)"] },
  });
  assert.deepEqual(JSON.parse(withInitDefaults(existing, false) ?? ""), {
    hooks: { Stop: [{ matcher: "*" }] },
    permissions: { allow: ["Bash(git *)"], defaultMode: CLOUD_DEFAULT_PERMISSION_MODE },
    ...CLAUDE_SETTINGS_DEFAULTS,
  });
});

test("withInitDefaults leaves existing values alone without force", () => {
  const existing = JSON.stringify({
    permissions: { defaultMode: "plan" },
    outputStyle: "Explanatory",
    language: "English",
  });
  assert.equal(withInitDefaults(existing, false), null);
});

test("withInitDefaults still fills the keys that are missing", () => {
  const existing = JSON.stringify({ outputStyle: "Explanatory" });
  assert.deepEqual(JSON.parse(withInitDefaults(existing, false) ?? ""), {
    ...allDefaults,
    outputStyle: "Explanatory",
  });
});

test("withInitDefaults overwrites existing values with force", () => {
  const existing = JSON.stringify({
    permissions: { defaultMode: "plan" },
    outputStyle: "Explanatory",
    language: "English",
  });
  assert.deepEqual(JSON.parse(withInitDefaults(existing, true) ?? ""), allDefaults);
});

test("withInitDefaults reports no change when every value already matches", () => {
  assert.equal(withInitDefaults(JSON.stringify(allDefaults), true), null);
});

test("withInitDefaults refuses to rewrite a file it cannot parse", () => {
  assert.throws(() => withInitDefaults("{ not json", false));
});

test("withInitDefaults refuses to rewrite a non-object permissions", () => {
  assert.throws(() => withInitDefaults(JSON.stringify({ permissions: [] }), false), /permissions/);
});
