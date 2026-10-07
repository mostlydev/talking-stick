import type { HerdrRunner } from "../../src/herdr.js";
import type { RoomMember } from "../../src/types.js";

export type FakeStartBehavior = "ok" | "not_ready" | "timeout" | "no_session" | "never_joins";

interface FakeAgent {
  name: string;
  kind: string;
  session_id: string | null;
  pid: number;
  joins: boolean;
}

interface FakePane {
  id: string;
  chat: boolean;
  agent: FakeAgent | null;
}

// A stateful stand-in for the Herdr CLI: records argv, creates panes, and
// starts agents whose sessions and processes the identity proof can check.
export class FakeHerdr {
  readonly calls: string[][] = [];
  readonly panes = new Map<string, FakePane>();
  readonly startTimes = new Map<number, string>();
  readonly startBehavior: Record<string, FakeStartBehavior> = {};
  failSplit = false;
  private nextPane = 2;
  private nextPid = 5000;

  constructor(readonly callerPane = "w1:p1", readonly callerRect = { width: 200, height: 50 }) {
    this.panes.set(callerPane, { id: callerPane, chat: false, agent: null });
  }

  // Adds an already-running agent, as if launched earlier or by hand.
  addAgent(paneId: string, kind: string, options: { name?: string; session?: string | null } = {}): FakeAgent {
    const pid = this.nextPid++;
    this.startTimes.set(pid, `Wed Oct  7 10:00:${String(pid % 60).padStart(2, "0")} 2026`);
    const agent: FakeAgent = {
      name: options.name ?? "",
      kind,
      session_id: options.session === undefined ? `sess-${kind}-${pid}` : options.session,
      pid,
      joins: true
    };
    this.panes.set(paneId, { id: paneId, chat: false, agent });
    return agent;
  }

  // The members the room would hold once each joinable agent ran its bootstrap.
  members(): RoomMember[] {
    const members: RoomMember[] = [];
    for (const pane of this.panes.values()) {
      if (pane.chat) {
        members.push({ agent_id: `human:op:chat:${pane.id}`, harness_name: null, status: "active",
          session_kind: "human_chat", process_liveness: "alive" } as RoomMember);
      }
      const agent = pane.agent;
      if (!agent || !agent.joins) continue;
      members.push({
        agent_id: `${agent.kind}:${agent.pid}`,
        harness_name: agent.kind,
        status: "active",
        session_kind: "harness_cli",
        process_liveness: "alive",
        harness_session_id: agent.session_id ? `harness:${agent.session_id}` : `pid:${agent.pid}`,
        harness_pid: agent.pid,
        harness_process_started_at: this.startTimes.get(agent.pid) ?? null
      } as RoomMember);
    }
    return members;
  }

  readonly runner: HerdrRunner = (args) => {
    this.calls.push([...args]);
    const [group, command] = args;
    const option = (name: string) => args[args.indexOf(name) + 1];
    const ok = (result: unknown) => JSON.stringify({ result });

    if (group === "pane" && command === "layout") {
      return ok({ layout: { panes: [{ pane_id: option("--pane"), rect: this.callerRect }] } });
    }
    if (group === "agent" && command === "list") {
      return ok({ agents: [...this.panes.values()].filter((pane) => pane.agent).map((pane) => ({
        pane_id: pane.id,
        agent: pane.agent!.kind,
        ...(pane.agent!.name ? { name: pane.agent!.name } : {}),
        ...(pane.agent!.session_id ? { agent_session: { kind: "id", value: pane.agent!.session_id } } : {}),
        agent_status: "idle"
      })) });
    }
    if (group === "pane" && command === "process-info") {
      const pane = this.panes.get(option("--pane"));
      const processes = pane?.agent ? [{ pid: pane.agent.pid, argv0: pane.agent.kind }] : [];
      return ok({ process_info: { foreground_processes: processes } });
    }
    if (group === "pane" && command === "split") {
      if (this.failSplit) throw herdrFailure("pane_not_found", "split failed");
      return ok({ pane: { pane_id: this.createPane() } });
    }
    if ((group === "tab" || group === "workspace") && command === "create") {
      return ok({ root_pane: { pane_id: this.createPane() } });
    }
    if (group === "pane" && command === "run") {
      this.panes.get(args[2])!.chat = true;
      return ok({ ran: true });
    }
    if (group === "agent" && command === "start") {
      const kind = option("--kind");
      const behavior = this.startBehavior[kind] ?? "ok";
      if (behavior === "not_ready") throw herdrFailure("agent_not_ready", "agent is blocked at startup");
      if (behavior === "timeout") throw new Error("spawnSync herdr ETIMEDOUT");
      const agent = this.addAgent(option("--pane"), kind, {
        name: args[3],
        session: behavior === "no_session" ? null : undefined
      });
      agent.joins = behavior !== "never_joins";
      return ok({ agent: { pane_id: option("--pane") } });
    }
    throw new Error(`unexpected herdr call: ${args.join(" ")}`);
  };

  private createPane(): string {
    const id = `w1:p${this.nextPane++}`;
    this.panes.set(id, { id, chat: false, agent: null });
    return id;
  }
}

function herdrFailure(code: string, message: string): Error {
  return Object.assign(new Error("exit 1"), {
    stdout: JSON.stringify({ error: { code, message } })
  });
}
