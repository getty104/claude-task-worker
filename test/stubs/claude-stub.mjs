/* global process */
// `claude` の代わりに起動されるスタブ。起動引数・cwd・env を記録し、既定で非空の
// stdout を返す（buildTaskResult は「exit 0 かつ stdout 空」を失敗扱いにするため）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const recordFile = process.env.CTW_STUB_RECORD_FILE;
if (recordFile) {
  const record = {
    command: "claude",
    argv,
    cwd: process.cwd(),
    env: { ...process.env },
  };
  appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
}

// クラウドセッションの投函コマンド（`claude -p --cloud <sessionId> <prompt>`）として
// 起動された場合、appendCloudDoneInstruction() がセッションへ指示する最後の2操作
// （報告コメント投稿 → cc-cloud-done 付与）を gh-stub.mjs の状態ファイルへ直接模倣する。
// gh-stub.mjs と import し合うと installCliStubs() のラッパー構成が複雑になるため、
// read/write の重複はここでは許容する。
const isCloudDispatch = argv[0] === "-p" && argv[1] === "--cloud";
const cloudCompleteRaw = process.env.CTW_STUB_CLAUDE_CLOUD_COMPLETE;
if (isCloudDispatch && cloudCompleteRaw && recordFile) {
  const { type, number, report } = JSON.parse(cloudCompleteRaw);
  const stateFile = `${recordFile}.gh-state.json`;
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { labels: {}, comments: {} };
  const key = `${type}:${number}`;
  if (report) {
    const comments = state.comments?.[number] ?? [];
    comments.push({ body: report, created_at: new Date().toISOString() });
    state.comments = { ...state.comments, [number]: comments };
  }
  const labels = new Set(state.labels?.[key] ?? []);
  labels.add("cc-cloud-done");
  state.labels = { ...state.labels, [key]: [...labels] };
  writeFileSync(stateFile, JSON.stringify(state));
}

// クラウド起動前チェック（checkCloudAuth）が失敗するとワーカーが落ちるため、
// 通常の stdout/exitCode 制御より先に判定する。
if (argv[0] === "auth" && argv[1] === "status" && argv[2] === "--json") {
  const authStatus =
    process.env.CTW_STUB_CLAUDE_AUTH_STATUS ??
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
  process.stdout.write(authStatus.endsWith("\n") ? authStatus : `${authStatus}\n`);
  process.exit(0);
}

const stdout = process.env.CTW_STUB_CLAUDE_STDOUT ?? "[stub] claude report";
process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);

const stderr = process.env.CTW_STUB_CLAUDE_STDERR;
if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);

process.exit(Number(process.env.CTW_STUB_CLAUDE_EXIT_CODE ?? "0"));
