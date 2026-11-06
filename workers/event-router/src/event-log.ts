/**
 * The event log client (NATS JetStream, one stream per shard). Delivery is at-least-once with no
 * ordering guarantee across consumers. The router never logs record content.
 */

export const SUBSCRIPTIONS = ["project-view-projector", "causal-router"] as const;
/** Drained on the sweep only (the archive may lag). */
export const ARCHIVE_SUBSCRIPTION = "audit-archiver";
/** Drained on the sweep only, one batch per tick (analytics may lag). */
export const ANALYTICS_SUBSCRIPTION = "analytics-projector";
export type SubscriptionName =
  | (typeof SUBSCRIPTIONS)[number]
  | typeof ARCHIVE_SUBSCRIPTION
  | typeof ANALYTICS_SUBSCRIPTION;

export const MAX_CONSUMES_PER_SUBSCRIPTION = 2;
/** Cap on applyDelta calls across one invocation, so one sweep stays short. */
export const APPLY_DELTA_CAP = 15;

/** One stream per sweep tick. The minute number rotates through the streams. */
export function sweepStreamIndex(scheduledTimeMs: number, streamCount: number): number {
  if (streamCount <= 0) return -1;
  return Math.floor(scheduledTimeMs / 60_000) % streamCount;
}

/** One record: standard base64 of the JSON event envelope, plus headers. */
export type EventRecord = {
  content: string;
  timestamp_ms?: number;
  headers?: Record<string, string>;
};
export type ConsumedBatch = { batchId: string; records: EventRecord[] };

/** Consumer client of one stream. A subscription is a durable consumer; a batch is acked as a whole. */
export type EventLogClient = {
  resolveSubscription(name: SubscriptionName): Promise<string>;
  consume(subscriptionId: string, workerId: string): Promise<ConsumedBatch | null>;
  ack(subscriptionId: string, batchId: string, workerId: string): Promise<void>;
  nack(subscriptionId: string, batchId: string, workerId: string): Promise<void>;
};

/** The `EVENT_LOG` binding: the stream count and a client per stream. */
export type EventLog = { streams: number; client(streamIndex: number): EventLogClient };

export function eventLogOf(env: object): EventLog | null {
  return ((env as { EVENT_LOG?: EventLog }).EVENT_LOG ?? null) as EventLog | null;
}
