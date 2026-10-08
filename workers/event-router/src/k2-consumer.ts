import { z } from "zod";

/**
 * K2 HTTP pull client (data plane). Section 19 and ADR 0006.
 * Delivery is at-least-once with no ordering guarantee across workers.
 * Never logs the token or record content.
 */

export const SUBSCRIPTIONS = ["project-view-projector", "causal-router"] as const;
/** Drained on the cron sweep only (the archive may lag). */
export const ARCHIVE_SUBSCRIPTION = "audit-archiver";
export type SubscriptionName = (typeof SUBSCRIPTIONS)[number] | typeof ARCHIVE_SUBSCRIPTION;

/** K2 error codes that can succeed on a later attempt. The cron sweep is the retry. */
const RETRYABLE_CODES = new Set([10211, 10214, 10216, 10217]);
/** The batch lease is gone. Do not retry. The batch redelivers and dedupe makes that safe. */
const LEASE_GONE_CODE = 10218;

export const MAX_CONSUMES_PER_SUBSCRIPTION = 2;
const MAX_RECORDS = 100;
/** Cap on applyDelta calls across one invocation (Workers Free allows 50 subrequests). */
export const APPLY_DELTA_CAP = 15;
const REQUEST_TIMEOUT_MS = 15_000;

const StreamIds = z.array(z.string().min(1));

/** Parses K2_STREAM_IDS. Bad or empty config yields an empty list, so the router does nothing. */
export function parseStreamIds(raw: string): string[] {
  try {
    const parsed = StreamIds.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** One stream per cron tick. The minute number rotates through the streams. */
export function sweepStreamIndex(scheduledTimeMs: number, streamCount: number): number {
  if (streamCount <= 0) return -1;
  return Math.floor(scheduledTimeMs / 60_000) % streamCount;
}

export class K2Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: number | undefined,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.code !== undefined && RETRYABLE_CODES.has(this.code);
  }
  get leaseGone(): boolean {
    return this.code === LEASE_GONE_CODE;
  }
}

const Envelope = z.object({
  success: z.boolean(),
  errors: z
    .array(z.object({ code: z.number().optional(), message: z.string().optional() }))
    .default([]),
  result: z.unknown().optional(),
});

const SubscriptionResult = z.object({ id: z.string().min(1) });

const K2Record = z.object({
  content: z.string(),
  timestamp_ms: z.number().optional(),
  headers: z.record(z.string(), z.string()).optional(),
});

const ConsumeResult = z.object({
  batch_id: z.string().min(1).optional(),
  leased_until_ms: z.number().optional(),
  records: z.array(K2Record).default([]),
});
export type ConsumedBatch = { batchId: string; records: z.infer<typeof K2Record>[] };

/** Subscription IDs are stable per (stream, name). Cached per isolate. */
const subscriptionIds = new Map<string, string>();

export class K2Client {
  constructor(
    private readonly streamId: string,
    private readonly token: string,
  ) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    const response = await fetch(`https://${this.streamId}.k2.cloudflarestorage.com${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new K2Error("K2 returned a non-JSON response", response.status, undefined);
    }
    const parsed = Envelope.safeParse(json);
    if (!parsed.success)
      throw new K2Error("K2 returned an unexpected response", response.status, undefined);
    if (!response.ok || !parsed.data.success) {
      const first = parsed.data.errors[0];
      throw new K2Error(first?.message ?? "K2 request failed", response.status, first?.code);
    }
    return parsed.data.result;
  }

  /** 0 or 1 subrequest. Idempotent on the K2 side: same settings return the same ID. */
  async resolveSubscription(name: SubscriptionName): Promise<string> {
    const key = `${this.streamId}:${name}`;
    const cached = subscriptionIds.get(key);
    if (cached) return cached;
    const result = await this.call("/subscriptions", { name, start_at: { type: "earliest" } });
    const { id } = SubscriptionResult.parse(result);
    subscriptionIds.set(key, id);
    return id;
  }

  /** Returns null when there is nothing to process. */
  async consume(subscriptionId: string, workerId: string): Promise<ConsumedBatch | null> {
    const result = await this.call(`/subscriptions/${subscriptionId}/consume`, {
      worker_id: workerId,
      max_records: MAX_RECORDS,
    });
    const parsed = ConsumeResult.parse(result);
    if (parsed.records.length === 0 || !parsed.batch_id) return null;
    return { batchId: parsed.batch_id, records: parsed.records };
  }

  async ack(subscriptionId: string, batchId: string, workerId: string): Promise<void> {
    await this.call(`/subscriptions/${subscriptionId}/batches/${batchId}/ack`, {
      worker_id: workerId,
    });
  }

  async nack(subscriptionId: string, batchId: string, workerId: string): Promise<void> {
    await this.call(`/subscriptions/${subscriptionId}/batches/${batchId}/nack`, {
      worker_id: workerId,
    });
  }
}
