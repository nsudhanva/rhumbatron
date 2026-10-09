import { EMBEDDING_MODEL } from "@rhumbatron/context-compiler";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { AnyCommandEnvelope } from "@rhumbatron/protocol";
import {
  type Bucket,
  buildIndex,
  type IndexerDeps,
  purgeIndex,
  RetryLater,
  recordFailure,
} from "./handler.ts";
import { readCanonicalTree } from "./source.ts";

/**
 * rhumbatron-indexer (AGENTS.md section 12.7): consumes `rhumbatron-indexing`. Exact symbol and
 * dependency indexes, the Product Graph store, and Vectorize file summaries per canonical tree.
 * Queue consumer settings live in Terraform (`cloudflare_queue_consumer.indexing`): max_retries 3,
 * no dead-letter Queue. The last failed delivery is recorded in D1 `project_indexes` instead.
 */

/** Same as the consumer's max_retries: deliveries after the first. */
const MAX_RETRIES = 3;
const RETRY_DELAY_SECONDS = 30;
/** R2 list pages read per purge (1,000 keys each). */
const PURGE_PAGES = 5;

const log = (line: Record<string, unknown>) => console.warn(JSON.stringify(line));

function bucketOf(r2: R2Bucket): Bucket {
  return {
    getJson: async (key) => {
      const object = await r2.get(key);
      return object ? ((await object.json()) as unknown) : null;
    },
    putJson: async (key, value) => {
      await r2.put(key, JSON.stringify(value), {
        httpMetadata: { contentType: "application/json" },
      });
    },
    list: async (prefix) => {
      const keys: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < PURGE_PAGES; page += 1) {
        const listed = await r2.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
        keys.push(...listed.objects.map((o) => o.key));
        if (!listed.truncated) break;
        cursor = listed.cursor;
      }
      return keys;
    },
    delete: async (keys) => {
      for (let i = 0; i < keys.length; i += 1000) await r2.delete(keys.slice(i, i + 1000));
    },
  };
}

function depsOf(env: Env): IndexerDeps {
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return {
    db: env.DB,
    bucket: bucketOf(env.EVIDENCE),
    canonical: async (projectId) => {
      const c = await root.get(root.idFromName(projectId)).getCanonical();
      return c && c.artifactRef !== "unassigned"
        ? { treeSha: c.treeSha, generation: c.generation }
        : null;
    },
    readSource: (projectId, commit, treeSha) =>
      readCanonicalTree(env.ARTIFACTS, projectId, commit, treeSha),
    memory: env.MEMORY,
    embed: async (texts) => {
      const out = (await env.AI.run(EMBEDDING_MODEL, { text: texts })) as { data?: number[][] };
      return out.data ?? [];
    },
    metric: (point) => env.METRICS.writeDataPoint(point),
    now: () => new Date().toISOString(),
  };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: env.SERVICE_NAME, environment: env.ENVIRONMENT });
    }
    return new Response("Not Found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    const deps = depsOf(env);
    // batch_size 1 and max_concurrency 1 (Terraform): builds never race on a vector manifest.
    for (const message of batch.messages) {
      const parsed = AnyCommandEnvelope.safeParse(message.body);
      if (!parsed.success) {
        log({ event: "indexer.invalid_command" });
        message.ack();
        continue;
      }
      const command = parsed.data;
      const rawTree = (command.payload as { treeSha?: unknown } | null)?.treeSha;
      // Absent for the daily backfill: build the current canonical tree.
      const treeSha = typeof rawTree === "string" && rawTree.length > 0 ? rawTree : null;
      const last = message.attempts > MAX_RETRIES;
      if (last && command.commandType === "index.build" && treeSha) {
        // Marked before the last try: a crash (CPU or memory limit) still leaves a visible row.
        // A successful build overwrites it with `ready`.
        await recordFailure(
          deps,
          command.projectId,
          treeSha,
          "last delivery started; no result recorded",
        ).catch(() => undefined);
      }
      try {
        if (command.commandType === "index.build") {
          const outcome = await buildIndex(deps, command.projectId, treeSha);
          if (last && treeSha && outcome.result !== "built") {
            // Superseded or no source: not a failure. Drop the pre-mark.
            await env.DB.prepare(
              "DELETE FROM project_indexes WHERE project_id = ? AND tree_sha = ? AND status = 'failed'",
            )
              .bind(command.projectId, treeSha)
              .run();
          }
          log({ event: "indexer.build", projectId: command.projectId, treeSha, ...outcome });
        } else if (command.commandType === "index.purge") {
          const purged = await purgeIndex(deps, command.projectId);
          log({ event: "indexer.purge", projectId: command.projectId, ...purged });
        } else {
          log({ event: "indexer.unknown_command", commandType: command.commandType });
        }
        message.ack();
      } catch (error) {
        const detail = String(error).slice(0, 300);
        log({
          event: "indexer.failed",
          projectId: command.projectId,
          commandType: command.commandType,
          attempts: message.attempts,
          retryLater: error instanceof RetryLater,
          last,
          error: detail,
        });
        if (!last) {
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
          continue;
        }
        if (command.commandType === "index.build" && treeSha) {
          await recordFailure(deps, command.projectId, treeSha, detail).catch(() => undefined);
        }
        message.ack();
      }
    }
  },
} satisfies ExportedHandler<Env>;
