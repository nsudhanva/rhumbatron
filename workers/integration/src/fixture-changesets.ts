import {
  detectConflicts,
  type ForkDecision,
  forkDecision,
  intentFromDeclaration,
} from "@rhumbatron/conflict";
import type { ProjectRootDO, ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import type { Challenge, ConflictReport, Intent } from "@rhumbatron/protocol";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { createFsFromVolume, Volume } from "memfs";
import { applyDesign } from "../../../fixtures/wishlist/apply.ts";
import {
  CHANGE_PLAN,
  DESIGNS,
  fixtureIds,
  type WishlistDesign,
} from "../../../fixtures/wishlist/manifest.ts";
import { appendChangeEvents, type ChangeContext, changeEvent, qualify } from "./events.ts";
import wishlistFixture from "./fixtures/wishlist.fixture.gen.ts";

/**
 * Dev-only fixture publisher for the Wishlist design conflict (P9-08).
 * It records what two agents would record, without a model call: a Work Graph Task per
 * design, a completed run with zero model calls, an Artifacts workspace fork with the design
 * committed on the canonical commit, a `proposed` ChangeSet, and the declared Intent. The same
 * deterministic detector the agents use then flags the conflict on `wishlist:membership`.
 * Everything is marked fixture-sourced: run tier `fixture`, model policy `fixture`, actor `fixture`.
 * Safe to repeat: IDs derive from the Change and the design, and commits have a fixed date.
 */

const ACTOR = { kind: "system", id: "fixture" } as const;
const AUTHOR = { name: "Rhumbatron fixture", email: "fixture@rhumbatron.com" };
const DIR = "/repo";
const DESIGN_KEYS = new Set(Object.values(DESIGNS).map((d) => d.taskKey));
/** Must match workers/agents/src/conflicts.ts until Project policies are stored. */
const PROTECTED_RESOURCES = ["cart", "checkout", "identity"];
const INACTIVE_CANDIDATES = ["rejected", "stale", "promoted"];

export type FixtureOutcome =
  | { status: "skipped"; reason: string }
  | { status: "published"; changeSets: string[]; conflicts: string[] };

/** The fixture does not fit the canonical source (for example after a promotion). Permanent. */
class FixtureMismatch extends Error {}

type ChangeRow = {
  status: string;
  base_generation: number;
  created_at: string;
  org_id: string;
  slug: string;
  project_status: string;
};

/** `git diff --stat`-style summary from common prefix and suffix lines per file. */
function diffStat(changes: { path: string; before: string | null; after: string }[]) {
  let insertions = 0;
  let deletions = 0;
  const lines = changes.map(({ path, before, after }) => {
    const a = before === null ? [] : before.split("\n");
    const b = after.split("\n");
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
    let tail = 0;
    while (
      tail < a.length - head &&
      tail < b.length - head &&
      a[a.length - 1 - tail] === b[b.length - 1 - tail]
    ) {
      tail += 1;
    }
    const del = a.length - head - tail;
    const ins = b.length - head - tail;
    insertions += ins;
    deletions += del;
    return ` ${path} | ${ins + del} ${"+".repeat(Math.min(ins, 40))}${"-".repeat(Math.min(del, 40))}`;
  });
  return [
    ...lines,
    ` ${changes.length} files changed, ${insertions} insertions(+), ${deletions} deletions(-)`,
  ].join("\n");
}

type MemFs = Parameters<typeof git.init>[0]["fs"] & {
  promises: {
    readFile(p: string, o: string): Promise<string>;
    writeFile(p: string, c: string): Promise<void>;
    mkdir(p: string, o: object): Promise<void>;
  };
};

/**
 * Commits one design on `baseCommit` in the fork and pushes it to the fork's `main` (a fast-forward
 * from the canonical commit). The commit date is the Change creation time, so a retry builds the
 * same commit and the push is a no-op.
 */
async function commitDesign(
  env: Env,
  input: { fork: string; baseCommit: string; design: WishlistDesign; commitTime: number },
) {
  using repo = await env.ARTIFACTS.get(input.fork);
  const info = await repo.info();
  const token = await repo.createToken("write", 600);
  const secret = token.plaintext.split("?expires=")[0] ?? token.plaintext;
  const onAuth = () => ({ username: "x", password: secret });
  try {
    const fs = createFsFromVolume(new Volume()) as unknown as MemFs;
    await git.init({ fs, dir: DIR, defaultBranch: "main" });
    // isomorphic-git needs a configured remote for its fetch refspec.
    await git.addRemote({ fs, dir: DIR, remote: "origin", url: info.remote, force: true });
    await git.fetch({
      fs,
      http,
      dir: DIR,
      remote: "origin",
      url: info.remote,
      ref: "main",
      singleBranch: true,
      tags: false,
      onAuth,
    });
    const head = await git.resolveRef({ fs, dir: DIR, ref: "refs/remotes/origin/main" });
    await git.writeRef({
      fs,
      dir: DIR,
      ref: "refs/heads/main",
      value: input.baseCommit,
      force: true,
    });
    await git.checkout({ fs, dir: DIR, ref: "main", force: true });

    const readBase = (path: string) =>
      fs.promises.readFile(`${DIR}/${path}`, "utf8").catch(() => null);
    const base = new Map<string, string | null>();
    // applyDesign reads synchronously: load every path it can touch first.
    const spec = DESIGNS[input.design];
    for (const key of Object.keys(wishlistFixture)) {
      const source = spec.sources.find((s) => key.startsWith(`files/${s}/`));
      if (source) {
        const path = key.slice(`files/${source}/`.length);
        base.set(path, await readBase(path));
      }
    }
    for (const edit of spec.edits) base.set(edit.path, await readBase(edit.path));
    let changes: ReturnType<typeof applyDesign>;
    try {
      changes = applyDesign(input.design, wishlistFixture, (p) => base.get(p) ?? null);
    } catch (error) {
      throw new FixtureMismatch(String(error));
    }

    for (const [path, content] of Object.entries(changes.files)) {
      const full = `${DIR}/${path}`;
      await fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      await fs.promises.writeFile(full, content);
      await git.add({ fs, dir: DIR, filepath: path });
    }
    const signature = { ...AUTHOR, timestamp: input.commitTime, timezoneOffset: 0 };
    const commit = await git.commit({
      fs,
      dir: DIR,
      message: spec.commitMessage,
      author: signature,
      committer: signature,
    });
    // A retry finds its own commit on the fork; anything else there means the fork was reused.
    if (head !== input.baseCommit && head !== commit) {
      throw new Error(`fork ${input.fork} main is at ${head.slice(0, 12)}, not the base commit`);
    }
    if (head !== commit) {
      const pushed = await git.push({ fs, http, dir: DIR, url: info.remote, ref: "main", onAuth });
      if (!pushed.ok)
        throw new Error(`push rejected: ${JSON.stringify(pushed.refs).slice(0, 200)}`);
    }
    const files = Object.keys(changes.files).sort();
    return {
      intent: changes.intent,
      changeSet: {
        fork: input.fork,
        commit,
        baseCommit: input.baseCommit,
        diffStat: diffStat(
          files.map((path) => ({
            path,
            before: base.get(path) ?? null,
            after: changes.files[path] ?? "",
          })),
        ),
        files,
      },
    };
  } finally {
    await repo.revokeToken(token.id).catch(() => false);
  }
}

/** Forks the canonical repo into the design's workspace fork. An existing fork is reused. */
async function ensureFork(env: Env, projectId: string, fork: string) {
  using canonical = await env.ARTIFACTS.get(projectId);
  try {
    await canonical.fork(fork, {
      description: `Fixture workspace ${fork}`,
      defaultBranchOnly: true,
    });
  } catch (error) {
    using existing = await env.ARTIFACTS.get(fork).catch(() => {
      throw error;
    });
    await existing.info();
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Same ID rule as workers/agents/src/conflicts.ts `conflictId`, so either writer dedupes. */
async function conflictId(report: Pick<ConflictReport, "intentIds" | "resource">) {
  const key = [...report.intentIds].sort().join("\u0000");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${key}\u0000${report.resource}`),
  );
  return `cfl_${hex(new Uint8Array(digest).slice(0, 12))}`;
}

/** The earlier Intent's agent objects to the later one (agents' `challengeFor`). */
function challengeFor(id: string, report: ConflictReport, pair: [Intent, Intent]): Challenge {
  const [earlier, later] = [...pair].sort((x, y) =>
    x.createdAt === y.createdAt
      ? x.intentId < y.intentId
        ? -1
        : 1
      : x.createdAt < y.createdAt
        ? -1
        : 1,
  ) as [Intent, Intent];
  const hard = report.signals.filter((s) => s.severity === "hard");
  return {
    challengeId: `chl_${id.slice(4)}`,
    sourceAgentId: earlier.agentId,
    targetIntentId: later.intentId,
    semanticResource: report.resource,
    kind: hard[0]?.kind === "contract_conflict" ? "contract_conflict" : "data_semantics_conflict",
    summary: `${report.resource}: ${hard.map((s) => s.detail).join("; ")}`.slice(0, 2000),
    evidenceRefs: [...new Set(hard.flatMap((s) => s.evidenceRefs))]
      .filter((r) => r.length <= 128)
      .slice(0, 20),
    ...(report.recommendedAction === "fork_candidates"
      ? { proposedResolution: "Fork 2 Candidates and let executable evidence decide." }
      : {}),
  };
}

/**
 * Declares the Intents of the published designs on the Change's shard and records new suspected
 * or confirmed conflicts in D1, with a Challenge for a confirmed one. Mirrors the agents'
 * `declareIntentAndDetect`, scoped to fixture Tasks.
 */
async function declareAndDetect(
  env: Env,
  ctx: ChangeContext,
  intents: Intent[],
  titles: Map<string, { key: string; title: string }>,
): Promise<string[]> {
  const ns = env.RESOURCE_SHARD as DurableObjectNamespace<ResourceShardDO>;
  const shard = ns.get(ns.idFromName(shardKey(ctx.projectId, `change:${ctx.changeId}`)));
  const scope = {
    projectId: ctx.projectId,
    changeId: ctx.changeId,
    projectSlug: ctx.projectSlug,
    canonicalGeneration: ctx.baseGeneration,
  };
  for (const intent of intents) {
    const declared = await shard.declareIntent({ ...scope, intent });
    if (!declared.ok) throw new Error(`intent ${intent.intentId}: ${declared.reason}`);
  }
  const all = (await shard.listIntents()).filter((i) => titles.has(i.taskId));
  const [recorded, active] = await env.DB.batch([
    env.DB.prepare(
      "SELECT id, state, challenge_id, fork_decision_json FROM conflicts WHERE change_id = ?",
    ).bind(ctx.changeId),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM candidates WHERE change_id = ? AND status NOT IN (?, ?, ?)`,
    ).bind(ctx.changeId, ...INACTIVE_CANDIDATES),
  ]);
  const rows = (recorded?.results ?? []) as {
    id: string;
    state: string;
    challenge_id: string | null;
    fork_decision_json: string;
  }[];
  const done = new Set(
    rows.filter((r) => r.state !== "confirmed" || r.challenge_id !== null).map((r) => r.id),
  );
  const plannedForks = rows.filter(
    (r) => (JSON.parse(r.fork_decision_json) as ForkDecision).kind === "fork",
  ).length;
  let activeCandidates = Math.max(
    (active?.results?.[0] as { n: number } | undefined)?.n ?? 0,
    plannedForks * 2,
  );

  const byId = new Map(all.map((i) => [i.intentId, i]));
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const ids: string[] = [];
  for (const report of detectConflicts(all, {
    protectedResources: PROTECTED_RESOURCES,
    includeDismissed: false,
  })) {
    const a = byId.get(report.intentIds[0]);
    const b = byId.get(report.intentIds[1]);
    if (!a || !b || (report.state !== "suspected" && report.state !== "confirmed")) continue;
    const id = await conflictId(report);
    ids.push(id);
    if (done.has(id)) continue;
    const fork = forkDecision(report, { activeCandidates });
    if (fork.kind === "fork") activeCandidates += 2;
    let challengeId: string | null = null;
    if (report.state === "confirmed") {
      const challenge = challengeFor(id, report, [a, b]);
      const created = await shard.createChallenge({ ...scope, challenge });
      if (created.ok) challengeId = challenge.challengeId;
    }
    const side = (i: Intent) => ({
      intentId: i.intentId,
      taskId: i.taskId,
      taskKey: titles.get(i.taskId)?.key ?? "",
      title: titles.get(i.taskId)?.title ?? "",
      agentId: i.agentId,
      summary: i.summary,
      semanticResources: i.semanticResources,
      assumptions: i.assumptions,
      createdAt: i.createdAt,
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO conflicts (id, change_id, resource, state, recommended_action, report_json, intents_json,
           review_json, fork_decision_json, challenge_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET challenge_id = excluded.challenge_id, updated_at = excluded.updated_at
         WHERE conflicts.challenge_id IS NULL AND excluded.challenge_id IS NOT NULL`,
      ).bind(
        id,
        ctx.changeId,
        report.resource,
        report.state,
        report.recommendedAction,
        JSON.stringify(report),
        JSON.stringify([side(a), side(b)]),
        JSON.stringify({
          state: report.state,
          recommendedAction: report.recommendedAction,
          decidedBy: "rules",
        }),
        JSON.stringify(fork),
        challengeId,
        now,
        now,
      ),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return ids;
}

/** Publishes the requested designs as proposed ChangeSets on a Change. See the module comment. */
async function publishFixtureChangeSets(
  env: Env,
  input: { projectId: string; changeId: string; designs: WishlistDesign[] },
): Promise<FixtureOutcome> {
  const row = await env.DB.prepare(
    `SELECT c.status, c.base_generation, c.created_at, p.org_id, p.slug, p.status AS project_status
     FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ? AND c.project_id = ?`,
  )
    .bind(input.changeId, input.projectId)
    .first<ChangeRow>();
  if (row?.project_status !== "active") return { status: "skipped", reason: "no change" };
  if (!["created", "verifying"].includes(row.status)) {
    return { status: "skipped", reason: `change is ${row.status}` };
  }
  const keys = await env.DB.prepare("SELECT task_key FROM tasks WHERE change_id = ?")
    .bind(input.changeId)
    .all<{ task_key: string | null }>();
  if ((keys.results ?? []).some((t) => !t.task_key || !DESIGN_KEYS.has(t.task_key))) {
    return { status: "skipped", reason: "change has a planned Work Graph" };
  }

  const ctx: ChangeContext = {
    projectId: input.projectId,
    orgId: row.org_id,
    projectSlug: row.slug,
    changeId: input.changeId,
    baseGeneration: row.base_generation,
  };
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(input.projectId)).getCanonical();
  if (!canonical || canonical.generation !== row.base_generation) {
    return { status: "skipped", reason: "change base is not the canonical generation" };
  }
  const index = await env.EVIDENCE.get(`source/${input.projectId}/${canonical.treeSha}/index.json`);
  const baseCommit = index ? ((await index.json()) as { commit?: string }).commit : undefined;
  if (!baseCommit) throw new Error("canonical source index is not written yet");

  // The Work Graph a planner would record: one completed Task per design, nothing to dispatch.
  const now = new Date().toISOString();
  const workGraphRef = `work-graphs/${input.projectId}/${input.changeId}.json`;
  const designs = [...new Set(input.designs)].sort();
  const tasks = designs.map((d) => ({
    design: d,
    spec: DESIGNS[d],
    ids: fixtureIds(input.changeId, d),
  }));
  await env.EVIDENCE.put(
    workGraphRef,
    JSON.stringify({
      source: "fixture",
      plan: {
        ...CHANGE_PLAN,
        tasks: Object.values(DESIGNS).map((d) => ({ key: d.taskKey, title: d.title })),
      },
      calls: [],
    }),
    { httpMetadata: { contentType: "application/json" } },
  );
  await env.DB.batch([
    ...tasks.map(({ spec, ids }) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO tasks (id, change_id, kind, semantic_resource, status, assigned_agent_id,
           complexity, risk_tier, model_policy, task_key, title, objective, acceptance_criteria_json,
           semantic_resources_json, route_json, wake_sent_at, created_at, updated_at)
         VALUES (?, ?, 'implement', ?, 'completed', ?, 'medium', ?, 'fixture', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        ids.taskId,
        input.changeId,
        qualify(ctx, spec.intent.semanticResources[0] ?? "wishlist"),
        spec.agentId,
        CHANGE_PLAN.riskTier,
        spec.taskKey,
        spec.title,
        spec.objective,
        JSON.stringify(CHANGE_PLAN.acceptanceCriteria),
        JSON.stringify(spec.intent.semanticResources.map((r) => qualify(ctx, r))),
        JSON.stringify({
          touchesAuthorization: true,
          touchesBilling: false,
          touchesMigration: false,
          source: "fixture",
        }),
        now,
        now,
        now,
      ),
    ),
    env.DB.prepare(
      `UPDATE changes SET status = 'verifying', risk_tier = ?, acceptance_criteria_json = ?,
         invariants_json = ?, work_graph_ref = ?, updated_at = ?
       WHERE id = ? AND status IN ('created', 'verifying')`,
    ).bind(
      CHANGE_PLAN.riskTier,
      JSON.stringify(CHANGE_PLAN.acceptanceCriteria),
      JSON.stringify(CHANGE_PLAN.invariants),
      workGraphRef,
      now,
      input.changeId,
    ),
  ]);

  const commitTime = Math.floor(Date.parse(row.created_at) / 1000);
  const intents: Intent[] = [];
  const changeSets: string[] = [];
  for (const { design, spec, ids } of tasks) {
    const existing = await env.DB.prepare(
      "SELECT intent_json, created_at FROM changesets WHERE id = ?",
    )
      .bind(ids.changeSetId)
      .first<{ intent_json: string; created_at: string }>();
    let declared: Record<string, unknown>;
    let createdAt: string;
    if (existing) {
      declared = JSON.parse(existing.intent_json) as Record<string, unknown>;
      createdAt = existing.created_at;
    } else {
      let published: Awaited<ReturnType<typeof commitDesign>>;
      try {
        await ensureFork(env, input.projectId, ids.fork);
        published = await commitDesign(env, { fork: ids.fork, baseCommit, design, commitTime });
      } catch (error) {
        // No `task_runs` row tracks the fork yet, so cleanup could never find it: remove it now.
        // A retry forks again and rebuilds the same commit.
        await env.ARTIFACTS.delete(ids.fork).catch(() => false);
        if (error instanceof FixtureMismatch) {
          return { status: "skipped", reason: `design ${design} does not apply: ${error.message}` };
        }
        throw error;
      }
      declared = { ...published.intent, changeSet: published.changeSet };
      createdAt = new Date().toISOString();
      const outcome = JSON.stringify(declared);
      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO task_runs (id, task_id, agent_id, attempt, tier, status, outcome_json,
             model_calls, input_tokens, output_tokens, cost_usd, started_at, ended_at)
           VALUES (?, ?, ?, 1, 'fixture', 'completed', ?, 0, 0, 0, 0, ?, ?)`,
        ).bind(ids.runId, ids.taskId, spec.agentId, outcome, createdAt, createdAt),
        env.DB.prepare(
          `INSERT OR IGNORE INTO changesets (id, change_id, agent_id, base_generation, artifact_ref,
             intent_json, resources_json, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
        ).bind(
          ids.changeSetId,
          input.changeId,
          spec.agentId,
          row.base_generation,
          `artifacts://${ids.fork}@${published.changeSet.commit}`,
          outcome,
          JSON.stringify(spec.intent.semanticResources),
          createdAt,
        ),
      ]);
      // A concurrent delivery may have won the insert: keep its timestamp for the Intent.
      const stored = await env.DB.prepare("SELECT created_at FROM changesets WHERE id = ?")
        .bind(ids.changeSetId)
        .first<{ created_at: string }>();
      createdAt = stored?.created_at ?? createdAt;
    }
    const resource = qualify(ctx, spec.intent.semanticResources[0] ?? "wishlist");
    const changeSet = declared.changeSet as { fork: string; commit: string; files: string[] };
    await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "task.created",
        {
          key: spec.taskKey,
          title: spec.title,
          kind: "implement",
          dependsOn: [],
          source: "fixture",
        },
        { taskId: ids.taskId, resource, actor: ACTOR },
      ),
      await changeEvent(
        ctx,
        "changeset.proposed",
        {
          changeSetId: ids.changeSetId,
          fork: changeSet.fork,
          commit: changeSet.commit,
          files: changeSet.files,
          source: "fixture",
        },
        { taskId: ids.taskId, resource, actor: ACTOR },
      ),
      await changeEvent(
        ctx,
        "task.completed",
        { runId: ids.runId, tier: "fixture", attempt: 1, source: "fixture" },
        { taskId: ids.taskId, resource, actor: ACTOR },
      ),
    ]);
    intents.push(
      intentFromDeclaration(
        {
          summary: String(declared.summary ?? ""),
          semanticResources: (declared.semanticResources as string[]) ?? [],
          expectedFiles: (declared.expectedFiles as string[]) ?? [],
          expectedContractChanges: (declared.expectedContractChanges as string[]) ?? [],
          expectedDataChanges: (declared.expectedDataChanges as string[]) ?? [],
          assumptions: (declared.assumptions as string[]) ?? [],
        },
        { intentId: ids.intentId, taskId: ids.taskId, agentId: spec.agentId, createdAt },
      ),
    );
    changeSets.push(ids.changeSetId);
  }

  const titles = new Map(
    Object.values(DESIGNS).map((d) => [
      fixtureIds(input.changeId, d.design).taskId,
      { key: d.taskKey, title: d.title },
    ]),
  );
  const conflicts = await declareAndDetect(env, ctx, intents, titles);
  return { status: "published", changeSets, conflicts };
}

/** The environment where fixture ChangeSets may be published by queue command. */
const FIXTURE_ENVIRONMENT = "local";

/** Queue entry for `fixture.publish` (payload `{designs: ["a", "b"]}`). Logs the outcome. */
export async function handleFixtureCommand(
  env: Env,
  command: { projectId: string; changeId?: string | undefined; payload: unknown },
): Promise<undefined> {
  const designs = (command.payload as { designs?: unknown } | null)?.designs;
  const valid =
    Array.isArray(designs) &&
    designs.length > 0 &&
    designs.every((d): d is WishlistDesign => d === "a" || d === "b");
  const outcome: FixtureOutcome =
    env.ENVIRONMENT !== FIXTURE_ENVIRONMENT || !command.changeId || !valid
      ? { status: "skipped", reason: "not a local fixture command" }
      : await publishFixtureChangeSets(env, {
          projectId: command.projectId,
          changeId: command.changeId,
          designs,
        });
  console.warn(
    JSON.stringify({ event: "fixture.publish", changeId: command.changeId, ...outcome }),
  );
  return undefined;
}
