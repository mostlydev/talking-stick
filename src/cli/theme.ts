// House palettes use the terminal's own surface. Semantic tokens keep
// typing, completions and the transcript speaking the same visual language.
export type ChatColorMode = "truecolor" | "256";
export const CHAT_THEME = {
  name: "Lantern",
  colors: {
    accent: ["edcb96", 222], command: ["b8a6df", 147], mention: ["87d2df", 81],
    ref: ["92b9d0", 110], code: ["e5bb85", 180], path: ["8dc8c3", 116],
    url: ["86b5dc", 75], muted: ["92949f", 244], ok: ["a2c98c", 114],
    warn: ["d7b577", 179], error: ["e58d90", 203],
    attention: ["222529", 235],
    selection: ["343640", 237], selectionText: ["f0e4d0", 223]
  },
  agents: {
    claude: ["e8a180", 209], codex: ["91c9a1", 78],
    antigravity: ["b8a6df", 141], agy: ["b8a6df", 141], grok: ["d49fc7", 177], opencode: ["83c9c7", 44],
    human: ["e3c578", 220]
  },
  roles: [["86b5dc", 75], ["e5bb85", 214], ["d49fc7", 170], ["a2c98c", 114],
    ["e58d90", 203], ["e3c578", 229], ["b8a6df", 147], ["87d2df", 81]],
  fallback: [81, 214, 170, 114, 39, 203, 229, 147]
} as const;
export type ChatThemeToken = keyof typeof CHAT_THEME.colors;
export type ChatThemeName = "lantern" | "tide" | "dusk";
type ThemeColors = { [K in ChatThemeToken]: readonly [string, number] };
export const CHAT_THEMES: Record<ChatThemeName, { name: string; colors: ThemeColors }> = {
  lantern: CHAT_THEME,
  tide: { name: "Tide", colors: {
    ...CHAT_THEME.colors,
    accent: ["80cbc4", 116], command: ["98bfff", 111], mention: ["d2b7ee", 183],
    ref: ["a3bfcd", 110], code: ["dfc49a", 180], path: ["99c6ad", 115],
    url: ["85c8e0", 117], muted: ["8e9ca6", 246],
    selection: ["293e48", 238], selectionText: ["dcf0ed", 195]
  } },
  dusk: { name: "Dusk", colors: {
    ...CHAT_THEME.colors,
    accent: ["c8b0e8", 183], command: ["e3b0c8", 182], mention: ["9ccfcb", 116],
    ref: ["b6badb", 147], code: ["d6c391", 180], path: ["a9c6ac", 151],
    url: ["9fbfe0", 110], muted: ["9b95aa", 246],
    selection: ["3b344b", 238], selectionText: ["eee4f5", 255]
  } }
};

// A chat console is the only renderer in its CLI process. Identity hues stay
// fixed while semantic colors change; switching never changes text geometry.
let currentTheme: ChatThemeName = "lantern";
export function chatThemeName(): ChatThemeName { return currentTheme; }
export function setChatTheme(name: string): void {
  const key = name.trim().toLowerCase();
  if (!Object.hasOwn(CHAT_THEMES, key)) {
    throw new Error(`Unknown theme "${name}". Choose lantern, tide or dusk.`);
  }
  currentTheme = key as ChatThemeName;
}

export function terminalColorMode(env: NodeJS.ProcessEnv = process.env): ChatColorMode {
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "") ? "truecolor" : "256";
}

function colorCode(color: readonly [string, number], mode: ChatColorMode, background = false): string {
  const channel = background ? 48 : 38;
  return mode === "truecolor"
    ? `${channel};2;${color[0].match(/../g)!.map(hex => parseInt(hex, 16)).join(";")}`
    : `${channel};5;${color[1]}`;
}

export function themeStyle(token: ChatThemeToken, mode: ChatColorMode = "256", background = false): string {
  return colorCode(CHAT_THEMES[currentTheme].colors[token], mode, background);
}

export function agentColorIndex(id: string): number {
  const known = CHAT_THEME.agents[id.split(":")[0].toLowerCase() as keyof typeof CHAT_THEME.agents];
  let hash = 0;
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return known?.[1] ?? CHAT_THEME.fallback[hash % CHAT_THEME.fallback.length];
}

export function agentStyle(id: string, mode: ChatColorMode = "256"): string {
  const known = CHAT_THEME.agents[id.split(":")[0].toLowerCase() as keyof typeof CHAT_THEME.agents];
  return known ? colorCode(known, mode) : `38;5;${agentColorIndex(id)}`;
}

export function roleStyle(index: number, mode: ChatColorMode = "256"): string {
  return colorCode(CHAT_THEME.roles[index % CHAT_THEME.roles.length], mode);
}

export function paintStyle(enabled: boolean, style: string, text: string): string {
  return enabled && text ? `\u001b[${style}m${text}\u001b[0m` : text;
}
