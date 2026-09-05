import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import type * as CloudSettingsModule from "./cloud-setup";

// node --experimental-strip-types は .ts 拡張子付きの実ファイル解決を要求するため、
// .ts 拡張子付きのリテラル文字列で動的importする。
const {
  withCloudDefaults,
  claudeSettingsPath,
  CLOUD_DEFAULT_PERMISSION_MODE,
  CLOUD_SETTINGS_DEFAULTS,
  CLOUD_SETTINGS_ENV,
} = (await import("./cloud-setup.ts")) as typeof CloudSettingsModule;

const allDefaults = {
  permissions: { defaultMode: CLOUD_DEFAULT_PERMISSION_MODE },
  ...CLOUD_SETTINGS_DEFAULTS,
  env: { ...CLOUD_SETTINGS_ENV },
};

test("withCloudDefaults creates the file content when settings.json is absent", () => {
  assert.deepEqual(JSON.parse(withCloudDefaults(null, false) ?? ""), allDefaults);
});

test("withCloudDefaults keeps unrelated settings and the rest of permissions", () => {
  const existing = JSON.stringify({
    hooks: { SessionStart: [{ matcher: "*" }] },
    permissions: { allow: ["Bash(git *)"] },
    env: { MY_VAR: "keep" },
  });
  assert.deepEqual(JSON.parse(withCloudDefaults(existing, false) ?? ""), {
    hooks: { SessionStart: [{ matcher: "*" }] },
    permissions: { allow: ["Bash(git *)"], defaultMode: CLOUD_DEFAULT_PERMISSION_MODE },
    ...CLOUD_SETTINGS_DEFAULTS,
    env: { MY_VAR: "keep", ...CLOUD_SETTINGS_ENV },
  });
});

test("withCloudDefaults leaves existing values alone without force", () => {
  const existing = JSON.stringify({
    permissions: { defaultMode: "plan" },
    outputStyle: "Explanatory",
    language: "English",
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" },
  });
  assert.equal(withCloudDefaults(existing, false), null);
});

test("withCloudDefaults still fills the keys that are missing", () => {
  const existing = JSON.stringify({ outputStyle: "Explanatory" });
  assert.deepEqual(JSON.parse(withCloudDefaults(existing, false) ?? ""), {
    ...allDefaults,
    outputStyle: "Explanatory",
  });
});

test("withCloudDefaults overwrites existing values with force", () => {
  const existing = JSON.stringify({
    permissions: { defaultMode: "plan" },
    outputStyle: "Explanatory",
    language: "English",
    env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "0" },
  });
  assert.deepEqual(JSON.parse(withCloudDefaults(existing, true) ?? ""), allDefaults);
});

test("withCloudDefaults reports no change when every value already matches", () => {
  assert.equal(withCloudDefaults(JSON.stringify(allDefaults), true), null);
});

test("withCloudDefaults refuses to rewrite a file it cannot parse", () => {
  assert.throws(() => withCloudDefaults("{ not json", false));
});

test("withCloudDefaults refuses to rewrite a non-object permissions", () => {
  assert.throws(() => withCloudDefaults(JSON.stringify({ permissions: [] }), false), /permissions/);
});

test("withCloudDefaults refuses to rewrite a non-object env", () => {
  assert.throws(() => withCloudDefaults(JSON.stringify({ env: "x" }), false), /env/);
});

test("claudeSettingsPath defaults to the user scope settings file", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    assert.equal(claudeSettingsPath(), join(homedir(), ".claude", "settings.json"));
  } finally {
    if (saved !== undefined) process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test("claudeSettingsPath follows CLAUDE_CONFIG_DIR", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/tmp/claude-config";
  try {
    assert.equal(claudeSettingsPath(), join("/tmp/claude-config", "settings.json"));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  }
});
