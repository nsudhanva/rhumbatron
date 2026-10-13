import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProjectViewDO } from "@rhumbatron/coordinator";
import type { EventEnvelope } from "@rhumbatron/protocol";
import { ANALYTICS_POINT_CAP, analyticsPoint } from "./analytics.ts";
import { buildArchive, writeArchive } from "./archive.ts";
import { routeCausalBatch } from "./causal.ts";
import { consumeDeadLetters } from "./dead-letter.ts";
import { claimEvents, releaseEvents } from "./dedupe.ts";
import { feedStatements } from "./feed.ts";
import {
  ANALYTICS_SUBSCRIPTION,
  APPLY_DELTA_CAP,
  ARCHIVE_SUBSCRIPTION,
  type ConsumedBatch,
  K2Client,
  K2Error,
  MAX_CONSUMES_PER_SUBSCRIPTION,
  parseStreamIds,
  SUBSCRIPTIONS,
  type SubscriptionName,
  sweepStreamIndex,
} from "./k2-consumer.ts";
import {
  isMaintenanceTick,
  isReleaseSweepTick,
  queueIndexPurges,
  queueMaintenance,
  queueReleaseRecovery,
  queueStuckChanges,
} from "./maintenance.ts";
import { batchKey, countBatchFailure, deadLetterBatch, shouldSkipBatch } from "./poison-batch.ts";
import { decodeEnvelope, groupByProject, planProjects, toViewDelta } from "./projector.ts";

/**
 * K2 pull consumer. Two subscriptions per stream:
 * `project-view-projector` updates ProjectViewDO; `causal-router` wakes affected agents.
 * Subrequest budget per invocation, worst case, both subscriptions on one stream:
 *   per subscription: 1 resolve + 2 consume + 2 ack/nack + 2 D1 claim batches + 2 D1 release batches
 *     + 2 D1 batches for one failed delivery (count, dead-letter); a failure ends the subscription
 *   shared: at most APPLY_DELTA_CAP (15) applyDelta calls
 *   total: 2 * 11 + 15 = 37, below the Workers Free limit of 50.
 * A batch that keeps failing is skipped after MAX_BATCH_FAILURES deliveries (poison-batch.ts).
 * The projector's event feed rows (feed.ts) ride in its D1 claim batch: no extra subrequest.
 */

const NOT_INITIALIZED = "ProjectViewDO is not initialized";

const projectView = (env: Env, projectId: string) => {
  const ns = env.PROJECT_VIEW as DurableObjectNamespace<ProjectViewDO>;
  return ns.get(ns.idFromName(projectId));
};

// Biome allows only warn and error; Workers Logs keeps them as structured JSON lines.
const log = (line: Record<string, unknown>) => console.warn(JSON.stringify(line));

/** Log "view not initialized" once per project per isolate. */
const warnedProjects = new Set<string>();

type Run = {
  env: Env;
  streamIndex: number;
  k2: K2Client;
  /** Remaining applyDelta calls for this invocation, shared by both subscriptions. */
  applyBudget: { remaining: number };
};

const errorInfo = (error: unknown) =>
  error instanceof K2Error
    ? { code: error.code, status: error.status, retryable: error.retryable, message: error.message }
    : { message: error instanceof Error ? error.message : "unknown error" };

/**
 * Outcome of one batch. `failure` is set when processing failed, so the delivery counts toward the
 * poison limit. A nack without it (events deferred by the applyDelta cap) is not a failure.
 */
type BatchOutcome = { fresh: number; ack: boolean; failure?: string };

/** Handles one consumed batch. Returns the number of fresh events and whether to ack. */
async function handleBatch(
  run: Run,
  sub: SubscriptionName,
  records: { content: string }[],
): Promise<BatchOutcome> {
  const events: EventEnvelope[] = [];
  let invalid = 0;
  for (const record of records) {
    const event = decodeEnvelope(record.content);
    if (event) events.push(event);
    else invalid += 1;
  }
  if (invalid > 0)
    log({ event: "router.invalid_records", stream: run.streamIndex, sub, count: invalid });

  // The projector also records every decoded event in the feed, in the same batch as its claims.
  // A redelivered event is ignored by the feed's UNIQUE event_id, so this needs no fresh check.
  const freshIds = await claimEvents(
    run.env.DB,
    sub,
    events.map((e) => e.eventId),
    new Date(),
    sub === "project-view-projector" ? feedStatements(run.env.DB, events) : [],
  );
  const seen = new Set<string>();
  const fresh = events.filter((event) => {
    if (!freshIds.has(event.eventId) || seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });

  if (sub === "causal-router") {
    try {
      const routed = await routeCausalBatch(run.env, fresh);
      log({ event: "router.routed", stream: run.streamIndex, count: records.length, ...routed });
      return { fresh: fresh.length, ack: true };
    } catch (error) {
      // Release the claims so the redelivered batch is routed again, not skipped as a duplicate.
      await releaseEvents(
        run.env.DB,
        sub,
        fresh.map((e) => e.eventId),
      );
      const info = errorInfo(error);
      log({ event: "router.route_failed", stream: run.streamIndex, ...info });
      return { fresh: 0, ack: false, failure: info.message };
    }
  }

  const { selected, deferred } = planProjects(groupByProject(fresh), run.applyBudget.remaining);
  run.applyBudget.remaining -= selected.length;

  const results = await Promise.allSettled(
    selected.map(([projectId, group]) =>
      projectView(run.env, projectId).applyDelta(toViewDelta(group)),
    ),
  );

  const unapplied: string[] = deferred.flatMap(([, group]) => group.map((e) => e.eventId));
  let failed = 0;
  results.forEach((result, index) => {
    const entry = selected[index];
    if (!entry || result.status === "fulfilled") return;
    const [projectId, group] = entry;
    const message = result.reason instanceof Error ? result.reason.message : "";
    if (message.includes(NOT_INITIALIZED)) {
      // The API initializes views on project creation. Skip this project's events.
      if (!warnedProjects.has(projectId)) {
        warnedProjects.add(projectId);
        log({ event: "router.view_not_initialized", projectId });
      }
      return;
    }
    failed += 1;
    unapplied.push(...group.map((e) => e.eventId));
    log({
      event: "router.apply_failed",
      stream: run.streamIndex,
      projectId,
      message: message.slice(0, 200),
    });
  });

  // Unapplied events must lose their claim, or redelivery would skip them as duplicates.
  if (unapplied.length > 0) await releaseEvents(run.env.DB, sub, unapplied);
  log({
    event: "router.projected",
    stream: run.streamIndex,
    count: records.length,
    applied: selected.length - failed,
    deferred: deferred.length,
    failed,
  });
  return {
    fresh: fresh.length - unapplied.length,
    ack: unapplied.length === 0,
    ...(failed > 0 ? { failure: `${failed} applyDelta call(s) failed` } : {}),
  };
}

/**
 * A failed delivery: counts it, and at the limit dead-letters the batch and acks it, so one poison
 * batch cannot block its subscription forever. Below the limit, or when counting fails, it nacks.
 */
async function failedDelivery(
  run: Run,
  sub: SubscriptionName,
  subscriptionId: string,
  batch: ConsumedBatch,
  workerId: string,
  failure: string,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    const key = await batchKey(batch.records);
    const failures = await countBatchFailure(run.env.DB, sub, key, failure, now);
    if (shouldSkipBatch(failures)) {
      const events = batch.records
        .map((r) => decodeEnvelope(r.content))
        .filter((e): e is EventEnvelope => e !== null);
      await deadLetterBatch(
        run.env.DB,
        {
          consumer: sub,
          stream: run.streamIndex,
          key,
          events,
          records: batch.records.length,
          failures,
          error: failure,
        },
        now,
      );
      await run.k2.ack(subscriptionId, batch.batchId, workerId);
      console.error(
        JSON.stringify({
          event: "router.batch_dead_lettered",
          stream: run.streamIndex,
          sub,
          batchKey: key,
          failures,
          records: batch.records.length,
          error: failure.slice(0, 200),
        }),
      );
      return;
    }
    log({ event: "router.batch_failed", stream: run.streamIndex, sub, batchKey: key, failures });
  } catch (error) {
    log({ event: "router.batch_count_failed", stream: run.streamIndex, sub, ...errorInfo(error) });
  }
  await run.k2.nack(subscriptionId, batch.batchId, workerId);
}

async function runSubscription(run: Run, sub: SubscriptionName): Promise<number> {
  const workerId = `${sub}-s${run.streamIndex}`;
  let processed = 0;
  let stage = "resolve";
  try {
    const subscriptionId = await run.k2.resolveSubscription(sub);
    for (let i = 0; i < MAX_CONSUMES_PER_SUBSCRIPTION; i += 1) {
      stage = "consume";
      const batch = await run.k2.consume(subscriptionId, workerId);
      if (!batch) break;

      let outcome: BatchOutcome;
      try {
        stage = "process";
        outcome = await handleBatch(run, sub, batch.records);
      } catch (error) {
        const info = errorInfo(error);
        log({ event: "router.process_failed", stream: run.streamIndex, sub, ...info });
        stage = "nack";
        await failedDelivery(run, sub, subscriptionId, batch, workerId, info.message);
        break;
      }

      processed += outcome.fresh;
      stage = outcome.ack ? "ack" : "nack";
      if (outcome.ack) await run.k2.ack(subscriptionId, batch.batchId, workerId);
      else if (outcome.failure) {
        await failedDelivery(run, sub, subscriptionId, batch, workerId, outcome.failure);
        break;
      } else {
        await run.k2.nack(subscriptionId, batch.batchId, workerId);
        break;
      }
    }
  } catch (error) {
    // Includes lease-gone (10218) and retryable K2 codes. The cron sweep is the retry; at-least-once
    // delivery plus dedupe makes a redelivered batch safe.
    log({ event: "router.k2_failed", stream: run.streamIndex, sub, stage, ...errorInfo(error) });
  }
  return processed;
}

/**
 * Archives one batch from the audit-archiver subscription to R2. Budget: 1 resolve + 1 consume +
 * 1 R2 put + 1 ack or nack. Invalid records are skipped; the batch is still archived and acked.
 */
async function runArchive(run: Run): Promise<number> {
  const workerId = `${ARCHIVE_SUBSCRIPTION}-s${run.streamIndex}`;
  try {
    const subscriptionId = await run.k2.resolveSubscription(ARCHIVE_SUBSCRIPTION);
    const batch = await run.k2.consume(subscriptionId, workerId);
    if (!batch) return 0;
    try {
      const events = batch.records
        .map((r) => decodeEnvelope(r.content))
        .filter((e): e is EventEnvelope => e !== null);
      const archive = await buildArchive(events, run.streamIndex);
      if (archive) await writeArchive(run.env.EVIDENCE, archive);
      await run.k2.ack(subscriptionId, batch.batchId, workerId);
      log({
        event: "router.archived",
        stream: run.streamIndex,
        count: events.length,
        key: archive?.key,
      });
      return events.length;
    } catch (error) {
      log({ event: "router.archive_failed", stream: run.streamIndex, ...errorInfo(error) });
      await run.k2.nack(subscriptionId, batch.batchId, workerId);
      return 0;
    }
  } catch (error) {
    log({
      event: "router.k2_failed",
      stream: run.streamIndex,
      sub: ARCHIVE_SUBSCRIPTION,
      ...errorInfo(error),
    });
    return 0;
  }
}

/**
 * Projects one batch from the analytics-projector subscription into Analytics Engine (section
 * 41.1, analytics.ts). Dedupe as the other consumers: only events whose (consumer, event) claim is
 * new write a point, so a redelivered batch writes nothing twice. Bounded: one batch of at most 100
 * records per tick, at most ANALYTICS_POINT_CAP points. Budget: 1 resolve + 1 consume + 1 D1 claim
 * batch + 1 ack or nack + 1 D1 release batch on failure = 5 subrequests. Data points are not
 * subrequests.
 */
async function runAnalytics(run: Run): Promise<number> {
  const workerId = `${ANALYTICS_SUBSCRIPTION}-s${run.streamIndex}`;
  try {
    const subscriptionId = await run.k2.resolveSubscription(ANALYTICS_SUBSCRIPTION);
    const batch = await run.k2.consume(subscriptionId, workerId);
    if (!batch) return 0;
    // Claimed but not yet written: released on a failure, so redelivery projects them.
    let unwritten = new Set<string>();
    let written = 0;
    let count = 0;
    try {
      const events = batch.records
        .map((r) => decodeEnvelope(r.content))
        .filter((e): e is EventEnvelope => e !== null);
      count = events.length;
      unwritten = await claimEvents(
        run.env.DB,
        ANALYTICS_SUBSCRIPTION,
        events.map((e) => e.eventId),
      );
      for (const event of events) {
        if (!unwritten.has(event.eventId)) continue;
        const point = analyticsPoint(event);
        if (point && written < ANALYTICS_POINT_CAP) {
          run.env.EVENT_METRICS.writeDataPoint(point);
          written += 1;
        }
        unwritten.delete(event.eventId);
      }
    } catch (error) {
      await releaseEvents(run.env.DB, ANALYTICS_SUBSCRIPTION, [...unwritten]).catch(
        () => undefined,
      );
      log({ event: "router.analytics_failed", stream: run.streamIndex, ...errorInfo(error) });
      await run.k2.nack(subscriptionId, batch.batchId, workerId);
      return 0;
    }
    // A failed ack redelivers the batch; its claims stay, so no point is written twice.
    await run.k2.ack(subscriptionId, batch.batchId, workerId);
    log({ event: "router.analytics", stream: run.streamIndex, count, written });
    return written;
  } catch (error) {
    log({
      event: "router.k2_failed",
      stream: run.streamIndex,
      sub: ANALYTICS_SUBSCRIPTION,
      ...errorInfo(error),
    });
    return 0;
  }
}

function newRun(env: Env, streamIndex: number): Run | null {
  const streamId = parseStreamIds(env.K2_STREAM_IDS)[streamIndex];
  if (!streamId || !env.K2_CONSUMER_TOKEN) return null;
  return {
    env,
    streamIndex,
    k2: new K2Client(streamId, env.K2_CONSUMER_TOKEN),
    applyBudget: { remaining: APPLY_DELTA_CAP },
  };
}

async function processStream(env: Env, streamIndex: number): Promise<number> {
  const run = newRun(env, streamIndex);
  if (!run) return 0;
  let processed = 0;
  for (const sub of SUBSCRIPTIONS) processed += await runSubscription(run, sub);
  return processed;
}

export default class EventRouter extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: this.env.SERVICE_NAME,
        environment: this.env.ENVIRONMENT,
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  /**
   * Safety-net sweep: one stream per tick. Once a day it also queues fork and Project cleanup;
   * every 5 minutes it queues recovery of Changes stuck in `releasing` (2 more subrequests).
   * Ticks without either also project one analytics batch (5 more subrequests), so the worst case
   * stays at 37 + 4 (archive) + 5 = 46, under the Workers Free limit of 50.
   */
  override async scheduled(controller: ScheduledController): Promise<void> {
    if (isMaintenanceTick(controller.scheduledTime)) {
      try {
        log({
          event: "router.maintenance",
          ...(await queueMaintenance(this.env, controller.scheduledTime)),
        });
      } catch (error) {
        log({ event: "router.maintenance_failed", ...errorInfo(error) });
      }
    }
    if (isReleaseSweepTick(controller.scheduledTime)) {
      try {
        const swept = await queueReleaseRecovery(this.env, controller.scheduledTime);
        if (swept.stuck > 0) log({ event: "router.release_sweep", ...swept });
      } catch (error) {
        log({ event: "router.release_sweep_failed", ...errorInfo(error) });
      }
      try {
        const settled = await queueStuckChanges(this.env, controller.scheduledTime);
        if (settled.stuck > 0) log({ event: "router.change_sweep", ...settled });
      } catch (error) {
        log({ event: "router.change_sweep_failed", ...errorInfo(error) });
      }
      try {
        const purged = await queueIndexPurges(this.env, controller.scheduledTime);
        if (purged.purges > 0) log({ event: "router.index_purge_sweep", ...purged });
      } catch (error) {
        log({ event: "router.index_purge_sweep_failed", ...errorInfo(error) });
      }
    }
    const count = parseStreamIds(this.env.K2_STREAM_IDS).length;
    const index = sweepStreamIndex(controller.scheduledTime, count);
    if (index < 0) return;
    await processStream(this.env, index);
    const run = newRun(this.env, index);
    if (!run) return;
    await runArchive(run);
    const housekeeping =
      isMaintenanceTick(controller.scheduledTime) || isReleaseSweepTick(controller.scheduledTime);
    if (!housekeeping) await runAnalytics(run);
  }

  /**
   * Dead-letter Queue consumer: records each poison command, blocks its
   * Task, and leaves the operator a retry or dismiss action. This is the only Queue it consumes.
   */
  override async queue(batch: MessageBatch): Promise<void> {
    await consumeDeadLetters(this.env, batch.messages, log);
  }

  /** Fast path: the coordinator calls this through a service binding after publishing. */
  async nudge(streamIndex: number): Promise<{ processed: number }> {
    if (!Number.isInteger(streamIndex) || streamIndex < 0) return { processed: 0 };
    return { processed: await processStream(this.env, streamIndex) };
  }
}
