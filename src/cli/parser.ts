export interface ParsedCommand {
  name: string;
  positionals: string[];
  options: Map<string, string | true>;
}

const BOOLEAN_FLAGS = new Set([
  "all",
  "copy",
  "events",
  "explain",
  "follow",
  "force",
  "force-new",
  "help",
  "interrupt",
  "json",
  "link",
  "operator-requested",
  "park",
  "print",
  "project",
  "quiet",
  "room",
  "shared",
  "stdin",
  "text",
  "user",
  "verbose",
  "wait"
]);

export function parseCommand(argv: string[]): ParsedCommand {
  let name = "";
  const options = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "-h") {
      options.set("help", true);
      continue;
    }

    if (!name && token.startsWith("--")) {
      index = consumeLongOption(argv, index, options);
      continue;
    }

    if (!name) {
      name = token;
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    index = consumeLongOption(argv, index, options);
  }

  return { name, positionals, options };
}

function consumeLongOption(
  argv: string[],
  index: number,
  options: Map<string, string | true>
): number {
  const token = argv[index];
  const key = token.slice(2);
  if (BOOLEAN_FLAGS.has(key)) {
    options.set(key, true);
    return index;
  }

  const next = argv[index + 1];
  if (!next || next === "-h" || next.startsWith("--")) {
    options.set(key, true);
    return index;
  }

  options.set(key, next);
  return index + 1;
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

export function parseOptionalInteger(
  parsed: ParsedCommand,
  key: string
): number | undefined {
  const value = getStringOption(parsed, key);
  if (!value) {
    return undefined;
  }

  if (!/^\d+$/.test(value)) {
    throw new Error(`--${key} must be an integer.`);
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
