/* global process */
// `claude` の代わりに起動されるスタブ。起動引数・cwd・env を記録し、既定で非空の
// stdout を返す（buildTaskResult は「exit 0 かつ stdout 空」を失敗扱いにするため）。
import { appendFileSync } from "node:fs";

const recordFile = process.env.CTW_STUB_RECORD_FILE;
if (recordFile) {
  const record = {
    command: "claude",
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: { ...process.env },
  };
  appendFileSync(recordFile, `${JSON.stringify(record)}\n`);
}

const stdout = process.env.CTW_STUB_CLAUDE_STDOUT ?? "[stub] claude report";
process.stdout.write(stdout.endsWith("\n") ? stdout : `${stdout}\n`);

const stderr = process.env.CTW_STUB_CLAUDE_STDERR;
if (stderr) process.stderr.write(stderr.endsWith("\n") ? stderr : `${stderr}\n`);

process.exit(Number(process.env.CTW_STUB_CLAUDE_EXIT_CODE ?? "0"));
