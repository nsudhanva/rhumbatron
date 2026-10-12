import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";

/**
 * Graph reads over the API Worker (service binding `API`), on the web Worker with the user's Clerk
 * session token. The Agents and Events DAGs read the endpoints in lib/api.ts; this
 * file holds the Product Graph read (workers/api product-graph.ts).
 */

async function call<T>(path: string): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new Error("Sign in to continue");
  const response = await env.API.fetch(
    new Request(`https://api.internal${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }),
  );
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok || json.data === undefined) {
    throw new Error(json.error?.message ?? `API returned ${response.status}`);
  }
  return json.data;
}

/**
 * Product Graph, derived by the API from Task resources, Intents, Task
 * dependencies, ChangeSets, conflicts, the stored Product Graph of the indexed canonical tree
 * (P7-04), and the protected resources of the Project's own stored policy.
 */
export type ProductGraphEdgeOrigin =
  | { kind: "source_import"; file: string; detail: string }
  | { kind: "task_dependency"; changeId: string; taskKey: string; dependsOnTaskKey: string }
  | { kind: "shared_task"; changeId: string; taskKey: string; resources: string[] };

export type ProductGraphNode = {
  id: string;
  name: string;
  /** Present in the indexed canonical source. */
  baseline: boolean;
  baselineFile: string | null;
  sourceFiles: string[];
  sourceResources: string[];
  /** Protected resources of the Project's stored policy in this area. */
  protectedResources: string[];
  touches: {
    changeId: string;
    resources: string[];
    tasks: { id: string; key: string; title: string; kind: string; status: string }[];
    changeSetCount: number;
  }[];
  conflicts: { id: string; changeId: string; resource: string; state: string }[];
};

export type ProductGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "authorization" | "product_reference" | "state" | "dependency";
  label: string;
  changeIds: string[];
  origins: ProductGraphEdgeOrigin[];
  moreOrigins: number;
};

export type ProductGraph = {
  projectId: string;
  canonicalGeneration: number | null;
  /** Version of the Project's stored policy; null when the Project has none. */
  policyVersion: string | null;
  /** Stored policy protected resources whose area is in the graph. */
  protectedResources: string[];
  source:
    | { kind: "index"; treeSha: string; commit: string | null; builtAt: string; current: boolean }
    | { kind: "none" };
  /** Runtime wiring files of the indexed tree, not shown as areas. */
  wiringFiles: string[];
  /** Oldest first, newest 20. */
  changes: { id: string; goal: string; title?: string | null; status: string; createdAt: string }[];
  nodes: ProductGraphNode[];
  edges: ProductGraphEdge[];
  counts: {
    tasks: number;
    intents: number;
    dependencies: number;
    changeSets: number;
    conflicts: number;
  };
  truncated: boolean;
};

export const getProjectProductGraph = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProductGraph>(`/v1/projects/${data}/product-graph`));
