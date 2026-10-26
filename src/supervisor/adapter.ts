// The contract between the supervisor and one harness's headless mode. An
// adapter starts a worker process and speaks its native protocol; the
// supervisor owns every decision about when to start, stop, prompt or answer.
// See docs/supervisor.md.

export type Harness = "claude" | "codex" | "grok";

/** What an adapter has proven it can do. False means unavailable, never assumed. */
export interface Capabilities {
  prompt: boolean;
  resume: boolean;
  interrupt: boolean;
  approvals: boolean;
}

/** Explicit per-harness permissions; nothing is inherited from local defaults. */
export type WorkerPermissions =
  | { harness: "claude"; mode: "default" | "plan" }
  | { harness: "codex"; sandbox: "read-only" | "workspace-write"; approval: "on-request" | "untrusted" }
  | { harness: "grok" };

/**
 * Where a worker's environment value comes from. Specs store references and
 * approved non-secret literals only, never credential values.
 */
export type EnvReference =
  | { name: string; from: "inherit" }
  | { name: string; from: "keychain"; service: string }
  | { name: string; from: "literal"; value: string };

export interface WorkerSpec {
  worker_id: string;
  harness: Harness;
  cwd: string;
  model?: string;
  permissions: WorkerPermissions;
  /** Resume this native session; a worker that cannot resume is held, never restarted fresh. */
  resume_session_id?: string;
  env: EnvReference[];
  /**
   * Set by the supervisor for one start and never stored: the supervisor's
   * TALKING_STICK_DATA_DIR, and for workers that can take a prompt their
   * supervisor endpoint and delivery token. Adapters build the child's
   * environment from env references and these alone: never the daemon's whole
   * environment, so no inherited TT_ROOM or harness identity marker leaks in.
   */
  supervisor_env?: Record<string, string>;
}

export type InputMode = "start_turn" | "steer";

/**
 * What became of one journalled input. Written means the bytes reached the
 * pipe; accepted means the harness started (or, for a steer, joined) a turn;
 * uncertain means it was written but never acknowledged, and is never retried.
 */
export type InputOutcome = "written" | "accepted" | "queued" | "rejected" | "uncertain";

export type WorkerEvent =
  | { type: "session"; session_id: string }
  | { type: "input"; input_id: string; outcome: InputOutcome; native_turn_id?: string }
  | { type: "turn_started"; native_turn_id: string; input_id?: string }
  | { type: "turn_completed"; native_turn_id: string; outcome: "success" | "error" | "interrupted" }
  | { type: "approval_requested"; native_request_id: string; tool: string; summary: string }
  /** The harness settled a pending request itself, such as Codex's serverRequest/resolved after an interrupt. */
  | { type: "approval_resolved"; native_request_id: string }
  | { type: "state"; state: "idle" | "awaiting_input" | "auth_required" | "disconnected" }
  | { type: "resume_failed" }
  | { type: "request_refused"; method: string }
  /** The harness broke its protocol, such as naming another session: the supervisor holds the worker. */
  | { type: "protocol_error" }
  /** A protocol queue overflowed: the supervisor holds the worker. */
  | { type: "overflow" }
  | { type: "exited"; code: number | null; signal: string | null };

export interface WorkerHandle {
  readonly pid: number;
  readonly processStartedAt: string;
  readonly pgid: number;
  readonly generation: number;
  sessionId(): string | null;
  /** Events in order. Adapters drain the child's output continuously. */
  onEvent(listener: (event: WorkerEvent) => void): void;
  /** Writes one journalled input; a timeout after writing resolves uncertain. */
  submit(input: { input_id: string; text: string; mode: InputMode }): Promise<InputOutcome>;
  interrupt(): Promise<"interrupted" | "not_busy" | "unsupported">;
  /**
   * Answers the request with this native id on this handle's generation only.
   * It rejects when the harness no longer has that request pending.
   */
  answerApproval(nativeRequestId: string, decision: "allow" | "deny", note?: string): Promise<void>;
  /** A non-model liveness check: the process, and a protocol ping where one exists. */
  probe(): Promise<"alive" | "gone" | "unknown">;
  /** Stdin EOF, then the process group, then SIGKILL after the grace. */
  stop(graceMs: number): Promise<void>;
}

/** The child's exact identity, reported the moment it exists. */
export interface SpawnedProcess {
  pid: number;
  processStartedAt: string;
  pgid: number;
}

export interface HarnessAdapter {
  readonly harness: Harness;
  capabilities(): Capabilities;
  /**
   * Spawns and handshakes only; it never takes a prompt. It must call onSpawn
   * synchronously right after spawning, before the handshake, so the
   * supervisor owns the child even if it crashes mid-handshake. A child whose
   * handshake fails is stopped before start rejects. When signal aborts, the
   * supervisor is stopping: stop the child and reject promptly.
   */
  start(spec: WorkerSpec, generation: number, onSpawn: (process: SpawnedProcess) => void, signal?: AbortSignal): Promise<WorkerHandle>;
}
