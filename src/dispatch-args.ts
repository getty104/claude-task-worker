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

// --debug はクラウド実行のデバッグ用フラグ。用途は「クラウドセッションの最終報告を
// Issue/PR コメントとして残すか」で、既定では残さない（通常運用は Slack 通知で足りる一方、
// Issue/PR がワーカーの実行ログで埋まるため）。--cloud と同じくプロセス起動時に確定させる。
let cachedDebugFlag: boolean | undefined;

export function hasDebugFlag(): boolean {
  if (cachedDebugFlag === undefined) {
    cachedDebugFlag = process.argv.includes("--debug");
  }
  return cachedDebugFlag;
}

// テスト用。キャッシュを未解決へ戻す。
export function resetDebugFlagCache(): void {
  cachedDebugFlag = undefined;
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
