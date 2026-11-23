// Light markdown-aware styling for chat message bodies. Agents write
// markdown-ish text; giving code, emphasis, references, and structure their own
// intensity and hue makes a dense transcript scannable. Input must already be
// sanitized: this module only adds SGR codes and never changes the text, so
// copying from the terminal returns the original message.

import { agentStyle, themeStyle, type ChatColorMode } from "./theme.js";

export type Paint = (code: string, text: string) => string;

export interface HighlightOptions {
  paint: Paint;
  // 256-color index for an agent id or @name mention.
  agent_color?: (name: string) => number;
  agent_style?: (name: string) => string;
  color_mode?: ChatColorMode;
}

const MUTED = "2";

const HARNESS_PREFIX = "(?:claude|codex|grok|gemini|antigravity|agy|opencode|human)";
const TOKEN = new RegExp(
  [
    // `inline code`
    "(?<code>`[^`\\n]+`)",
    // URLs
    "(?<url>\\bhttps?://[^\\s<>()\"'`]+[^\\s<>()\"'`.,;:!?])",
    // **bold** or __bold__
    "(?<bold>\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__)",
    // Agent ids (codex:fb4bbf13) and @mentions
    `(?<agent>(?<![\\w/])${HARNESS_PREFIX}:[\\w.:-]*[\\w]|(?<![\\w@])@[A-Za-z][\\w.:-]*[\\w])`,
    // #123, PR #45, event #22871
    "(?<ref>(?<![\\w&])#\\d+\\b)",
    // Paths: ~/x, ./x, /abs/x, a/b/c, dir/file.ext, or file.ext, each with an optional :line[:col]
    "(?<path>(?<![\\w/.~-])(?:(?:~|\\.{1,2})?/(?:[\\w.@-]+/)*[\\w.@-]*\\w|(?:[\\w.@-]+/){2,}[\\w.@-]*\\w|(?:[\\w.@-]+/)+[\\w.@-]*\\.[A-Za-z]\\w*|[\\w-]+\\.(?:ts|tsx|js|mjs|cjs|json|md|toml|ya?ml|sh|py|rs|go|sql|lock)\\b)(?::\\d+(?::\\d+)?)?)"
  ].join("|"),
  "g"
);

export function highlightChatBody(body: string, options: HighlightOptions): string {
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const fenceMatch = /^(\s*)(```+|~~~+)/.exec(line);
      if (fence !== null) {
        if (fenceMatch && fenceMatch[2].startsWith(fence)) {
          fence = null;
          return options.paint(MUTED, line);
        }
        return line.length > 0 ? options.paint(themeStyle("code", options.color_mode), line) : line;
      }
      if (fenceMatch) {
        fence = fenceMatch[2];
        return options.paint(MUTED, line);
      }
      return highlightLine(line, options);
    })
    .join("\n");
}

function highlightLine(line: string, options: HighlightOptions): string {
  const { paint } = options;

  const heading = /^(\s*)(#{1,6})(\s+)(.*)$/.exec(line);
  if (heading) {
    return `${heading[1]}${paint(MUTED, heading[2])}${heading[3]}${boldWithMarkers(heading[4], paint)}`;
  }

  const quote = /^(\s*)(>+)(\s?)(.*)$/.exec(line);
  if (quote) {
    return `${quote[1]}${paint(MUTED, quote[2])}${quote[3]}${paint("2;3", quote[4])}`;
  }

  const bullet = /^(\s*)([-*+•]|\d+[.)])(\s+)(.*)$/.exec(line);
  if (bullet) {
    return `${bullet[1]}${paint(MUTED, bullet[2])}${bullet[3]}${highlightInline(bullet[4], options)}`;
  }

  if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) return paint(MUTED, line);

  return highlightInline(line, options);
}

function highlightInline(text: string, options: HighlightOptions): string {
  const { paint } = options;
  return text.replace(TOKEN, (match, ...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    if (groups.code) {
      return `${paint(MUTED, "`")}${paint(themeStyle("code", options.color_mode), match.slice(1, -1))}${paint(MUTED, "`")}`;
    }
    if (groups.url) return paint(`4;${themeStyle("url", options.color_mode)}`, match);
    if (groups.bold) {
      const marker = match.slice(0, 2);
      return `${paint(MUTED, marker)}${paint("1", match.slice(2, -2))}${paint(MUTED, marker)}`;
    }
    if (groups.agent) {
      const name = match.replace(/^@/, "");
      return paint(options.agent_style?.(name) ?? (options.agent_color
        ? `38;5;${options.agent_color(name)}` : agentStyle(name, options.color_mode)), match);
    }
    if (groups.ref) return paint(themeStyle("ref", options.color_mode), match);
    if (groups.path) return paint(themeStyle("path", options.color_mode), match);
    return match;
  });
}

// Headings are bold throughout; emphasis markers inside stay visible but dim
// so copied text keeps its Markdown.
function boldWithMarkers(text: string, paint: Paint): string {
  return text
    .split(/(\*\*|__)/)
    .map((part) => (part === "**" || part === "__" ? paint(MUTED, part) : part.length > 0 ? paint("1", part) : part))
    .join("");
}
