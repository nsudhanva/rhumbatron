import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Product Graph read model (AGENTS.md sections 28 and 38.3). No Product Graph is stored yet
 * (P7-04), so this route derives one deterministically, on each read, from data that exists:
 *
 * - Task semantic resources and the Intents of completed Task runs (`project:<slug>:` stripped).
 *   The area of a resource is its first segment: `wishlist:membership` and `identity.auth` belong
 *   to `wishlist` and `identity`.
 * - Exact Task dependency edges between Tasks of different areas, and areas that one Task touches
 *   together (its first resource depends on the others).
 * - ChangeSet resources and semantic conflicts of each Change.
 * - Policy `protectedResources` (section 53), the same default the integration Worker applies.
 * - The import graph of the Acme Shop fixture (`fixtures/acme-shop/src`), the only template a
 *   Project can be seeded with today. It applies only when the Project has canonical source.
 *
 * No model call, no Artifacts read. Reads are capped: the newest 20 Changes and their rows.
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

/** Default policy (section 53) until Project policies are stored. Same as candidate-composer.ts. */
const POLICY = { version: "policy-1", protectedResources: ["cart", "checkout", "identity.auth"] };

const UNASSIGNED = "unassigned";

/**
 * Areas and imports of `fixtures/acme-shop/src` at seed time. `store.ts`, `server.ts` and
 * `worker.ts` are runtime wiring, not product areas. Update this table with the fixture.
 */
const FIXTURE = {
  source: "fixtures/acme-shop/src",
  areas: [
    { area: "storefront", file: "src/app.ts" },
    { area: "catalog", file: "src/catalog.ts" },
    { area: "cart", file: "src/cart.ts" },
    { area: "identity", file: "src/identity.ts" },
  ],
  imports: [
    {
      from: "storefront",
      to: "identity",
      file: "src/app.ts",
      detail: "resolveUser from ./identity",
    },
    {
      from: "storefront",
      to: "cart",
      file: "src/app.ts",
      detail: "addItem, removeItem, setQuantity, totals from ./cart",
    },
    {
      from: "storefront",
      to: "catalog",
      file: "src/app.ts",
      detail: "store.products, seeded from SEED_PRODUCTS in ./catalog by src/store.ts",
    },
    { from: "cart", to: "catalog", file: "src/cart.ts", detail: "type Product from ./catalog" },
  ],
  hiddenFiles: ["src/store.ts", "src/server.ts", "src/worker.ts"],
} as const;

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
  | { kind: "fixture_import"; file: string; detail: string }
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
  /** Present in the seeded fixture source. */
  baseline: boolean;
  baselineFile: string | null;
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
  /** Changes whose Tasks produced this edge. Fixture edges have none. */
  changeIds: string[];
  origins: EdgeOrigin[];
  moreOrigins: number;
};

export type ProductGraph = {
  projectId: string;
  canonicalGeneration: number | null;
  policyVersion: string;
  protectedResources: string[];
  fixture: { applied: boolean; source: string; hiddenFiles: readonly string[] };
  changes: { id: string; goal: string; status: string; createdAt: string }[];
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

type ChangeRow = { id: string; goal: string; status: string; created_at: string };
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

export type DeriveInput = {
  projectId: string;
  canonicalGeneration: number | null;
  hasSource: boolean;
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

  // 1. Seeded fixture source.
  if (input.hasSource) {
    for (const { area, file } of FIXTURE.areas) {
      const n = node(area);
      n.baseline = true;
      n.baselineFile = file;
    }
    for (const imp of FIXTURE.imports) {
      addEdge(imp.from, imp.to, { kind: "fixture_import", file: imp.file, detail: imp.detail });
    }
  }

  // 2. Policy protected resources.
  for (const resource of POLICY.protectedResources) {
    const area = areaOf(resource);
    if (area) node(area).protectedResources.push(resource);
  }

  // 3. Tasks: planner resources first (the first one is the primary area), then Intent resources.
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

  // 4. Exact Task dependencies that cross areas: the dependent primary area depends on the other.
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

  // 5. ChangeSets and conflicts.
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

  for (const n of nodes.values()) {
    for (const t of n.touches) t.resources.sort();
  }

  return {
    projectId: input.projectId,
    canonicalGeneration: input.canonicalGeneration,
    policyVersion: POLICY.version,
    protectedResources: [...POLICY.protectedResources],
    fixture: { applied: input.hasSource, source: FIXTURE.source, hiddenFiles: FIXTURE.hiddenFiles },
    changes: input.changes.map((c) => ({
      id: c.id,
      goal: c.goal,
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
        `SELECT id, goal, status, created_at FROM changes WHERE project_id = ?
         ORDER BY created_at DESC LIMIT ${CHANGE_LIMIT}`,
      )
      .bind(projectId)
      .all<ChangeRow>();
    // Oldest first, so "first touched by" reads in creation order.
    const changes = (changeRows.results ?? []).reverse();

    const root = c.env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
    const canonical = await root.get(root.idFromName(projectId)).getCanonical();
    const hasSource = !!canonical && canonical.artifactRef !== UNASSIGNED;

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
      hasSource,
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
