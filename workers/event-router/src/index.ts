import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProjectViewDO } from "@rhumbatron/coordinator";
import type { EventEnvelope } from "@rhumbatron/protocol";
import { claimEvents, releaseEvents } from "./dedupe.ts";
import {
  APPLY_DELTA_CAP,
  K2Client,
  K2Error,
  MAX_CONSUMES_PER_SUBSCRIPTION,
  parseStreamIds,
  SUBSCRIPTIONS,
  type SubscriptionName,
  sweepStreamIndex,
} from "./k2-consumer.ts";
import { decodeEnvelope, groupByProject, planProjects, toViewDelta } from "./projector.ts";

/**
 * K2 pull consumer (AGENTS.md sections 12.5, 19, 31.1). Two subscriptions per stream:
 * `project-view-projector` updates ProjectViewDO; `causal-router` only dedupes for now.
 * Subrequest budget per invocation, worst case, both subscriptions on one stream:
 *   per subscription: 1 resolve + 2 consume + 2 ack/nack + 2 D1 claim batches + 2 D1 release batches
 *   shared: at most APPLY_DELTA_CAP (15) applyDelta calls
 *   total: 2 * 9 + 15 = 33, below the Workers Free limit of 50.
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

/** Handles one consumed batch. Returns the number of fresh events and whether to ack. */
async function handleBatch(
  run: Run,
  sub: SubscriptionName,
  records: { content: string }[],
): Promise<{ fresh: number; ack: boolean }> {
  const events: EventEnvelope[] = [];
  let invalid = 0;
  for (const record of records) {
    const event = decodeEnvelope(record.content);
    if (event) events.push(event);
    else invalid += 1;
  }
  if (invalid > 0)
    log({ event: "router.invalid_records", stream: run.streamIndex, sub, count: invalid });

  const freshIds = await claimEvents(
    run.env.DB,
    sub,
    events.map((e) => e.eventId),
  );
  const seen = new Set<string>();
  const fresh = events.filter((event) => {
    if (!freshIds.has(event.eventId) || seen.has(event.eventId)) return false;
    seen.add(event.eventId);
    return true;
  });

  if (sub === "causal-router") {
    // Deterministic routing to Queues arrives in Phase 5. Record only.
    log({ event: "router.batch", stream: run.streamIndex, count: records.length });
    return { fresh: fresh.length, ack: true };
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
  return { fresh: fresh.length - unapplied.length, ack: unapplied.length === 0 };
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

      let outcome: { fresh: number; ack: boolean };
      try {
        stage = "process";
        outcome = await handleBatch(run, sub, batch.records);
      } catch (error) {
        log({ event: "router.process_failed", stream: run.streamIndex, sub, ...errorInfo(error) });
        stage = "nack";
        await run.k2.nack(subscriptionId, batch.batchId, workerId);
        break;
      }

      processed += outcome.fresh;
      stage = outcome.ack ? "ack" : "nack";
      if (outcome.ack) await run.k2.ack(subscriptionId, batch.batchId, workerId);
      else {
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

async function processStream(env: Env, streamIndex: number): Promise<number> {
  const streamId = parseStreamIds(env.K2_STREAM_IDS)[streamIndex];
  if (!streamId || !env.K2_CONSUMER_TOKEN) return 0;
  const run: Run = {
    env,
    streamIndex,
    k2: new K2Client(streamId, env.K2_CONSUMER_TOKEN),
    applyBudget: { remaining: APPLY_DELTA_CAP },
  };
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

  /** Safety-net sweep: one stream per tick. */
  override async scheduled(controller: ScheduledController): Promise<void> {
    const count = parseStreamIds(this.env.K2_STREAM_IDS).length;
    const index = sweepStreamIndex(controller.scheduledTime, count);
    if (index < 0) return;
    await processStream(this.env, index);
  }

  /** Fast path: the coordinator calls this through a service binding after publishing. */
  async nudge(streamIndex: number): Promise<{ processed: number }> {
    if (!Number.isInteger(streamIndex) || streamIndex < 0) return { processed: 0 };
    return { processed: await processStream(this.env, streamIndex) };
  }
}
