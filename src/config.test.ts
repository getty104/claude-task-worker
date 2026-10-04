import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ConfigModule from "./config";
import type * as DispatchArgsModule from "./dispatch-args";

const {
  parseLastRunEntry,
  parseLabelsEntry,
  parseWorkerFilesEntry,
  resolveWorkerFilePath,
  parseUiDesignEntry,
  parseWorkerEntry,
  writeLastRun,
  DEFAULT_UI_DESIGN_CONFIG,
  DEFAULT_WORKER_CONFIG,
  WORKER_DEFAULTS,
  SCHEDULED_WORKER_NAMES,
  checkCloudConfig,
  checkCloudAuth,
  isCloudWorker,
  mergeConfigRaw,
  resolveInheritedRelativePaths,
  partitionEnabledWorkers,
  disabledWorkerMessage,
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

test("opus workers default to medium effort; sonnet workers split by task difficulty", () => {
  // Opus 5.5 の既定は medium で、medium が Opus 5 の high と同等以上。同じレベル名でも
  // ターンあたりの思考量が増えるため、Opus 5 時代の high を持ち越すと長く高くなるだけ。
  // Sonnet 5.5 は「仕様が確定したエージェント的タスクは medium から、難しい・長いものは high」。
  // 手順が本文に書き切ってあるワーカーは medium、コード変更の判断を伴うワーカーは high。
  assert.equal(DEFAULT_WORKER_CONFIG.effort, "medium");
  const sonnetHigh = new Set(["resolve-conflict", "check-dependabot"]);
  for (const [name, config] of Object.entries(WORKER_DEFAULTS)) {
    if (config.model === "opus") {
      assert.equal(config.effort, "medium", `WORKER_DEFAULTS.${name}.effort`);
    } else {
      assert.equal(config.effort, sonnetHigh.has(name) ? "high" : "medium", `WORKER_DEFAULTS.${name}.effort`);
    }
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

test("parseLabelsEntry treats unspecified and non-array values as empty", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseLabelsEntry(undefined), []);
  assert.deepEqual(parseLabelsEntry("cc-a"), []);
  assert.deepEqual(parseLabelsEntry({ a: 1 }), []);
});

test("parseLabelsEntry keeps only non-empty string entries", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseLabelsEntry(["cc-a", 1, null, "", " cc-b "]), ["cc-a", "cc-b"]);
});

test("parseWorkerFilesEntry keeps only non-empty string entries and ignores non-arrays", (t) => {
  silenceWarn(t);
  assert.deepEqual(parseWorkerFilesEntry(["a.ts", 1, "", " b.ts "]), ["a.ts", "b.ts"]);
  assert.deepEqual(parseWorkerFilesEntry("a.ts"), []);
  assert.deepEqual(parseWorkerFilesEntry(undefined), []);
});

test("resolveWorkerFilePath resolves absolute, home-relative and config-relative entries", () => {
  assert.equal(resolveWorkerFilePath("/abs/w.ts", "/cfg", "/home/u"), "/abs/w.ts");
  assert.equal(resolveWorkerFilePath("~/w/a.ts", "/cfg", "/home/u"), "/home/u/w/a.ts");
  assert.equal(resolveWorkerFilePath("~", "/cfg", "/home/u"), "/home/u");
  assert.equal(resolveWorkerFilePath("workers/a.ts", "/cfg", "/home/u"), "/cfg/workers/a.ts");
  assert.equal(resolveWorkerFilePath("../a.ts", "/cfg/sub", "/home/u"), "/cfg/a.ts");
});

test("loadConfig reads workerFiles, with the local file replacing the array", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-workerfiles-"));
  writeFileSync(join(dir, "claude-task-worker.json"), JSON.stringify({ workerFiles: ["a.ts", "b.ts"] }));
  writeFileSync(join(dir, "claude-task-worker.local.json"), JSON.stringify({ workerFiles: ["c.ts"] }));
  const configUrl = pathToFileURL(resolve("src/config.ts")).href;
  const script = `const m = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(m.loadConfig().workerFiles));`;
  const out = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(resolve("scripts/test-resolver.mjs")).href,
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: dir, encoding: "utf-8" },
  );
  assert.deepEqual(JSON.parse(out.trim().split("\n").at(-1) as string), ["c.ts"]);
});

test("mergeConfigRaw lets a local labels array replace the base one wholesale", () => {
  assert.deepEqual(mergeConfigRaw({ labels: ["a", "b"] }, { labels: ["c"] }), { labels: ["c"] });
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

test("parseWorkerEntry warns and ignores a legacy cloud key (moved to the --cloud runtime flag)", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const result = parseWorkerEntry("exec-issue", { cloud: true });
  assert.ok(result);
  assert.ok(!("cloud" in result), "cloud はもう WorkerRuntimeConfig に含まれてはいけない");
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0]?.arguments[0]), /workers\.exec-issue\.cloud is removed/);
});

test("checkCloudConfig returns nothing when cloud is false", () => {
  assert.deepEqual(checkCloudConfig({ cloud: false }), []);
});

test("checkCloudConfig allows cloud: true regardless of mode (mode is no longer a field)", () => {
  assert.deepEqual(checkCloudConfig({ cloud: true }), []);
});

test("checkCloudConfig rejects cloud: true when scriptAvailable is false", () => {
  const errors = checkCloudConfig({ cloud: true, scriptAvailable: false });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--cloud/);
  assert.match(errors[0], /script/);
});

test("checkCloudConfig allows cloud: true when scriptAvailable is true", () => {
  assert.deepEqual(checkCloudConfig({ cloud: true, scriptAvailable: true }), []);
});

test("checkCloudConfig does not inspect scriptAvailable when cloud is false", () => {
  assert.deepEqual(checkCloudConfig({ cloud: false, scriptAvailable: false }), []);
});

test("checkCloudConfig does not inspect auth when cloud is false", () => {
  const errors = checkCloudConfig({
    cloud: false,
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

// 許可リストは撤去済み（定期ワーカーは実行記録PRを cc-cloud-done の置き先に使い、
// create-ui-design には worktree ガードの免除指示が届くようになったため）。--cloud を
// 付けたプロセスでは全ワーカーがクラウド実行になる。
test("isCloudWorker returns true for every worker when --cloud is passed", (t) => {
  const originalArgv = process.argv;
  t.after(() => {
    process.argv = originalArgv;
    resetCloudFlagCache();
  });
  process.argv = [...originalArgv, "--cloud"];
  resetCloudFlagCache();

  for (const name of Object.keys(WORKER_DEFAULTS)) {
    assert.equal(isCloudWorker(name), true, `isCloudWorker(${name}) under --cloud`);
  }
  for (const name of SCHEDULED_WORKER_NAMES) {
    assert.equal(isCloudWorker(name), true, `isCloudWorker(${name}) under --cloud`);
  }
});

// M1: 通常のサインイン（旧 `docs/cloud-prerequisite-checks.md`（git 履歴） verbatim）
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

test("mergeConfigRaw lets the local file win on the same key", () => {
  const merged = mergeConfigRaw({ remoteEnvId: null, uiDesign: { enabled: false } }, { remoteEnvId: "env_local" });
  assert.deepEqual(merged, { remoteEnvId: "env_local", uiDesign: { enabled: false } });
});

test("mergeConfigRaw merges nested objects key by key instead of replacing them", () => {
  const merged = mergeConfigRaw(
    { workers: { "exec-issue": { model: "opus", effort: "high" }, "triage-pr": { model: "opus" } } },
    { workers: { "exec-issue": { model: "sonnet" } } },
  );
  assert.deepEqual(merged, {
    workers: { "exec-issue": { model: "sonnet", effort: "high" }, "triage-pr": { model: "opus" } },
  });
});

test("mergeConfigRaw replaces arrays and scalars wholesale and leaves the base untouched", () => {
  const base = { tags: ["a", "b"], uiDesign: { enabled: true } };
  const merged = mergeConfigRaw(base, { tags: ["c"], uiDesign: false });
  assert.deepEqual(merged, { tags: ["c"], uiDesign: false });
  assert.deepEqual(base, { tags: ["a", "b"], uiDesign: { enabled: true } });
});

test("mergeConfigRaw with appendArrays appends override arrays to the base without duplicates", () => {
  const base = { labels: ["cc-a"], workerFiles: ["/pack/w.ts"] };
  assert.deepEqual(mergeConfigRaw(base, { labels: [], workerFiles: ["w2.ts", "/pack/w.ts"], extra: ["x"] }, true), {
    labels: ["cc-a"],
    workerFiles: ["/pack/w.ts", "w2.ts"],
    extra: ["x"],
  });
  assert.deepEqual(mergeConfigRaw(base, { labels: [] }), { labels: [], workerFiles: ["/pack/w.ts"] });
});

test("parseWorkerEntry reads enabled and falls back to true on a non-boolean", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(parseWorkerEntry("exec-issue", {})?.enabled, true);
  assert.equal(parseWorkerEntry("exec-issue", { enabled: false })?.enabled, false);
  assert.equal(parseWorkerEntry("my-custom", { enabled: false })?.enabled, false);
  assert.equal(parseWorkerEntry("exec-issue", { enabled: "false" })?.enabled, true);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(
    String(warn.mock.calls[0].arguments[0]),
    /invalid workers\.exec-issue\.enabled: false, using default true/,
  );
});

test("partitionEnabledWorkers splits names by the predicate and keeps their order", () => {
  assert.deepEqual(
    partitionEnabledWorkers(["a", "b", "c", "d"], (n) => n !== "b" && n !== "d"),
    { enabled: ["a", "c"], disabled: ["b", "d"] },
  );
  assert.deepEqual(
    partitionEnabledWorkers(["a"], () => true),
    { enabled: ["a"], disabled: [] },
  );
});

test("disabledWorkerMessage tells how to re-enable the worker", () => {
  const msg = disabledWorkerMessage("exec-issue");
  assert.match(msg, /workers\.exec-issue\.enabled/);
  assert.match(msg, /set workers\.exec-issue\.enabled to true or remove the key/);
});

test("claude-task-worker.local.json can toggle workers.<name>.enabled over the base file", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-config-enabled-"));
  writeFileSync(
    join(dir, "claude-task-worker.json"),
    JSON.stringify({ workers: { "exec-issue": { model: "sonnet" }, "triage-pr": { enabled: false } } }),
  );
  writeFileSync(
    join(dir, "claude-task-worker.local.json"),
    JSON.stringify({ workers: { "exec-issue": { enabled: false }, "triage-pr": { enabled: true } } }),
  );
  const configUrl = pathToFileURL(resolve("src/config.ts")).href;
  const script = `const m = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ exec: m.getWorkerConfig("exec-issue"), triage: m.isWorkerEnabled("triage-pr"), other: m.isWorkerEnabled("fix-review-point") }));`;
  const out = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(resolve("scripts/test-resolver.mjs")).href,
      "--input-type=module",
      "-e",
      script,
    ],
    { cwd: dir, encoding: "utf-8" },
  );
  const { exec, triage, other } = JSON.parse(out.trim().split("\n").at(-1) as string);
  assert.equal(exec.enabled, false);
  assert.equal(exec.model, "sonnet");
  assert.equal(triage, true);
  assert.equal(other, true);
});

// cwd とコマンドライン引数を指定して、新しいプロセスで config.ts の式を評価する（引数・cwd はモジュールロード時に固定されるため）。
function evalConfigIn(cwd: string, expr: string, args: string[] = []): unknown {
  const configUrl = pathToFileURL(resolve("src/config.ts")).href;
  const script = `const m = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify(${expr}));`;
  const out = execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(resolve("scripts/test-resolver.mjs")).href,
      "--input-type=module",
      "-e",
      script,
      "--",
      ...args,
    ],
    { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return JSON.parse(out.trim().split("\n").at(-1) as string);
}

test("loadConfig without --inherit-config reads only the cwd files, unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-inherit-"));
  writeFileSync(join(dir, "claude-task-worker.json"), JSON.stringify({ uiDesign: { designDir: "designs/" } }));
  writeFileSync(join(dir, "claude-task-worker.local.json"), JSON.stringify({ remoteEnvId: "env_local" }));
  assert.deepEqual(evalConfigIn(dir, "[m.loadConfig().uiDesign.designDir, m.loadConfig().remoteEnvId]"), [
    "designs/",
    "env_local",
  ]);
});

test("loadConfig layers --inherit-config < cwd claude-task-worker.json < cwd local.json", () => {
  const base = mkdtempSync(join(tmpdir(), "ctw-inherit-base-"));
  const cwd = mkdtempSync(join(tmpdir(), "ctw-inherit-cwd-"));
  writeFileSync(
    join(base, "shared.json"),
    JSON.stringify({ remoteEnvId: "env_base", labels: ["base"], fixReviewPointCallbackCommentMessage: "base" }),
  );
  // --inherit-config の所在ディレクトリの local.json は読まない。
  writeFileSync(join(base, "claude-task-worker.local.json"), JSON.stringify({ labels: ["ignored"] }));
  writeFileSync(join(cwd, "claude-task-worker.json"), JSON.stringify({ remoteEnvId: "env_cwd", labels: ["cwd"] }));
  writeFileSync(join(cwd, "claude-task-worker.local.json"), JSON.stringify({ labels: ["local"] }));
  const out = evalConfigIn(
    cwd,
    "(c => [c.remoteEnvId, c.labels, c.fixReviewPointCallbackCommentMessage])(m.loadConfig())",
    ["--inherit-config", join(base, "shared.json")],
  );
  // 配列は cwd 側（local が cwd を置き換えた結果）を土台の後ろへ追記する。
  assert.deepEqual(out, ["env_cwd", ["base", "local"], "base"]);
});

test("loadConfig works from --inherit-config alone when the cwd has no config file", () => {
  const base = mkdtempSync(join(tmpdir(), "ctw-inherit-base-"));
  const cwd = mkdtempSync(join(tmpdir(), "ctw-inherit-cwd-"));
  writeFileSync(join(base, "shared.json"), JSON.stringify({ remoteEnvId: "env_base" }));
  assert.equal(
    evalConfigIn(cwd, "m.loadConfig().remoteEnvId", ["--inherit-config", join(base, "shared.json")]),
    "env_base",
  );
});

test("loadConfig rejects a missing --inherit-config file instead of falling back", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctw-inherit-cwd-"));
  const expr = "(() => { try { m.loadConfig(); return 'loaded'; } catch (e) { return e.message; } })()";
  assert.match(
    evalConfigIn(cwd, expr, ["--inherit-config", join(cwd, "missing.json")]) as string,
    /--inherit-config .*missing\.json does not exist/,
  );
});

test("getLastRunAt reads the cwd claude-task-worker.json regardless of --inherit-config", () => {
  const base = mkdtempSync(join(tmpdir(), "ctw-inherit-base-"));
  const cwd = mkdtempSync(join(tmpdir(), "ctw-inherit-cwd-"));
  writeFileSync(
    join(base, "shared.json"),
    JSON.stringify({ lastRun: { "update-design-md": "2026-01-01T00:00:00.000Z" } }),
  );
  writeFileSync(
    join(cwd, "claude-task-worker.json"),
    JSON.stringify({ lastRun: { "update-coding-guidelines": "2026-08-17T09:00:00.000Z" } }),
  );
  const out = evalConfigIn(
    cwd,
    "[m.getLastRunAt('update-coding-guidelines'), m.getLastRunAt('update-design-md') ?? null]",
    ["--inherit-config", join(base, "shared.json")],
  );
  assert.deepEqual(out, [Date.parse("2026-08-17T09:00:00.000Z"), null]);
});

test("init's seedCwdLastRun fills only missing cwd lastRun entries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctw-inherit-cwd-"));
  writeFileSync(
    join(cwd, "claude-task-worker.json"),
    JSON.stringify({ labels: ["keep"], lastRun: { "update-coding-guidelines": "2026-08-17T09:00:00.000Z" } }),
  );
  const initUrl = pathToFileURL(resolve("src/commands/init.ts")).href;
  execFileSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(resolve("scripts/test-resolver.mjs")).href,
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(initUrl)}); m.seedCwdLastRun(new Date("2026-10-04T00:00:00.000Z"));`,
    ],
    { cwd, stdio: "ignore" },
  );
  const written = JSON.parse(readFileSync(join(cwd, "claude-task-worker.json"), "utf-8"));
  assert.deepEqual(written.labels, ["keep"]);
  assert.equal(written.lastRun["update-coding-guidelines"], "2026-08-17T09:00:00.000Z");
  assert.equal(written.lastRun["update-requirement-rules"], "2026-10-04T00:00:00.000Z");
  assert.equal(written.lastRun["update-design-md"], "2026-10-04T00:00:00.000Z");
});

test("resolveInheritedRelativePaths resolves designDir from the config file's directory, relative to the repo", () => {
  assert.deepEqual(resolveInheritedRelativePaths({ uiDesign: { designDir: "designs" } }, "/repo/conf", "/repo"), {
    uiDesign: { designDir: join("conf", "designs") },
  });
  assert.deepEqual(resolveInheritedRelativePaths({ uiDesign: { designDir: ".." } }, "/repo/conf", "/repo"), {
    uiDesign: { designDir: "." },
  });
});

test("resolveInheritedRelativePaths leaves a designDir outside the repo for parseUiDesignEntry to reject", (t) => {
  silenceWarn(t);
  const raw = resolveInheritedRelativePaths({ uiDesign: { designDir: "designs" } }, "/elsewhere", "/repo");
  assert.equal(parseUiDesignEntry(raw["uiDesign"]).designDir, DEFAULT_UI_DESIGN_CONFIG.designDir);
});

test("resolveInheritedRelativePaths makes relative workerFiles absolute and keeps ~ and absolute entries", () => {
  assert.deepEqual(
    resolveInheritedRelativePaths({ workerFiles: ["w/a.ts", "~/b.ts", "/abs/c.ts"] }, "/conf", "/repo"),
    { workerFiles: [resolve("/conf", "w/a.ts"), "~/b.ts", "/abs/c.ts"] },
  );
});
