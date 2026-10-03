import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type * as ConfigModule from "./config";

const { WORKER_DEFAULTS, DEFAULT_WORKER_CONFIG, parseWorkerEntry } = (await import("./config")) as typeof ConfigModule;

// 本番定数を参照せず複製したリテラルで固定する。本番値が変わったらここが落ちる。
function preset(skill: string, model: string, effort: string, pollingIntervalSeconds: number) {
  return {
    skill,
    model,
    advisorModel: "",
    effort,
    pollingIntervalSeconds,
    cooldownSeconds: 0,
    maxConcurrentTasks: 1,
    enabled: true,
  };
}

const EXPECTED_WORKER_DEFAULTS = {
  "answer-issue-questions": preset("/claude-task-worker:answer-issue-questions", "opus", "high", 60),
  "create-issue": preset("/claude-task-worker:create-issue-from-issue-number", "opus", "high", 60),
  "update-issue": preset("/claude-task-worker:update-issue", "sonnet", "high", 60),
  "exec-issue": preset("/claude-task-worker:exec-issue", "opus", "high", 60),
  "fix-review-point": preset("/claude-task-worker:fix-review-point", "opus", "high", 60),
  "triage-created-issue": preset("/claude-task-worker:triage-created-issue", "sonnet", "high", 60),
  "triage-pr": preset("/claude-task-worker:triage-pr", "opus", "high", 60),
  "resolve-conflict": preset("/claude-task-worker:resolve-pr-conflict", "sonnet", "high", 60),
  "check-dependabot": preset("/claude-task-worker:check-dependabot", "sonnet", "high", 3600),
  "epic-issue": preset("/claude-task-worker:create-epic-pr", "sonnet", "medium", 300),
  "create-ui-design": preset("/claude-task-worker:create-ui-design", "opus", "high", 60),
  "apply-ui-design": preset("/claude-task-worker:apply-ui-design", "sonnet", "medium", 300),
  "update-coding-guidelines": preset("/claude-task-worker:update-coding-guidelines", "opus", "high", 3600),
  "update-requirement-rules": preset("/claude-task-worker:update-requirement-rules", "opus", "high", 3600),
  "update-design-md": preset("/claude-task-worker:update-design-md", "opus", "high", 3600),
};

const EXPECTED_DEFAULT_WORKER_CONFIG = preset("", "opus", "high", 60);

const EXPECTED_DEFAULT_CONFIG = {
  fixReviewPointCallbackCommentMessage: "",
  remoteEnvId: null,
  labels: [],
  workerFiles: [],
  uiDesign: { enabled: false, designDir: "designs", yolo: false },
  lastRun: {},
  workers: {},
};

const PRESET_NAMES = [
  "answer-issue-questions",
  "apply-ui-design",
  "check-dependabot",
  "create-issue",
  "create-ui-design",
  "epic-issue",
  "exec-issue",
  "fix-review-point",
  "resolve-conflict",
  "triage-created-issue",
  "triage-pr",
  "update-coding-guidelines",
  "update-design-md",
  "update-issue",
  "update-requirement-rules",
] as const;

test("WORKER_DEFAULTS and DEFAULT_WORKER_CONFIG are pinned", () => {
  assert.deepEqual(Object.keys(WORKER_DEFAULTS).sort(), [...PRESET_NAMES]);
  assert.deepEqual(WORKER_DEFAULTS, EXPECTED_WORKER_DEFAULTS);
  assert.deepEqual(DEFAULT_WORKER_CONFIG, EXPECTED_DEFAULT_WORKER_CONFIG);
});

test("parseWorkerEntry output is pinned for every preset", (t: TestContext) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const name of PRESET_NAMES) {
    const expected = EXPECTED_WORKER_DEFAULTS[name];
    assert.deepEqual(parseWorkerEntry(name, {}), expected, `${name} {}`);
    assert.deepEqual(parseWorkerEntry(name, { model: "x" }), { ...expected, model: "x" }, `${name} model`);
    assert.deepEqual(parseWorkerEntry(name, { enabled: true }), expected, `${name} enabled:true`);
    assert.deepEqual(
      parseWorkerEntry(name, { enabled: false }),
      { ...expected, enabled: false },
      `${name} enabled:false`,
    );
  }
  assert.equal(warn.mock.callCount(), 0);
});

test("loadConfig() with an empty claude-task-worker.json equals DEFAULT_CONFIG", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctw-config-invariant-"));
  writeFileSync(join(dir, "claude-task-worker.json"), "{}");
  const configUrl = pathToFileURL(resolve("src/config.ts")).href;
  const script = `const m = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify({ loaded: m.loadConfig(), def: m.DEFAULT_CONFIG }));`;
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
  const { loaded, def } = JSON.parse(out.trim().split("\n").at(-1) as string);
  assert.deepEqual(loaded, EXPECTED_DEFAULT_CONFIG);
  assert.deepEqual(loaded, def);
});
