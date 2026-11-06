/**
 * Rhumbatron core: the composition root. One Bun process hosts the API, the coordinator actors,
 * the agents, integration, the event router and the indexer. It builds their bindings from
 * open-source backends:
 *
 *   SQL, KV, vectors, metrics   SQLite (bun:sqlite), one file on the data volume
 *   actors                      the actor host, one SQLite file per actor
 *   workflows                   the workflow engine, SQLite
 *   queues and event log        NATS JetStream
 *   objects                     an S3-compatible store (versitygw)
 *   source repositories         the git service
 *   sandboxes                   sandboxd (sibling containers)
 *   generated apps              the apps service (workerd)
 *   embeddings, rerank          llama.cpp servers; Clef questions go to Claude Haiku
 *
 * Start it with `bun --preload ./packages/platform/src/preload.ts services/core/src/main.ts`.
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { ActorSystem } from "../../../packages/platform/src/actors/host.ts";
import type { BridgeData } from "../../../packages/platform/src/actors/websocket.ts";
import { attachClient, type PairSocket } from "../../../packages/platform/src/actors/websocket.ts";
import { SmallModels } from "../../../packages/platform/src/ai/models.ts";
import { log } from "../../../packages/platform/src/log.ts";
import {
  EVENT_STREAM_COUNT,
  EventLogClient,
  EventStreamProducer,
  Messaging,
  QueueProducer,
  runQueueConsumer,
} from "../../../packages/platform/src/messaging/jetstream.ts";
import { ObjectBucket } from "../../../packages/platform/src/objects/bucket.ts";
import { setProcessBindings } from "../../../packages/platform/src/runtime-module.ts";
import { SqlDatabase } from "../../../packages/platform/src/sql/database.ts";
import { KeyValueStore } from "../../../packages/platform/src/sql/kv.ts";
import { MetricsDataset } from "../../../packages/platform/src/sql/metrics.ts";
import { VectorIndex } from "../../../packages/platform/src/sql/vectors.ts";
import { WorkflowEngine } from "../../../packages/platform/src/workflows/engine.ts";
import { browserBinding } from "./browser.ts";
import { config } from "./config.ts";
import { type ConsumerSpec, QUEUE_CONSUMERS } from "./consumers.ts";
import { scheduleExpiry } from "./expiry.ts";
import { internalRoutes } from "./internal.ts";
import { appsBinding, artifactsBinding, sandboxBinding } from "./services.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const W = (name: string) => join(ROOT, "workers", name, "src", "index.ts");

// --- Backends ---------------------------------------------------------------------------------

mkdirSync(config.dataDir, { recursive: true });
const db = new SqlDatabase(join(config.dataDir, "rhumbatron.sqlite"));
db.migrate(join(ROOT, "migrations", "d1"));
const actors = new ActorSystem(config.dataDir);
const workflows = new WorkflowEngine(join(config.dataDir, "workflows.sqlite"));
const messaging = await Messaging.connect(config.natsUrl);
const evidence = new ObjectBucket(config.objects);

const queue = (name: string) => new QueueProducer(messaging, name);
const queues = {
  agentWakeups: queue("agent-wakeups"),
  integration: queue("integration"),
  verification: queue("verification"),
  indexing: queue("indexing"),
  release: queue("release"),
  deadLetter: queue("dead-letter"),
};

// --- Application modules ----------------------------------------------------------------------

const api = (await import(W("api"))).default as {
  fetch(r: Request, env: unknown, ctx: unknown): Promise<Response>;
};
const coordinator = await import(W("coordinator"));
const agents = await import(W("agents"));
const integration = await import(W("integration"));
const eventRouter = await import(W("event-router"));
const indexer = (await import(W("indexer"))).default as {
  queue(batch: unknown, env: unknown, ctx: unknown): Promise<void>;
};

// --- The shared environment -------------------------------------------------------------------

const env: Record<string, unknown> = {
  ENVIRONMENT: "local",
  ...config.vars,
  DB: db,
  EVIDENCE: evidence,
  CONFIG: new KeyValueStore(db.handle, "config"),
  MEMORY: new VectorIndex(db.handle, "memory", 384),
  METRICS: new MetricsDataset(db.handle, "metrics"),
  EVENT_METRICS: new MetricsDataset(db.handle, "event_metrics"),
  AI: new SmallModels(config.models),
  PROJECT_ROOT: actors.namespace("ProjectRootDO"),
  RESOURCE_SHARD: actors.namespace("ResourceShardDO"),
  PROJECT_VIEW: actors.namespace("ProjectViewDO"),
  AGENT: actors.namespace("AgentDO"),
  CHANGE_WORKFLOW: workflows.binding("ChangeWorkflow"),
  CANDIDATE_WORKFLOW: workflows.binding("CandidateVerificationWorkflow"),
  RELEASE_WORKFLOW: workflows.binding("ReleaseWorkflow"),
  AGENT_WAKEUPS: queues.agentWakeups,
  INTEGRATION_COMMANDS: queues.integration,
  VERIFICATION_COMMANDS: queues.verification,
  INDEXING: queues.indexing,
  RELEASE_COMMANDS: queues.release,
  EVENT_LOG: {
    client: (index: number) => new EventLogClient(messaging, index),
    streams: EVENT_STREAM_COUNT,
  },
  ARTIFACTS: artifactsBinding(),
  SANDBOX: sandboxBinding(),
  APPS: appsBinding(),
  BROWSER: browserBinding(),
};
for (let i = 0; i < EVENT_STREAM_COUNT; i++)
  env[`EVENTS_${String(i).padStart(2, "0")}`] = new EventStreamProducer(messaging, i);

const envFor = (service: string) => ({ ...env, SERVICE_NAME: `rhumbatron-${service}` });

/** A WorkerEntrypoint instance, used as a service binding: its methods are RPC targets. */
function entrypoint(
  Cls: new (ctx: unknown, env: unknown) => unknown,
  service: string,
): Record<string, unknown> {
  return new Cls(
    { waitUntil: (p: Promise<unknown>) => actors.track(p), passThroughOnException() {}, props: {} },
    envFor(service),
  ) as Record<string, unknown>;
}

const routerEntrypoint = entrypoint(eventRouter.default, "event-router");
const integrationEntrypoint = entrypoint(integration.default, "integration");
const agentsEntrypoint = entrypoint(agents.default, "agents");
env.EVENT_ROUTER = routerEntrypoint;
env.INTEGRATION = integrationEntrypoint;
env.AGENTS = agentsEntrypoint;

// --- Actors and workflows ---------------------------------------------------------------------

const classes: Record<string, unknown> = {
  ProjectRootDO: coordinator.ProjectRootDO,
  ResourceShardDO: coordinator.ResourceShardDO,
  ProjectViewDO: coordinator.ProjectViewDO,
  AgentDO: agents.AgentDO,
};
const exportsMap: Record<string, unknown> = {};
for (const [name, cls] of Object.entries(classes)) {
  const service = name === "AgentDO" ? "agents" : "coordinator";
  actors.register(
    name,
    cls as never,
    () => envFor(service),
    () => exportsMap,
  );
  exportsMap[name] = actors.namespace(name);
}
workflows.register("ChangeWorkflow", integration.ChangeWorkflow, () => envFor("integration"));
workflows.register("CandidateVerificationWorkflow", integration.CandidateVerificationWorkflow, () =>
  envFor("integration"),
);
workflows.register("ReleaseWorkflow", integration.ReleaseWorkflow, () => envFor("integration"));
setProcessBindings(env, exportsMap);

// --- Queue consumers --------------------------------------------------------------------------

const shutdown = new AbortController();
const handlers: Record<ConsumerSpec["service"], (batch: unknown) => Promise<void>> = {
  agents: (b) =>
    (agentsEntrypoint.queue as (b: unknown) => Promise<void>).call(agentsEntrypoint, b),
  integration: (b) =>
    (integrationEntrypoint.queue as (b: unknown) => Promise<void>).call(integrationEntrypoint, b),
  "event-router": (b) =>
    (routerEntrypoint.queue as (b: unknown) => Promise<void>).call(routerEntrypoint, b),
  indexer: (b) =>
    indexer.queue(b, envFor("indexer"), { waitUntil: (p: Promise<unknown>) => actors.track(p) }),
};
for (const spec of QUEUE_CONSUMERS) {
  void runQueueConsumer(
    messaging,
    {
      queue: spec.queue,
      maxBatchSize: spec.batch,
      maxRetries: spec.retries,
      concurrency: spec.concurrency,
      ...(spec.deadLetter ? { deadLetter: queues.deadLetter } : {}),
      handler: handlers[spec.service],
    },
    shutdown.signal,
  ).catch((error) =>
    log.error("queue.consumer_stopped", { queue: spec.queue, error: String(error) }),
  );
}

// --- Schedules --------------------------------------------------------------------------------

actors.resumeAlarms();
workflows.resume();

/** The event router's per-minute sweep, aligned to the minute like a cron trigger. */
function scheduleSweep(): void {
  const next = Math.ceil((Date.now() + 1) / 60_000) * 60_000;
  setTimeout(async () => {
    try {
      await (routerEntrypoint.scheduled as (c: unknown) => Promise<void>).call(routerEntrypoint, {
        scheduledTime: next,
        cron: "* * * * *",
        noRetry() {},
      });
    } catch (error) {
      log.error("sweep.failed", { error: String(error).slice(0, 300) });
    }
    if (!shutdown.signal.aborted) scheduleSweep();
    scheduleExpiry(evidence, shutdown.signal);
  }, next - Date.now());
}
scheduleSweep();

// --- HTTP -------------------------------------------------------------------------------------

const apiEnv = envFor("api");
const ctx = {
  waitUntil: (p: Promise<unknown>) => actors.track(p),
  passThroughOnException() {},
  props: {},
};

/**
 * `GET /live/projects/:id` from the web origin. Caddy routes it here. The browser sends only its
 * Clerk session cookie; it becomes the bearer token of the API's live route. The Origin header
 * must be the web origin, so another site cannot open the socket with the cookie.
 */
function liveRequest(request: Request, url: URL): Request | Response {
  const match = /^\/live\/projects\/(proj_[a-z0-9-]+)$/.exec(url.pathname);
  if (!match) return new Response("Not Found", { status: 404 });
  if (request.headers.get("origin") !== config.webOrigin)
    return new Response("Forbidden", { status: 403 });
  const session = /(?:^|;\s*)__session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  if (!session) return new Response("Sign in to continue", { status: 401 });
  const target = new URL(`/v1/projects/${match[1]}/live${url.search}`, url);
  return new Request(target, {
    headers: { upgrade: "websocket", authorization: `Bearer ${decodeURIComponent(session)}` },
  });
}

const server = Bun.serve<BridgeData>({
  port: config.port,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(request, srv) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    let forwarded: Request = request;
    if (url.pathname.startsWith("/live/")) {
      const live = liveRequest(request, url);
      if (live instanceof Response) return live;
      forwarded = live;
    }
    const response = await api.fetch(forwarded, apiEnv, ctx);
    const client = (response as Response & { webSocket?: PairSocket | null }).webSocket;
    if (response.status === 101 && client) {
      if (srv.upgrade(request, { data: { client } })) return undefined;
      client.close(1011, "upgrade failed");
      return new Response("Upgrade failed", { status: 500 });
    }
    return response;
  },
  websocket: {
    open(ws) {
      attachClient(ws.data.client, ws);
    },
    message(ws, message) {
      ws.data.client.send(
        typeof message === "string"
          ? message
          : (message.buffer.slice(
              message.byteOffset,
              message.byteOffset + message.byteLength,
            ) as ArrayBuffer),
      );
    },
    close(ws, code, reason) {
      ws.data.client.close(code, reason);
    },
  },
});

const internal = Bun.serve({
  port: config.internalPort,
  hostname: "0.0.0.0",
  fetch: internalRoutes({ db, evidence, token: config.internalToken }),
});

log.info("core.started", { port: server.port, internalPort: internal.port });

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    log.info("core.stopping", { signal });
    shutdown.abort();
    server.stop();
    internal.stop();
    await actors.drain();
    await messaging.close();
    process.exit(0);
  });
}
