import type { EventEnvelope } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { buildArchive } from "./archive.ts";

const event = (id: string, timestamp: string): EventEnvelope => ({
  eventId: id,
  eventType: "project.created",
  eventVersion: 1,
  tenantId: "org_1",
  projectId: "proj_1",
  actor: { kind: "system", id: "test" },
  canonicalGeneration: 0,
  correlationId: id,
  timestamp,
  payload: {},
});

describe("buildArchive", () => {
  it("returns nothing for an empty batch", async () => {
    expect(await buildArchive([], 3)).toBeNull();
  });

  it("writes one NDJSON line per event, ordered, under a date and stream key", async () => {
    const archive = await buildArchive(
      [event("e2", "2026-10-08T10:00:02.000Z"), event("e1", "2026-10-08T10:00:01.000Z")],
      3,
    );
    expect(archive?.key).toMatch(
      /^events\/2026\/10\/08\/stream-03\/part-\d+-[0-9a-f]{16}\.ndjson\.gz$/,
    );
    const lines = archive?.body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l).eventId);
    expect(lines).toEqual(["e1", "e2"]);
    expect(archive?.metadata).toMatchObject({
      count: "2",
      firstEventId: "e1",
      lastEventId: "e2",
      firstTimestamp: "2026-10-08T10:00:01.000Z",
      lastTimestamp: "2026-10-08T10:00:02.000Z",
    });
    expect(archive?.metadata.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the same key for a redelivered batch with the same events", async () => {
    const batch = [
      event("e1", "2026-10-08T10:00:01.000Z"),
      event("e2", "2026-10-08T10:00:02.000Z"),
    ];
    const a = await buildArchive(batch, 1);
    const b = await buildArchive([...batch].reverse(), 1);
    expect(a?.key).toBe(b?.key);
  });
});
