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
  // クラウド実行（1コマンド方式）の作成コマンド（`claude --cloud <prompt> ...`）は、
  // claude バイナリを実起動せずこの pane send-text でターミナル文字列として送出される
  // だけなので、appendCloudDoneInstruction() がセッションへ指示する最後の2操作
  // （報告コメント投稿 → cc-cloud-done 付与）をここで gh-stub.mjs の状態ファイルへ
  // 直接模倣する（旧実装は claude-stub.mjs の投函コマンド起動時に行っていた）。
  // gh-stub.mjs と import し合うと installCliStubs() のラッパー構成が複雑になるため、
  // read/write の重複はここでは許容する。
  if (action === "send-text") {
    const text = rest[1] ?? "";
    const cloudCompleteRaw = process.env.CTW_STUB_CLAUDE_CLOUD_COMPLETE;
    if (cloudCompleteRaw && text.includes("'--cloud'") && recordFile) {
      const { type, number, report } = JSON.parse(cloudCompleteRaw);
      const ghStateFile = `${recordFile}.gh-state.json`;
      const ghState = existsSync(ghStateFile)
        ? JSON.parse(readFileSync(ghStateFile, "utf8"))
        : { labels: {}, comments: {} };
      const key = `${type}:${number}`;
      if (report) {
        const comments = ghState.comments?.[number] ?? [];
        comments.push({ body: report, created_at: new Date().toISOString() });
        ghState.comments = { ...ghState.comments, [number]: comments };
      }
      const labels = new Set(ghState.labels?.[key] ?? []);
      labels.add("cc-cloud-done");
      ghState.labels = { ...ghState.labels, [key]: [...labels] };
      writeFileSync(ghStateFile, JSON.stringify(ghState));
    }
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
