/* global process */
// `claude` の代わりに起動されるスタブ。起動引数・cwd・env を記録し、既定で非空の
// stdout を返す（buildTaskResult は「exit 0 かつ stdout 空」を失敗扱いにするため）。
import { appendFileSync } from "node:fs";

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

const stdout = process.env.CTW_STUB_CLAUDE_STDOUT ?? "[stub] claude report";
process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);

const stderr = process.env.CTW_STUB_CLAUDE_STDERR;
if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);

process.exit(Number(process.env.CTW_STUB_CLAUDE_EXIT_CODE ?? "0"));
