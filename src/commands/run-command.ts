import { spawn } from "node:child_process";

/**
 * `npm install -g <pkg>@latest`。
 *
 * `--prefer-online` は必須。registry.npmjs.org の packument は `cache-control: max-age=300` を
 * 返すため、npm は直近5分以内に取得済みのメタデータを再検証せずに使う。publish 直後に update すると
 * `@latest` が旧バージョンのまま解決され、「更新したのに上がらない」状態になる
 * （version.ts の更新通知は別URL `/<pkg>/latest` を叩くため先に新版を検知でき、案内と実際が食い違う）。
 */
export function npmInstallGlobalLatest(pkg: string): Promise<void> {
  return runCommand("npm", ["install", "-g", `${pkg}@latest`, "--prefer-online"]);
}

export function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    const forwardSignal = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    const onSigint = () => forwardSignal("SIGINT");
    const onSigterm = () => forwardSignal("SIGTERM");

    const cleanup = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
      }
    });
  });
}
