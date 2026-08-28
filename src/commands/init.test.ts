import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as M from "./init";
import { DEFAULT_WORKER_CONFIG, type WorkerRuntimeConfig } from "../config";

const { mergePluginSettings, registerPluginInSettings, shouldRegisterPlugin } = (await import("./init")) as typeof M;

function worker(overrides: Partial<WorkerRuntimeConfig>): WorkerRuntimeConfig {
  return { ...DEFAULT_WORKER_CONFIG, ...overrides };
}

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

test("shouldRegisterPlugin is true when --cloud is passed regardless of config", () => {
  assert.equal(shouldRegisterPlugin({}, { cloud: true }), true);
  assert.equal(shouldRegisterPlugin({ "exec-issue": worker({ cloud: false }) }, { cloud: true }), true);
});

test("shouldRegisterPlugin is true when a worker has cloud: true", () => {
  const workers = { "exec-issue": worker({ cloud: true }), "triage-pr": worker({ cloud: false }) };
  assert.equal(shouldRegisterPlugin(workers, {}), true);
});

test("shouldRegisterPlugin is false when all workers have cloud: false", () => {
  const workers = { "exec-issue": worker({ cloud: false }), "triage-pr": worker({ cloud: false }) };
  assert.equal(shouldRegisterPlugin(workers, {}), false);
});

test("shouldRegisterPlugin is false when workers is empty", () => {
  assert.equal(shouldRegisterPlugin({}, {}), false);
});
