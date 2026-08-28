import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ConfigModule from "./config";

const {
  parseLastRunEntry,
  parseUiDesignEntry,
  parseWorkerEntry,
  writeLastRun,
  DEFAULT_UI_DESIGN_CONFIG,
  DEFAULT_WORKER_CONFIG,
  WORKER_DEFAULTS,
  SCHEDULED_WORKER_NAMES,
} = (await import("./config")) as typeof ConfigModule;

// 不正値は console.warn を出して既定値へ倒す仕様なので、テスト出力を汚さないよう黙らせる。
function silenceWarn(t: TestContext): void {
  t.mock.method(console, "warn", () => {});
}

test("parseUiDesignEntry defaults to disabled with designs/ as the design dir", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseUiDesignEntry(undefined), { enabled: false, designDir: "designs", yolo: false });
  assert.deepEqual(DEFAULT_UI_DESIGN_CONFIG, { enabled: false, designDir: "designs", yolo: false });
});

test("parseUiDesignEntry reads enabled and designDir", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseUiDesignEntry({ enabled: true, designDir: "docs/designs", yolo: true }), {
    enabled: true,
    designDir: "docs/designs",
    yolo: true,
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
  assert.deepEqual(parseUiDesignEntry("designs"), { enabled: false, designDir: "designs", yolo: false });
  assert.deepEqual(parseUiDesignEntry([]), { enabled: false, designDir: "designs", yolo: false });
  assert.deepEqual(parseUiDesignEntry(null), { enabled: false, designDir: "designs", yolo: false });
});

test("parseUiDesignEntry warns once per invalid key", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  parseUiDesignEntry({ enabled: 1, designDir: 2, yolo: 3 });
  assert.equal(warn.mock.callCount(), 3);
});

test("parseUiDesignEntry falls back to the default for a non-boolean yolo", (t) => {
  silenceWarn(t);
  // yolo を文字列で有効扱いすると、人のレビューを挟むつもりのデザインPRが
  // cc-triage-scope 付きで自動マージへ流れる。必ず既定（無効）へ倒す。
  assert.equal(parseUiDesignEntry({ enabled: true, yolo: "true" }).yolo, false);
});

test("every worker defaults to a known model without an advisor", () => {
  // claude 側の制約: advisor は main モデル以上の能力が必要。opus のワーカーに
  // opus advisor を付けても意味がないため既定は空文字（＝渡さない）。sonnet へ
  // 下げたワーカーも既定は空文字で、必要なら claude-task-worker.json で付ける。
  assert.equal(DEFAULT_WORKER_CONFIG.model, "opus");
  assert.equal(DEFAULT_WORKER_CONFIG.advisorModel, "");
  for (const [name, config] of Object.entries(WORKER_DEFAULTS)) {
    assert.ok(["opus", "sonnet"].includes(config.model), `WORKER_DEFAULTS.${name}.model=${config.model}`);
    assert.equal(config.advisorModel, "", `WORKER_DEFAULTS.${name}.advisorModel`);
  }
});

test("workers on the delivery critical path stay on opus", () => {
  // セッションログの実測（sonnet期 vs opus期）で、opus は手戻り（fix-review-point/exec-issue）が
  // 1.16 → 0.72、PR再トリアージが 5.48 → 3.23 に減った。単セッションのコストが高くても
  // Issue 1件あたりの合計では opus が安い。下げると手戻りが増えて逆に高くつく。
  for (const name of ["exec-issue", "fix-review-point", "triage-pr", "create-issue"]) {
    assert.equal(WORKER_DEFAULTS[name].model, "opus", `WORKER_DEFAULTS.${name}.model`);
  }
});

test("parseWorkerEntry keeps the worker default advisorModel when unspecified", (t) => {
  silenceWarn(t);
  assert.equal(parseWorkerEntry("triage-pr", {})?.advisorModel, "");
  assert.equal(parseWorkerEntry("exec-issue", {})?.advisorModel, "");
});

test("parseWorkerEntry accepts an empty advisorModel as an explicit opt-out", (t) => {
  silenceWarn(t);
  // 他フィールドと違い空文字は不正値ではなく「advisor を使わない」の明示指定。
  assert.equal(parseWorkerEntry("update-issue", { advisorModel: "" })?.advisorModel, "");
  assert.equal(parseWorkerEntry("update-issue", { advisorModel: "fable" })?.advisorModel, "fable");
});

test("parseLastRunEntry keeps only parseable timestamps", (t) => {
  silenceWarn(t);
  // 壊れた値で定期ワーカーが「実行済み」と誤判定して永久に走らなくなるのを防ぐ。
  assert.deepEqual(parseLastRunEntry({ "update-design-md": "2026-08-17T00:00:00.000Z", broken: "yesterday", n: 1 }), {
    "update-design-md": "2026-08-17T00:00:00.000Z",
  });
  assert.deepEqual(parseLastRunEntry("2026-08-17"), {});
});

test("writeLastRun records the timestamp without dropping other settings", () => {
  const root = mkdtempSync(join(tmpdir(), "ctw-lastrun-"));
  const path = join(root, "claude-task-worker.json");
  writeFileSync(path, JSON.stringify({ uiDesign: { enabled: true }, lastRun: { "update-design-md": "2026-08-01" } }));

  writeLastRun(root, "update-coding-guidelines", new Date("2026-08-17T09:00:00.000Z"));

  assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), {
    uiDesign: { enabled: true },
    lastRun: {
      "update-design-md": "2026-08-01",
      "update-coding-guidelines": "2026-08-17T09:00:00.000Z",
    },
  });
});

test("writeLastRun creates the config file when the repo has none", () => {
  const root = mkdtempSync(join(tmpdir(), "ctw-lastrun-"));
  writeLastRun(root, "update-requirement-rules", new Date("2026-08-17T09:00:00.000Z"));
  assert.deepEqual(JSON.parse(readFileSync(join(root, "claude-task-worker.json"), "utf-8")), {
    lastRun: { "update-requirement-rules": "2026-08-17T09:00:00.000Z" },
  });
});

test("parseWorkerEntry falls back to the default for a non-string advisorModel", (t) => {
  silenceWarn(t);
  // 既定は全ワーカー ""（advisor なし）なので、不正値は既定へ落ちて advisor が付かない。
  assert.equal(parseWorkerEntry("triage-pr", { advisorModel: 1 })?.advisorModel, "");
  assert.equal(parseWorkerEntry("exec-issue", { advisorModel: null })?.advisorModel, "");
  // 有効値の指定は残る（不正値だけが弾かれることの確認）。
  assert.equal(parseWorkerEntry("triage-pr", { advisorModel: "opus" })?.advisorModel, "opus");
});

test("SCHEDULED_WORKER_NAMES all have worker defaults", () => {
  for (const name of SCHEDULED_WORKER_NAMES) {
    assert.ok(WORKER_DEFAULTS[name], `missing defaults for ${name}`);
  }
});

test("parseWorkerEntry reads a boolean cloud", (t) => {
  silenceWarn(t);
  assert.equal(parseWorkerEntry("exec-issue", { cloud: true })?.cloud, true);
  assert.equal(parseWorkerEntry("exec-issue", { cloud: false })?.cloud, false);
});

test("parseWorkerEntry defaults cloud to false when unspecified", (t) => {
  silenceWarn(t);
  assert.equal(parseWorkerEntry("exec-issue", {})?.cloud, false);
});

test("parseWorkerEntry falls back to false for a non-boolean cloud", (t) => {
  silenceWarn(t);
  // クラウド実行は既定で無効なオプトインなので、不正値は必ず既定（無効）へ倒す。
  assert.equal(parseWorkerEntry("exec-issue", { cloud: "true" })?.cloud, false);
  assert.equal(parseWorkerEntry("exec-issue", { cloud: 1 })?.cloud, false);
  assert.equal(parseWorkerEntry("exec-issue", { cloud: null })?.cloud, false);
});

test("every worker defaults to cloud disabled", () => {
  // オプトインが既定で有効化されないことの保証。
  assert.equal(DEFAULT_WORKER_CONFIG.cloud, false);
  for (const [name, config] of Object.entries(WORKER_DEFAULTS)) {
    assert.equal(config.cloud, false, `WORKER_DEFAULTS.${name}.cloud`);
  }
});
