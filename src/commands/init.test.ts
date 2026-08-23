import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as M from "./init";

const { mergePluginSettings, registerPluginInSettings } = (await import("./init")) as typeof M;

test("mergePluginSettings registers the marketplace and enables the plugin", () => {
  const merged = mergePluginSettings({});
  assert.deepEqual(merged, {
    extraKnownMarketplaces: {
      "claude-task-worker": { source: { source: "github", repo: "getty104/claude-task-worker" } },
    },
    enabledPlugins: { "claude-task-worker@claude-task-worker": true },
  });
});

test("mergePluginSettings keeps unrelated settings and other plugins", () => {
  // 既存の `.claude/settings.json`（permissions・hooks・他プラグイン）を壊さないことが
  // マージ方式の唯一の理由なので、ここが崩れたら書き込み方式ごと誤り。
  const merged = mergePluginSettings({
    permissions: { defaultMode: "auto" },
    enabledPlugins: { "other@other": true },
    extraKnownMarketplaces: { other: { source: { source: "github", repo: "someone/other" } } },
  });
  assert.deepEqual(merged.permissions, { defaultMode: "auto" });
  assert.equal((merged.enabledPlugins as Record<string, unknown>)["other@other"], true);
  assert.equal((merged.enabledPlugins as Record<string, unknown>)["claude-task-worker@claude-task-worker"], true);
  assert.ok((merged.extraKnownMarketplaces as Record<string, unknown>).other);
});

test("mergePluginSettings is idempotent", () => {
  const once = mergePluginSettings({ permissions: { defaultMode: "auto" } });
  assert.equal(JSON.stringify(mergePluginSettings(once)), JSON.stringify(once));
});

test("registerPluginInSettings does not throw when writing fails", async () => {
  // .claude を通常ファイルとして作っておくと、`mkdir(".claude", { recursive: true })` が
  // ENOTDIR で失敗する。読み込み失敗時と同様に警告ログのみで return することを検証する。
  const dir = mkdtempSync(join(tmpdir(), "ctw-init-settings-"));
  writeFileSync(join(dir, ".claude"), "not a directory");
  const originalCwd = process.cwd();
  process.chdir(dir);
  try {
    await assert.doesNotReject(registerPluginInSettings());
  } finally {
    process.chdir(originalCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
