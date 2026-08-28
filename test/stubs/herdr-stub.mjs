/* global process */
// `herdr` の代わりに起動されるスタブ。src/herdr.ts が解釈するエンベロープ形状
// （snake_case キー・`pane read` のみ生テキスト応答）を再現する。
//
// herdr サブコマンドは1回ごとに別プロセスで実行されるため、`agent get` のシナリオ
// 消費位置と ctrl-c による停止フラグは記録ファイルと同じディレクトリの状態ファイルへ
// 永続化する（プロセスメモリには残せない）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const recordFile = process.env.CTW_STUB_RECORD_FILE;

if (recordFile) {
  const record = { command: "herdr", argv, cwd: process.cwd(), env: { ...process.env } };
  appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
}

const stateFile = recordFile ? `${recordFile}.state.json` : undefined;

function readState() {
  if (!stateFile || !existsSync(stateFile)) return { statusIndex: 0, stopped: false };
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { statusIndex: 0, stopped: false };
  }
}

function writeState(state) {
  if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
}

function argAfter(args, flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function ok(result) {
  process.stdout.write(JSON.stringify({ result }));
}

function fail(code, message) {
  process.stdout.write(JSON.stringify({ error: { code, message } }));
}

const [sub, action, ...rest] = argv;

if (sub === "tab" && action === "create") {
  ok({ tab: { tab_id: `stub-tab-${randomUUID()}` }, root_pane: { pane_id: `stub-pane-${randomUUID()}` } });
} else if (sub === "tab" && action === "close") {
  ok({});
} else if (sub === "tab" && action === "list") {
  ok({ tabs: [] });
} else if (sub === "agent" && action === "start") {
  const paneId = argAfter(rest, "--pane") ?? "";
  ok({
    agent: {
      pane_id: paneId,
      tab_id: `stub-tab-for-${paneId}`,
      workspace_id: "stub-workspace",
      agent_status: "idle",
      agent_session: { kind: "id", value: "stub-session-id" },
    },
  });
} else if (sub === "agent" && action === "prompt") {
  // fire-and-forget: 空 stdout / stderr のまま終了
} else if (sub === "agent" && action === "get") {
  const paneId = rest[0] ?? "";
  const state = readState();
  if (state.stopped) {
    fail("agent_not_found", `agent not found in pane ${paneId} (stopped)`);
  } else {
    const statuses = (process.env.CTW_STUB_HERDR_AGENT_STATUSES ?? "done")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    const index = Math.min(state.statusIndex, statuses.length - 1);
    const status = statuses[index] ?? "done";
    if (state.statusIndex < statuses.length - 1) {
      writeState({ ...state, statusIndex: state.statusIndex + 1 });
    }
    ok({
      agent: {
        pane_id: paneId,
        tab_id: `stub-tab-for-${paneId}`,
        workspace_id: "stub-workspace",
        agent_status: status,
        agent_session: { kind: "id", value: "stub-session-id" },
      },
    });
  }
} else if (sub === "pane" && action === "read") {
  // `pane read` だけ JSON エンベロープではなく生テキストを返す（src/herdr.ts の paneRead 参照）。
  const output = process.env.CTW_STUB_HERDR_PANE_OUTPUT ?? "[stub] pane output";
  process.stdout.write(output);
} else if (sub === "pane" && (action === "send-keys" || action === "send-text")) {
  if (action === "send-keys" && rest.includes("ctrl+c")) {
    writeState({ ...readState(), stopped: true });
  }
  // fire-and-forget: 空 stdout / stderr
} else if (sub === "pane" && action === "get") {
  const paneId = rest[0] ?? "";
  ok({ pane: { pane_id: paneId, tab_id: `stub-tab-for-${paneId}` } });
} else if (sub === "pane" && action === "process-info") {
  ok({ process_info: { foreground_processes: [] } });
} else if (sub === "workspace" && action === "list") {
  ok({ workspaces: [] });
} else {
  fail("unknown_command", `unknown command: ${argv.join(" ")}`);
}

process.exit(0);
