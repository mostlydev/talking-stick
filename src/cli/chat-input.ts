import readline from "node:readline";
import { PassThrough, Writable, type Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { sanitizeChatText } from "./chat-format.js";
import { moveChatCursorVertical, type ChatDraft } from "./chat-view.js";
import { isShiftEnter, isSuperPaste, legacyKey } from "./terminal-keys.js";

export interface ChatInputOptions {
  input: Readable;
  columns: number;
  onChange: () => void;
  onSubmit: (line: string) => void;
  onScroll: (kind: "lines" | "pages", amount: number) => void;
  onClick?: (column: number, row: number) => void;
  onRightClick?: (column: number, row: number) => void;
  onWheel?: (row: number, direction: number) => void;
  onBottom: () => void;
  onQuit: () => void;
  onClear: () => void;
  onEmptyEscape?: () => void;
  /** Alt+Left / Alt+Right: move to the previous or next room. */
  onRoomTree?: () => void;
  /** Ctrl-G: the next unread message addressed to this human. */
  onNextUnread?: () => void;
  onCycleRoom?: (direction: -1 | 1) => void;
  /**
   * Ctrl+V, or a paste with no text: the clipboard image's marker, or null.
   * Keys typed while it resolves wait, so the marker lands where the paste was.
   */
  onImagePaste?: () => Promise<string | null>;
  // Cmd+V forwarded as a key: the clipboard's image marker or text, inserted
  // as is. Falls back to onImagePaste.
  onClipboardPaste?: () => Promise<string | null>;
  /** Replacement text for a paste (image paths become markers), or null to keep it. */
  transformPaste?: (text: string) => string | null;
  now?: () => number;
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

export type ChatModalKey = "up" | "down" | "left" | "right" | "space" | "enter" | "escape" | "default" | "yes" | "no" | "tab" | "edit" | "instructions" | "preview" | "undo" | "reset" | "help" | "quit" | "page_up" | "page_down" | "notifications" | "parent" | "search" | "sort" | "all" | "next_unread";

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
  private suspended = false;
  private selectedCompletion = 0;
  private completionDismissed = false;
  private verticalColumn: number | undefined;
  private lastEmptyEscape = Number.NEGATIVE_INFINITY;
  // While set, keys drive a modal panel (the /roles editor) and never reach
  // readline: nothing typed in a modal can become chat text.
  private modal: ((key: ChatModalKey) => void) | null = null;
  private modalMouse = false;
  private modalText: ((text: string) => boolean) | null = null;
  // A terminal may deliver ESC and the rest of an arrow sequence separately.
  private modalPending = "";
  // Pasted text is never a modal command: swallow it until the paste ends.
  private modalPaste = false;
  private modalEscapeTimer: ReturnType<typeof setTimeout> | null = null;
  // While the clipboard is read, later keys (Enter included) stay in pending.
  private imagePending = false;

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
      // A previous controller (before a room switch) paused the stream.
      options.input.resume();
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

  /** Route keys to a modal panel until cleared with null. The draft is untouched. */
  setModal(handler: ((key: ChatModalKey) => void) | null, text?: (text: string) => boolean, mouse = false): void {
    this.modalMouse = mouse;
    this.modal = handler;
    this.modalText = handler && text ? text : null;
    this.pending = "";
    this.modalPending = "";
    if (this.modalEscapeTimer) clearTimeout(this.modalEscapeTimer);
    this.modalEscapeTimer = null;
  }

  get imagePasteActive(): boolean {
    return this.imagePending;
  }

  private requestImage(clipboard = false): void {
    const request = clipboard && this.options.onClipboardPaste ? this.options.onClipboardPaste : this.options.onImagePaste;
    if (!request) return;
    const verbatim = request === this.options.onClipboardPaste;
    this.imagePending = true;
    const settle = (marker: string | null) => {
      if (this.closed) return;
      this.imagePending = false;
      if (marker) this.insertText(verbatim ? marker : `${marker} `);
      // Replay what was typed meanwhile, in order.
      this.onData("");
    };
    void request().then(settle, () => settle(null));
  }

  get modalActive(): boolean {
    return this.modal !== null;
  }

  private feedModal(text: string): void {
    const keys: Array<[string, ChatModalKey]> = [
      ["\u001b[A", "up"], ["\u001bOA", "up"], ["\u001b[B", "down"], ["\u001bOB", "down"],
      ["\u001b[C", "right"], ["\u001bOC", "right"], ["\u001b[D", "left"], ["\u001bOD", "left"],
      [" ", "space"], ["\r", "enter"], ["\n", "enter"], ["d", "default"], ["D", "default"], ["y", "yes"], ["Y", "yes"], ["n", "no"], ["N", "no"],
      ["\t", "tab"], ["e", "edit"], ["i", "instructions"], ["p", "preview"], ["v", "notifications"], ["u", "undo"], ["r", "reset"], ["?", "help"], ["q", "quit"],
      ["\u001b[5~", "page_up"], ["\u001b[6~", "page_down"],
      ["k", "up"], ["j", "down"], ["h", "left"], ["l", "right"], ["\u0003", "escape"],
      ["\u007f", "parent"], ["\b", "parent"], ["/", "search"], ["s", "sort"], ["a", "all"],
      ["\u0007", "next_unread"]
    ];
    if (this.modalEscapeTimer) clearTimeout(this.modalEscapeTimer);
    this.modalEscapeTimer = null;
    let rest = this.modalPending + text;
    this.modalPending = "";
    while (rest && this.modal) {
      const click = /^\u001b\[<0;(\d+);(\d+)M/.exec(rest);
      if (this.modalMouse && click) {
        rest = rest.slice(click[0].length);
        this.options.onClick?.(Number(click[1]), Number(click[2]));
        continue;
      }
      if (this.modalPaste) {
        const end = rest.indexOf(PASTE_END);
        if (end < 0) {
          // Keep the longest suffix that could begin a split PASTE_END.
          let keep = Math.min(PASTE_END.length - 1, rest.length);
          while (keep > 0 && !PASTE_END.startsWith(rest.slice(-keep))) keep--;
          this.modalPending = keep > 0 ? rest.slice(-keep) : "";
          return;
        }
        rest = rest.slice(end + PASTE_END.length);
        this.modalPaste = false;
        continue;
      }
      if (rest.startsWith(PASTE_START)) {
        rest = rest.slice(PASTE_START.length);
        this.modalPaste = true;
        continue;
      }
      // An incomplete escape sequence (a lone ESC, or the start of an arrow or
      // paste marker) may be completed by the next chunk; wait briefly.
      if (rest.startsWith("\u001b") && !/^\u001b(?:\[[0-?]*[ -/]*[@-~]|O.|[^[O])/.test(rest)) {
        this.modalPending = rest;
        this.modalEscapeTimer = setTimeout(() => {
          this.modalEscapeTimer = null;
          const pending = this.modalPending;
          this.modalPending = "";
          if (pending === "\u001b" && this.modal) {
            this.modal("escape");
            this.options.onChange();
          }
        }, 50);
        return;
      }
      const enhanced = /^\u001b\[[\d:;]*[u~]/.exec(rest)?.[0];
      const legacy = enhanced === undefined ? null
        : isShiftEnter(enhanced) ? "\r" : legacyKey(enhanced);
      if (enhanced !== undefined && legacy !== null) {
        rest = legacy + rest.slice(enhanced.length);
        continue;
      }
      const char = [...rest][0];
      if (char !== "\u001b" && this.modalText?.(char)) {
        rest = rest.slice(char.length);
        continue;
      }
      const match = keys.find(([sequence]) => rest.startsWith(sequence));
      if (match) {
        rest = rest.slice(match[0].length);
        this.modal(match[1]);
        continue;
      }
      // Skip any other escape sequence or character (pastes, mouse reports).
      const sequence = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(rest)?.[0] ?? /^\u001b./.exec(rest)?.[0] ?? rest[0];
      rest = rest.slice(sequence.length);
    }
  }

  /** Insert text at the cursor, e.g. an image marker once the clipboard is read. */
  insertText(text: string): void {
    if (this.closed) return;
    const { line, cursor } = this.draft;
    this.rl.line = line.slice(0, cursor) + text + line.slice(cursor);
    this.rl.cursor = cursor + text.length;
    this.selectedCompletion = 0;
    this.completionDismissed = false;
    this.verticalColumn = undefined;
    this.options.onChange();
  }

  /** Restore a saved draft, e.g. after returning to a room. */
  setDraft(line: string): void {
    if (this.closed) return;
    this.rl.line = line;
    this.rl.cursor = line.length;
    this.options.onChange();
  }

  scrollPrompt(direction: number): void {
    this.moveVertical(direction, direction < 0 ? "\u001b[A" : "\u001b[B");
  }

  /**
   * Hands the terminal to another program (an external editor): stops
   * reading keys and restores the terminal's previous mode. resume() takes
   * it back. Typed-ahead bytes are dropped rather than replayed into chat.
   */
  suspend(): void {
    if (this.closed || this.suspended) return;
    this.suspended = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    if (this.modalEscapeTimer) clearTimeout(this.modalEscapeTimer);
    this.escapeTimer = null;
    this.modalEscapeTimer = null;
    this.pending = "";
    this.modalPending = "";
    this.options.input.off("data", this.onData);
    this.options.input.pause();
    (this.options.input as RawInput).setRawMode?.(this.wasRaw);
  }

  resume(): void {
    if (this.closed || !this.suspended) return;
    this.suspended = false;
    // Keys buffered while another program owned the terminal were meant for
    // that program; drop them rather than replay them into chat.
    while (this.options.input.read() !== null) { /* discard */ }
    (this.options.input as RawInput).setRawMode?.(true);
    this.options.input.on("data", this.onData);
    this.options.input.resume();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    if (this.modalEscapeTimer) clearTimeout(this.modalEscapeTimer);
    this.options.input.off("data", this.onData);
    this.options.input.off("end", this.onEnd);
    this.options.input.pause();
    (this.options.input as RawInput).setRawMode?.(this.wasRaw);
    this.rl.close();
    this.keys.destroy();
    this.sink.destroy();
  }

  private requestEmptyEscape(): void {
    const now = this.options.now?.() ?? Date.now();
    if (now - this.lastEmptyEscape < 1000) {
      this.lastEmptyEscape = now;
      return;
    }
    this.lastEmptyEscape = now;
    this.options.onEmptyEscape?.();
    this.options.onChange();
  }

  private readonly onEnd = () => this.options.onQuit();

  private readonly onData = (data: Buffer | string) => {
    if (this.closed) return;
    if (this.modal) {
      this.feedModal(typeof data === "string" ? data : this.decoder.write(data));
      this.options.onChange();
      return;
    }
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = null;
    this.pending += typeof data === "string" ? data : this.decoder.write(data);
    this.consume();
    if (this.pending && this.paste === null && !this.imagePending) {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null;
        // Never leak an incomplete mouse/control report into the draft.
        if (this.pending === "\u001b" || this.pending === "\u001b\u001b") {
          // A typed draft wins over the suggestion list: one Esc clears `@c`.
          // Two presses buffered together must still act as two presses.
          const presses = this.pending.length;
          for (let press = 0; press < presses; press++) this.pressEscape();
        }
        this.pending = "";
      }, 50);
    }
    this.options.onChange();
  };

  private pressEscape(): void {
    if (this.draft.line.length > 0) this.clear();
    else if (this.completionVisible) {
      this.completionDismissed = true;
      this.options.onChange();
    } else this.requestEmptyEscape();
  }

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
    while (this.pending && !this.closed && !this.imagePending) {
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
        const pasted = sanitizeChatText(
          (this.paste + this.pending.slice(0, end)).slice(0, MAX_PASTE_LENGTH)
        );
        this.pending = this.pending.slice(end + PASTE_END.length);
        this.paste = null;
        // Some terminals paste nothing when the clipboard holds only an image.
        if (pasted.length === 0) {
          this.requestImage();
          continue;
        }
        let text = pasted;
        try {
          text = this.options.transformPaste?.(pasted) ?? pasted;
        } catch {
          // An unreadable dropped file stays as the text that was pasted.
        }
        this.insertText(text);
        continue;
      }

      if (this.pending.startsWith(PASTE_START)) {
        this.pending = this.pending.slice(PASTE_START.length);
        this.paste = "";
        continue;
      }
      if (this.pending[0] === "\u0016") {
        this.pending = this.pending.slice(1);
        this.requestImage();
        continue;
      }
      // Ctrl-G. A pasted ^G arrives inside the paste markers above and stays text.
      if (this.pending[0] === "\u0007") {
        const rest = this.pending.slice(1);
        this.pending = "";
        this.options.onNextUnread?.();
        if (this.modal) this.feedModal(rest);
        else this.pending = rest;
        continue;
      }
      if (this.pending[0] === "\u0014") {
        const rest = this.pending.slice(1);
        this.pending = "";
        this.options.onRoomTree?.();
        if (this.modal) this.feedModal(rest);
        else this.pending = rest;
        continue;
      }
      if (this.pending[0] === "\u001b") {
        if (this.pending.length === 1) return;
        if (this.pending.startsWith("\u001b\u001b")) {
          if (this.pending.length === 2 || this.pending === "\u001b\u001b[") return;
          const metaArrow = /^\u001b\u001b\[([CD])/.exec(this.pending);
          if (metaArrow) {
            this.pending = this.pending.slice(metaArrow[0].length);
            this.options.onCycleRoom?.(metaArrow[1] === "D" ? -1 : 1);
            continue;
          }
        }
        if (this.pending[1] === "[") {
          const match = /^\u001b\[[0-?]*[ -/]*[@-~]/.exec(this.pending);
          if (!match) {
            if (this.pending.length > 64) this.pending = "";
            return;
          }
          const sequence = match[0];
          this.pending = this.pending.slice(sequence.length);
          let legacy: string | null;
          const mouse = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(sequence);
          if (mouse) {
            if (mouse[4] === "M") {
              const button = Number(mouse[1]);
              if ((button & 195) === 0 && (button & 32) === 0) this.options.onClick?.(Number(mouse[2]), Number(mouse[3]));
              if ((button & 195) === 2) this.options.onRightClick?.(Number(mouse[2]), Number(mouse[3]));
              if ((button & 195) === 64 || (button & 195) === 65) {
                const direction = button & 1 ? 1 : -1;
                if (this.options.onWheel) this.options.onWheel(Number(mouse[3]), direction);
                else this.options.onScroll("lines", direction * 3);
              }
            }
          } else if (isShiftEnter(sequence)) {
            this.insertNewline();
          } else if (isSuperPaste(sequence)) {
            this.requestImage(true);
          } else if (sequence === "\u001b[27u") {
            // An enhanced Escape report is complete; no timeout is needed.
            this.pressEscape();
          } else if ((legacy = legacyKey(sequence)) !== null) {
            // An enhanced report of an ordinary key: decode it as typed.
            this.pending = legacy + this.pending;
          } else if (sequence === "\u001b[A" || sequence === "\u001b[B") {
            this.moveVertical(sequence.endsWith("A") ? -1 : 1, sequence);
          } else if (sequence === "\u001b[5~" || sequence === "\u001b[6~") {
            this.options.onScroll("pages", sequence === "\u001b[5~" ? -1 : 1);
          } else if (sequence === "\u001b[1;2A" || sequence === "\u001b[1;2B") {
            this.options.onScroll("lines", sequence.endsWith("A") ? -1 : 1);
          } else if (sequence === "\u001b[1;5F" || sequence === "\u001b[4;5~") {
            this.options.onBottom();
          } else if (/^\u001b\[(?:1;)?(?:3|9)[CD]$/.test(sequence)) {
            this.options.onCycleRoom?.(sequence.endsWith("D") ? -1 : 1);
          } else if (sequence === "\u001b[5;5~" || sequence === "\u001b[6;5~") {
            // Ctrl+PageUp/PageDown is a fallback when a terminal or pane
            // manager consumes Alt+Arrow before the chat sees it.
            this.options.onCycleRoom?.(sequence === "\u001b[5;5~" ? -1 : 1);
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
        } else if ((sequence === "\u001bb" || sequence === "\u001bf") && this.options.onCycleRoom && !this.draft.line) {
          // macOS terminals commonly encode Option+Arrow as Meta-b/f. In a
          // draft, keep readline's word-back/word-forward bindings.
          this.options.onCycleRoom(sequence === "\u001bb" ? -1 : 1);
        } else this.writeKeys(sequence);
        this.pending = this.pending.slice(length);
        continue;
      }

      if (this.pending[0] === "\r" || this.pending[0] === "\n") {
        const key = this.pending[0];
        this.pending = this.pending.slice(1);
        const completed = this.completionVisible ? this.options.complete(this.draft, this.completionIndex) : null;
        if (completed && /^\/go(?:\s+#?[^\s]*)?$/i.test(this.draft.line)) {
          // /go is a picker: the selected room opens with one Enter. Other
          // completions still require a separate Enter before sending.
          this.rl.line = completed.line.trimEnd();
          this.rl.cursor = this.rl.line.length;
          this.writeKeys(key);
        } else if (completed && this.draft.line.trimEnd() !== completed.line.trimEnd()) {
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
      const next = this.pending.search(/[\u0007\u001b\u0014\u0016\t\r\n]/);
      const length = next < 0 ? this.pending.length : next;
      const text = this.pending.slice(0, length);
      this.pending = this.pending.slice(length);
      this.writeKeys(text);
    }
  }
}
