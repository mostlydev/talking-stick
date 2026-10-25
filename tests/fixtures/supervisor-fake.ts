import type {
  Capabilities, Harness, HarnessAdapter, InputMode, InputOutcome, SpawnedProcess, WorkerEvent, WorkerHandle, WorkerSpec
} from "../../src/supervisor/adapter.js";

// A scriptable adapter: tests drive its processes' events, liveness and input
// outcomes, and read back what the supervisor asked of them.

export class FakeHandle implements WorkerHandle {
  readonly pid: number;
  readonly processStartedAt: string;
  readonly pgid: number;
  readonly generation: number;
  readonly spec: WorkerSpec;
  liveness: "alive" | "gone" | "unknown" = "alive";
  submitOutcome: InputOutcome | (() => Promise<InputOutcome>) = "accepted";
  readonly submitted: Array<{ input_id: string; text: string; mode: InputMode }> = [];
  readonly answers: Array<{ id: string; decision: "allow" | "deny" }> = [];
  stopped = false;
  private session: string | null;
  private listeners: Array<(event: WorkerEvent) => void> = [];

  constructor(spec: WorkerSpec, generation: number, pid: number) {
    this.spec = spec;
    this.generation = generation;
    this.pid = pid;
    this.pgid = pid;
    this.processStartedAt = `start-${pid}`;
    this.session = spec.resume_session_id ?? null;
  }

  sessionId(): string | null { return this.session; }
  onEvent(listener: (event: WorkerEvent) => void): void { this.listeners.push(listener); }
  emit(event: WorkerEvent): void {
    if (event.type === "session") this.session = event.session_id;
    for (const listener of this.listeners) listener(event);
  }
  async submit(input: { input_id: string; text: string; mode: InputMode }): Promise<InputOutcome> {
    this.submitted.push(input);
    return typeof this.submitOutcome === "function" ? this.submitOutcome() : this.submitOutcome;
  }
  async interrupt(): Promise<"interrupted" | "not_busy" | "unsupported"> { return "interrupted"; }
  async answerApproval(id: string, decision: "allow" | "deny"): Promise<void> { this.answers.push({ id, decision }); }
  async probe(): Promise<"alive" | "gone" | "unknown"> { return this.liveness; }
  async stop(): Promise<void> {
    this.stopped = true;
    this.liveness = "gone";
    this.emit({ type: "exited", code: 0, signal: null });
  }
}

export class FakeAdapter implements HarnessAdapter {
  readonly harness: Harness;
  readonly handles: FakeHandle[] = [];
  caps: Capabilities = { prompt: true, resume: true, interrupt: true, approvals: true };
  failStart: ((spec: WorkerSpec) => boolean) | null = null;
  /** Resolves a start only when the test releases it. */
  holdStart: Promise<void> | null = null;
  private nextPid = 1000;

  constructor(harness: Harness = "claude") {
    this.harness = harness;
  }

  capabilities(): Capabilities { return this.caps; }

  async start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle> {
    const pid = this.nextPid++;
    onSpawn({ pid, processStartedAt: `start-${pid}`, pgid: pid });
    // The handshake; an abort stops the child and rejects, as real adapters must.
    if (this.holdStart) {
      await Promise.race([this.holdStart, new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
    }
    if (signal?.aborted) {
      const child = new FakeHandle(spec, generation, pid);
      child.stopped = true;
      child.liveness = "gone";
      this.handles.push(child);
      throw new Error("start aborted");
    }
    if (this.failStart?.(spec)) throw new Error("fake start failure");
    const handle = new FakeHandle(spec, generation, pid);
    this.handles.push(handle);
    return handle;
  }

  get last(): FakeHandle {
    return this.handles[this.handles.length - 1];
  }
}
