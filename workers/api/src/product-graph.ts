import { indexKeys, type ProductGraphStore } from "@rhumbatron/context-compiler";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { changeTitle, ProjectPolicy } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Product Graph read model (AGENTS.md sections 28 and 38.3). Deterministic, no model call:
 *
 * - Source areas and imports: the stored Product Graph of the canonical tree (P7-04), written by
 *   rhumbatron-indexer to R2 `index/<project>/<tree>/product-graph.json` and pointed at by D1
 *   `project_indexes`. When the canonical tree has no index yet, the newest indexed tree is used
 *   and marked not current. With no index, the graph has no source areas.
 * - Task semantic resources and the Intents of completed Task runs (`project:<slug>:` stripped).
 *   The area of a resource is its first segment: `wishlist:membership` and `identity.auth` belong
 *   to `wishlist` and `identity`.
 * - Exact Task dependency edges between Tasks of different areas, and areas that one Task touches
 *   together (its first resource depends on the others).
 * - ChangeSet resources and semantic conflicts of each Change.
 * - The Project's own stored policy (D1 `project_policies`, section 53). Its `protectedResources`
 *   mark only areas the graph already has; a protected resource never adds an area. A Project
 *   without a stored policy has no protected areas here: the integration Worker's default policy
 *   is a fallback for promotion, not a fact about this Project's product.
 *
 * No Artifacts read. Reads are capped: the newest 20 Changes and their rows, one policy row, one
 * index pointer row, and one R2 object.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

const CHANGE_LIMIT = 20;
const TASK_LIMIT = 400;
const DEPENDENCY_LIMIT = 1000;
const RUN_LIMIT = 600;
const CHANGESET_LIMIT = 200;
const CONFLICT_LIMIT = 200;
/** Origins kept per edge; the rest are counted. */
const ORIGIN_LIMIT = 8;

const UNASSIGNED = "unassigned";

export type EdgeKind = "authorization" | "product_reference" | "state" | "dependency";

const EDGE_LABEL: Record<EdgeKind, string> = {
  authorization: "authorization dependency",
  product_reference: "product reference",
  state: "state dependency",
  dependency: "dependency",
};

/** Edge kind from the area depended on: a documented naming rule, not inference. */
function edgeKind(target: string): EdgeKind {
  if (target === "identity") return "authorization";
  if (target === "catalog") return "product_reference";
  if (target === "cart" || target === "checkout") return "state";
  return "dependency";
}

export type EdgeOrigin =
  /** An import in the indexed canonical tree. */
  | { kind: "source_import"; file: string; detail: string }
  | {
      kind: "task_dependency";
      changeId: string;
      taskKey: string;
      dependsOnTaskKey: string;
    }
  | { kind: "shared_task"; changeId: string; taskKey: string; resources: string[] };

export type ProductGraphNode = {
  /** Area key, for example `wishlist`. */
  id: string;
  name: string;
  /** Present in the indexed canonical source. */
  baseline: boolean;
  baselineFile: string | null;
  /** Every source file of the area in the indexed tree. */
  sourceFiles: string[];
  /** Semantic resources that promoted ChangeSets declared on this area (indexed tree). */
  sourceResources: string[];
  /** Policy protected resources in this area, for example `identity.auth`. */
  protectedResources: string[];
  /** One entry per Change that touches the area. */
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
  /** The dependent area. */
  source: string;
  /** The area depended on. */
  target: string;
  kind: EdgeKind;
  label: string;
  /** Changes whose Tasks produced this edge. Source import edges have none. */
  changeIds: string[];
  origins: EdgeOrigin[];
  moreOrigins: number;
};

export type ProductGraph = {
  projectId: string;
  canonicalGeneration: number | null;
  /** Version of the Project's stored policy; null when the Project has none. */
  policyVersion: string | null;
  /** Stored policy protected resources whose area is in the graph. */
  protectedResources: string[];
  /** Where source areas and imports came from. */
  source:
    | { kind: "index"; treeSha: string; commit: string | null; builtAt: string; current: boolean }
    | { kind: "none" };
  /** Runtime wiring files of the indexed tree, which the graph does not show as areas. */
  wiringFiles: readonly string[];
  changes: { id: string; goal: string; title: string; status: string; createdAt: string }[];
  nodes: ProductGraphNode[];
  edges: ProductGraphEdge[];
  counts: {
    tasks: number;
    intents: number;
    dependencies: number;
    changeSets: number;
    conflicts: number;
  };
  /** True when a cap cut rows; the UI says so. */
  truncated: boolean;
};

type ChangeRow = {
  id: string;
  goal: string;
  title?: string | null;
  status: string;
  created_at: string;
};
type TaskRow = {
  id: string;
  change_id: string;
  task_key: string | null;
  title: string | null;
  kind: string;
  status: string;
  semantic_resource: string | null;
  semantic_resources_json: string;
  created_at: string;
};
type DependencyRow = { task_id: string; depends_on_task_id: string };
type RunRow = { task_id: string; outcome_json: string | null };
type ChangeSetRow = { change_id: string; resources_json: string };
type ConflictRow = { id: string; change_id: string; resource: string; state: string };

const PROJECT_PREFIX = /^project:[a-z0-9-]+:/;
const AREA = /^[a-z][a-z0-9-]*$/;

/** Lowercase, `project:<slug>:` stripped (same rule as packages/conflict normalizeResource). */
function normalizeResource(resource: string) {
  return resource.trim().toLowerCase().replace(PROJECT_PREFIX, "");
}

function areaOf(resource: string): string | null {
  const head = normalizeResource(resource).split(/[:./]/)[0] ?? "";
  return AREA.test(head) ? head : null;
}

function areaName(area: string) {
  const words = area.split("-").filter(Boolean).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function stringArray(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function intentResources(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as { semanticResources?: unknown };
    return Array.isArray(value.semanticResources)
      ? value.semanticResources.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

const unique = <T>(items: Iterable<T>) => [...new Set(items)];

export type StoredGraph = {
  graph: ProductGraphStore;
  treeSha: string;
  commit: string | null;
  builtAt: string;
  /** False when the canonical tree has moved past the newest index. */
  current: boolean;
};

export type DeriveInput = {
  projectId: string;
  canonicalGeneration: number | null;
  /** The Project's stored policy; null when it has none. */
  policy: { version: string; protectedResources: readonly string[] } | null;
  stored: StoredGraph | null;
  changes: ChangeRow[];
  tasks: TaskRow[];
  dependencies: DependencyRow[];
  runs: RunRow[];
  changeSets: ChangeSetRow[];
  conflicts: ConflictRow[];
  truncated: boolean;
};

/** Pure and deterministic: the same rows give the same graph, in the same order. */
function deriveProductGraph(input: DeriveInput): ProductGraph {
  const nodes = new Map<string, ProductGraphNode>();
  const node = (area: string) => {
    let n = nodes.get(area);
    if (!n) {
      n = {
        id: area,
        name: areaName(area),
        baseline: false,
        baselineFile: null,
        sourceFiles: [],
        sourceResources: [],
        protectedResources: [],
        touches: [],
        conflicts: [],
      };
      nodes.set(area, n);
    }
    return n;
  };
  const touch = (area: string, changeId: string) => {
    const n = node(area);
    let t = n.touches.find((x) => x.changeId === changeId);
    if (!t) {
      t = { changeId, resources: [], tasks: [], changeSetCount: 0 };
      n.touches.push(t);
    }
    return t;
  };

  const edges = new Map<string, ProductGraphEdge>();
  const addEdge = (source: string, target: string, origin: EdgeOrigin, changeId?: string) => {
    if (source === target) return;
    const id = `${source}->${target}`;
    let e = edges.get(id);
    if (!e) {
      const kind = edgeKind(target);
      e = {
        id,
        source,
        target,
        kind,
        label: EDGE_LABEL[kind],
        changeIds: [],
        origins: [],
        moreOrigins: 0,
      };
      edges.set(id, e);
    }
    if (changeId && !e.changeIds.includes(changeId)) e.changeIds.push(changeId);
    if (e.origins.length < ORIGIN_LIMIT) e.origins.push(origin);
    else e.moreOrigins += 1;
  };

  // 1. Source areas: the indexed canonical tree.
  const stored = input.stored;
  if (stored) {
    for (const area of stored.graph.areas) {
      const n = node(area.id);
      n.baseline = true;
      n.baselineFile = area.files[0] ?? null;
      n.sourceFiles = [...area.files];
      n.sourceResources = [...area.resources];
    }
    for (const edge of stored.graph.edges) {
      for (const imp of edge.imports) {
        addEdge(edge.from, edge.to, { kind: "source_import", file: imp.file, detail: imp.detail });
      }
    }
  }

  // 2. Tasks: planner resources first (the first one is the primary area), then Intent resources.
  const intentByTask = new Map<string, string[]>();
  for (const run of input.runs) {
    const resources = intentResources(run.outcome_json);
    if (resources.length > 0) intentByTask.set(run.task_id, resources);
  }
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const taskAreas = new Map<string, string[]>();
  const taskKey = (t: TaskRow) => t.task_key ?? t.id;
  for (const task of input.tasks) {
    const resources = unique(
      [
        ...stringArray(task.semantic_resources_json),
        ...(task.semantic_resource ? [task.semantic_resource] : []),
        ...(intentByTask.get(task.id) ?? []),
      ].map(normalizeResource),
    );
    const areas = unique(resources.map(areaOf).filter((a): a is string => a !== null));
    taskAreas.set(task.id, areas);
    for (const area of areas) {
      const t = touch(area, task.change_id);
      for (const r of resources) {
        if (areaOf(r) === area && !t.resources.includes(r)) t.resources.push(r);
      }
      t.tasks.push({
        id: task.id,
        key: taskKey(task),
        title: task.title ?? taskKey(task),
        kind: task.kind,
        status: task.status,
      });
    }
    const [primary, ...others] = areas;
    if (primary) {
      for (const other of others) {
        addEdge(
          primary,
          other,
          {
            kind: "shared_task",
            changeId: task.change_id,
            taskKey: taskKey(task),
            resources: resources.filter((r) => {
              const a = areaOf(r);
              return a === primary || a === other;
            }),
          },
          task.change_id,
        );
      }
    }
  }

  // 3. Exact Task dependencies that cross areas: the dependent primary area depends on the other.
  for (const dep of input.dependencies) {
    const task = taskById.get(dep.task_id);
    const on = taskById.get(dep.depends_on_task_id);
    const from = taskAreas.get(dep.task_id)?.[0];
    const to = taskAreas.get(dep.depends_on_task_id)?.[0];
    if (!task || !on || !from || !to) continue;
    addEdge(
      from,
      to,
      {
        kind: "task_dependency",
        changeId: task.change_id,
        taskKey: taskKey(task),
        dependsOnTaskKey: taskKey(on),
      },
      task.change_id,
    );
  }

  // 4. ChangeSets and conflicts.
  for (const cs of input.changeSets) {
    const areas = unique(
      stringArray(cs.resources_json)
        .map(areaOf)
        .filter((a): a is string => a !== null),
    );
    for (const area of areas) {
      const t = touch(area, cs.change_id);
      t.changeSetCount += 1;
      for (const r of stringArray(cs.resources_json).map(normalizeResource)) {
        if (areaOf(r) === area && !t.resources.includes(r)) t.resources.push(r);
      }
    }
  }
  for (const conflict of input.conflicts) {
    const area = areaOf(conflict.resource);
    if (!area) continue;
    node(area).conflicts.push({
      id: conflict.id,
      changeId: conflict.change_id,
      resource: normalizeResource(conflict.resource),
      state: conflict.state,
    });
  }

  // 5. The Project's own protected resources, on areas the graph already has.
  const guarded: string[] = [];
  for (const resource of input.policy?.protectedResources ?? []) {
    const area = areaOf(resource);
    const n = area ? nodes.get(area) : undefined;
    if (!n) continue;
    const normalized = normalizeResource(resource);
    if (!n.protectedResources.includes(normalized)) n.protectedResources.push(normalized);
    if (!guarded.includes(normalized)) guarded.push(normalized);
  }

  for (const n of nodes.values()) {
    for (const t of n.touches) t.resources.sort();
  }

  return {
    projectId: input.projectId,
    canonicalGeneration: input.canonicalGeneration,
    policyVersion: input.policy?.version ?? null,
    protectedResources: guarded,
    source: stored
      ? {
          kind: "index",
          treeSha: stored.treeSha,
          commit: stored.commit,
          builtAt: stored.builtAt,
          current: stored.current,
        }
      : { kind: "none" },
    wiringFiles: stored ? stored.graph.wiringFiles : [],
    changes: input.changes.map((c) => ({
      id: c.id,
      goal: c.goal,
      title: changeTitle(c.title, c.goal),
      status: c.status,
      createdAt: c.created_at,
    })),
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
    counts: {
      tasks: input.tasks.length,
      intents: intentByTask.size,
      dependencies: input.dependencies.length,
      changeSets: input.changeSets.length,
      conflicts: input.conflicts.length,
    },
    truncated: input.truncated,
  };
}

type IndexRow = { tree_sha: string; commit_sha: string | null; built_at: string };

/**
 * The Project's stored policy (D1 `project_policies`), one row read. No row, or a row that does
 * not parse, gives null: the graph then marks no area protected rather than guessing.
 */
async function readStoredPolicy(
  db: D1Database,
  projectId: string,
): Promise<{ version: string; protectedResources: string[] } | null> {
  const row = await db
    .prepare("SELECT policy_json FROM project_policies WHERE project_id = ?")
    .bind(projectId)
    .first<{ policy_json: string }>();
  if (!row) return null;
  let json: unknown = null;
  try {
    json = JSON.parse(row.policy_json);
  } catch {
    return null;
  }
  const parsed = ProjectPolicy.safeParse(json);
  return parsed.success
    ? { version: parsed.data.version, protectedResources: parsed.data.protectedResources }
    : null;
}

/**
 * The stored Product Graph of the canonical tree, else of the newest indexed tree. One D1 row and
 * one R2 read. A missing or foreign object falls back to the derivation without it.
 */
async function readStoredGraph(
  env: Env,
  projectId: string,
  canonicalTree: string,
): Promise<StoredGraph | null> {
  const row = await env.DB.prepare(
    `SELECT tree_sha, commit_sha, built_at FROM project_indexes
     WHERE project_id = ? AND status = 'ready'
     ORDER BY tree_sha = ? DESC, built_at DESC LIMIT 1`,
  )
    .bind(projectId, canonicalTree)
    .first<IndexRow>();
  if (!row) return null;
  const object = await env.EVIDENCE.get(indexKeys(projectId, row.tree_sha).productGraph);
  if (!object) return null;
  const graph = (await object.json()) as ProductGraphStore;
  if (graph.projectId !== projectId || graph.treeSha !== row.tree_sha) return null;
  return {
    graph,
    treeSha: row.tree_sha,
    commit: row.commit_sha,
    builtAt: row.built_at,
    current: row.tree_sha === canonicalTree,
  };
}

export const productGraph = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/product-graph",
  requireAuth,
  validate("param", ProjectIdParam),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const db = c.env.DB;

    const changeRows = await db
      .prepare(
        `SELECT id, goal, title, status, created_at FROM changes WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ${CHANGE_LIMIT}`,
      )
      .bind(projectId)
      .all<ChangeRow>();
    // Oldest first, so "first touched by" reads in creation order.
    const changes = (changeRows.results ?? []).reverse();

    const root = c.env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await root.get(root.idFromName(projectId)).getCanonical();
    const hasSource = !!canonical && canonical.artifactRef !== UNASSIGNED;
    const [stored, policy] = await Promise.all([
      hasSource && canonical ? readStoredGraph(c.env, projectId, canonical.treeSha) : null,
      readStoredPolicy(db, projectId),
    ]);

    let tasks: TaskRow[] = [];
    let dependencies: DependencyRow[] = [];
    let runs: RunRow[] = [];
    let changeSets: ChangeSetRow[] = [];
    let conflicts: ConflictRow[] = [];
    if (changes.length > 0) {
      const ids = changes.map((ch) => ch.id);
      const marks = ids.map(() => "?").join(", ");
      const [t, d, r, cs, cf] = await db.batch([
        db
          .prepare(
            `SELECT id, change_id, task_key, title, kind, status, semantic_resource,
                    semantic_resources_json, created_at
             FROM tasks WHERE change_id IN (${marks})
             ORDER BY created_at, id LIMIT ${TASK_LIMIT + 1}`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
             JOIN tasks t ON t.id = d.task_id WHERE t.change_id IN (${marks})
             ORDER BY d.task_id, d.depends_on_task_id LIMIT ${DEPENDENCY_LIMIT + 1}`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT r.task_id, r.outcome_json FROM task_runs r JOIN tasks t ON t.id = r.task_id
             WHERE t.change_id IN (${marks}) AND r.status = 'completed'
             ORDER BY r.task_id, r.attempt LIMIT ${RUN_LIMIT + 1}`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT change_id, resources_json FROM changesets WHERE change_id IN (${marks})
             ORDER BY created_at, id LIMIT ${CHANGESET_LIMIT + 1}`,
          )
          .bind(...ids),
        db
          .prepare(
            `SELECT id, change_id, resource, state FROM conflicts WHERE change_id IN (${marks})
             ORDER BY created_at, id LIMIT ${CONFLICT_LIMIT + 1}`,
          )
          .bind(...ids),
      ]);
      tasks = (t?.results ?? []) as TaskRow[];
      dependencies = (d?.results ?? []) as DependencyRow[];
      runs = (r?.results ?? []) as RunRow[];
      changeSets = (cs?.results ?? []) as ChangeSetRow[];
      conflicts = (cf?.results ?? []) as ConflictRow[];
    }

    const truncated =
      changes.length >= CHANGE_LIMIT ||
      tasks.length > TASK_LIMIT ||
      dependencies.length > DEPENDENCY_LIMIT ||
      runs.length > RUN_LIMIT ||
      changeSets.length > CHANGESET_LIMIT ||
      conflicts.length > CONFLICT_LIMIT;

    const data = deriveProductGraph({
      projectId,
      canonicalGeneration: canonical?.generation ?? null,
      policy,
      stored,
      changes,
      tasks: tasks.slice(0, TASK_LIMIT),
      dependencies: dependencies.slice(0, DEPENDENCY_LIMIT),
      runs: runs.slice(0, RUN_LIMIT),
      changeSets: changeSets.slice(0, CHANGESET_LIMIT),
      conflicts: conflicts.slice(0, CONFLICT_LIMIT),
      truncated,
    });
    return c.json({ data });
  },
);
