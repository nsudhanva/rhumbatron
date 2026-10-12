/**
 * R2 audit archive of K2 events. The audit-archiver subscription is drained
 * on the cron sweep only; the archive may lag. Objects are gzipped NDJSON, one per batch.
 */
import type { EventEnvelope } from "@rhumbatron/protocol";

export type ArchiveObject = {
  key: string;
  body: string;
  metadata: Record<string, string>;
};

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds the archive object for one batch. The key is derived from the batch content, so a
 * redelivered batch with the same events overwrites the same object instead of duplicating it.
 */
export async function buildArchive(
  events: EventEnvelope[],
  streamIndex: number,
): Promise<ArchiveObject | null> {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const first = sorted[0] as EventEnvelope;
  const last = sorted[sorted.length - 1] as EventEnvelope;
  const body = `${sorted.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const idsHash = (await sha256Hex(sorted.map((e) => e.eventId).join(","))).slice(0, 16);

  const day = first.timestamp.slice(0, 10).replaceAll("-", "/");
  const stream = String(streamIndex).padStart(2, "0");
  const firstMs = Date.parse(first.timestamp);
  return {
    key: `events/${day}/stream-${stream}/part-${firstMs}-${idsHash}.ndjson.gz`,
    body,
    metadata: {
      contentSha256: await sha256Hex(body),
      count: String(sorted.length),
      firstEventId: first.eventId,
      lastEventId: last.eventId,
      firstTimestamp: first.timestamp,
      lastTimestamp: last.timestamp,
    },
  };
}

/** Writes the object gzipped. One R2 Class A operation. */
export async function writeArchive(bucket: R2Bucket, archive: ArchiveObject): Promise<void> {
  const gzipped = new Response(
    new Blob([archive.body]).stream().pipeThrough(new CompressionStream("gzip")),
  );
  await bucket.put(archive.key, await gzipped.arrayBuffer(), {
    httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
    customMetadata: archive.metadata,
  });
}
