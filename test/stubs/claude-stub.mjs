/* global process */
// `claude` の代わりに起動されるスタブ。起動引数・cwd・env を記録し、既定で非空の
// stdout を返す（buildTaskResult は「exit 0 かつ stdout 空」を失敗扱いにするため）。
//
// クラウド実行（1コマンド方式）ではこのバイナリが script(1) 経由で直接起動される。
// セッション作成コマンドの stdout は CTW_STUB_CLAUDE_CLOUD_OUTPUT で差し替えられ、
// 実際のクラウドセッションが最後の操作として行う報告コメント投稿・cc-cloud-done 付与は
// CTW_STUB_CLAUDE_CLOUD_COMPLETE の指定時にここで gh-stub.mjs の状態ファイルへ模倣する。
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

// クラウド起動前チェック（checkCloudAuth）が失敗するとワーカーが落ちるため、
// 通常の stdout/exitCode 制御より先に判定する。
if (argv[0] === "auth" && argv[1] === "status" && argv[2] === "--json") {
  const authStatus =
    process.env.CTW_STUB_CLAUDE_AUTH_STATUS ??
    JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" });
  process.stdout.write(authStatus.endsWith("\n") ? authStatus : `${authStatus}\n`);
  process.exit(0);
}

// クラウドセッション作成コマンド（`claude --cloud <prompt> ...`）。実バイナリはセッションを
// 作って即 exit するため、セッションIDを含む起動出力だけを再現する。
if (argv.includes("--cloud")) {
  const cloudCompleteRaw = process.env.CTW_STUB_CLAUDE_CLOUD_COMPLETE;
  if (cloudCompleteRaw && recordFile) {
    const { type, number, report } = JSON.parse(cloudCompleteRaw);
    const ghStateFile = `${recordFile}.gh-state.json`;
    const ghState = existsSync(ghStateFile) ? JSON.parse(readFileSync(ghStateFile, "utf8")) : { labels: {}, comments: {} };
    if (report) {
      const comments = ghState.comments?.[number] ?? [];
      comments.push({ body: report, created_at: new Date().toISOString() });
      ghState.comments = { ...ghState.comments, [number]: comments };
    }
    const key = `${type}:${number}`;
    const labels = new Set(ghState.labels?.[key] ?? []);
    labels.add("cc-cloud-done");
    ghState.labels = { ...ghState.labels, [key]: [...labels] };
    writeFileSync(ghStateFile, JSON.stringify(ghState));
  }
  const cloudOutput = process.env.CTW_STUB_CLAUDE_CLOUD_OUTPUT ?? "";
  if (cloudOutput) process.stdout.write(cloudOutput.endsWith("\n") ? cloudOutput : `${cloudOutput}\n`);
  process.exit(0);
}

const stdout = process.env.CTW_STUB_CLAUDE_STDOUT ?? "[stub] claude report";
process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);

const stderr = process.env.CTW_STUB_CLAUDE_STDERR;
if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);

process.exit(Number(process.env.CTW_STUB_CLAUDE_EXIT_CODE ?? "0"));
