import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, isRecord } from "./block-async-execution.mjs";

const bash = (command, extra = {}) => ({ tool_name: "Bash", tool_input: { command, ...extra } });

test("isRecord distinguishes plain objects from null/arrays/primitives", () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord({ a: 1 }), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord("x"), false);
  assert.equal(isRecord(42), false);
  assert.equal(isRecord(undefined), false);
});

test("malformed / non-record payloads fail open (allow)", () => {
  // JSON.parse("null") yields null — previously crashed on payload.tool_name.
  assert.equal(evaluate(null).deny, false);
  assert.equal(evaluate(undefined).deny, false);
  assert.equal(evaluate("null").deny, false);
  assert.equal(evaluate(42).deny, false);
  assert.equal(evaluate([]).deny, false);
});

test("tool_input that is null / non-object does not throw and allows", () => {
  assert.equal(evaluate({ tool_name: "Bash", tool_input: null }).deny, false);
  assert.equal(evaluate({ tool_name: "Bash", tool_input: "oops" }).deny, false);
  assert.equal(evaluate({ tool_name: "Bash" }).deny, false);
});

test("Monitor and ScheduleWakeup are denied", () => {
  assert.equal(evaluate({ tool_name: "Monitor", tool_input: { command: "x" } }).deny, true);
  assert.equal(evaluate({ tool_name: "ScheduleWakeup", tool_input: {} }).deny, true);
});

test("Agent must explicitly set run_in_background: false", () => {
  assert.equal(evaluate({ tool_name: "Agent", tool_input: { run_in_background: false } }).deny, false);
  assert.equal(evaluate({ tool_name: "Agent", tool_input: { run_in_background: true } }).deny, true);
  // Omitted flag defaults to background -> deny.
  assert.equal(evaluate({ tool_name: "Agent", tool_input: { prompt: "x" } }).deny, true);
});

test("Bash foreground commands are allowed", () => {
  assert.equal(evaluate(bash("npm test")).deny, false);
  assert.equal(evaluate(bash("npm run build && npm run lint")).deny, false);
  assert.equal(evaluate(bash("npm test 2>&1 | tee log")).deny, false);
  assert.equal(evaluate(bash("foo &>/dev/null")).deny, false);
  assert.equal(evaluate(bash("foo >&2")).deny, false);
  assert.equal(evaluate(bash("cmd |& other")).deny, false);
  assert.equal(evaluate(bash('curl "http://x?a=1&b=2"')).deny, false);
});

test("Bash run_in_background: true is denied", () => {
  assert.equal(evaluate(bash("sleep 20", { run_in_background: true })).deny, true);
});

test("Bash backgrounding via & is denied, including mid-command and multi-line", () => {
  assert.equal(evaluate(bash("npm run dev &")).deny, true);
  assert.equal(evaluate(bash("long-task & echo done")).deny, true);
  assert.equal(evaluate(bash("sleep 100 &\necho done")).deny, true);
  assert.equal(evaluate(bash("npm run dev & ; echo hi")).deny, true);
});

test("Bash detach keywords are denied only at command start", () => {
  assert.equal(evaluate(bash("nohup npm start")).deny, true);
  assert.equal(evaluate(bash("disown")).deny, true);
  assert.equal(evaluate(bash("foo; setsid bar")).deny, true);
  assert.equal(evaluate(bash("foo && nohup bar")).deny, true);
});

test("detach keywords inside arguments or quotes are NOT false-positives", () => {
  assert.equal(evaluate(bash("cat nohup.log")).deny, false);
  assert.equal(evaluate(bash('echo "please dont nohup this"')).deny, false);
  assert.equal(evaluate(bash("grep setsid src/foo.ts")).deny, false);
});

test("unrelated tools (e.g. TaskCreate) are allowed", () => {
  assert.equal(evaluate({ tool_name: "TaskCreate", tool_input: { subject: "x", description: "y" } }).deny, false);
});
