import { spawn } from "node:child_process";

const running = new Set<number>();

export function isRunning(id: number): boolean {
  return running.has(id);
}

export function run(command: string, args: string[], id: number): void {
  running.add(id);

  const child = spawn(command, args, { stdio: "inherit" });

  child.on("close", (code) => {
    running.delete(id);
    if (code !== 0) {
      console.error(`[worker] process for #${id} exited with code ${code}`);
    }
  });

  child.on("error", (err) => {
    running.delete(id);
    console.error(`[worker] failed to spawn process for #${id}: ${err.message}`);
  });
}
