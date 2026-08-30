import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as ConfigModule from "./config";
import type * as DispatchArgsModule from "./dispatch-args";

const {
  parseLastRunEntry,
  parseUiDesignEntry,
  parseWorkerEntry,
  writeLastRun,
  DEFAULT_UI_DESIGN_CONFIG,
  DEFAULT_WORKER_CONFIG,
  WORKER_DEFAULTS,
  SCHEDULED_WORKER_NAMES,
  CLOUD_DENIED_WORKERS,
  checkCloudConfig,
  checkCloudAuth,
  isCloudWorker,
} = (await import("./config")) as typeof ConfigModule;
const { resetCloudFlagCache } = (await import("./dispatch-args")) as typeof DispatchArgsModule;

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

// 定期ワーカーは cc-cloud-done を置く対象 Issue/PR を持たないが、完了検知を作る代わりに
// 「セッション作成＝完了」（process-manager.ts の runViaCloud() の !cloudTarget 分岐）を
// 正式な経路にしたためクラウド実行できる。deny-list へ差し戻さないよう固定する。
test("scheduled workers are not in CLOUD_DENIED_WORKERS (session creation counts as completion)", () => {
  for (const name of SCHEDULED_WORKER_NAMES) {
    assert.ok(
      !(CLOUD_DENIED_WORKERS as readonly string[]).includes(name),
      `${name} must not be in CLOUD_DENIED_WORKERS`,
    );
  }
});

// denied に残るのは pen 系3件だけ。`--cloud` 起動ログ（src/index.ts の "these workers stay
// local"）はこの配列を join するため、内容がそのままログに出る。
test("CLOUD_DENIED_WORKERS holds only the pencil-dependent workers", () => {
  assert.deepEqual([...CLOUD_DENIED_WORKERS], ["resolve-conflict", "create-ui-design", "apply-ui-design"]);
});

test("isCloudWorker returns true for every scheduled worker when --cloud is passed", (t) => {
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    resetCloudFlagCache();
  });
  process.argv = [...originalArgv, "--cloud"];
  resetCloudFlagCache();

  for (const name of SCHEDULED_WORKER_NAMES) {
    assert.equal(isCloudWorker(name), true, `isCloudWorker(${name}) must run in the cloud under --cloud`);
  }
});

test("parseWorkerEntry warns and ignores a legacy cloud key (moved to the --cloud runtime flag)", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const result = parseWorkerEntry("exec-issue", { cloud: true });
  assert.ok(result);
  assert.ok(!("cloud" in result), "cloud はもう WorkerRuntimeConfig に含まれてはいけない");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /workers\.exec-issue\.cloud is removed/);
});

test("checkCloudConfig returns nothing when cloud is false, regardless of mode", () => {
  assert.deepEqual(checkCloudConfig({ cloud: false, mode: "default" }), []);
});

test("checkCloudConfig allows cloud: true when mode is herdr", () => {
  assert.deepEqual(checkCloudConfig({ cloud: true, mode: "herdr" }), []);
});

test("checkCloudConfig rejects cloud: true when mode is not herdr", () => {
  const errors = checkCloudConfig({ cloud: true, mode: "default" });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--cloud/);
  assert.match(errors[0], /herdr/);
});

test("checkCloudConfig does not inspect auth when cloud is false", () => {
  const errors = checkCloudConfig({
    cloud: false,
    mode: "herdr",
    auth: { status: { kind: "ok", loggedIn: false, authMethod: "none", apiProvider: "firstParty" } },
  });
  assert.deepEqual(errors, []);
});

test("isCloudWorker returns false for every worker when --cloud is not passed", (t) => {
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    resetCloudFlagCache();
  });
  process.argv = [...originalArgv.filter((a) => a !== "--cloud")];
  resetCloudFlagCache();

  for (const name of Object.keys(WORKER_DEFAULTS)) {
    assert.equal(isCloudWorker(name), false, `isCloudWorker(${name}) without --cloud`);
  }
});

test("isCloudWorker returns true for non-denied workers when --cloud is passed", (t) => {
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    resetCloudFlagCache();
  });
  process.argv = [...originalArgv, "--cloud"];
  resetCloudFlagCache();

  assert.equal(isCloudWorker("exec-issue"), true);
  assert.equal(isCloudWorker("triage-pr"), true);
});

test("isCloudWorker returns false for every CLOUD_DENIED_WORKERS entry even when --cloud is passed", (t) => {
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    resetCloudFlagCache();
  });
  process.argv = [...originalArgv, "--cloud"];
  resetCloudFlagCache();

  for (const name of CLOUD_DENIED_WORKERS) {
    assert.equal(isCloudWorker(name), false, `isCloudWorker(${name}) must stay local under --cloud`);
  }
});

// M1: 通常のサインイン（`docs/cloud-prerequisite-checks.md` verbatim）
test("checkCloudAuth allows a normal claude.ai sign-in", () => {
  const errors = checkCloudAuth({
    status: { kind: "ok", loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" },
  });
  assert.deepEqual(errors, []);
});

// M2: ANTHROPIC_API_KEY
test("checkCloudAuth rejects ANTHROPIC_API_KEY even though authMethod reads claude.ai", () => {
  const errors = checkCloudAuth({
    status: {
      kind: "ok",
      loggedIn: true,
      authMethod: "claude.ai",
      apiProvider: "firstParty",
      apiKeySource: "ANTHROPIC_API_KEY",
    },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /API キー/);
});

// M2: ANTHROPIC_AUTH_TOKEN
test("checkCloudAuth rejects ANTHROPIC_AUTH_TOKEN (authMethod: oauth_token)", () => {
  const errors = checkCloudAuth({
    status: { kind: "ok", loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /API キー/);
});

// M2: Bedrock / Vertex
test("checkCloudAuth rejects third-party providers (Bedrock/Vertex)", () => {
  const bedrock = checkCloudAuth({
    status: { kind: "ok", loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" },
  });
  assert.equal(bedrock.length, 1);
  assert.match(bedrock[0], /第三者プロバイダ/);

  const vertex = checkCloudAuth({
    status: { kind: "ok", loggedIn: true, authMethod: "third_party", apiProvider: "vertex" },
  });
  assert.equal(vertex.length, 1);
  assert.match(vertex[0], /第三者プロバイダ/);
});

// M3: 未ログイン
test("checkCloudAuth rejects a logged-out state", () => {
  const errors = checkCloudAuth({
    status: { kind: "ok", loggedIn: false, authMethod: "none", apiProvider: "firstParty" },
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /未サインイン/);
});

// ANTHROPIC_BASE_URL: `claude auth status` の出力上は通常のサインインと区別できないため、
// ワーカー側が別途 baseUrl を渡して判定する。
test("checkCloudAuth rejects a custom ANTHROPIC_BASE_URL even with an otherwise normal sign-in", () => {
  const errors = checkCloudAuth({
    status: { kind: "ok", loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" },
    baseUrl: "https://example.invalid",
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /ANTHROPIC_BASE_URL/);
});

test("checkCloudAuth treats an indeterminate status as not an error", () => {
  assert.deepEqual(checkCloudAuth({ status: { kind: "unknown" } }), []);
});
