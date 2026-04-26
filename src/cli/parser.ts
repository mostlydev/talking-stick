export interface ParsedCommand {
  name: string;
  positionals: string[];
  options: Map<string, string | true>;
}

export function parseCommand(argv: string[]): ParsedCommand {
  const [name = "", ...rest] = argv;
  const options = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith("--")) {
      options.set(key, true);
      continue;
    }

    options.set(key, next);
    index += 1;
  }

  return { name, positionals, options };
}

export function hasOption(parsed: ParsedCommand, key: string): boolean {
  return parsed.options.has(key);
}

export function getStringOption(
  parsed: ParsedCommand,
  key: string
): string | undefined {
  const value = parsed.options.get(key);
  return typeof value === "string" ? value : undefined;
}

export function requireStringOption(
  parsed: ParsedCommand,
  key: string
): string {
  const value = getStringOption(parsed, key);
  if (!value) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

export function normalizeBooleanFlag(
  parsed: ParsedCommand,
  key: string
): void {
  const value = parsed.options.get(key);
  if (typeof value === "string") {
    parsed.positionals.unshift(value);
    parsed.options.set(key, true);
  }
}

export function parseOptionalInteger(
  parsed: ParsedCommand,
  key: string
): number | undefined {
  const value = getStringOption(parsed, key);
  if (!value) {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`--${key} must be an integer.`);
  }
  return parsedValue;
}

export function parseRequiredInteger(
  parsed: ParsedCommand,
  key: string
): number {
  const value = parseOptionalInteger(parsed, key);
  if (value === undefined) {
    throw new Error(`Missing required option --${key}`);
  }
  return value;
}

export function parseWaitTimeout(parsed: ParsedCommand): number | undefined {
  const value = getStringOption(parsed, "timeout");
  if (!value) {
    return undefined;
  }
  return parseDurationMs(value);
}

export function parseDurationMs(value: string): number {
  if (/^\d+$/.test(value)) {
    return Number.parseInt(value, 10) * 1000;
  }

  const match = value.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) {
    throw new Error("Timeout values must be bare seconds or use ms/s/m/h suffixes.");
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2];
  switch (unit) {
    case "ms":
      return amount;
    case "s":
      return amount * 1000;
    case "m":
      return amount * 60 * 1000;
    case "h":
      return amount * 60 * 60 * 1000;
    default:
      throw new Error(`Unsupported duration unit: ${unit}`);
  }
}
