import type { WorkflowStep } from "cloudflare:workers";
import { ProjectPolicy } from "@rhumbatron/protocol";
import { z } from "zod";
import { DEFAULT_POLICY } from "./candidate-composer.ts";

/**
 * Project policy snapshot. D1 `project_policies` is the
 * source of truth; Workers KV (binding CONFIG) holds a read-through copy for at most
 * POLICY_CACHE_TTL_SECONDS. A Project without a row gets DEFAULT_POLICY, which protects no
 * resource (protected resources are Project-specific), and that answer is cached too, so a read never needs D1 while the copy is fresh. No write path exists yet: a policy row
 * written by hand takes effect within the TTL. A future write path must delete the key.
 *
 * Volume: one KV read per promotion attempt and approval decision; one KV write per Project per
 * TTL window on a miss. Tens of each per day, far inside the free 100,000 reads and 1,000 writes.
 */

/** KV expiry of a snapshot. KV's minimum is 60 seconds. */
const POLICY_CACHE_TTL_SECONDS = 300;
/** Edge cache of a KV read. 60 seconds is KV's minimum. */
const EDGE_CACHE_TTL_SECONDS = 60;

export const policyKey = (projectId: string) => `policy:v2:${projectId}`;

const Snapshot = z.object({ source: z.enum(["d1", "default"]), policy: ProjectPolicy });
type Snapshot = z.infer<typeof Snapshot>;

type PolicyEnv = Pick<Env, "DB"> & { CONFIG?: Pick<KVNamespace, "get" | "put"> };

const log = (line: Record<string, unknown>) => console.warn(JSON.stringify(line));

/** The D1 snapshot. Throws on an invalid stored policy: a broken policy must not pass as default. */
async function readStored(env: PolicyEnv, projectId: string): Promise<Snapshot> {
  const row = await env.DB.prepare("SELECT policy_json FROM project_policies WHERE project_id = ?")
    .bind(projectId)
    .first<{ policy_json: string }>();
  if (!row) return { source: "default", policy: DEFAULT_POLICY };
  let json: unknown;
  try {
    json = JSON.parse(row.policy_json);
  } catch {
    json = null;
  }
  const parsed = ProjectPolicy.safeParse(json);
  if (!parsed.success) throw new Error(`Stored policy of Project ${projectId} is invalid`);
  return { source: "d1", policy: parsed.data };
}

/**
 * The Project's policy. KV first; on a miss, a KV failure, or a malformed copy, D1, then a
 * best-effort KV write. A KV failure never fails the caller.
 */
export async function loadProjectPolicy(env: PolicyEnv, projectId: string): Promise<ProjectPolicy> {
  const key = policyKey(projectId);
  if (env.CONFIG) {
    try {
      const cached = Snapshot.safeParse(
        await env.CONFIG.get(key, { type: "json", cacheTtl: EDGE_CACHE_TTL_SECONDS }),
      );
      // A cached default answer means "no row": the default of the running code applies, so a
      // changed DEFAULT_POLICY takes effect at deploy, not after the cache expires.
      if (cached.success) {
        return cached.data.source === "default" ? DEFAULT_POLICY : cached.data.policy;
      }
    } catch (error) {
      log({ event: "policy.cache_read_failed", projectId, message: String(error).slice(0, 200) });
    }
  }
  const snapshot = await readStored(env, projectId);
  if (env.CONFIG) {
    try {
      await env.CONFIG.put(key, JSON.stringify(snapshot), {
        expirationTtl: POLICY_CACHE_TTL_SECONDS,
      });
    } catch (error) {
      log({ event: "policy.cache_write_failed", projectId, message: String(error).slice(0, 200) });
    }
  }
  return snapshot.policy;
}

/**
 * One policy read per Workflow run (verification, plan, approval gate, auto-promotion). The first
 * call for a Project runs one step; later calls in the run reuse its result, and a replay reads
 * the step result instead of KV or D1.
 */
export function policyForRun(env: PolicyEnv, step: Pick<WorkflowStep, "do">) {
  const loaded = new Map<string, Promise<ProjectPolicy>>();
  return (projectId: string): Promise<ProjectPolicy> => {
    let policy = loaded.get(projectId);
    if (!policy) {
      policy = step.do(`load project policy ${projectId}`, () =>
        loadProjectPolicy(env, projectId),
      ) as Promise<ProjectPolicy>;
      loaded.set(projectId, policy);
    }
    return policy;
  };
}
