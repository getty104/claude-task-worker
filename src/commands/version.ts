import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function version(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    console.log(pkg.version ?? "unknown");
  } catch (err) {
    console.error(`[version] Failed to read version: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
