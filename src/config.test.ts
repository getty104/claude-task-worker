import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type * as ConfigModule from "./config";

const { parseUiDesignEntry, DEFAULT_UI_DESIGN_CONFIG } = (await import("./config")) as typeof ConfigModule;

// 不正値は console.warn を出して既定値へ倒す仕様なので、テスト出力を汚さないよう黙らせる。
function silenceWarn(t: TestContext): void {
  t.mock.method(console, "warn", () => {});
}

test("parseUiDesignEntry defaults to disabled with designs/ as the design dir", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseUiDesignEntry(undefined), { enabled: false, designDir: "designs" });
  assert.deepEqual(DEFAULT_UI_DESIGN_CONFIG, { enabled: false, designDir: "designs" });
});

test("parseUiDesignEntry reads enabled and designDir", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseUiDesignEntry({ enabled: true, designDir: "docs/designs" }), {
    enabled: true,
    designDir: "docs/designs",
  });
});

test("parseUiDesignEntry falls back to the default for a non-boolean enabled", (t) => {
  silenceWarn(t);
  // "true" のような文字列を有効扱いすると、オプトインしていないリポジトリで
  // デザインPRが勝手に作られる。必ず既定（無効）へ倒す。
  assert.equal(parseUiDesignEntry({ enabled: "true" }).enabled, false);
});

test("parseUiDesignEntry falls back to the default for an empty designDir", (t) => {
  silenceWarn(t);
  assert.equal(parseUiDesignEntry({ enabled: true, designDir: "" }).designDir, "designs");
});

test("parseUiDesignEntry accepts a normal relative designDir", (t) => {
  silenceWarn(t);
  assert.equal(parseUiDesignEntry({ enabled: true, designDir: "my-designs" }).designDir, "my-designs");
});

test("parseUiDesignEntry falls back to the default for an absolute designDir", (t) => {
  silenceWarn(t);
  assert.equal(parseUiDesignEntry({ enabled: true, designDir: "/etc/passwd" }).designDir, "designs");
});

test("parseUiDesignEntry falls back to the default for a path-traversal designDir", (t) => {
  silenceWarn(t);
  assert.equal(parseUiDesignEntry({ enabled: true, designDir: "../../etc" }).designDir, "designs");
});

test("parseUiDesignEntry falls back to defaults when uiDesign is not an object", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseUiDesignEntry("designs"), { enabled: false, designDir: "designs" });
  assert.deepEqual(parseUiDesignEntry([]), { enabled: false, designDir: "designs" });
  assert.deepEqual(parseUiDesignEntry(null), { enabled: false, designDir: "designs" });
});

test("parseUiDesignEntry warns once per invalid key", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  parseUiDesignEntry({ enabled: 1, designDir: 2 });
  assert.equal(warn.mock.callCount(), 2);
});
