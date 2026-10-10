// Release path invariants (AGENTS.md sections 21.3, 42.10, 60; ADR 0018):
// - one release per Project and generation, however often promotion retries;
// - a newer promotion supersedes an older in-flight release, which can then never deploy;
// - a smoke failure (or a probe with no answer) never marks a release deployed;
// - only the build of the promoted commit counts.
// Runs the real migrations and SQL against SQLite (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type LoadedRelease, loadRelease, startRelease, transitionRelease } from "./release.ts";
import {
  ACME_SHOP_LIVE_PROBES,
  addedRoutesFromContract,
  buildPhase,
  canTransition,
  classifySmoke,
  judgeProbe,
  matchBuild,
  maxPolls,
  POLL_DEADLINE_MS,
  pollDelaySeconds,
  releaseIdFor,
  routesFromContract,
  smokePassed,
  smokeProbes,
  supersededBy,
} from "./release-model.ts";

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const PROJECT = "proj_077b581d-15b3-4f6d-b68a-6a6659cc2668";
const T = "2026-10-09T11:00:00.000Z";
const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";

function harness(withTarget = true) {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const seedProject = () =>
    db.exec(`INSERT INTO organizations (id, name, created_at, updated_at)
             VALUES ('org_a', 'A', '${T}', '${T}');
             INSERT INTO projects (id, org_id, name, slug, status, canonical_generation,
               created_at, updated_at)
             VALUES ('${PROJECT}', 'org_a', 'Acme Shop Live', 'acme-shop-live', 'active', 0,
               '${T}', '${T}');`);
  // The 0015 seed adds the target only where the Project exists: with a target, the Project
  // exists before 0015 runs (as on dev); without one, it is created afterwards (as on prod).
  for (const file of files) {
    if (file.startsWith("0015") && withTarget) seedProject();
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  if (!withTarget) seedProject();

  const exec = (sql: string, params: unknown[]) => {
    const statement = db.prepare(sql);
    if (/^\s*select/i.test(sql)) {
      return { results: statement.all(...(params as never[])), meta: { changes: 0 } };
    }
    return {
      results: [],
      meta: { changes: Number(statement.run(...(params as never[])).changes) },
    };
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    sql,
    params,
    bind: (...next: unknown[]) => statement(sql, next),
    run: async () => exec(sql, params),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => exec(sql, params),
  });

  const created: string[] = [];
  const events: { eventType: string; eventId: string }[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (list: { sql: string; params: unknown[] }[]) =>
        list.map((s) => exec(s.sql.trim(), s.params)),
    },
    RELEASE_WORKFLOW: {
      create: async ({ id }: { id: string }) => {
        if (created.includes(id)) throw new Error("instance already exists");
        created.push(id);
        return { id };
      },
      get: async (id: string) => {
        if (!created.includes(id)) throw new Error("not found");
        return { id };
      },
    },
    RESOURCE_SHARD: {
      idFromName: (name: string) => name,
      get: () => ({
        appendEvents: async (list: { eventType: string; eventId: string }[]) => {
          for (const e of list) {
            if (!events.some((x) => x.eventId === e.eventId)) events.push(e);
          }
        },
      }),
    },
  } as unknown as Env;
  const status = (generation: number) =>
    (
      db
        .prepare("SELECT status FROM releases WHERE project_id = ? AND generation = ?")
        .get(PROJECT, generation) as { status: string } | undefined
    )?.status;
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM releases").get() as { n: number }).n;
  return { db, env, created, events, status, count };
}

const promote = (env: Env, generation: number, commit: string) =>
  startRelease(env, {
    projectId: PROJECT,
    changeId: `chg_${generation}`,
    candidateId: `cand_g${generation}`,
    generation,
    commit,
  });

describe("migration 0015 seed", () => {
  it("adds the Acme Shop Live target only where that Project exists", () => {
    const withProject = harness(true);
    const without = harness(false);
    const targets = (h: ReturnType<typeof harness>) =>
      (h.db.prepare("SELECT COUNT(*) AS n FROM release_targets").get() as { n: number }).n;
    expect(targets(withProject)).toBe(1);
    expect(targets(without)).toBe(0);
  });
});

describe("release idempotency per generation (section 60)", () => {
  it("a retried promotion starts one release and one workflow", async () => {
    const h = harness();
    const first = await promote(h.env, 1, C1);
    const again = await promote(h.env, 1, C1);
    expect(first?.releaseId).toBe(releaseIdFor(PROJECT, 1));
    expect(again?.releaseId).toBe(first?.releaseId);
    expect(h.count()).toBe(1);
    expect(h.created).toEqual([releaseIdFor(PROJECT, 1)]);
    expect(h.status(1)).toBe("queued");
  });

  it("a Project without a release target starts nothing", async () => {
    const h = harness(false);
    expect(await promote(h.env, 1, C1)).toBeNull();
    expect(h.count()).toBe(0);
    expect(h.created).toEqual([]);
  });

  it("a repeated transition appends its events once", async () => {
    const h = harness();
    await promote(h.env, 1, C1);
    const loaded = (await loadRelease(h.env, releaseIdFor(PROJECT, 1))) as LoadedRelease;
    const event = { eventType: "build.started", eventId: "evt_same" } as never;
    await transitionRelease(h.env, loaded, "building", {}, [event]);
    await transitionRelease(h.env, loaded, "building", {}, [event]);
    expect(h.status(1)).toBe("building");
    expect(h.events.map((e) => e.eventType)).toEqual(["build.started"]);
  });
});

describe("supersession when a newer generation is promoted mid-build", () => {
  it("marks the older in-flight release superseded, and it can never deploy afterwards", async () => {
    const h = harness();
    await promote(h.env, 1, C1);
    const older = (await loadRelease(h.env, releaseIdFor(PROJECT, 1))) as LoadedRelease;
    await transitionRelease(h.env, older, "building", {});
    await promote(h.env, 2, C2);
    expect(h.status(1)).toBe("superseded");
    expect(h.status(2)).toBe("queued");

    // The older workflow finishes its build late: no transition out of superseded.
    const late = await transitionRelease(h.env, older, "deployed", { versionId: "v-old" }, [
      { eventType: "deployment.completed", eventId: "evt_late" } as never,
    ]);
    expect(late).toBe("superseded");
    expect(h.events).toEqual([]);
  });

  it("never supersedes a finished release", async () => {
    const h = harness();
    await promote(h.env, 1, C1);
    const done = (await loadRelease(h.env, releaseIdFor(PROJECT, 1))) as LoadedRelease;
    await transitionRelease(h.env, done, "building", {});
    await transitionRelease(h.env, done, "deployed", {});
    await promote(h.env, 2, C2);
    expect(h.status(1)).toBe("deployed");
  });

  it("canonical past the release generation means superseded", () => {
    expect(supersededBy(1, 2)).toBe(true);
    expect(supersededBy(2, 2)).toBe(false);
  });
});

describe("a smoke failure never marks a release deployed (sections 34.4.1, 42.10)", () => {
  const routes = [
    "GET /api/health",
    "GET /api/wishlists",
    "GET /api/wishlists/:id",
    "GET /api/zebras",
    "POST /api/x",
  ];
  const probes = smokeProbes({ routes, added: ["GET /api/wishlists/:id", "GET /api/wishlists"] });
  const routerPage = (title: string) =>
    `<html><head><title>${title}</title></head><body><h1>${title}</h1>
<p><a href="https://rhumbatron.com">Rhumbatron</a></p></body></html>`;

  it("probes the home page and up to 3 static GET routes of the app, added routes first", () => {
    expect(probes.map((p) => p.path)).toEqual([
      "/",
      "/api/wishlists",
      "/api/health",
      "/api/zebras",
    ]);
    expect(probes.every((p) => !p.headers)).toBe(true);
  });

  it("without a route table only the home page is probed", () => {
    expect(smokeProbes().map((p) => p.path)).toEqual(["/"]);
    expect(smokeProbes({ routes: null, added: [] }).map((p) => p.path)).toEqual(["/"]);
  });

  it("the dev Acme Shop target keeps its products API probe, never probed twice", () => {
    const acme = smokeProbes({ routes: ["GET /api/products"], fixed: ACME_SHOP_LIVE_PROBES });
    expect(acme.map((p) => `${p.path} ${p.expect}`)).toEqual(["/ page", "/api/products json"]);
    expect(judgeProbe(acme[1] as never, 200, "<html>").ok).toBe(false);
    expect(judgeProbe(acme[1] as never, 200, '{"products":[]}').ok).toBe(true);
  });

  it("the home page passes on 2xx or 3xx, never on a router status page", () => {
    const home = probes[0] as never;
    expect(judgeProbe(home, 200, "<html><title>Wishlists</title>").ok).toBe(true);
    expect(judgeProbe(home, 302, "").ok).toBe(true);
    expect(judgeProbe(home, 404, "Not Found").ok).toBe(false);
    expect(judgeProbe(home, 200, routerPage("Nothing built yet")).ok).toBe(false);
    expect(judgeProbe(home, 503, routerPage("Building")).ok).toBe(false);
    // An app page that only shares a title with the router is still the app.
    expect(judgeProbe(home, 200, "<title>Building</title>").ok).toBe(true);
  });

  it("a missing app route (404) fails the smoke check", () => {
    const results = [
      judgeProbe(probes[0] as never, 200, "<html>"),
      judgeProbe(probes[1] as never, 404, "Not Found"),
    ];
    const outcome = classifySmoke(results);
    expect(outcome.status).toBe("fail");
    expect(smokePassed(outcome)).toBe(false);
  });

  it("401 and 403 prove an app route exists", () => {
    expect(judgeProbe(probes[1] as never, 401, "").ok).toBe(true);
    expect(judgeProbe(probes[1] as never, 403, "").ok).toBe(true);
  });

  it("reads the route table from contract Evidence, with or without a base table", () => {
    const output = [
      "$ CONTRACT_ROOT=<base 0123456789ab> bun run contract",
      '{"routes":["GET /api/health"]}',
      "$ bun run contract",
      '{"routes":["GET /api/wishlists","GET /api/health"]}',
      'declared: ["GET /api/wishlists"]',
    ].join("\n");
    expect(routesFromContract(output)).toEqual(["GET /api/health", "GET /api/wishlists"]);
    expect(addedRoutesFromContract(output)).toEqual(["GET /api/wishlists"]);
    const firstChange = output.replace('{"routes":["GET /api/health"]}', "error: no src/app.ts");
    expect(routesFromContract(firstChange)).toEqual(["GET /api/health", "GET /api/wishlists"]);
    expect(addedRoutesFromContract(firstChange)).toEqual([]);
    expect(routesFromContract("no contract ran")).toBeNull();
  });

  it("a probe with no response is a gap, never a pass", () => {
    const outcome = classifySmoke([
      judgeProbe(probes[0] as never, 200, ""),
      { probe: probes[1] as never, status: null, ok: false, detail: "timeout" },
    ]);
    expect(outcome).toMatchObject({ status: "error", coverage: "not_checked" });
    expect(smokePassed(outcome)).toBe(false);
    expect(smokePassed(classifySmoke([]))).toBe(false);
  });

  it("the injected probe of a missing route fails against a healthy app", () => {
    const withInjected = smokeProbes({}, "/__rhumbatron/injected-missing-route");
    const results = withInjected.map((p) =>
      p.path === "/__rhumbatron/injected-missing-route"
        ? judgeProbe(p, 404, "Not Found")
        : judgeProbe(p, 200, "{}"),
    );
    expect(smokePassed(classifySmoke(results))).toBe(false);
  });

  it("smoke_failed and failed are final; deployed only from building", () => {
    expect(canTransition("smoke_failed", "deployed")).toBe(false);
    expect(canTransition("failed", "deployed")).toBe(false);
    expect(canTransition("queued", "deployed")).toBe(false);
    expect(canTransition("building", "deployed")).toBe(true);
  });

  it("a smoke-failed release stays smoke_failed when a late deployed write arrives", async () => {
    const h = harness();
    await promote(h.env, 1, C1);
    const loaded = (await loadRelease(h.env, releaseIdFor(PROJECT, 1))) as LoadedRelease;
    await transitionRelease(h.env, loaded, "building", {});
    await transitionRelease(h.env, loaded, "smoke_failed", { failureReason: "404" });
    expect(await transitionRelease(h.env, loaded, "deployed", {})).toBe("smoke_failed");
  });
});

describe("build-commit matching", () => {
  const build = (
    uuid: string,
    commit: string,
    created: string,
    status = "stopped",
    outcome = "success",
  ) => ({
    build_uuid: uuid,
    status,
    build_outcome: outcome,
    created_on: created,
    build_trigger_metadata: { commit_hash: commit, branch: "main" },
  });

  it("matches only the promoted commit, full or abbreviated, newest first", () => {
    const builds = [
      build("b-other", C2, "2026-10-09T12:05:00Z"),
      build("b-old", C1, "2026-10-09T12:00:00Z", "stopped", "fail"),
      build("b-new", C1.slice(0, 10), "2026-10-09T12:03:00Z"),
    ];
    expect(matchBuild(builds, C1)?.build_uuid).toBe("b-new");
    expect(matchBuild(builds, "3333333333333333333333333333333333333333")).toBeNull();
    expect(matchBuild([build("b-short", "111111", T)], C1)).toBeNull();
  });

  it("reads running, failed, and successful builds", () => {
    expect(buildPhase(build("b", C1, T, "running", "")).phase).toBe("building");
    expect(buildPhase(build("b", C1, T, "stopped", "fail")).phase).toBe("failed");
    expect(buildPhase(build("b", C1, T, "stopped", "cancelled")).phase).toBe("failed");
    expect(buildPhase(build("b", C1, T)).phase).toBe("succeeded");
  });

  it("polling stays inside the 15-minute deadline", () => {
    const polls = maxPolls();
    let waited = 0;
    for (let i = 0; i < polls - 1; i++) waited += pollDelaySeconds(i) * 1000;
    expect(waited).toBeLessThanOrEqual(POLL_DEADLINE_MS);
    expect(waited + pollDelaySeconds(polls - 1) * 1000).toBeGreaterThan(POLL_DEADLINE_MS);
  });
});
