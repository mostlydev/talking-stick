import readline from "node:readline";
import { PassThrough, Writable, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { sanitizeChatText } from "./chat-format.js";
import { moveChatCursorVertical, type ChatDraft } from "./chat-view.js";

export interface ChatInputOptions {
  input: Readable;
  columns: number;
  onChange: () => void;
  onSubmit: (line: string) => void;
  onScroll: (kind: "lines" | "pages", amount: number) => void;
  onWheel?: (row: number, direction: number) => void;
  onBottom: () => void;
  onQuit: () => void;
  onClear: () => void;
  complete: (draft: ChatDraft, index: number) => ChatDraft | null;
  completionCount?: (draft: ChatDraft) => number;
}

type EditableReadline = Omit<readline.Interface, "line" | "cursor"> & {
  line: string;
  cursor: number;
  history: string[];
};

type RawInput = Readable & {
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => void;
};
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";
const MAX_PASTE_LENGTH = 65_536;

// Readline edits a private buffer; it never writes to the physical terminal.
// Terminal-only controls are consumed before readline's keypress decoder.
export class ChatInputController {
  private readonly keys = new PassThrough();
  private readonly sink: Writable & { columns: number };
  private readonly rl: EditableReadline;
  private readonly decoder = new StringDecoder("utf8");
  private readonly wasRaw: boolean;
  private pending = "";
  private paste: string | null = null;
  private escapeTimer: ReturnType<typeof setTimeout> | null = null;
  private submitted: string | null = null;
  private closed = false;
  private selectedCompletion = 0;
  private completionDismissed = false;
  private verticalColumn: number | undefined;

  constructor(private readonly options: ChatInputOptions) {
    this.sink = Object.assign(
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        }
      }),
      {
        columns: Math.max(1, options.columns)
      }
    );
    readline.emitKeypressEvents(this.keys);
    this.rl = readline.createInterface({
      input: this.keys,
      output: this.sink,
      terminal: true,
      prompt: "",
      historySize: 100
    }) as EditableReadline;
    this.keys.prependListener(
      "keypress",
      (_text: string, key: readline.Key) => {
        if (key.name === "return" || key.name === "enter")
          this.submitted = this.rl.line;
      }
    );
    this.rl.on("line", (line) => {
      // Readline may reorder multiline history internally. The pre-Enter
      // snapshot is the source of truth for both delivery and recalled text.
      const body = this.submitted ?? line;
      this.submitted = null;
      if (body && this.rl.history.length > 0) this.rl.history[0] = body;
      options.onSubmit(body);
    });
    this.rl.on("SIGINT", () => this.clear());
    this.rl.on("close", () => {
      if (!this.closed) options.onQuit();
    });
    this.wasRaw = Boolean((options.input as RawInput).isRaw);
    try {
      (options.input as RawInput).setRawMode?.(true);
      options.input.on("data", this.onData);
      options.input.on("end", this.onEnd);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  get draft(): ChatDraft {
    return { line: this.rl.line, cursor: this.rl.cursor };
  }

  get completionIndex(): number {
    const count = this.options.completionCount?.(this.draft) ?? 0;
    return Math.max(0, Math.min(this.selectedCompletion, count - 1));
  }

  get completionVisible(): boolean {
    return !this.completionDismissed && this.paste === null && (this.options.completionCount?.(this.draft) ?? 0) > 0;
  }

  resize(columns: number): void {
    this.verticalColumn = undefined;
    this.sink.columns = Math.max(1, columns);
  }

  clear(): void {
    if (this.closed) return;
    this.selectedCompletion = 0;
    this.completionDismissed = false;
    this.verticalColumn = undefined;
    this.rl.line = "";
    this.rl.cursor = 0;
    this.options.onClear();
    this.options.onChange();
  }

  scrollPrompt(direction: number): void {
    this.moveVertical(direction, direction < 0 ? "\u001b[A" : "\u001b[B");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onEnd);
    this.options.input.pause();
    (this.options.input as RawInput).setRawMode?.(this.wasRaw);
    this.rl.close();
    this.keys.destroy();
    this.sink.destroy();
  }

  private readonly onEnd = () => this.options.onQuit();

  private readonly onData = (data: Buffer | string) => {
    if (this.closed) return;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    this.pending += typeof data === "string" ? data : this.decoder.write(data);
    this.consume();
    if (this.pending && this.paste === null) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        // Never leak an incomplete mouse/control report into the draft.
        if (this.pending === "\u001b") {
          if (this.completionVisible) {
            this.completionDismissed = true;
            this.options.onChange();
          } else this.clear();
        }
        this.pending = "";
      }, 50);
    }
    this.options.onChange();
  };

  private writeKeys(text: string): void {
    this.completionDismissed = false;
    this.verticalColumn = undefined;
    this.selectedCompletion = 0;
    this.keys.write(text);
  }

  private moveVertical(direction: number, sequence: string): void {
    const count = this.completionVisible ? this.options.completionCount!(this.draft) : 0;
    if (count > 0) {
      this.selectedCompletion = (this.completionIndex + direction + count) % count;
      return;
    }
    const moved = moveChatCursorVertical(this.draft, this.sink.columns, direction, this.verticalColumn);
    if (moved) {
      this.rl.cursor = moved.draft.cursor;
      this.verticalColumn = moved.column;
      return;
    }
    this.writeKeys(sequence);
  }

  private insertNewline(): void {
    const { line, cursor } = this.draft;
    this.rl.line = line.slice(0, cursor) + "\n" + line.slice(cursor);
    this.rl.cursor = cursor + 1;
    this.completionDismissed = false;
    this.selectedCompletion = 0;
    this.verticalColumn = undefined;
  }

  private consume(): void {
    while (this.pending && !this.closed) {
      if (this.paste !== null) {
        const end = this.pending.indexOf(PASTE_END);
        if (end < 0) {
          const keep = Math.min(PASTE_END.length - 1, this.pending.length);
          this.paste = (
            this.paste + this.pending.slice(0, this.pending.length - keep)
          ).slice(0, MAX_PASTE_LENGTH);
          this.pending = this.pending.slice(-keep);
          return;
        }
        const text = sanitizeChatText(
          (this.paste + this.pending.slice(0, end)).slice(0, MAX_PASTE_LENGTH)
        );
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.paste = null;
        const { line, cursor } = this.draft;
        this.rl.line = line.slice(0, cursor) + text + line.slice(cursor);
        this.rl.cursor = cursor + text.length;
        this.selectedCompletion = 0;
        this.completionDismissed = false;
        this.verticalColumn = undefined;
        continue;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.paste = "";
        continue;
      }
      if (this.pending[0] === "\u001b") {
        if (this.pending.length === 1) return;
        if (this.pending[1] === "[") {
          const match = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(this.pending);
          if (!match) {
            if (this.pending.length > 64) this.pending = "";
            return;
          }
          const sequence = match[0];
          this.pending = this.pending.slice(sequence.length);
          const mouse = /^\u001b\[<(\d+);\d+;(\d+)([Mm])$/.exec(sequence);
          if (mouse) {
            if (mouse[3] === "M") {
              const button = Number(mouse[1]);
              if ((button & 195) === 64 || (button & 195) === 65) {
                const direction = button & 1 ? 1 : -1;
                if (this.options.onWheel) this.options.onWheel(Number(mouse[2]), direction);
                else this.options.onScroll("lines", direction * 3);
              }
            }
          } else if (sequence === "\u001b[13;2u" || sequence === "\u001b[27;2;13~") {
            this.insertNewline();
          } else if (sequence === "\u001b[A" || sequence === "\u001b[B") {
            this.moveVertical(sequence.endsWith("A") ? -1 : 1, sequence);
          } else if (sequence === "\u001b[5~" || sequence === "\u001b[6~") {
            this.options.onScroll("pages", sequence === "\u001b[5~" ? -1 : 1);
          } else if (sequence === "\u001b[1;2A" || sequence === "\u001b[1;2B") {
            this.options.onScroll("lines", sequence.endsWith("A") ? -1 : 1);
          } else if (sequence === "\u001b[1;5F" || sequence === "\u001b[4;5~") {
            this.options.onBottom();
          } else if (sequence !== PASTE_END) {
            this.writeKeys(sequence);
          }
          continue;
        }
        if (this.pending[1] === "O" && this.pending.length < 3) return;
        const length = this.pending[1] === "O" ? 3 : 2;
        const sequence = this.pending.slice(0, length);
        if (sequence === "\u001b\r" || sequence === "\u001b\n") {
          this.insertNewline();
        } else if (sequence === "\u001bOA" || sequence === "\u001bOB") {
          this.moveVertical(sequence.endsWith("A") ? -1 : 1, sequence);
        } else this.writeKeys(sequence);
        this.pending = this.pending.slice(length);
        continue;
      }

      if (this.pending[0] === "\r" || this.pending[0] === "\n") {
        const key = this.pending[0];
        this.pending = this.pending.slice(1);
        const completed = this.completionVisible ? this.options.complete(this.draft, this.completionIndex) : null;
        if (completed && this.draft.line.trimEnd() !== completed.line.trimEnd()) {
          this.rl.line = completed.line;
          this.rl.cursor = completed.cursor;
          this.selectedCompletion = 0;
          this.verticalColumn = undefined;
        } else this.writeKeys(key);
        continue;
      }

      // Tabs belong to completion, not to readline's off-screen candidate list.
      if (this.pending[0] === "\t") {
        const completed = this.options.complete(this.draft, this.completionIndex);
        if (completed) {
          this.rl.line = completed.line;
          this.rl.cursor = completed.cursor;
        }
        this.selectedCompletion = 0;
        this.verticalColumn = undefined;
        this.pending = this.pending.slice(1);
        continue;
      }
      const next = this.pending.search(/[\u001b\t\r\n]/);
      const length = next < 0 ? this.pending.length : next;
      const text = this.pending.slice(0, length);
      this.pending = this.pending.slice(length);
      this.writeKeys(text);
    }
  }
}
