// --project と --cloud のどちらも「ワーカー起動」を前提とするフラグのため、
// 非互換コマンド集合は共有する。
const FLAG_INCOMPATIBLE_COMMANDS = ["init", "install", "update", "cloud-setup", "usage", "version"];

function collectFlagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const raw = argv[i + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(`[dispatcher] ${flag} requires a value`);
      process.exit(1);
    }
    values.push(raw);
  }
  return values;
}

export function parseProjectFilters(): string[] {
  return collectFlagValues(process.argv, "--project");
}

export function hasProjectFilter(): boolean {
  return process.argv.includes("--project");
}

export function assertProjectCompatibleCommand(command: string): void {
  if (FLAG_INCOMPATIBLE_COMMANDS.includes(command)) {
    console.error(`[dispatcher] --project cannot be used with the "${command}" command`);
    process.exit(1);
  }
}

// --cloud はプロセス起動時に確定させる。実行中に argv が変わることは無いが、
// getRunMode() / isAdvisorEnabled() と同じくキャッシュして解決経路を一本化する。
let cachedCloudFlag: boolean | undefined;

export function hasCloudFlag(): boolean {
  if (cachedCloudFlag === undefined) {
    cachedCloudFlag = process.argv.includes("--cloud");
  }
  return cachedCloudFlag;
}

// テスト用。キャッシュを未解決へ戻す。
export function resetCloudFlagCache(): void {
  cachedCloudFlag = undefined;
}

export function assertCloudCompatibleCommand(command: string): void {
  if (FLAG_INCOMPATIBLE_COMMANDS.includes(command)) {
    console.error(`[worker] --cloud cannot be used with the "${command}" command`);
    process.exit(1);
  }
}

export function shellQuote(value: string): string {
  if (value === "") return "''";
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildForwardedCommand(argv: string[]): string {
  const tokens: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") {
      i++;
      continue;
    }
    tokens.push(argv[i]);
  }
  return ["claude-task-worker", ...tokens.map(shellQuote)].join(" ");
}
