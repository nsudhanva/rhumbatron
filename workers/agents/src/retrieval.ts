import {
  EMBEDDING_MODEL,
  type IntentInput,
  loadRetrieval,
  type Retrieval,
  type SemanticMatch,
} from "@rhumbatron/context-compiler";
import type { ProjectRootDO } from "@rhumbatron/coordinator";

/**
 * Context Compiler input loader for agent runs (P7-06). Reads the stored
 * indexes of the canonical tree (rhumbatron-indexer) and, after them, at most one Vectorize query.
 * Never throws: without an index the packet keeps only the exact file list.
 *
 * Free-limit guard: at most QUERY_DAILY_CAP query embeddings per UTC day. One query is
 * about 100 tokens of bge-small-en-v1.5 (well under 1 Neuron) and 384 queried dimensions.
 */

const QUERY_DAILY_CAP = 1_000;

export type TaskRetrievalInput = {
  projectId: string;
  /** Canonical commit the run reads; the index must be of the same commit. */
  commit: string;
  taskId: string;
  texts: string[];
  resources: string[];
  dependencyIntents: IntentInput[];
  inheritedFiles: string[];
};

async function takeDailyQuota(db: D1Database, counter: string, cap: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, 1)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(new Date().toISOString().slice(0, 10), counter, cap)
    .first<{ count: number }>();
  return row !== null;
}

const stringList = (value: unknown) =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

export async function taskRetrieval(
  env: Env,
  input: TaskRetrievalInput,
): Promise<Retrieval | null> {
  try {
    const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await root.get(root.idFromName(input.projectId)).getCanonical();
    if (!canonical || canonical.artifactRef === "unassigned") return null;

    const retrieval = await loadRetrieval(
      {
        read: async (key) => {
          const object = await env.EVIDENCE.get(key);
          return object ? ((await object.json()) as unknown) : null;
        },
        search: async (text, projectId, topK): Promise<SemanticMatch[] | null> => {
          if (!(await takeDailyQuota(env.DB, "context-embed", QUERY_DAILY_CAP))) return null;
          const embedded = (await env.AI.run(EMBEDDING_MODEL, { text: [text] })) as {
            data?: number[][];
          };
          const vector = embedded.data?.[0];
          if (!vector) return null;
          // Namespace is the Project: Vectorize never searches another Project's vectors.
          const result = await env.MEMORY.query(vector, {
            topK,
            namespace: projectId,
            returnMetadata: "all",
          });
          return result.matches.map((m) => ({
            id: m.id,
            score: m.score,
            metadata: (m.metadata ?? null) as Record<string, unknown> | null,
          }));
        },
      },
      {
        projectId: input.projectId,
        treeSha: canonical.treeSha,
        taskTexts: input.texts,
        upstreamFiles: [
          ...input.dependencyIntents.flatMap((i) => stringList(i.intent.expectedFiles)),
          ...input.inheritedFiles,
        ],
        resources: input.resources,
      },
    );
    // The canonical tree moved between the run's source read and this one: no mixed inputs.
    if (!retrieval || retrieval.commit !== input.commit) return null;

    const count = (tier: string) => retrieval.files.filter((f) => f.tier === tier).length;
    env.METRICS.writeDataPoint({
      blobs: ["context_retrieval", retrieval.semantic.status, input.taskId],
      doubles: [
        count("declared"),
        count("dependency"),
        retrieval.owners.length,
        count("semantic"),
        retrieval.semantic.refused,
      ],
      indexes: [input.projectId],
    });
    return retrieval;
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "context.retrieval_failed",
        projectId: input.projectId,
        taskId: input.taskId,
        error: String(error).slice(0, 200),
      }),
    );
    return null;
  }
}
