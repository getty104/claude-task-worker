const PROJECT_INCOMPATIBLE_COMMANDS = ["init", "install", "update", "usage", "version"];

function collectFlagValues(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const raw = argv[i + 1];
    if (!raw || raw.startsWith("--")) {
      console.error(`${flag} requires a value`);
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
  if (PROJECT_INCOMPATIBLE_COMMANDS.includes(command)) {
    console.error(`--project cannot be used with the "${command}" command`);
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
