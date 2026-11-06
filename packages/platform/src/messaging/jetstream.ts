import {
  AckPolicy,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  jetstream,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
} from "@nats-io/jetstream";
import {
  connect,
  type NatsConnection,
  nanos,
  headers as natsHeaders,
} from "@nats-io/transport-node";
import { log } from "../log.ts";

/**
 * Durable messaging on NATS JetStream.
 *
 * - Commands: one work-queue stream `COMMANDS`, one subject and one durable consumer per queue.
 *   At-least-once, explicit ack, retry with delay (`nak`), a bounded retry count, then the
 *   dead-letter queue. Publish dedupe uses the command ID.
 * - Events: eight limit-retention streams `EVENTS_00..07` (7 days), sharded by Project. Each
 *   subscription is a durable pull consumer. Publish dedupe uses the event ID.
 */

export const EVENT_STREAM_COUNT = 8;
const COMMAND_STREAM = "COMMANDS";
const DAY_NS = nanos(86_400_000);
const HANDLER_ACK_WAIT_MS = 15 * 60_000;

function eventStreamName(index: number): string {
  return `EVENTS_${String(index).padStart(2, "0")}`;
}

export class Messaging {
  private constructor(
    readonly nc: NatsConnection,
    readonly js: JetStreamClient,
    readonly jsm: JetStreamManager,
  ) {}

  static async connect(servers: string): Promise<Messaging> {
    const nc = await connect({ servers, name: "rhumbatron-core", maxReconnectAttempts: -1 });
    const jsm = await jetstreamManager(nc);
    const messaging = new Messaging(nc, jetstream(nc), jsm);
    await messaging.ensureStreams();
    return messaging;
  }

  private async ensureStream(
    config: Parameters<JetStreamManager["streams"]["add"]>[0],
  ): Promise<void> {
    try {
      await this.jsm.streams.info(config.name as string);
      await this.jsm.streams.update(config.name as string, config);
    } catch {
      await this.jsm.streams.add(config);
    }
  }

  private async ensureStreams(): Promise<void> {
    await this.ensureStream({
      name: COMMAND_STREAM,
      subjects: ["cmd.>"],
      retention: RetentionPolicy.Workqueue,
      storage: StorageType.File,
      duplicate_window: nanos(2 * 3_600_000),
      max_age: 14 * DAY_NS,
    });
    for (let i = 0; i < EVENT_STREAM_COUNT; i++) {
      await this.ensureStream({
        name: eventStreamName(i),
        subjects: [`events.${String(i).padStart(2, "0")}`],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        duplicate_window: nanos(2 * 3_600_000),
        max_age: 7 * DAY_NS,
      });
    }
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}

// ---------------------------------------------------------------------------------------------
// Command queues

export type QueueMessage<T = unknown> = {
  id: string;
  timestamp: Date;
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
};

export type QueueBatch<T = unknown> = {
  queue: string;
  messages: QueueMessage<T>[];
  ackAll(): void;
  retryAll(options?: { delaySeconds?: number }): void;
};

/** Producer side of one queue. */
export class QueueProducer {
  constructor(
    private readonly messaging: Messaging,
    readonly queue: string,
  ) {}

  async send(
    body: unknown,
    _options?: { contentType?: string; delaySeconds?: number },
  ): Promise<void> {
    await this.publish(body);
  }

  async sendBatch(
    messages: Iterable<{ body: unknown }>,
    _options?: { delaySeconds?: number },
  ): Promise<void> {
    for (const message of messages) await this.publish(message.body);
  }

  private async publish(body: unknown): Promise<void> {
    const id = (body as { commandId?: unknown } | null)?.commandId;
    const h = natsHeaders();
    h.set("rt-sent-at", String(Date.now()));
    await this.messaging.js.publish(
      `cmd.${this.queue}`,
      new TextEncoder().encode(JSON.stringify(body)),
      {
        headers: h,
        ...(typeof id === "string" ? { msgID: `${this.queue}:${id}` } : {}),
      },
    );
  }
}

export type QueueConsumerConfig = {
  queue: string;
  maxBatchSize: number;
  maxRetries: number;
  deadLetter?: QueueProducer;
  concurrency: number;
  retryDelaySeconds?: number;
  handler: (batch: QueueBatch) => Promise<void>;
};

/** Pulls batches from one queue and runs the handler, with the at-least-once rules above. */
export async function runQueueConsumer(
  messaging: Messaging,
  config: QueueConsumerConfig,
  signal: AbortSignal,
): Promise<void> {
  const durable = `q-${config.queue}`;
  const consumerConfig = {
    durable_name: durable,
    ack_policy: AckPolicy.Explicit,
    filter_subject: `cmd.${config.queue}`,
    ack_wait: nanos(HANDLER_ACK_WAIT_MS),
    max_deliver: -1,
    max_ack_pending: config.maxBatchSize * config.concurrency,
  };
  try {
    await messaging.jsm.consumers.info(COMMAND_STREAM, durable);
    await messaging.jsm.consumers.update(COMMAND_STREAM, durable, consumerConfig);
  } catch {
    await messaging.jsm.consumers.add(COMMAND_STREAM, consumerConfig);
  }
  const consumer = await messaging.js.consumers.get(COMMAND_STREAM, durable);
  const worker = async () => {
    while (!signal.aborted) {
      try {
        const fetched = await consumer.fetch({ max_messages: config.maxBatchSize, expires: 5000 });
        const raw: JsMsg[] = [];
        for await (const m of fetched) raw.push(m);
        if (raw.length > 0) await deliver(config, raw);
      } catch (error) {
        if (signal.aborted) return;
        log.error("queue.fetch", { queue: config.queue, error: String(error) });
        await Bun.sleep(2000);
      }
    }
  };
  await Promise.all(Array.from({ length: config.concurrency }, worker));
}

async function deliver(config: QueueConsumerConfig, raw: JsMsg[]): Promise<void> {
  type Decision = { kind: "ack" } | { kind: "retry"; delaySeconds: number } | null;
  const decisions: Decision[] = raw.map(() => null);
  const messages: QueueMessage[] = raw.map((m, i) => ({
    id: `${m.info.stream}:${m.seq}`,
    timestamp: new Date(Number(m.headers?.get("rt-sent-at") || Date.now())),
    body: JSON.parse(new TextDecoder().decode(m.data)),
    attempts: m.info.deliveryCount,
    ack: () => {
      decisions[i] = { kind: "ack" };
    },
    retry: (options) => {
      decisions[i] = {
        kind: "retry",
        delaySeconds: options?.delaySeconds ?? config.retryDelaySeconds ?? 0,
      };
    },
  }));
  const keepAlive = setInterval(() => {
    for (const m of raw) m.working();
  }, 30_000);
  let failed = false;
  try {
    await config.handler({
      queue: config.queue,
      messages,
      ackAll: () => {
        for (const m of messages) m.ack();
      },
      retryAll: (options) => {
        for (const m of messages) m.retry(options);
      },
    });
  } catch (error) {
    failed = true;
    log.error("queue.handler", { queue: config.queue, error: String(error).slice(0, 500) });
  } finally {
    clearInterval(keepAlive);
  }
  for (const [i, m] of raw.entries()) {
    const decision =
      decisions[i] ??
      (failed
        ? { kind: "retry" as const, delaySeconds: config.retryDelaySeconds ?? 0 }
        : { kind: "ack" as const });
    if (decision.kind === "ack") {
      m.ack();
      continue;
    }
    const message = messages[i] as QueueMessage;
    if (message.attempts > config.maxRetries) {
      if (config.deadLetter) await config.deadLetter.send(message.body);
      log.warn("queue.dead_letter", {
        queue: config.queue,
        id: message.id,
        attempts: message.attempts,
        toDeadLetter: Boolean(config.deadLetter),
      });
      m.term();
      continue;
    }
    m.nak(decision.delaySeconds * 1000);
  }
}

// ---------------------------------------------------------------------------------------------
// Event log

export type EventSendResult = { success: boolean; error?: { message: string; retryable: boolean } };

/** Producer of one event stream. Records carry an `event-id` header used for dedupe. */
export class EventStreamProducer {
  constructor(
    private readonly messaging: Messaging,
    private readonly index: number,
  ) {}

  async send(
    records: { content: Uint8Array; headers?: Record<string, string> }[],
  ): Promise<EventSendResult> {
    try {
      for (const record of records) {
        const h = natsHeaders();
        for (const [k, v] of Object.entries(record.headers ?? {})) h.set(k, v);
        const id = record.headers?.["event-id"];
        await this.messaging.js.publish(
          `events.${String(this.index).padStart(2, "0")}`,
          record.content,
          {
            headers: h,
            ...(id ? { msgID: id } : {}),
          },
        );
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: { message: String(error).slice(0, 300), retryable: true } };
    }
  }
}

export type EventRecord = {
  content: string;
  timestamp_ms?: number;
  headers?: Record<string, string>;
};
export type EventBatch = { batchId: string; records: EventRecord[] };

/**
 * Consumer client of one event stream. A subscription is a durable consumer. A batch is
 * acknowledged or returned as a whole. Record content is standard base64, as the router expects.
 */
export class EventLogClient {
  readonly #batches = new Map<string, JsMsg[]>();

  constructor(
    private readonly messaging: Messaging,
    private readonly index: number,
  ) {}

  private get stream(): string {
    return eventStreamName(this.index);
  }

  async resolveSubscription(name: string): Promise<string> {
    try {
      await this.messaging.jsm.consumers.info(this.stream, name);
    } catch {
      await this.messaging.jsm.consumers.add(this.stream, {
        durable_name: name,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: nanos(5 * 60_000),
      });
    }
    return name;
  }

  async consume(subscriptionId: string, _workerId: string): Promise<EventBatch | null> {
    const consumer = await this.messaging.js.consumers.get(this.stream, subscriptionId);
    const fetched = await consumer.fetch({ max_messages: 100, expires: 1000 });
    const msgs: JsMsg[] = [];
    for await (const m of fetched) msgs.push(m);
    if (msgs.length === 0) return null;
    const batchId = crypto.randomUUID();
    this.#batches.set(batchId, msgs);
    return {
      batchId,
      records: msgs.map((m) => {
        const recordHeaders: Record<string, string> = {};
        for (const key of m.headers?.keys() ?? []) recordHeaders[key] = m.headers?.get(key) ?? "";
        return {
          content: Buffer.from(m.data).toString("base64"),
          timestamp_ms: Math.floor(m.info.timestampNanos / 1e6),
          headers: recordHeaders,
        };
      }),
    };
  }

  async ack(_subscriptionId: string, batchId: string, _workerId: string): Promise<void> {
    for (const m of this.#batches.get(batchId) ?? []) m.ack();
    this.#batches.delete(batchId);
  }

  async nack(_subscriptionId: string, batchId: string, _workerId: string): Promise<void> {
    for (const m of this.#batches.get(batchId) ?? []) m.nak(30_000);
    this.#batches.delete(batchId);
  }
}
