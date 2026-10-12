// Intents and Challenges must be idempotent on their IDs, and each state change must write exactly
// one outbox event in the same transaction.
// Runs the real IntentStore against SQLite (node:sqlite) behind a minimal SqlStorage adapter.
import { DatabaseSync } from "node:sqlite";
import type { Intent } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { IntentStore, migrateIntents } from "./intents.ts";
import { migrateOutbox } from "./outbox.ts";

function fakeSql(): SqlStorage {
  const db = new DatabaseSync(":memory:");
  const exec = (query: string, ...params: unknown[]) => {
    if (
      params.length === 0 &&
      query
        .trim()
        .split(";")
        .filter((s) => s.trim()).length > 1
    ) {
      db.exec(query);
      return { toArray: () => [], rowsWritten: 0 };
    }
    const statement = db.prepare(query);
    if (statement.columns().length > 0) {
      const rows = statement.all(...(params as never[]));
      return { toArray: () => rows, rowsWritten: 0 };
    }
    const result = statement.run(...(params as never[]));
    return { toArray: () => [], rowsWritten: Number(result.changes) };
  };
  return { exec } as unknown as SqlStorage;
}

function setup() {
  const sql = fakeSql();
  migrateOutbox(sql);
  migrateIntents(sql);
  const outbox = () =>
    sql
      .exec<{ event_type: string; payload_json: string }>(
        "SELECT event_type, payload_json FROM outbox ORDER BY id",
      )
      .toArray();
  return { store: new IntentStore(sql), outbox };
}

const intent: Intent = {
  intentId: "int-a",
  taskId: "task-a",
  agentId: "agent-a",
  summary: "Store collaborators in a membership table",
  semanticResources: ["wishlist:membership"],
  expectedFiles: ["src/wishlist/membership.ts"],
  expectedSymbols: [],
  expectedContractChanges: [],
  expectedDataChanges: [
    { entity: "wishlist_members", kind: "add", model: "mutable_table", description: "" },
  ],
  expectedSideEffects: [],
  assumptions: [],
  createdAt: "2026-10-08T00:00:00.000Z",
};
const scope = { projectId: "proj_1", changeId: "chg_1", projectSlug: "acme" };

describe("IntentStore", () => {
  it("declares an Intent once and writes one intent.declared event", () => {
    const { store, outbox } = setup();
    expect(store.declare({ ...scope, intent }, 1_000)).toMatchObject({ status: "declared" });
    expect(store.declare({ ...scope, intent }, 2_000)).toMatchObject({ status: "duplicate" });
    expect(
      store.declare({ ...scope, intent: { ...intent, summary: "Something else" } }, 3_000),
    ).toEqual({
      ok: false,
      reason: "id_reused",
    });

    const events = outbox();
    expect(events.map((e) => e.event_type)).toEqual(["intent.declared"]);
    const envelope = JSON.parse(events[0]?.payload_json ?? "{}");
    expect(envelope).toMatchObject({
      projectId: "proj_1",
      changeId: "chg_1",
      taskId: "task-a",
      resource: "project:acme:wishlist:membership",
      actor: { kind: "agent", id: "agent-a" },
      payload: { intentId: "int-a" },
    });
    expect(store.list()).toEqual([intent]);
  });

  it("lists Intents by exact, ancestor, and descendant resource only", () => {
    const { store } = setup();
    store.declare({ ...scope, intent }, 1_000);
    expect(store.list("project:acme:wishlist:membership")).toHaveLength(1);
    expect(store.list("wishlist")).toHaveLength(1);
    expect(store.list("wishlist:membership:roles")).toHaveLength(1);
    expect(store.list("wish")).toEqual([]);
    expect(store.list("cart")).toEqual([]);
  });

  it("creates and resolves a Challenge once, with one event per transition", () => {
    const { store, outbox } = setup();
    const challenge = {
      challengeId: "chl-1",
      sourceAgentId: "agent-b",
      targetIntentId: "int-a",
      semanticResource: "wishlist:membership",
      kind: "data_semantics_conflict" as const,
      summary: "Mutable rows race with concurrent collaborator edits",
      evidenceRefs: [],
    };
    const resolution = {
      outcome: "forked" as const,
      summary: "Two Candidates",
      resolvedBy: { kind: "system" as const, id: "integration" },
    };

    expect(store.resolveChallenge({ challengeId: "chl-1", resolution }, 500)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(store.createChallenge({ ...scope, challenge }, 1_000)).toMatchObject({
      status: "created",
    });
    expect(store.createChallenge({ ...scope, challenge }, 1_500)).toMatchObject({
      status: "duplicate",
    });
    expect(store.resolveChallenge({ challengeId: "chl-1", resolution }, 2_000)).toEqual({
      ok: true,
      status: "resolved",
    });
    expect(store.resolveChallenge({ challengeId: "chl-1", resolution }, 3_000)).toEqual({
      ok: true,
      status: "duplicate",
    });
    expect(
      store.resolveChallenge(
        { challengeId: "chl-1", resolution: { ...resolution, outcome: "dismissed" } },
        4_000,
      ),
    ).toEqual({ ok: false, reason: "already_resolved" });

    expect(outbox().map((e) => e.event_type)).toEqual(["challenge.created", "challenge.resolved"]);
    expect(store.listChallenges("wishlist:membership")).toEqual([
      { challenge, status: "resolved", resolution },
    ]);
  });
});
