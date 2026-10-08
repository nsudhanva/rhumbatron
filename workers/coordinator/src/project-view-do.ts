import { DurableObject } from "cloudflare:workers";
import {
  applyDelta,
  ClientMessage,
  deltaMessage,
  emptySnapshot,
  ProjectViewDelta,
  ProjectViewSnapshot,
  snapshotMessage,
} from "./view-model.ts";

/**
 * Owner of one Project's dashboard read model and live sockets (AGENTS.md sections 13.3, 39).
 * One instance per active Project: `env.PROJECT_VIEW.idFromName(projectId)`.
 * Eventually consistent: never use this state for a release safety decision.
 */

export type InitializeViewInput = {
  projectId: string;
  name: string;
  canonicalGeneration: number;
};

export type ViewState = { sequence: number; snapshot: ProjectViewSnapshot };

type ViewRow = { sequence: number; snapshot_json: string };

export class ProjectViewDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS project_view (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  private state(): ViewState | null {
    const row = this.sql
      .exec<ViewRow>("SELECT sequence, snapshot_json FROM project_view WHERE id = 1")
      .toArray()[0];
    if (!row) return null;
    return {
      sequence: row.sequence,
      snapshot: ProjectViewSnapshot.parse(JSON.parse(row.snapshot_json)),
    };
  }

  private requireState(): ViewState {
    const state = this.state();
    if (!state) throw new Error("ProjectViewDO is not initialized");
    return state;
  }

  /** Creates an empty view once. Repeating the call returns the existing state. */
  async initialize(input: InitializeViewInput): Promise<ViewState> {
    const existing = this.state();
    if (existing) {
      if (existing.snapshot.project.id !== input.projectId) {
        throw new Error("ProjectViewDO already belongs to a different project");
      }
      return existing;
    }
    const snapshot = emptySnapshot(input);
    this.sql.exec(
      "INSERT INTO project_view (id, sequence, snapshot_json, updated_at) VALUES (1, 0, ?, ?)",
      JSON.stringify(snapshot),
      new Date().toISOString(),
    );
    return { sequence: 0, snapshot };
  }

  async getSnapshot(): Promise<ViewState> {
    return this.requireState();
  }

  /**
   * Applies one delta, advances the sequence by exactly 1, and broadcasts it.
   * The read, compute, and write run with no await, so no other call can interleave.
   */
  async applyDelta(delta: ProjectViewDelta): Promise<ViewState> {
    const parsed = ProjectViewDelta.parse(delta);
    const current = this.requireState();
    const snapshot = ProjectViewSnapshot.parse(applyDelta(current.snapshot, parsed));
    const sequence = current.sequence + 1;
    this.sql.exec(
      "UPDATE project_view SET sequence = ?, snapshot_json = ?, updated_at = ? WHERE id = 1",
      sequence,
      JSON.stringify(snapshot),
      new Date().toISOString(),
    );
    this.broadcast(JSON.stringify(deltaMessage(sequence, parsed)));
    return { sequence, snapshot };
  }

  private broadcast(message: string) {
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // A dead socket closes through webSocketClose or webSocketError. Skip it here.
      }
    }
  }

  /** Live endpoint: `WS /v1/projects/:projectId/live?afterSequence=<n>`. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", {
        status: 426,
        headers: { Upgrade: "websocket" },
      });
    }
    const state = this.state();
    if (!state) return new Response("Project view is not initialized", { status: 409 });

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API: an idle socket does not keep this object in memory.
    this.ctx.acceptWebSocket(server);
    // `afterSequence` is accepted but not used. The client always gets a full snapshot first
    // and decides from the sequence whether it had a gap.
    server.send(JSON.stringify(snapshotMessage(state.sequence, state.snapshot)));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!ClientMessage.safeParse(parsed).success) return;
    const state = this.state();
    if (state) ws.send(JSON.stringify(snapshotMessage(state.sequence, state.snapshot)));
  }

  override async webSocketClose(ws: WebSocket, code: number, _reason: string): Promise<void> {
    // 1005 and 1006 are reserved and cannot be sent in a close frame.
    ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
  }
}
